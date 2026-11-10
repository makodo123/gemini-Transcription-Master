import { TranscriptSegment } from '../types';
import { CHUNK_DURATION } from '../constants';

/** 這個時間屬於第幾段（每 CHUNK_DURATION 秒一段，和送去轉錄的分段一致） */
export const chunkIndexOf = (seconds: number) => Math.max(0, Math.floor(seconds / CHUNK_DURATION));

/** 一段逐字稿的講者從 from 改成 to；復原時只改回還是 to 的段落 */
export interface SpeakerChange { id: string; from: string; to: string }

/** 第 chunk 段裡 a、b 兩位講者互換時，要改哪些段落 */
export const swapSpeakersInChunk = (segments: TranscriptSegment[], chunk: number, a: string, b: string): SpeakerChange[] =>
  a === b ? [] : segments
    .filter(s => s.failedChunk === undefined && chunkIndexOf(s.startTimeSeconds) === chunk && (s.speaker === a || s.speaker === b))
    .map(s => ({ id: s.id!, from: s.speaker, to: s.speaker === a ? b : a }));

export const applySpeakerChanges = (segments: TranscriptSegment[], changes: SpeakerChange[]): TranscriptSegment[] => {
  const next = new Map(changes.map(c => [c.id, c.to]));
  return segments.map(s => (next.has(s.id!) ? { ...s, speaker: next.get(s.id!)! } : s));
};

/** 改回原本的講者；之後又手動改過的段落保留 */
export const revertSpeakerChanges = (segments: TranscriptSegment[], changes: SpeakerChange[]): TranscriptSegment[] => {
  const byId = new Map(changes.map(c => [c.id, c]));
  return segments.map(s => {
    const change = byId.get(s.id!);
    return change && s.speaker === change.to ? { ...s, speaker: change.from } : s;
  });
};

/** 每一段的講者，依段落數由多到少（不含轉錄失敗的佔位段落） */
export const speakersByChunk = (segments: TranscriptSegment[]): Map<number, string[]> => {
  const counts = new Map<number, Map<string, number>>();
  for (const s of segments) {
    if (s.failedChunk !== undefined) continue;
    const chunk = chunkIndexOf(s.startTimeSeconds);
    const inChunk = counts.get(chunk) ?? new Map<string, number>();
    inChunk.set(s.speaker, (inChunk.get(s.speaker) ?? 0) + 1);
    counts.set(chunk, inChunk);
  }
  return new Map([...counts].map(([chunk, c]) => [chunk, [...c].sort((x, y) => y[1] - x[1]).map(([name]) => name)]));
};
