import { TranscriptSegment, SpeakerHint } from "../types";
import { validSegments } from "./segmentValidation";

interface SavedProgress {
  fileName: string;
  fileSize: number;
  transcripts: TranscriptSegment[];
  processedChunks: number;
  /** 已完成的片段編號（並行轉錄時完成順序不一定連續） */
  completedChunks: number[];
  totalChunks: number;
  timestamp: number;
  /** 這份逐字稿開始轉錄時用的講者名單；續傳沿用，名字才不會前後不一 */
  speakers?: SpeakerHint[];
}

const STORAGE_KEY = 'transcription_progress';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * 保存转录进度到 localStorage
 */
export const saveProgress = (
  fileName: string,
  fileSize: number,
  transcripts: TranscriptSegment[],
  completedChunks: number[],
  totalChunks: number,
  speakers: SpeakerHint[] = []
): void => {
  try {
    const progress: SavedProgress = {
      fileName,
      fileSize,
      transcripts,
      processedChunks: completedChunks.length,
      completedChunks,
      totalChunks,
      timestamp: Date.now(),
      speakers,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch (error) {
    console.error('Failed to save progress:', error);
  }
};

/**
 * 从 localStorage 恢复转录进度
 */
export const loadProgress = (
  fileName: string,
  fileSize: number
): SavedProgress | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;

    const progress: SavedProgress = JSON.parse(saved);
    // 格式壞掉的進度無法續傳，直接清掉
    if (!progress || !validSegments(progress.transcripts) || !Number.isInteger(progress.totalChunks)
      || typeof progress.timestamp !== 'number') {
      clearProgress();
      return null;
    }

    // 检查是否是同一个文件
    if (progress.fileName !== fileName || progress.fileSize !== fileSize) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - progress.timestamp > MAX_AGE_MS) {
      clearProgress();
      return null;
    }

    // 舊版進度只記錄「前 N 段已完成」，轉成片段編號清單
    if (!Array.isArray(progress.completedChunks)) {
      progress.completedChunks = Array.from({ length: progress.processedChunks }, (_, i) => i);
    }
    if (!Array.isArray(progress.speakers)) progress.speakers = [];

    return progress;
  } catch (error) {
    console.error('Failed to load progress:', error);
    return null;
  }
};

/**
 * 不指定檔案，看看有沒有未完成的進度（用來在頁面上提醒使用者）
 */
export const peekProgress = (): Pick<SavedProgress, 'fileName' | 'fileSize' | 'processedChunks' | 'totalChunks'> | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const progress: SavedProgress | null = JSON.parse(saved);
    return progress ? loadProgress(progress.fileName, progress.fileSize) : null;
  } catch (error) {
    console.error('Failed to read progress:', error);
    return null;
  }
};

/**
 * 清除保存的进度
 */
export const clearProgress = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.error('Failed to clear progress:', error);
  }
};
