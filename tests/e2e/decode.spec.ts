import path from 'node:path';
import { test, expect, FIXTURES } from './helpers';

// 在真實瀏覽器裡比對「分段解碼」與瀏覽器內建的「整檔解碼」，確認內容一致、沒有缺漏或漂移。
// 用開發伺服器，才能直接載入 TypeScript 模組。
const DEV = 'http://localhost:5173/gemini-Transcription-Master/';

const compare = async (page: import('@playwright/test').Page, name: string) => {
  await page.goto(DEV);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'probe';
    document.body.append(input);
  });
  await page.setInputFiles('#probe', path.join(FIXTURES, name));
  return page.evaluate(async () => {
    // 路徑是開發伺服器上的網址，型別從原始檔取得
    const modulePath = '/gemini-Transcription-Master/utils/streamDecode.ts';
    const { decodeStreaming }: typeof import('../../utils/streamDecode') = await import(/* @vite-ignore */ modulePath);
    const file = (document.querySelector('#probe') as HTMLInputElement).files![0];
    const streamed = await decodeStreaming(file, { outputRate: 16000 });
    if (!streamed) return null;

    const decoded = await new OfflineAudioContext(1, 1, 16000).decodeAudioData(await file.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    const ref = new Float32Array(decoded.length);
    for (let i = 0; i < ref.length; i++) ref[i] = channels.reduce((sum, ch) => sum + ch[i], 0) / channels.length;
    const s = Float32Array.from(streamed, v => v / 32768);

    // 在 1 秒的視窗裡找兩者的時間差，再算相關係數
    const windowAt = (center: number) => {
      const W = 16000;
      let best = 0, bestScore = -Infinity;
      for (let lag = -3000; lag <= 3000; lag++) {
        let score = 0;
        for (let i = center; i < center + W; i += 4) { const j = i + lag; if (j >= 0 && j < s.length) score += ref[i] * s[j]; }
        if (score > bestScore) { bestScore = score; best = lag; }
      }
      let ab = 0, aa = 0, bb = 0;
      for (let i = center; i < center + W; i++) { const j = i + best; if (j < 0 || j >= s.length) continue; ab += ref[i] * s[j]; aa += ref[i] ** 2; bb += s[j] ** 2; }
      return { lag: best, corr: ab / Math.sqrt(aa * bb) };
    };
    const windows = [1, 3.5, 6].map(sec => windowAt(sec * 16000));
    let ea = 0, eb = 0;
    for (const v of ref) ea += v * v;
    for (const v of s) eb += v * v;
    return {
      lags: windows.map(w => w.lag),
      minCorr: Math.min(...windows.map(w => w.corr)),
      rmsRatio: Math.sqrt(eb / s.length / (ea / ref.length)),
      lengthDiffSeconds: (s.length - ref.length) / 16000,
    };
  });
};

for (const name of [
  'mp3-44k-stereo-cbr-id3.mp3', 'mp3-48k-mono-vbr.mp3', 'mp3-22k-mono-mpeg2.mp3', 'mp3-8k-mono-mpeg25.mp3',
  'm4a-aac-48k-stereo.m4a', 'm4a-aac-44k-mono-faststart.m4a', 'mov-aac-48k.mov',
]) {
  test(`分段解碼與整檔解碼一致：${name}`, async ({ page }) => {
    const result = await compare(page, name);
    expect(result, '這個格式應該走分段解碼').not.toBeNull();
    // 整份檔案時間差固定（只差編碼器延遲，最多一個取樣的捨入誤差），代表沒有缺漏、重複或漂移
    expect(Math.max(...result!.lags) - Math.min(...result!.lags)).toBeLessThanOrEqual(1);
    expect(Math.abs(result!.lags[0])).toBeLessThan(0.2 * 16000);
    expect(result!.minCorr).toBeGreaterThan(0.98);
    expect(result!.rmsRatio).toBeGreaterThan(0.97);
    expect(result!.rmsRatio).toBeLessThan(1.03);
    // 長度差就是編碼器延遲與結尾補白（瀏覽器會依檔案資訊扣掉，分段解碼不扣）；8kHz MP3 約 0.2 秒
    expect(Math.abs(result!.lengthDiffSeconds)).toBeLessThan(0.3);
  });
}

for (const name of ['m4a-alac.m4a', 'm4a-aac-fragmented.m4a', 'flac.flac', 'ogg-opus.ogg']) {
  test(`不支援分段解碼的格式交給整檔解碼：${name}`, async ({ page }) => {
    expect(await compare(page, name)).toBeNull();
  });
}
