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

/**
 * 解析 Gemini API 错误
 */
export const parseGeminiError = (error: any): AppError => {
  const errorMessage = error?.message || error?.toString() || '';

  // API Key 错误
  if (errorMessage.includes('API key') || errorMessage.includes('authentication')) {
    return new AppError(
      ErrorType.INVALID_API_KEY,
      errorMessage,
      'API 金鑰無效或已過期，請檢查您的設定',
      false
    );
  }

  // 配額超限
  if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
    return new AppError(
      ErrorType.QUOTA_EXCEEDED,
      errorMessage,
      '已達到 API 使用配額限制，請稍後再試',
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

  // 默認為 API 錯誤
  return new AppError(
    ErrorType.API_ERROR,
    errorMessage,
    `API 請求失敗：${errorMessage}`,
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
    '音訊檔案格式不支援或已損壞，請上傳有效的音訊檔案',
    false
  );
};
