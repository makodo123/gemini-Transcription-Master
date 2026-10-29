/**
 * 错误类型定义
 */
export enum ErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  AUDIO_DECODE_ERROR = 'AUDIO_DECODE_ERROR',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * 应用错误类
 */
export class AppError extends Error {
  type: ErrorType;
  retryable: boolean;
  userMessage: string;

  constructor(
    type: ErrorType,
    message: string,
    userMessage: string,
    retryable: boolean = false
  ) {
    super(message);
    this.type = type;
    this.userMessage = userMessage;
    this.retryable = retryable;
    this.name = 'AppError';
  }
}

export const isRateLimitError = (error: unknown): boolean =>
  /429|RESOURCE_EXHAUSTED|quota|rate limit/i.test(String((error as Error)?.message || error));

/**
 * 解析 Gemini API 错误
 */
export const parseGeminiError = (error: any): AppError => {
  const errorMessage = error?.message || error?.toString() || '';

  // API Key 错误
  if (/API key|API_KEY_INVALID|authentication/i.test(errorMessage)) {
    return new AppError(
      ErrorType.INVALID_API_KEY,
      errorMessage,
      'API 金鑰無效或已過期',
      false
    );
  }

  // 配額超限
  if (isRateLimitError(error)) {
    return new AppError(
      ErrorType.QUOTA_EXCEEDED,
      errorMessage,
      '已達到 Gemini API 的使用額度上限',
      true
    );
  }

  // 網絡錯誤
  if (errorMessage.includes('network') || errorMessage.includes('fetch')) {
    return new AppError(
      ErrorType.NETWORK_ERROR,
      errorMessage,
      '網路連線發生問題，請檢查您的網路連線',
      true
    );
  }

  // 以下都顯示白話說明，不把原始錯誤內容（常是一整段 JSON）秀給使用者；原文留在 message 供除錯
  if (/\b50[03]\b|INTERNAL|UNAVAILABLE|overloaded/i.test(errorMessage)) {
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 伺服器暫時忙碌或發生問題', true);
  }

  if (/\b504\b|DEADLINE_EXCEEDED|timed? ?out/i.test(errorMessage)) {
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 回應逾時', true);
  }

  if (/No response from Gemini|invalid JSON/i.test(errorMessage)) {
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 沒有回傳可用的逐字稿內容', true);
  }

  // 默認為 API 錯誤，只附上錯誤代碼
  const code = errorMessage.match(/"code"\s*:\s*(\d{3})/)?.[1] ?? errorMessage.match(/\b([45]\d\d)\b/)?.[1];
  return new AppError(
    ErrorType.API_ERROR,
    errorMessage,
    `Gemini 回傳了錯誤${code ? `（錯誤代碼 ${code}）` : ''}`,
    true
  );
};

/**
 * 解析音訊解碼錯誤
 */
export const parseAudioError = (error: any): AppError => {
  return new AppError(
    ErrorType.AUDIO_DECODE_ERROR,
    error?.message || error?.toString() || '',
    '無法讀取這個音檔，可能是格式不支援或檔案已損壞。建議改用 MP3、M4A 或 WAV 再試一次',
    false
  );
};
