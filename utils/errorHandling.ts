/**
 * 错误类型定义
 */
export enum ErrorType {
  NETWORK_ERROR = 'NETWORK_ERROR',
  API_ERROR = 'API_ERROR',
  AUDIO_DECODE_ERROR = 'AUDIO_DECODE_ERROR',
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  INVALID_API_KEY = 'INVALID_API_KEY',
  MODEL_UNAVAILABLE = 'MODEL_UNAVAILABLE',
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

/** 模型不存在或已停用（例如預覽版模型下架） */
export const isModelNotFoundError = (error: unknown): boolean => {
  const message = String((error as Error)?.message || error);
  return /NOT_FOUND|\b404\b|is not supported for generateContent/i.test(message) && /model/i.test(message);
};

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
      'API Key 無效或已過期',
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

  // 模型已停用且找不到替代模型：重試也沒用
  if (isModelNotFoundError(error)) {
    return new AppError(ErrorType.MODEL_UNAVAILABLE, errorMessage, '目前使用的 Gemini 模型已停用，也找不到可以替代的模型', false);
  }

  // 以下都顯示白話說明，不把原始錯誤內容（常是一整段 JSON）秀給使用者；原文留在 message 供除錯
  if (/\b50[03]\b|INTERNAL|UNAVAILABLE|overloaded/i.test(errorMessage)) {
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 伺服器暫時忙碌或發生問題', true);
  }

  if (/\b504\b|DEADLINE_EXCEEDED|timed? ?out/i.test(errorMessage)) {
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 回應逾時', true);
  }

  if (/No response from Gemini|invalid JSON/i.test(errorMessage)) {
    // 附上模型與結束原因，使用者回報問題時才知道發生了什麼
    const found = errorMessage.match(/model=([^,)\s]+), finishReason=([^,)\s]+)/);
    const detail = found ? `（${found[1]}，結束原因 ${found[2]}）` : '';
    // 被安全規則或版權偵測擋下時，同一段音訊重送也是一樣的結果，不重試
    if (/finishReason=(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII)|blockReason=(SAFETY|PROHIBITED_CONTENT|BLOCKLIST|OTHER)/i.test(errorMessage)) {
      return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 因內容安全規則沒有回傳逐字稿。可以改選其他轉錄模型後按「重試」' + detail, false);
    }
    if (/finishReason=RECITATION/i.test(errorMessage)) {
      return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 認為這段聲音可能是受版權保護的內容（例如音樂）而沒有回傳逐字稿。可以改選其他轉錄模型後按「重試」' + detail, false);
    }
    if (/finishReason=MAX_TOKENS/i.test(errorMessage)) {
      return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 的回覆太長被截斷（常見於長時間重複的聲音或雜音）。可以改選其他轉錄模型後按「重試」' + detail, true);
    }
    return new AppError(ErrorType.API_ERROR, errorMessage, 'Gemini 沒有回傳可用的逐字稿內容。可以改選其他轉錄模型後按「重試」' + detail, true);
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
