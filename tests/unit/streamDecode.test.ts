import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeStreaming, scanMp3, scanMp4 } from '../../utils/streamDecode';

const OUT = 16000;
const fixture = (name: string) =>
  new File([readFileSync(new URL(`../fixtures/audio/${name}`, import.meta.url))], name);

interface WavSpec {
  rate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32;
  float?: boolean;
  seconds: number;
  /** 第 c 聲道第 i 個樣本的值（-1 到 1） */
  sample: (c: number, i: number) => number;
}

/** 依規格產生 WAV 檔，用來測 WAV 分段讀取 */
const makeWav = ({ rate, channels, bits, float = false, seconds, sample }: WavSpec): File => {
  const frames = Math.round(rate * seconds);
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + frames * blockAlign);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, 36 + frames * blockAlign, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true); view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bits, true);
  text(36, 'data'); view.setUint32(40, frames * blockAlign, true);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const offset = 44 + i * blockAlign + c * bytesPerSample;
      const v = sample(c, i);
      if (float) view.setFloat32(offset, v, true);
      else if (bits === 8) view.setUint8(offset, Math.round(v * 127) + 128);
      else if (bits === 16) view.setInt16(offset, Math.round(v * 32767), true);
      else if (bits === 24) { const x = Math.round(v * 8388607); view.setUint8(offset, x & 255); view.setUint8(offset + 1, (x >> 8) & 255); view.setUint8(offset + 2, (x >> 16) & 255); }
      else view.setInt32(offset, Math.round(v * 2147483647), true);
    }
  }
  return new File([buffer], 'test.wav');
};

/** 取中段的平均值（避開開頭與結尾的濾波過渡） */
const middleMean = (pcm: Int16Array) => {
  const from = Math.floor(pcm.length * 0.25), to = Math.floor(pcm.length * 0.75);
  let sum = 0;
  for (let i = from; i < to; i++) sum += pcm[i];
  return sum / (to - from) / 32768;
};

describe('decodeStreaming：WAV 直接分段讀取', () => {
  it.each([
    { rate: 16000, label: '16kHz 原樣' },
    { rate: 48000, label: '48kHz 降頻' },
    { rate: 44100, label: '44.1kHz 降頻' },
    { rate: 8000, label: '8kHz 升頻' },
  ])('$label：長度正確，音量不變', async ({ rate }) => {
    const pcm = await decodeStreaming(makeWav({ rate, channels: 1, bits: 16, seconds: 2, sample: () => 0.25 }), { outputRate: OUT });
    expect(pcm).not.toBeNull();
    expect(Math.abs(pcm!.length - 2 * OUT)).toBeLessThanOrEqual(1);
    expect(middleMean(pcm!)).toBeCloseTo(0.25, 2);
  });

  it.each([
    { bits: 8 as const }, { bits: 24 as const }, { bits: 32 as const }, { bits: 32 as const, float: true },
  ])('支援 $bits-bit（float: $float）', async spec => {
    const pcm = await decodeStreaming(makeWav({ rate: 16000, channels: 1, seconds: 1, sample: () => -0.5, ...spec }), { outputRate: OUT });
    expect(middleMean(pcm!)).toBeCloseTo(-0.5, 1);
  });

  it('立體聲平均成單聲道', async () => {
    const pcm = await decodeStreaming(makeWav({ rate: 48000, channels: 2, bits: 16, seconds: 1, sample: c => (c === 0 ? 0.5 : 0) }), { outputRate: OUT });
    expect(middleMean(pcm!)).toBeCloseTo(0.25, 2);
  });

  it('跨越多個讀取區塊時沒有接縫', async () => {
    // 每個區塊 2^20 個樣本；這個檔案約 1.5 個區塊，接縫附近的值要和其他地方一樣
    const pcm = await decodeStreaming(makeWav({ rate: 48000, channels: 1, bits: 16, seconds: 33, sample: () => 0.3 }), { outputRate: OUT });
    const seam = Math.round((1 << 20) / 3);
    for (let i = seam - 50; i < seam + 50; i++) expect(Math.abs(pcm![i] / 32768 - 0.3)).toBeLessThan(0.01);
  });

  it('回報進度，最後到 100%', async () => {
    const progress: number[] = [];
    await decodeStreaming(makeWav({ rate: 48000, channels: 1, bits: 16, seconds: 25, sample: () => 0 }), { outputRate: OUT, onProgress: p => progress.push(p) });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
  });

  it('中止時拋出 AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(decodeStreaming(makeWav({ rate: 16000, channels: 1, bits: 16, seconds: 1, sample: () => 0 }), { outputRate: OUT, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('不支援的 WAV 編碼回傳 null（交給整檔解碼）', async () => {
    const file = makeWav({ rate: 16000, channels: 1, bits: 16, seconds: 0.1, sample: () => 0 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    new DataView(bytes.buffer).setUint16(20, 2, true); // ADPCM
    expect(await decodeStreaming(new File([bytes], 'adpcm.wav'), { outputRate: OUT })).toBeNull();
  });

  it('沒有 WebCodecs 的環境，壓縮格式回傳 null（交給整檔解碼）', async () => {
    expect(typeof (globalThis as { AudioDecoder?: unknown }).AudioDecoder).toBe('undefined');
    expect(await decodeStreaming(fixture('mp3-48k-mono-vbr.mp3'), { outputRate: OUT })).toBeNull();
  });
});

/** 音框要首尾相接、都在檔案範圍內 */
const expectContiguous = (offsets: number[], sizes: number[], fileSize: number) => {
  for (let i = 1; i < offsets.length; i++) expect(offsets[i]).toBe(offsets[i - 1] + sizes[i - 1]);
  expect(offsets.at(-1)! + sizes.at(-1)!).toBeLessThanOrEqual(fileSize);
};

describe('scanMp3', () => {
  // 預期音框數由 ffprobe 計算（不含 Xing/Info 標頭音框）
  it.each([
    ['mp3-44k-stereo-cbr-id3.mp3', 44100, 2, 308, 1152],
    ['mp3-48k-mono-vbr.mp3', 48000, 1, 335, 1152],
    ['mp3-22k-mono-mpeg2.mp3', 22050, 1, 309, 576],
    ['mp3-8k-mono-mpeg25.mp3', 8000, 1, 114, 576],
  ])('%s', async (name, sampleRate, channels, frames, samplesPerFrame) => {
    const file = fixture(name);
    const table = await scanMp3(file);
    expect(table).not.toBeNull();
    expect(table!.config).toEqual({ codec: 'mp3', sampleRate, numberOfChannels: channels });
    expect(table!.offsets.length).toBe(frames);
    expect(table!.durationSeconds).toBeCloseTo((frames * samplesPerFrame) / sampleRate, 5);
    expectContiguous(table!.offsets, table!.sizes, file.size);
  });

  it('跳過開頭的 ID3 標籤', async () => {
    const file = fixture('mp3-44k-stereo-cbr-id3.mp3');
    const head = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    expect(String.fromCharCode(...head)).toBe('ID3');
    const table = await scanMp3(file);
    const first = new Uint8Array(await file.slice(table!.offsets[0], table!.offsets[0] + 2).arrayBuffer());
    expect(first[0]).toBe(0xff);
    expect(first[1] & 0xe0).toBe(0xe0);
  });

  it.each(['flac.flac', 'ogg-opus.ogg', 'm4a-aac-48k-stereo.m4a'])('不是 MP3 的 %s 回傳 null', async name => {
    expect(await scanMp3(fixture(name))).toBeNull();
  });
});

describe('scanMp4', () => {
  it.each([
    ['m4a-aac-48k-stereo.m4a', 48000, 2, 376],
    ['m4a-aac-44k-mono-faststart.m4a', 44100, 1, 346],
    ['mov-aac-48k.mov', 48000, 1, 376],
  ])('%s', async (name, sampleRate, channels, frames) => {
    const file = fixture(name);
    const table = await scanMp4(file);
    expect(table).not.toBeNull();
    expect(table!.config).toMatchObject({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels });
    expect((table!.config.description as Uint8Array).length).toBeGreaterThanOrEqual(2);
    expect(table!.offsets.length).toBe(frames);
    expect(table!.durationSeconds).toBeGreaterThan(7.9);
    expect(table!.durationSeconds).toBeLessThan(8.2);
    expectContiguous(table!.offsets, table!.sizes, file.size);
  });

  it.each([
    ['m4a-alac.m4a', 'ALAC 編碼'],
    ['m4a-aac-fragmented.m4a', '分段式 MP4'],
    ['mp3-48k-mono-vbr.mp3', '不是 MP4'],
  ])('%s（%s）回傳 null，交給整檔解碼', async name => {
    expect(await scanMp4(fixture(name))).toBeNull();
  });
});
