import { describe, it, expect } from 'vitest';
import {
  parseTimeStringToSeconds,
  formatTime,
  formatSrtTime,
  generateSrtContent,
  getChunkCount,
  getChunkCountForDuration,
  pcmChunkToWav,
  isMediaFile,
  TRANSCRIBE_SAMPLE_RATE,
} from '../../utils/audioUtils';
import { TranscriptSegment } from '../../types';

const seg = (startTimeSeconds: number, text: string, speaker = 'A'): TranscriptSegment =>
  ({ speaker, timestamp: '', startTimeSeconds, text });

/** 把 SRT 拆成 [序號, 開始秒, 結束秒, 內容] */
const parseSrt = (srt: string) =>
  srt.trim().split('\n\n').map(cue => {
    const [index, times, ...text] = cue.split('\n');
    const [start, end] = times.split(' --> ').map(t => {
      const [h, m, s] = t.replace(',', '.').split(':').map(Number);
      return h * 3600 + m * 60 + s;
    });
    return { index: Number(index), start, end, text: text.join('\n') };
  });

describe('parseTimeStringToSeconds', () => {
  it.each([
    ['1:30', 90],
    ['05:12', 312],
    ['1:02:03', 3723],
    ['45', 45],
    ['00:10.5', 10.5],
    [' 1:30 ', 90],
  ])('%s → %d 秒', (input, expected) => {
    expect(parseTimeStringToSeconds(input)).toBe(expected);
  });

  it.each(['', 'abc', '1::2', '1:2:3:4', '-1:00', '1:3x'])('無效的 "%s" 回傳 null', input => {
    expect(parseTimeStringToSeconds(input)).toBeNull();
  });
});

describe('formatTime / formatSrtTime', () => {
  it('不到一小時用 MM:SS，超過用 H:MM:SS', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(90)).toBe('01:30');
    expect(formatTime(3723)).toBe('1:02:03');
  });

  it('SRT 時間含毫秒', () => {
    expect(formatSrtTime(3723.456)).toBe('01:02:03,456');
    expect(formatSrtTime(5)).toBe('00:00:05,000');
  });
});

describe('generateSrtContent', () => {
  it('依時間排序並重新編號', () => {
    const cues = parseSrt(generateSrtContent([seg(20, '後面'), seg(5, '前面')]));
    expect(cues.map(c => [c.index, c.start, c.text])).toEqual([[1, 5, 'A: 前面'], [2, 20, 'A: 後面']]);
  });

  it('顯示時間依字數估算：短句至少 1.5 秒，長句最多 7 秒', () => {
    const cues = parseSrt(generateSrtContent([seg(0, '好'), seg(100, '一'.repeat(20)), seg(200, '一'.repeat(100))]));
    expect(cues.map(c => c.end - c.start)).toEqual([1.5, 5, 7]);
  });

  it('不會超過下一句的開始時間', () => {
    const cues = parseSrt(generateSrtContent([seg(10, '一'.repeat(40)), seg(12, '下一句')]));
    expect(cues[0].end).toBe(12);
  });

  it('和下一句同一秒開始時至少顯示 0.5 秒，結束時間永遠晚於開始', () => {
    const cues = parseSrt(generateSrtContent([seg(10, '第一句'), seg(10, '第二句')]));
    expect(cues[0].end - cues[0].start).toBe(0.5);
    cues.forEach(c => expect(c.end).toBeGreaterThan(c.start));
  });

  it('空白行合併成單一換行，空白段落不輸出', () => {
    const srt = generateSrtContent([seg(0, '第一行\n\n\n第二行'), seg(5, '   '), seg(9, '  第三段  ')]);
    const cues = parseSrt(srt);
    expect(cues.map(c => c.text)).toEqual(['A: 第一行\n第二行', 'A: 第三段']);
  });

  it('格式正確，結尾有換行', () => {
    expect(generateSrtContent([seg(5, '你好', '講者 1')])).toBe('1\n00:00:05,000 --> 00:00:06,500\n講者 1: 你好\n');
  });
});

describe('段數計算', () => {
  it.each([
    [300, 1],
    [300.5, 1], // 結尾不到 1 秒併入前一段
    [302, 2],
    [0.5, 1],
    [3600.025, 12], // 編碼器延遲多出的幾十毫秒不另成一段
    [3601.5, 13],
  ])('%d 秒 → %d 段', (seconds, chunks) => {
    expect(getChunkCountForDuration(seconds, 300)).toBe(chunks);
  });

  it('getChunkCount 與 getChunkCountForDuration 一致', () => {
    const pcm = new Int16Array(Math.round(302 * TRANSCRIBE_SAMPLE_RATE));
    expect(getChunkCount(pcm, 300)).toBe(getChunkCountForDuration(302, 300));
  });
});

describe('pcmChunkToWav', () => {
  const readWav = async (blob: Blob) => {
    const view = new DataView(await blob.arrayBuffer());
    const text = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
    return {
      riff: text(0), wave: text(8), fmt: text(12), data: text(36),
      format: view.getUint16(20, true), channels: view.getUint16(22, true),
      sampleRate: view.getUint32(24, true), byteRate: view.getUint32(28, true),
      bits: view.getUint16(34, true), dataBytes: view.getUint32(40, true),
      riffSize: view.getUint32(4, true), totalBytes: view.byteLength,
      firstSample: view.getInt16(44, true),
    };
  };

  it('產生 16kHz 單聲道 16-bit 的 WAV 標頭', async () => {
    const pcm = new Int16Array(TRANSCRIBE_SAMPLE_RATE * 2).fill(1234);
    const wav = await readWav(pcmChunkToWav(pcm, 0, 1));
    expect(wav).toMatchObject({
      riff: 'RIFF', wave: 'WAVE', fmt: 'fmt ', data: 'data',
      format: 1, channels: 1, sampleRate: 16000, byteRate: 32000, bits: 16,
      dataBytes: 32000, riffSize: 36 + 32000, totalBytes: 44 + 32000, firstSample: 1234,
    });
  });

  it('切出指定的那一段', async () => {
    const pcm = new Int16Array(TRANSCRIBE_SAMPLE_RATE * 3);
    pcm.fill(7, TRANSCRIBE_SAMPLE_RATE, TRANSCRIBE_SAMPLE_RATE * 2);
    const wav = await readWav(pcmChunkToWav(pcm, 1, 1));
    expect(wav.firstSample).toBe(7);
    expect(wav.dataBytes).toBe(TRANSCRIBE_SAMPLE_RATE * 2);
  });

  it('結尾不到 1 秒併入最後一段', async () => {
    const pcm = new Int16Array(TRANSCRIBE_SAMPLE_RATE * 2.5);
    expect(getChunkCount(pcm, 1)).toBe(2);
    const wav = await readWav(pcmChunkToWav(pcm, 1, 1));
    expect(wav.dataBytes).toBe(TRANSCRIBE_SAMPLE_RATE * 1.5 * 2);
  });
});

describe('isMediaFile', () => {
  it.each([
    ['meeting.mp3', 'audio/mpeg'],
    ['zoom.mp4', 'video/mp4'],
    ['memo.m4a', ''], // 有些系統不給 m4a 類型
    ['voice.OPUS', ''],
    ['clip.mov', 'video/quicktime'],
  ])('%s（%s）可以使用', (name, type) => {
    expect(isMediaFile(new File([], name, { type }))).toBe(true);
  });

  it.each([
    ['notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['photo.jpg', 'image/jpeg'],
    ['readme', ''],
  ])('%s 不能使用', (name, type) => {
    expect(isMediaFile(new File([], name, { type }))).toBe(false);
  });
});
