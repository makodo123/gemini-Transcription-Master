import { describe, it, expect } from 'vitest';
import { toPlainText, baseFileName } from '../../utils/transcriptExport';
import { TranscriptSegment } from '../../types';

const segments: TranscriptSegment[] = [
  { speaker: '王經理', timestamp: '', startTimeSeconds: 5, text: '大家好' },
  { speaker: 'John', timestamp: '', startTimeSeconds: 3723, text: 'OK' },
];

describe('toPlainText', () => {
  it('每段一行，含時間戳記', () => {
    expect(toPlainText(segments, true)).toBe('[00:05] 王經理: 大家好\n[1:02:03] John: OK');
  });

  it('可以不含時間戳記', () => {
    expect(toPlainText(segments, false)).toBe('王經理: 大家好\nJohn: OK');
  });

  it('沒有段落時是空字串', () => {
    expect(toPlainText([], true)).toBe('');
  });
});

describe('baseFileName', () => {
  it.each([
    ['meeting.mp3', 'meeting'],
    ['2026.10.29 週會.m4a', '2026.10.29 週會'],
    ['no-extension', 'no-extension'],
    [undefined, 'transcript'],
  ])('%s → %s', (input, expected) => {
    expect(baseFileName(input)).toBe(expected);
  });
});
