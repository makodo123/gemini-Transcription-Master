// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveLastTranscript, loadLastTranscript, clearLastTranscript } from '../../utils/transcriptStore';

const segments = [{ id: 'a', speaker: 'A', timestamp: '00:01', startTimeSeconds: 1, text: '第一段' }];

beforeEach(() => localStorage.clear());

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
