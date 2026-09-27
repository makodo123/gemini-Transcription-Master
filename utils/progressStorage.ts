import { TranscriptSegment } from "../types";

interface SavedProgress {
  fileName: string;
  fileSize: number;
  transcripts: TranscriptSegment[];
  processedChunks: number;
  /** 已完成的片段編號（並行轉錄時完成順序不一定連續） */
  completedChunks: number[];
  totalChunks: number;
  timestamp: number;
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
  totalChunks: number
): void => {
  try {
    const progress: SavedProgress = {
      fileName,
      fileSize,
      transcripts,
      processedChunks: completedChunks.length,
      completedChunks,
      totalChunks,
      timestamp: Date.now()
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

    return progress;
  } catch (error) {
    console.error('Failed to load progress:', error);
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
