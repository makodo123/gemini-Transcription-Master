// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptSegment } from '../../types';
import { chunkIndexOf, swapSpeakersInChunk, applySpeakerChanges, revertSpeakerChanges, speakersByChunk } from '../../utils/speakerSwap';
import { loadSpeakerHints, saveSpeakerHints } from '../../utils/speakerHints';

const seg = (id: string, seconds: number, speaker: string, failedChunk?: number): TranscriptSegment =>
  ({ id, speaker, timestamp: '', startTimeSeconds: seconds, text: id, failedChunk });

const segments = [
  seg('a', 10, '面試官'), seg('b', 20, '我'),
  seg('c', 300, '我'), seg('d', 320, '面試官'), seg('e', 400, '其他講者'),
  seg('f', 600, '系統', 2),
];

describe('對調講者', () => {
  it('依開始時間算出第幾段（每 5 分鐘）', () => {
    expect([0, 299.9, 300, 650].map(chunkIndexOf)).toEqual([0, 0, 1, 2]);
  });

  it('只對調那一段裡的兩位講者，其他講者與其他段不變', () => {
    const changes = swapSpeakersInChunk(segments, 1, '我', '面試官');
    expect(changes).toEqual([{ id: 'c', from: '我', to: '面試官' }, { id: 'd', from: '面試官', to: '我' }]);
    const swapped = applySpeakerChanges(segments, changes);
    expect(swapped.map(s => s.speaker)).toEqual(['面試官', '我', '面試官', '我', '其他講者', '系統']);
  });

  it('同一位講者不用對調', () => {
    expect(swapSpeakersInChunk(segments, 1, '我', '我')).toEqual([]);
  });

  it('復原只改回還沒被再改過的段落', () => {
    const changes = swapSpeakersInChunk(segments, 1, '我', '面試官');
    const edited = applySpeakerChanges(segments, changes).map(s => (s.id === 'd' ? { ...s, speaker: '王經理' } : s));
    expect(revertSpeakerChanges(edited, changes).map(s => s.speaker)).toEqual(['面試官', '我', '我', '王經理', '其他講者', '系統']);
  });

  it('列出每段的講者，依段落數由多到少，不含轉錄失敗的佔位段落', () => {
    const list = speakersByChunk([...segments, seg('g', 350, '面試官')]);
    expect(list.get(1)).toEqual(['面試官', '我', '其他講者']);
    expect(list.has(2)).toBe(false);
  });
});

describe('講者名單的保存', () => {
  beforeEach(() => localStorage.clear());

  it('存了再讀回來', () => {
    saveSpeakerHints([{ name: '面試官', role: '提問的人' }, { name: '', role: '' }]);
    expect(loadSpeakerHints()).toEqual([{ name: '面試官', role: '提問的人' }, { name: '', role: '' }]);
  });

  it('全部空白就不保存', () => {
    saveSpeakerHints([{ name: '面試官', role: '' }]);
    saveSpeakerHints([{ name: ' ', role: '' }]);
    expect(localStorage.getItem('transcription_speakers')).toBeNull();
  });

  it('壞掉的資料當成沒有', () => {
    localStorage.setItem('transcription_speakers', '{oops');
    expect(loadSpeakerHints()).toEqual([]);
    localStorage.setItem('transcription_speakers', JSON.stringify([{ name: 1 }, { name: '我', role: '' }]));
    expect(loadSpeakerHints()).toEqual([{ name: '我', role: '' }]);
  });
});
