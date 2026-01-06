import { GoogleGenAI, Type } from "@google/genai";
import { TranscriptSegment } from "../types";
import { blobToBase64 } from "../utils/audioUtils";

export const MODEL_NAME = 'gemini-3-flash-preview';

interface GeminiResponseItem {
  speaker: string;
  timestamp: string;
  text: string;
}

export const transcribeChunk = async (
  audioBlob: Blob, 
  apiKey: string,
  chunkIndex: number,
  startTimeOffset: number
): Promise<TranscriptSegment[]> => {
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
};