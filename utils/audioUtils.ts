import { TranscriptSegment } from "../types";
import { decodeStreaming } from "./streamDecode";

// 語音辨識用 16kHz 單聲道就足夠，上傳量比 44.1/48kHz 立體聲小很多
export const TRANSCRIBE_SAMPLE_RATE = 16000;

interface DecodeOptions {
  signal?: AbortSignal;
  /** 解碼進度 0–1；只有分段解碼時會回報 */
  onProgress?: (fraction: number) => void;
}

/**
 * Decodes an audio file into 16kHz mono 16-bit PCM, the exact format sent to Gemini.
 * 先嘗試分段解碼（峰值記憶體不隨檔案長度暴增），格式或瀏覽器不支援時改用整檔解碼。
 */
export const decodeAudio = async (file: File, options: DecodeOptions = {}): Promise<Int16Array> => {
  try {
    const pcm = await decodeStreaming(file, { outputRate: TRANSCRIBE_SAMPLE_RATE, ...options });
    if (pcm) return pcm;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    console.warn('Streaming decode failed, falling back to decodeAudioData:', error);
  }
  return decodeWholeFile(file);
};

/**
 * 整檔解碼：decodeAudioData 會先以原始取樣率解出整個檔案，長音檔的峰值記憶體很高，只作為備用。
 * 只保留要上傳的格式：一小時約 115MB，若保留 48kHz 立體聲 float 則約 1.4GB。
 */
const decodeWholeFile = async (file: File): Promise<Int16Array> => {
  // 解碼時直接重新取樣成 16kHz（OfflineAudioContext 的取樣率決定 decodeAudioData 的輸出）
  const ctx = new OfflineAudioContext(1, 1, TRANSCRIBE_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());

  // 下混成單聲道並轉成 16-bit；之後只留這份資料，解碼結果即可釋放
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
  const pcm = new Int16Array(decoded.length);
  for (let i = 0; i < pcm.length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    const sample = Math.max(-1, Math.min(1, sum / channels.length));
    pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
  }
  return pcm;
};

// 結尾剩不到 1 秒時併入前一段，不單獨送出（編碼器延遲常讓長度多出幾十毫秒）
const MIN_TAIL_FRAMES = TRANSCRIBE_SAMPLE_RATE;

/**
 * Returns how many chunks of the given duration the audio splits into.
 */
export const getChunkCount = (pcm: Int16Array, chunkDurationSeconds: number): number =>
  Math.max(1, Math.ceil((pcm.length - MIN_TAIL_FRAMES) / (chunkDurationSeconds * TRANSCRIBE_SAMPLE_RATE)));

/**
 * Wraps one chunk of the decoded PCM in a WAV header.
 * Necessary because we need to send a valid file format to Gemini.
 */
export const pcmChunkToWav = (pcm: Int16Array, chunkIndex: number, chunkDurationSeconds: number): Blob => {
  const chunkFrames = chunkDurationSeconds * TRANSCRIBE_SAMPLE_RATE;
  let end = (chunkIndex + 1) * chunkFrames;
  if (pcm.length - end < MIN_TAIL_FRAMES) end = pcm.length;
  const data = pcm.subarray(chunkIndex * chunkFrames, end);
  const dataBytes = data.length * 2;

  const header = new DataView(new ArrayBuffer(44));
  const writeString = (offset: number, value: string) =>
    [...value].forEach((char, i) => header.setUint8(offset + i, char.charCodeAt(0)));
  writeString(0, 'RIFF');
  header.setUint32(4, 36 + dataBytes, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  header.setUint32(16, 16, true); // fmt chunk length
  header.setUint16(20, 1, true); // PCM (uncompressed)
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, TRANSCRIBE_SAMPLE_RATE, true);
  header.setUint32(28, TRANSCRIBE_SAMPLE_RATE * 2, true); // avg. bytes/sec
  header.setUint16(32, 2, true); // block-align
  header.setUint16(34, 16, true); // 16-bit
  writeString(36, 'data');
  header.setUint32(40, dataBytes, true);

  // Int16Array 依平台位元組序儲存；瀏覽器執行的平台皆為 little-endian，與 WAV 相同
  return new Blob([header, data], { type: 'audio/wav' });
};

/**
 * Helper to convert Blob to Base64 string for Gemini API
 */
export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

/**
 * Formats seconds into MM:SS or HH:MM:SS
 */
export const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const mStr = m.toString().padStart(2, '0');
  const sStr = s.toString().padStart(2, '0');
  
  if (h > 0) {
    return `${h}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
};

/**
 * Parses a time string (e.g. "1:30", "05:12", "1:02:03") back into total seconds.
 * Returns null if the string is not a valid time.
 */
export const parseTimeStringToSeconds = (timeStr: string): number | null => {
  const parts = timeStr.trim().split(':');
  if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.map(Number).reduce((total, part) => total * 60 + part, 0);
};

/**
 * Formats seconds into SRT timestamp format: HH:MM:SS,ms
 */
export const formatSrtTime = (seconds: number): string => {
  const totalMs = Math.floor(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(seconds);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
};

/**
 * Generates SRT formatted string from transcript segments
 */
export const generateSrtContent = (segments: TranscriptSegment[]): string => {
  return segments.map((segment, index) => {
    const nextSegment = segments[index + 1];
    // Estimate end time as start of next segment, or start + 5s if last
    const endTime = nextSegment ? nextSegment.startTimeSeconds : segment.startTimeSeconds + 5;
    
    return `${index + 1}
${formatSrtTime(segment.startTimeSeconds)} --> ${formatSrtTime(endTime)}
${segment.speaker}: ${segment.text}`;
  }).join('\n\n');
};