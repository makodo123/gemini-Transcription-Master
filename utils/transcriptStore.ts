import { TranscriptSegment } from '../types';
import { validSegments } from './segmentValidation';

/** 自動保存的最後一份逐字稿：瀏覽器當掉或關掉頁面後還能找回 */
export interface SavedTranscript {
  fileName: string;
  fileSize: number;
  transcripts: TranscriptSegment[];
  savedAt: number;
}

const STORAGE_KEY = 'transcription_last';
// 共用電腦上不要一直留著別人的逐字稿
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const saveLastTranscript = (fileName: string, fileSize: number, transcripts: TranscriptSegment[]): void => {
  try {
    const saved: SavedTranscript = { fileName, fileSize, transcripts, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch (error) {
    // 空間不足等情況：不影響使用，只是沒有自動保存
    console.error('Failed to save transcript:', error);
  }
};

export const loadLastTranscript = (): SavedTranscript | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const parsed: SavedTranscript = JSON.parse(saved);
    const transcripts = validSegments(parsed?.transcripts);
    // 過期或格式壞掉：刪掉，不再提示找回
    if (!transcripts || typeof parsed.fileName !== 'string' || typeof parsed.fileSize !== 'number'
      || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      clearLastTranscript();
      return null;
    }
    return transcripts.length > 0 ? parsed : null;
  } catch (error) {
    console.error('Failed to load transcript:', error);
    return null;
  }
};

export const clearLastTranscript = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear transcript:', error);
  }
};
