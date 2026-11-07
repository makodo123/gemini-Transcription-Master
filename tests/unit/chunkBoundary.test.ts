import { describe, it, expect } from 'vitest';
import { keepOwnedSegments, removeBoundaryDuplicates } from '../../utils/chunkBoundary';
import { TranscriptSegment } from '../../types';

const seg = (startTimeSeconds: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment =>
  ({ speaker: 'A', timestamp: '', startTimeSeconds, text, ...extra });

describe('keepOwnedSegments', () => {
  it('只留開始時間在負責範圍內的句子（含開頭、不含結尾）', () => {
    const segments = [seg(295, '前一段的'), seg(300, '剛好在切點'), seg(450, '中間'), seg(599, '快結束'), seg(600, '下一段的')];
    expect(keepOwnedSegments(segments, 300, 600).map(s => s.text)).toEqual(['剛好在切點', '中間', '快結束']);
  });

  it('最後一段負責到結尾', () => {
    expect(keepOwnedSegments([seg(890, '前'), seg(1199, '最後')], 900, Infinity).map(s => s.text)).toEqual(['最後']);
  });
});

describe('removeBoundaryDuplicates', () => {
  it('切點附近同一句被兩段各留一次時只留一次', () => {
    const result = removeBoundaryDuplicates([seg(298, '我們下一步要討論預算'), seg(301, '我們下一步要討論預算。')], 300);
    expect(result.map(s => s.startTimeSeconds)).toEqual([298]);
  });

  it('一段只聽到半句時，保留較完整的那句', () => {
    const result = removeBoundaryDuplicates([seg(299, '下一步要討論'), seg(300, '我們下一步要討論預算的部分')], 300);
    expect(result.map(s => s.text)).toEqual(['我們下一步要討論預算的部分']);
  });

  it('不在切點附近的重複句子保留（可能真的說了兩次）', () => {
    const result = removeBoundaryDuplicates([seg(100, '我們下一步要討論預算'), seg(102, '我們下一步要討論預算')], 300);
    expect(result).toHaveLength(2);
  });

  it('很短的句子（「好」、「對」）不當成重複', () => {
    const result = removeBoundaryDuplicates([seg(299, '好的'), seg(301, '好的')], 300);
    expect(result).toHaveLength(2);
  });

  it('不同內容、或轉錄失敗的佔位段落不受影響', () => {
    const result = removeBoundaryDuplicates([
      seg(298, '第一句話的內容'),
      seg(300, '[第 2 段轉錄失敗]', { failedChunk: 1 }),
      seg(301, '第二句不同的內容'),
    ], 300);
    expect(result).toHaveLength(3);
  });
});
