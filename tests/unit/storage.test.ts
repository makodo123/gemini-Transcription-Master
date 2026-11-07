// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveProgress, loadProgress, peekProgress, clearProgress } from '../../utils/progressStorage';
import { saveSpeedHistory, loadSpeedHistory } from '../../utils/speedHistory';
import { TranscriptSegment } from '../../types';

const segments: TranscriptSegment[] = [{ id: 'a', speaker: 'A', timestamp: '00:01', startTimeSeconds: 1, text: '第一段' }];

beforeEach(() => localStorage.clear());
afterEach(() => vi.useRealTimers());

describe('progressStorage', () => {
  it('同一個檔案可以讀回進度', () => {
    saveProgress('meeting.mp3', 1000, segments, [0, 2], 3);
    expect(loadProgress('meeting.mp3', 1000)).toMatchObject({
      fileName: 'meeting.mp3', transcripts: segments, completedChunks: [0, 2], processedChunks: 2, totalChunks: 3,
    });
  });

  it('檔名或大小不同時不算同一個檔案', () => {
    saveProgress('meeting.mp3', 1000, segments, [0], 3);
    expect(loadProgress('meeting.mp3', 999)).toBeNull();
    expect(loadProgress('other.mp3', 1000)).toBeNull();
  });

  it('超過 24 小時的進度會失效並被清除', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    saveProgress('meeting.mp3', 1000, segments, [0], 3);
    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'));
    expect(loadProgress('meeting.mp3', 1000)).toBeNull();
    expect(localStorage.getItem('transcription_progress')).toBeNull();
  });

  it('舊版只記錄「前 N 段已完成」的進度會轉成段落編號', () => {
    localStorage.setItem('transcription_progress', JSON.stringify({
      fileName: 'old.mp3', fileSize: 5, transcripts: segments, processedChunks: 2, totalChunks: 4, timestamp: Date.now(),
    }));
    expect(loadProgress('old.mp3', 5)?.completedChunks).toEqual([0, 1]);
  });

  it('peekProgress 不必指定檔案就能看到未完成的進度', () => {
    expect(peekProgress()).toBeNull();
    saveProgress('meeting.mp3', 1000, segments, [0], 3);
    expect(peekProgress()).toMatchObject({ fileName: 'meeting.mp3', fileSize: 1000, processedChunks: 1, totalChunks: 3 });
    clearProgress();
    expect(peekProgress()).toBeNull();
  });

  it('壞掉的資料不會讓頁面出錯', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('transcription_progress', '{not json');
    expect(peekProgress()).toBeNull();
    expect(loadProgress('x', 1)).toBeNull();
  });
});

describe('speedHistory', () => {
  it('存取轉錄速度', () => {
    expect(loadSpeedHistory()).toBeNull();
    saveSpeedHistory({ secondsPerChunk: 4.2, decodeSecondsPerAudioSecond: 0.01 });
    expect(loadSpeedHistory()).toEqual({ secondsPerChunk: 4.2, decodeSecondsPerAudioSecond: 0.01 });
  });

  it('不合理的紀錄不採用', () => {
    localStorage.setItem('transcription_speed', JSON.stringify({ secondsPerChunk: 0, decodeSecondsPerAudioSecond: 0.01 }));
    expect(loadSpeedHistory()).toBeNull();
  });
});
