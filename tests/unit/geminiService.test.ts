// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 用假的 SDK 取代真正的 Gemini 呼叫
const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent }; },
  ThinkingLevel: { MINIMAL: 'MINIMAL' },
  Type: { ARRAY: 'ARRAY', OBJECT: 'OBJECT', STRING: 'STRING' },
}));

const { transcribeChunk, requestLog } = await import('../../services/geminiService');

const audio = new Blob([new Uint8Array(64)], { type: 'audio/wav' });
const reply = (items: object[]) => ({ text: JSON.stringify(items), usageMetadata: { candidatesTokenCount: 10, thoughtsTokenCount: 0 } });
const serverError = () => new Error('got status: 500. {"error":{"code":500,"message":"Internal error","status":"INTERNAL"}}');

beforeEach(() => {
  generateContent.mockReset();
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
