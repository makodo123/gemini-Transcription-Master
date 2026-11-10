import { TranscriptSegment } from '../types';

/** 從瀏覽器儲存讀回的段落要先檢查格式：資料可能是舊版、或被其他程式改壞 */
export const isValidSegment = (value: unknown): value is TranscriptSegment => {
  const s = value as TranscriptSegment | null;
  return !!s && typeof s === 'object'
    && typeof s.speaker === 'string'
    && typeof s.text === 'string'
    && typeof s.startTimeSeconds === 'number' && Number.isFinite(s.startTimeSeconds)
    && (s.id === undefined || typeof s.id === 'string')
    && (s.failedChunk === undefined || Number.isInteger(s.failedChunk));
};

/** 全部段落格式正確才採用；壞掉一段就整份不用，避免顯示殘缺的逐字稿 */
export const validSegments = (value: unknown): TranscriptSegment[] | null =>
  Array.isArray(value) && value.every(isValidSegment) ? value : null;
