import { GoogleGenAI, Type } from "@google/genai";
import { TranscriptSegment } from "../types";
import { blobToBase64 } from "../utils/audioUtils";

export const MODEL_NAME = 'gemini-3-flash-preview';

interface GeminiResponseItem {
  speaker: string;
  timestamp: string;
  text: string;
}

interface TranscribeOptions {
  maxRetries?: number;
  retryDelay?: number;
}

/**
 * 带重试机制的转录函数
 */
const transcribeWithRetry = async (
  fn: () => Promise<TranscriptSegment[]>,
  chunkIndex: number,
  options: TranscribeOptions = {}
): Promise<TranscriptSegment[]> => {
  const { maxRetries = 3, retryDelay = 1000 } = options;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxRetries) {
        console.log(`Retry ${attempt + 1}/${maxRetries} for chunk ${chunkIndex + 1}`);
        // 指数退避策略
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
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
  return transcribeWithRetry(async () => {
  try {
    const ai = new GoogleGenAI({ apiKey });
    const base64Audio = await blobToBase64(audioBlob);

    const prompt = `
      你是一位專業的繁體中文逐字稿聽寫員。
      請將這段音訊轉錄為逐字稿。
      
      要求：
      1. 使用繁體中文 (Traditional Chinese)。
      2. 辨識說話者 (例如: 講者 1, 講者 2)。
      3. 提供每一句話相對於音訊開頭的時間點 (格式: MM:SS)。
      4. 如果音訊包含多種語言，請主要轉錄為中文，保留專有名詞原文。
      5. 輸出格式必須是嚴格的 JSON 陣列。
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

    // Process timestamps to be absolute based on chunk offset
    return parsed.map(item => {
      const [mm, ss] = item.timestamp.split(':').map(Number);
      const segmentSeconds = (isNaN(mm) ? 0 : mm * 60) + (isNaN(ss) ? 0 : ss);
      const absoluteSeconds = startTimeOffset + segmentSeconds;
      
      return {
        speaker: item.speaker,
        timestamp: item.timestamp, // Keep original relative string for reference if needed
        startTimeSeconds: absoluteSeconds,
        text: item.text
      };
    });

  } catch (error) {
    console.error(`Error transcribing chunk ${chunkIndex}:`, error);
    throw error;
  }
  }, chunkIndex, options);
};