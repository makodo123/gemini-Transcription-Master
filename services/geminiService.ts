import { GoogleGenAI, ThinkingLevel, Type } from "@google/genai";
import { TranscriptSegment } from "../types";
import { blobToBase64, parseTimeStringToSeconds } from "../utils/audioUtils";
import { isRateLimitError, parseGeminiError } from "../utils/errorHandling";

export const MODEL_NAME = 'gemini-3-flash-preview';

interface GeminiResponseItem {
  speaker: string;
  timestamp: string;
  text: string;
}

interface TranscribeOptions {
  maxRetries?: number;
  retryDelay?: number;
  /** 遇到請求次數過多（429）時呼叫，讓呼叫端降低同時數 */
  onRateLimited?: () => void;
  /** 使用者按下停止時中斷請求與重試等待 */
  signal?: AbortSignal;
}

/** 等待指定時間；signal 中斷時立即結束 */
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });

// 429 需要等配額恢復，退避時間比一般錯誤長
const RATE_LIMIT_RETRY_DELAY = 5000;

/** 每一次 API 請求的紀錄（含重試），用來找出長音檔轉錄慢在哪裡 */
export interface RequestLogEntry {
  chunk: number;
  attempt: number;
  startedAt: number;
  ms: number;
  ok: boolean;
  uploadMB: number;
  outputChars?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  error?: string;
}

export const requestLog: RequestLogEntry[] = [];

/**
 * 带重试机制的转录函数
 */
const transcribeWithRetry = async (
  fn: () => Promise<TranscriptSegment[]>,
  chunkIndex: number,
  options: TranscribeOptions = {}
): Promise<TranscriptSegment[]> => {
  const { maxRetries = 3, retryDelay = 1000, onRateLimited, signal } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      // 已停止、或 API Key 無效這類重試也不會成功的錯誤，直接拋出
      if (signal?.aborted || !parseGeminiError(error).retryable) throw error;
      const rateLimited = isRateLimitError(error);
      if (rateLimited) onRateLimited?.();

      if (attempt < maxRetries) {
        console.log(`Retry ${attempt + 1}/${maxRetries} for chunk ${chunkIndex + 1}`);
        // 指数退避策略
        const baseDelay = rateLimited ? RATE_LIMIT_RETRY_DELAY : retryDelay;
        await sleep(baseDelay * Math.pow(2, attempt), signal);
        if (signal?.aborted) throw error;
      }
    }
  }

  throw lastError || new Error('Transcription failed after retries');
};

export const transcribeChunk = async (
  audioBlob: Blob, 
  apiKey: string,
  chunkIndex: number,
  startTimeOffset: number,
  options?: TranscribeOptions
): Promise<TranscriptSegment[]> => {
  let attempt = 0;
  return transcribeWithRetry(async () => {
  const log: RequestLogEntry = { chunk: chunkIndex + 1, attempt: ++attempt, startedAt: performance.now(), ms: 0, ok: false, uploadMB: 0 };
  requestLog.push(log);
  try {
    const ai = new GoogleGenAI({ apiKey });
    const base64Audio = await blobToBase64(audioBlob);
    options?.signal?.throwIfAborted();
    log.uploadMB = +(base64Audio.length / 1e6).toFixed(1);

    const prompt = `
      你是一位專業的繁體中文逐字稿聽寫員。
      請將這段音訊轉錄為逐字稿。
      
      要求：
      1. 使用繁體中文 (Traditional Chinese)。
      2. 辨識說話者 (例如: 講者 1, 講者 2)。
      3. 提供每一句話相對於音訊開頭的時間點 (格式: MM:SS)。
      4. 如果音訊包含多種語言，請主要轉錄為中文，保留專有名詞原文。
    `;

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: 'audio/wav',
              data: base64Audio
            }
          },
          { text: prompt }
        ]
      },
      config: {
        abortSignal: options?.signal,
        // 逐字稿是聽寫任務，幾乎不需要推理；思考內容也要逐字產生，設為最低以縮短等待時間
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              speaker: { type: Type.STRING },
              timestamp: { type: Type.STRING },
              text: { type: Type.STRING }
            },
            required: ["speaker", "timestamp", "text"]
          }
        }
      }
    });

    const responseText = response.text;
    log.ms = Math.round(performance.now() - log.startedAt);
    log.outputChars = responseText?.length ?? 0;
    log.outputTokens = response.usageMetadata?.candidatesTokenCount;
    log.thinkingTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;
    if (!responseText) {
      throw new Error("No response from Gemini");
    }

    let parsed: GeminiResponseItem[] = [];
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      console.error("Failed to parse Gemini JSON", e);
      throw new Error("Gemini returned invalid JSON");
    }

    log.ok = true;

    // Process timestamps to be absolute based on chunk offset
    return parsed.map(item => {
      // 模型偶爾會回 HH:MM:SS，不能只當 MM:SS 拆
      const absoluteSeconds = startTimeOffset + (parseTimeStringToSeconds(item.timestamp) ?? 0);
      
      return {
        speaker: item.speaker,
        timestamp: item.timestamp, // Keep original relative string for reference if needed
        startTimeSeconds: absoluteSeconds,
        text: item.text
      };
    });

  } catch (error) {
    console.error(`Error transcribing chunk ${chunkIndex}:`, error);
    log.ms = log.ms || Math.round(performance.now() - log.startedAt);
    log.error = String((error as Error)?.message || error).slice(0, 120);
    throw error;
  }
  }, chunkIndex, options);
};