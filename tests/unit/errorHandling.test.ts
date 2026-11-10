import { describe, it, expect } from 'vitest';
import { parseGeminiError, parseAudioError, isRateLimitError, ErrorType } from '../../utils/errorHandling';

/** SDK 拋出的錯誤訊息通常包含 HTTP 狀態與整段 JSON */
const apiError = (code: number, message: string, status: string) =>
  new Error(`got status: ${code}. ${JSON.stringify({ error: { code, message, status } })}`);

describe('parseGeminiError', () => {
  it('API Key 無效：不可重試', () => {
    const e = parseGeminiError(apiError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT'));
    expect(e.type).toBe(ErrorType.INVALID_API_KEY);
    expect(e.retryable).toBe(false);
    expect(e.userMessage).toBe('API Key 無效或已過期');
  });

  it.each([
    apiError(429, 'You exceeded your current quota', 'RESOURCE_EXHAUSTED'),
    new Error('rate limit reached'),
  ])('配額或請求次數限制：%s', error => {
    const e = parseGeminiError(error);
    expect(e.type).toBe(ErrorType.QUOTA_EXCEEDED);
    expect(e.retryable).toBe(true);
    expect(e.userMessage).toBe('已達到 Gemini API 的使用額度上限');
  });

  it('網路錯誤', () => {
    const e = parseGeminiError(new TypeError('Failed to fetch'));
    expect(e.type).toBe(ErrorType.NETWORK_ERROR);
    expect(e.retryable).toBe(true);
  });

  it.each([
    [apiError(500, 'Internal error encountered.', 'INTERNAL'), 'Gemini 伺服器暫時忙碌或發生問題'],
    [apiError(503, 'The model is overloaded.', 'UNAVAILABLE'), 'Gemini 伺服器暫時忙碌或發生問題'],
    [apiError(504, 'Deadline exceeded', 'DEADLINE_EXCEEDED'), 'Gemini 回應逾時'],
    [new Error('No response from Gemini'), 'Gemini 沒有回傳可用的逐字稿內容'],
    [new Error('Gemini returned invalid JSON'), 'Gemini 沒有回傳可用的逐字稿內容'],
  ])('伺服器端錯誤顯示白話說明：%s', (error, message) => {
    const e = parseGeminiError(error);
    expect(e.userMessage).toBe(message);
    expect(e.retryable).toBe(true);
  });

  it('其他錯誤只附錯誤代碼，不把原始 JSON 給使用者看', () => {
    const e = parseGeminiError(apiError(400, 'Request contains an invalid argument.', 'INVALID_ARGUMENT'));
    expect(e.userMessage).toBe('Gemini 回傳了錯誤（錯誤代碼 400）');
    expect(e.userMessage).not.toContain('{');
    expect(e.message).toContain('invalid argument'); // 原文留著除錯
  });
});

describe('模型停用', () => {
  it('模型不存在：不可重試，說明模型已停用', () => {
    const e = parseGeminiError(apiError(404, 'models/gemini-3-flash-preview is not found for API version v1beta, or is not supported for generateContent.', 'NOT_FOUND'));
    expect(e.type).toBe(ErrorType.MODEL_UNAVAILABLE);
    expect(e.retryable).toBe(false);
    expect(e.userMessage).toContain('模型已停用');
  });
});

describe('isRateLimitError', () => {
  it.each(['429 Too Many Requests', 'RESOURCE_EXHAUSTED', 'exceeded your current quota'])('%s', message => {
    expect(isRateLimitError(new Error(message))).toBe(true);
  });

  it('一般錯誤不算', () => {
    expect(isRateLimitError(new Error('Internal error'))).toBe(false);
  });
});

describe('parseAudioError', () => {
  it('讀不了音檔時建議改用常見格式', () => {
    const e = parseAudioError(new Error('Unable to decode audio data'));
    expect(e.type).toBe(ErrorType.AUDIO_DECODE_ERROR);
    expect(e.userMessage).toContain('建議改用 MP3、M4A 或 WAV');
  });
});
