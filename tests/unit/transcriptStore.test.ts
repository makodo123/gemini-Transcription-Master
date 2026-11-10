// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveLastTranscript, loadLastTranscript, clearLastTranscript } from '../../utils/transcriptStore';

const segments = [{ id: 'a', speaker: 'A', timestamp: '00:01', startTimeSeconds: 1, text: '第一段' }];

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('transcriptStore', () => {
  it('保存後可以讀回，包含檔名、大小與時間', () => {
    saveLastTranscript('meeting.mp3', 1000, segments);
    expect(loadLastTranscript()).toMatchObject({ fileName: 'meeting.mp3', fileSize: 1000, transcripts: segments });
    expect(loadLastTranscript()!.savedAt).toBeGreaterThan(0);
  });

  it('沒有保存、空的或壞掉的資料都回傳 null', () => {
    expect(loadLastTranscript()).toBeNull();
    saveLastTranscript('x.mp3', 1, []);
    expect(loadLastTranscript()).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('transcription_last', '{broken');
    expect(loadLastTranscript()).toBeNull();
  });

  it('可以刪除', () => {
    saveLastTranscript('meeting.mp3', 1000, segments);
    clearLastTranscript();
    expect(loadLastTranscript()).toBeNull();
  });
});

describe('transcriptStore 保存期限', () => {
  it('超過 7 天自動刪除', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    saveLastTranscript('meeting.mp3', 1000, segments);
    vi.setSystemTime(new Date('2026-01-07T23:00:00Z'));
    expect(loadLastTranscript()).not.toBeNull();
    vi.setSystemTime(new Date('2026-01-08T00:00:01Z'));
    expect(loadLastTranscript()).toBeNull();
    expect(localStorage.getItem('transcription_last')).toBeNull();
  });
});

describe('transcriptStore 壞掉的資料', () => {
  const put = (value: unknown) => localStorage.setItem('transcription_last', JSON.stringify(value));
  it.each([
    ['段落是 null', { fileName: 'a.mp3', fileSize: 1, savedAt: Date.now(), transcripts: [null] }],
    ['時間不是數字', { fileName: 'a.mp3', fileSize: 1, savedAt: Date.now(), transcripts: [{ speaker: 'A', text: 't', startTimeSeconds: 'x' }] }],
    ['沒有檔名', { savedAt: Date.now(), transcripts: segments }],
    ['整份是 null', null],
  ])('%s：當作沒有，並清掉', (_, value) => {
    put(value);
    expect(loadLastTranscript()).toBeNull();
    expect(localStorage.getItem('transcription_last')).toBeNull();
  });
});
