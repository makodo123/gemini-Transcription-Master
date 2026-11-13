// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 用假的 SDK 取代真正的 Gemini 呼叫
const generateContent = vi.fn();
const listModels = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent, list: listModels }; },
  ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW' },
  Type: { ARRAY: 'ARRAY', OBJECT: 'OBJECT', STRING: 'STRING' },
}));

const {
  transcribeChunk, requestLog, getActiveModel, resetModelSelection, pickFallbackModel, thinkingConfigFor, validateApiKey, MODEL_NAME,
  buildTranscriptionPrompt, cleanSpeakerHints, OTHER_SPEAKER, MODEL_CHOICES, setPreferredModel, getPreferredModel,
} = await import('../../services/geminiService');
const { parseGeminiError, ErrorType } = await import('../../utils/errorHandling');

const audio = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
const reply = (items: object[]) => ({ text: JSON.stringify(items), usageMetadata: { candidatesTokenCount: 10, thoughtsTokenCount: 0 } });
const serverError = () => new Error('got status: 500. {"error":{"code":500,"message":"Internal error","status":"INTERNAL"}}');

beforeEach(() => {
  generateContent.mockReset();
  listModels.mockReset();
  setPreferredModel(MODEL_NAME);
  resetModelSelection();
  requestLog.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('transcribeChunk', () => {
  it('把片段內的相對時間換成整個檔案的絕對時間（支援 MM:SS 與 HH:MM:SS）', async () => {
    generateContent.mockResolvedValue(reply([
      { speaker: '講者 1', timestamp: '01:05', text: '甲' },
      { speaker: '講者 2', timestamp: '00:01:30', text: '乙' },
      { speaker: '講者 1', timestamp: '???', text: '丙' },
    ]));
    const segments = await transcribeChunk(audio, 'key', 1, 300);
    expect(segments.map(s => s.startTimeSeconds)).toEqual([365, 390, 300]);
    expect(segments.map(s => s.text)).toEqual(['甲', '乙', '丙']);
  });

  it('把停止訊號傳給 SDK', async () => {
    generateContent.mockResolvedValue(reply([]));
    const controller = new AbortController();
    await transcribeChunk(audio, 'key', 0, 0, { signal: controller.signal });
    expect(generateContent.mock.calls[0][0].config.abortSignal).toBe(controller.signal);
  });

  it('可重試的錯誤會重試，最後一次仍失敗才拋出', async () => {
    generateContent.mockRejectedValue(serverError());
    await expect(transcribeChunk(audio, 'key', 0, 0, { maxRetries: 2, retryDelay: 1 })).rejects.toThrow('Internal error');
    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(requestLog.map(r => r.attempt)).toEqual([1, 2, 3]);
  });

  it('重試後成功就回傳結果', async () => {
    generateContent.mockRejectedValueOnce(serverError()).mockResolvedValue(reply([{ speaker: 'A', timestamp: '00:01', text: 'ok' }]));
    const segments = await transcribeChunk(audio, 'key', 0, 0, { maxRetries: 3, retryDelay: 1 });
    expect(segments).toHaveLength(1);
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('API Key 無效時不重試', async () => {
    generateContent.mockRejectedValue(new Error('API key not valid. Please pass a valid API key.'));
    await expect(transcribeChunk(audio, 'bad', 0, 0, { maxRetries: 3, retryDelay: 1 })).rejects.toThrow('API key');
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('空白或不是 JSON 的回應會重試', async () => {
    generateContent.mockResolvedValueOnce({ text: '' }).mockResolvedValueOnce({ text: 'not json' }).mockResolvedValue(reply([]));
    await expect(transcribeChunk(audio, 'key', 0, 0, { maxRetries: 3, retryDelay: 1 })).resolves.toEqual([]);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('請求次數過多時通知呼叫端，並等比一般錯誤更久才重試', async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValueOnce(new Error('429 RESOURCE_EXHAUSTED')).mockResolvedValue(reply([]));
    const onRateLimited = vi.fn();
    const result = transcribeChunk(audio, 'key', 0, 0, { maxRetries: 1, retryDelay: 1, onRateLimited });
    await vi.advanceTimersByTimeAsync(4000);
    expect(generateContent).toHaveBeenCalledTimes(1); // 5 秒還沒到
    await vi.advanceTimersByTimeAsync(1500);
    await expect(result).resolves.toEqual([]);
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(onRateLimited).toHaveBeenCalledTimes(1);
  });

  it('等待重試時按停止，立刻結束且不再送出請求', async () => {
    vi.useFakeTimers();
    generateContent.mockRejectedValue(serverError());
    const controller = new AbortController();
    const result = transcribeChunk(audio, 'key', 0, 0, { maxRetries: 3, retryDelay: 10_000, signal: controller.signal });
    const settled = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await settled;
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

// 模擬 SDK 的分頁列表（可以 for await 逐一取出）
const pagerOf = (names: string[]) => (async function* () {
  for (const name of names) yield { name: `models/${name}`, supportedActions: ['generateContent', 'countTokens'] };
})();
const notFound = (model: string) =>
  new Error(`got status: 404. {"error":{"code":404,"message":"models/${model} is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}`);

describe('模型停用時的備援', () => {
  it('思考設定依模型世代：3 以後用 thinkingLevel，2.5 用 thinkingBudget', () => {
    expect(thinkingConfigFor('gemini-3-flash-preview')).toEqual({ thinkingLevel: 'MINIMAL' });
    expect(thinkingConfigFor('gemini-3.6-flash')).toEqual({ thinkingLevel: 'MINIMAL' });
    // 3.8 起不支援 minimal，送了會失敗
    expect(thinkingConfigFor('gemini-3.8-flash')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-4-flash')).toEqual({ thinkingLevel: 'LOW' });
    expect(thinkingConfigFor('gemini-2.5-flash')).toEqual({ thinkingBudget: 0 });
  });

  it('挑替代模型：正式版 Flash 優先、版本新的優先，排除 Lite、圖片、語音等特殊版本', () => {
    const models = (names: string[]) => names.map(n => ({ name: `models/${n}`, supportedActions: ['generateContent'] }));
    expect(pickFallbackModel(models([
      'gemini-2.5-flash', 'gemini-3-flash', 'gemini-4-flash-preview', 'gemini-3-flash-lite', 'gemini-3-flash-image', 'gemini-3-pro',
    ]), MODEL_NAME)).toBe('gemini-3-flash');
    expect(pickFallbackModel(models(['gemini-2.5-flash', 'gemini-4-flash-preview']), 'gemini-2.5-flash')).toBe('gemini-4-flash-preview');
    expect(pickFallbackModel(models(['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']), MODEL_NAME)).toBe('gemini-3.8-flash');
    expect(pickFallbackModel(models(['gemini-2.0-flash', 'gemini-3-flash-lite']), MODEL_NAME)).toBeNull();
    expect(pickFallbackModel([{ name: 'models/gemini-3-flash', supportedActions: ['embedContent'] }], MODEL_NAME)).toBeNull();
  });

  it('預設模型 404：查一次可用模型、改用替代模型馬上重送，之後的請求都用新模型', async () => {
    generateContent.mockImplementation(({ model }) =>
      model === MODEL_NAME ? Promise.reject(notFound(model)) : Promise.resolve(reply([{ speaker: 'A', timestamp: '00:01', text: 'ok' }])));
    listModels.mockImplementation(() => Promise.resolve(pagerOf(['gemini-2.5-flash', 'gemini-3-flash'])));

    // 三段同時遇到 404，只查一次模型列表
    const results = await Promise.all([0, 1, 2].map(i => transcribeChunk(audio, 'key', i, i * 300, { retryDelay: 1 })));
    expect(results.every(r => r.length === 1)).toBe(true);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(getActiveModel()).toBe('gemini-3-flash');
    const fallbackCall = generateContent.mock.calls.find(([req]) => req.model === 'gemini-3-flash')![0];
    expect(fallbackCall.config.thinkingConfig).toEqual({ thinkingLevel: 'MINIMAL' });

    generateContent.mockClear();
    await transcribeChunk(audio, 'key', 3, 900);
    expect(generateContent.mock.calls.map(([req]) => req.model)).toEqual(['gemini-3-flash']);
  });

  it('改用 2.5 時換成 thinkingBudget 設定', async () => {
    generateContent.mockImplementation(({ model }) =>
      model === MODEL_NAME ? Promise.reject(notFound(model)) : Promise.resolve(reply([])));
    listModels.mockResolvedValue(pagerOf(['gemini-2.5-flash']));
    await transcribeChunk(audio, 'key', 0, 0);
    expect(generateContent.mock.calls.at(-1)![0].config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('找不到替代模型：不重試，錯誤歸類為「模型無法使用」', async () => {
    generateContent.mockRejectedValue(notFound(MODEL_NAME));
    listModels.mockResolvedValue(pagerOf(['gemini-3-pro', 'gemini-3-flash-lite']));
    const error = await transcribeChunk(audio, 'key', 0, 0, { maxRetries: 3, retryDelay: 1 }).catch(e => e);
    expect(parseGeminiError(error).type).toBe(ErrorType.MODEL_UNAVAILABLE);
    expect(parseGeminiError(error).retryable).toBe(false);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(getActiveModel()).toBe(MODEL_NAME);
  });
});

describe('validateApiKey', () => {
  it('列得出模型就是有效', async () => {
    listModels.mockResolvedValue(pagerOf(['gemini-3-flash']));
    await expect(validateApiKey('good')).resolves.toBe('valid');
  });

  it('API Key 錯誤時回報無效', async () => {
    listModels.mockRejectedValue(new Error('got status: 400. API key not valid. Please pass a valid API key.'));
    await expect(validateApiKey('bad')).resolves.toBe('invalid');
  });

  it('網路等其他問題無法判斷', async () => {
    listModels.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(validateApiKey('maybe')).resolves.toBe('unknown');
  });
});

describe('講者名單', () => {
  it('沒有名單時照舊用「講者 1」編號', () => {
    expect(buildTranscriptionPrompt()).toContain('講者 1, 講者 2');
  });

  it('有名單時列出名字與角色，並要求依角色判斷、不照誰先開口', () => {
    const prompt = buildTranscriptionPrompt([{ name: '面試官', role: '提問的人' }, { name: '我', role: '' }]);
    expect(prompt).toContain('- 面試官：提問的人');
    expect(prompt).toMatch(/- 我\n/);
    expect(prompt).toContain('不要照誰先開口來分配名字');
    expect(prompt).toContain(`填「${OTHER_SPEAKER}」`);
    expect(prompt).not.toContain('講者 1, 講者 2');
  });

  it('整理名單：去掉空白、沒有名字的列與重複的名字', () => {
    expect(cleanSpeakerHints([
      { name: ' 面試官 ', role: ' 提問的人 ' },
      { name: '', role: '沒有名字' },
      { name: '面試官', role: '重複' },
      { name: '我', role: '' },
    ])).toEqual([{ name: '面試官', role: '提問的人' }, { name: '我', role: '' }]);
  });

  it('送出的請求帶著名單', async () => {
    generateContent.mockResolvedValue(reply([]));
    await transcribeChunk(audio, 'key', 0, 0, { speakers: [{ name: '面試官', role: '提問的人' }] });
    const parts = generateContent.mock.calls[0][0].contents.parts;
    expect(parts[1].text).toContain('- 面試官：提問的人');
  });
});

describe('選擇轉錄模型', () => {
  it('選項第一個是預設；選了之後請求就用那個模型', async () => {
    expect(MODEL_CHOICES[0].id).toBe(MODEL_NAME);
    setPreferredModel('gemini-3.8-flash');
    expect(getActiveModel()).toBe('gemini-3.8-flash');
    generateContent.mockResolvedValue(reply([]));
    await transcribeChunk(audio, 'key', 0, 0);
    expect(generateContent.mock.calls[0][0].model).toBe('gemini-3.8-flash');
    // 3.8 不支援 minimal 思考，要送 low
    expect(generateContent.mock.calls[0][0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
  });

  it('不在選項裡的模型當作預設', () => {
    setPreferredModel('gemini-9-nonsense');
    expect(getPreferredModel()).toBe(MODEL_NAME);
  });

  it('換 API Key 重設後回到「選的」模型，不是預設', () => {
    setPreferredModel('gemini-3.6-flash');
    resetModelSelection();
    expect(getActiveModel()).toBe('gemini-3.6-flash');
  });
});

describe('沒有回傳內容時記下原因', () => {
  it('回覆空白：錯誤訊息帶著模型與結束原因', async () => {
    generateContent.mockResolvedValue({ text: '', candidates: [{ finishReason: 'SAFETY' }], usageMetadata: {} });
    await expect(transcribeChunk(audio, 'key', 0, 0, { maxRetries: 3, retryDelay: 1 })).rejects.toThrow(/No response from Gemini \(model=gemini-3-flash-preview, finishReason=SAFETY/);
    expect(generateContent).toHaveBeenCalledTimes(1); // 被安全規則擋下，不重試
  });

  it('JSON 被截斷：訊息帶著 MAX_TOKENS，並且會重試', async () => {
    generateContent.mockResolvedValue({ text: '[{"speaker":"A","timest', candidates: [{ finishReason: 'MAX_TOKENS' }], usageMetadata: {} });
    await expect(transcribeChunk(audio, 'key', 0, 0, { maxRetries: 2, retryDelay: 1 })).rejects.toThrow(/invalid JSON .*finishReason=MAX_TOKENS/);
    expect(generateContent).toHaveBeenCalledTimes(3);
  });

  it('回傳的不是陣列也當作無效', async () => {
    generateContent.mockResolvedValue({ text: '{"error":"x"}', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} });
    await expect(transcribeChunk(audio, 'key', 0, 0, { maxRetries: 0 })).rejects.toThrow(/invalid JSON/);
  });
});
