import { GoogleGenAI, ThinkingConfig, ThinkingLevel, Type } from "@google/genai";
import { TranscriptSegment, SpeakerHint } from "../types";
import { blobToBase64, parseTimeStringToSeconds } from "../utils/audioUtils";
import { isRateLimitError, isModelNotFoundError, parseGeminiError, ErrorType } from "../utils/errorHandling";

export const MODEL_NAME = 'gemini-3-flash-preview';

// 目前實際使用的模型：預設模型停用（例如預覽版下架）時，改成自動找到的替代模型
let activeModel = MODEL_NAME;
let fallbackLookup: { from: string; result: Promise<string | null> } | null = null;

export const getActiveModel = () => activeModel;

/** 回到預設模型（換 API Key 時、測試用） */
export const resetModelSelection = () => {
  activeModel = MODEL_NAME;
  fallbackLookup = null;
};

const modelVersion = (model: string) => Number(model.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);

/**
 * 各世代的「最少思考」設定：2.5 用 thinkingBudget，3 以後用 thinkingLevel。
 * 3.8 起不再支援 minimal（送了會回錯誤），最低只到 low。
 */
export const thinkingConfigFor = (model: string): ThinkingConfig => {
  const version = modelVersion(model);
  if (version >= 3.8) return { thinkingLevel: ThinkingLevel.LOW };
  return version >= 3 ? { thinkingLevel: ThinkingLevel.MINIMAL } : { thinkingBudget: 0 };
};

export interface ModelInfo { name?: string; supportedActions?: string[] }

/**
 * 從可用模型中挑替代模型：能用 generateContent 的 Flash（不含 Lite、圖片、語音等特殊版本），
 * 2.5 以後；正式版優先，再挑最新的版本。
 */
export const pickFallbackModel = (models: ModelInfo[], exclude: string): string | null => {
  const candidates = models
    .map(m => ({ name: (m.name ?? '').replace(/^models\//, ''), actions: m.supportedActions ?? [] }))
    .filter(m => m.actions.includes('generateContent') && m.name !== exclude)
    .filter(m => /^gemini-\d+(\.\d+)?-flash(-preview(-[\w-]+)?)?$/.test(m.name) && !/lite|image|tts|live|audio/.test(m.name))
    .filter(m => modelVersion(m.name) >= 2.5);
  candidates.sort((a, b) => {
    const aPreview = a.name.includes('preview') ? 1 : 0, bPreview = b.name.includes('preview') ? 1 : 0;
    return aPreview - bPreview || modelVersion(b.name) - modelVersion(a.name);
  });
  return candidates[0]?.name ?? null;
};

/** 列出這組 API Key 可用的模型（不耗額度） */
const listModels = async (apiKey: string, pageSize = 100): Promise<ModelInfo[]> => {
  const ai = new GoogleGenAI({ apiKey });
  const pager = await ai.models.list({ config: { pageSize } });
  const models: ModelInfo[] = [];
  for await (const model of pager) models.push(model);
  return models;
};

/**
 * 模型不存在時找替代模型並切換；同時有好幾段失敗也只查一次。找不到時回傳 null。
 */
const switchToFallbackModel = async (apiKey: string, failedModel: string): Promise<string | null> => {
  if (activeModel !== failedModel) return activeModel; // 其他段已經換好了
  if (!fallbackLookup || fallbackLookup.from !== failedModel) {
    fallbackLookup = {
      from: failedModel,
      result: listModels(apiKey).then(models => pickFallbackModel(models, failedModel)).catch(() => null),
    };
  }
  const next = await fallbackLookup.result;
  if (next && activeModel === failedModel) {
    console.warn(`Model ${failedModel} is unavailable, switching to ${next}`);
    activeModel = next;
  }
  return next;
};

export type ApiKeyCheck = 'valid' | 'invalid' | 'unknown';

/** 儲存前確認 API Key 有效：列模型不耗額度。網路問題等無法判斷時回傳 unknown */
export const validateApiKey = async (apiKey: string): Promise<ApiKeyCheck> => {
  try {
    await listModels(apiKey, 1);
    return 'valid';
  } catch (error) {
    return parseGeminiError(error).type === ErrorType.INVALID_API_KEY ? 'invalid' : 'unknown';
  }
};

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
  /** 轉錄前填的講者（已用 cleanSpeakerHints 整理過） */
  speakers?: SpeakerHint[];
}

/** 聽不出是誰、或名單以外的人 */
export const OTHER_SPEAKER = '其他講者';

/** 去掉前後空白、沒填名字的列與重複的名字 */
export const cleanSpeakerHints = (hints: SpeakerHint[]): SpeakerHint[] => {
  const seen = new Set<string>();
  return hints
    .map(h => ({ name: h.name.trim(), role: h.role.trim() }))
    .filter(h => h.name && !seen.has(h.name) && seen.add(h.name));
};

/**
 * 給 Gemini 的指示。每 5 分鐘一段是分開辨識的；沒有講者名單時只能照誰先開口編號，
 * 不同段落的「講者 1」可能是不同人。有名單時要它依角色判斷，各段才會一致。
 */
export const buildTranscriptionPrompt = (speakers: SpeakerHint[] = []): string => {
  const speakerRule = speakers.length === 0
    ? ['2. 辨識說話者 (例如: 講者 1, 講者 2)。']
    : [
        '2. 辨識說話者。這段錄音的講者如下，speaker 欄位請直接填這裡的名字：',
        ...speakers.map(h => `   - ${h.name}${h.role ? `：${h.role}` : ''}`),
        '   這段音訊是一段長錄音的其中一部分，開頭可能是任何一位在說話。請依每個人的角色、說話內容與聲音判斷是誰（例如誰在提問、誰在回答），不要照誰先開口來分配名字。',
        `   聽不出是誰、或出現名單以外的人時，填「${OTHER_SPEAKER}」。`,
      ];
  return [
    '你是一位專業的繁體中文逐字稿聽寫員。',
    '請將這段音訊轉錄為逐字稿。',
    '',
    '要求：',
    '1. 使用繁體中文 (Traditional Chinese)。',
    ...speakerRule,
    '3. 提供每一句話相對於音訊開頭的時間點 (格式: MM:SS)。',
    '4. 如果音訊包含多種語言，請主要轉錄為中文，保留專有名詞原文。',
  ].join('\n');
};

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
  model?: string;
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

    const prompt = buildTranscriptionPrompt(options?.speakers);

    const generate = (model: string) => ai.models.generateContent({
      model,
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
        thinkingConfig: thinkingConfigFor(model),
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

    let model = activeModel;
    log.model = model;
    let response;
    try {
      response = await generate(model);
    } catch (error) {
      // 模型停用：換成替代模型馬上重送（不算重試次數）；找不到替代模型就照原錯誤往外丟
      if (!isModelNotFoundError(error)) throw error;
      const fallback = await switchToFallbackModel(apiKey, model);
      if (!fallback) throw error;
      model = fallback;
      log.model = model;
      response = await generate(model);
    }

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