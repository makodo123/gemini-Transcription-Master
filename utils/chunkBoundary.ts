import { TranscriptSegment } from '../types';

/** 只留開始時間落在這段負責範圍內的句子；重疊部分的句子由相鄰那段負責 */
export const keepOwnedSegments = (segments: TranscriptSegment[], ownStart: number, ownEnd: number): TranscriptSegment[] =>
  segments.filter(s => s.startTimeSeconds >= ownStart && s.startTimeSeconds < ownEnd);

// 切點前後幾秒內的句子才檢查重複（模型標的時間可能差一兩秒，同一句會被兩段各留一次）
const BOUNDARY_WINDOW_SECONDS = 4;
// 太短的句子（「好」、「對」）重複出現很正常，不當成重複
const MIN_DUPLICATE_LENGTH = 4;

const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '');

const nearBoundary = (seconds: number, chunkDuration: number) => {
  const boundary = Math.round(seconds / chunkDuration) * chunkDuration;
  return boundary > 0 && Math.abs(seconds - boundary) <= BOUNDARY_WINDOW_SECONDS;
};

/**
 * 移除切點附近、前後兩段都轉到的同一句：內容相同或一句包含另一句時，保留較完整的那句。
 * segments 需已依時間排序。
 */
export const removeBoundaryDuplicates = (segments: TranscriptSegment[], chunkDuration: number): TranscriptSegment[] => {
  const result: TranscriptSegment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.failedChunk === undefined && segment.failedChunk === undefined &&
      nearBoundary(previous.startTimeSeconds, chunkDuration) && nearBoundary(segment.startTimeSeconds, chunkDuration)
    ) {
      const a = normalize(previous.text), b = normalize(segment.text);
      if (Math.min(a.length, b.length) >= MIN_DUPLICATE_LENGTH && (a.includes(b) || b.includes(a))) {
        if (b.length > a.length) result[result.length - 1] = segment;
        continue;
      }
    }
    result.push(segment);
  }
  return result;
};
