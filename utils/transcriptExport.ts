import { TranscriptSegment } from '../types';
import { formatTime } from './audioUtils';

/** 轉成純文字：每段一行，可選擇是否加上 [MM:SS] 時間 */
export const toPlainText = (segments: TranscriptSegment[], includeTimestamps: boolean): string =>
  segments
    .map(t => `${includeTimestamps ? `[${formatTime(t.startTimeSeconds)}] ` : ''}${t.speaker}: ${t.text}`)
    .join('\n');

/** 下載檔名沿用音檔名稱（去掉副檔名） */
export const baseFileName = (fileName: string | undefined): string => {
  if (!fileName) return 'transcript';
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? fileName : fileName.substring(0, lastDot);
};

/** 讓瀏覽器下載一個 UTF-8 文字檔 */
export const downloadText = (fileName: string, content: string): void => {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
};
