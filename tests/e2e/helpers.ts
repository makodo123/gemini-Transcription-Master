import { test as base, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { expect };

export const CHUNK_SECONDS = 300;
export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'audio');

// ---------- 測試用音檔 ----------

/**
 * 產生 8kHz 單聲道 WAV：第 i 段（每段 5 分鐘）的音量是 (i + 1) × 0.1，
 * 假的 Gemini 依送來的音量就能認出是第幾段。
 */
export const meetingWav = (seconds = 660): string => {
  const file = path.join(os.tmpdir(), 'gtm-e2e', `meeting-${seconds}s.wav`);
  if (fs.existsSync(file)) return file;
  const rate = 8000, n = rate * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round((Math.floor(i / rate / CHUNK_SECONDS) + 1) * 0.1 * 32767), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 多個 worker 同時產生時，先寫暫存檔再改名，避免讀到寫一半的檔案
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
};

/** 從送給 Gemini 的 WAV（base64）讀出音量，換算成第幾段 */
const chunkOf = (base64: string) =>
  Math.round(Buffer.from(base64, 'base64').readInt16LE(44 + 2 * 4000) / 32767 / 0.1) - 1;

// ---------- 假的 Gemini API ----------

export interface Segment { speaker: string; timestamp: string; text: string }
export type GeminiReply =
  | Segment[]
  | { error: { code: number; message: string; status: string } }
  | 'hang'; // 不回應（模擬進行中，停止時會被取消）

export const serverError = { error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } };
export const invalidKey = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };
export const quotaExceeded = { error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } };

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class GeminiMock {
  /** 每次請求是第幾段 */
  readonly requests: number[] = [];
  handler: (chunk: number) => GeminiReply | Promise<GeminiReply> =
    chunk => [{ speaker: '講者 1', timestamp: '00:05', text: `第${chunk}段` }];
}

// ---------- 對話框 ----------

export class Dialogs {
  readonly messages: { type: string; message: string }[] = [];
  /** confirm 要回答「確定」還是「取消」 */
  answer = true;
  last() { return this.messages.at(-1)?.message ?? ''; }
}

// ---------- fixture ----------

interface OpenOptions {
  apiKey?: string | null;
  /** 預先放進 localStorage 的轉錄進度 */
  progress?: object;
}

export const test = base.extend<{ gemini: GeminiMock; dialogs: Dialogs; openApp: (options?: OpenOptions) => Promise<void> }>({
  gemini: async ({ page }, use) => {
    const mock = new GeminiMock();
    // 在本機沒有網路時可用 TAILWIND_BROWSER_JS 指向 @tailwindcss/browser 的檔案代替 CDN
    const tailwind = process.env.TAILWIND_BROWSER_JS ? fs.readFileSync(process.env.TAILWIND_BROWSER_JS, 'utf8') : null;
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('http://localhost')) return route.continue();
      if (url.includes('cdn.tailwindcss.com')) {
        return tailwind ? route.fulfill({ contentType: 'application/javascript', body: tailwind }) : route.continue();
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        const body = JSON.parse(route.request().postData() ?? '{}');
        const chunk = chunkOf(body.contents[0].parts[0].inlineData.data);
        mock.requests.push(chunk);
        const reply = await mock.handler(chunk);
        if (reply === 'hang') return; // 不回應
        if ('error' in reply) {
          return route.fulfill({ status: reply.error.code, contentType: 'application/json', body: JSON.stringify(reply) });
        }
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(reply) }] } }] }),
        });
      }
      return route.abort(); // 其他外部資源（字型等）不載入，測試結果才穩定
    });
    await use(mock);
  },

  dialogs: async ({ page }, use) => {
    const dialogs = new Dialogs();
    page.on('dialog', dialog => {
      dialogs.messages.push({ type: dialog.type(), message: dialog.message() });
      if (dialog.type() === 'beforeunload' || !dialogs.answer) dialog.dismiss();
      else dialog.accept();
    });
    await use(dialogs);
  },

  openApp: async ({ page, gemini, dialogs }, use) => {
    void gemini; void dialogs; // 確保路由與對話框處理先設定好
    await use(async ({ apiKey = 'test-key-1234', progress }: OpenOptions = {}) => {
      await page.goto('./');
      await page.evaluate(({ apiKey, progress }) => {
        localStorage.clear();
        if (apiKey) localStorage.setItem('gemini_api_key', apiKey);
        if (progress) localStorage.setItem('transcription_progress', JSON.stringify(progress));
      }, { apiKey, progress });
      await page.reload();
      await expect(page.getByText('上傳音訊檔案')).toBeVisible();
    });
  },
});

// ---------- 常用操作 ----------

export const startButton = (page: Page) => page.getByRole('button', { name: '開始轉錄' });
export const restartButton = (page: Page) => page.getByRole('button', { name: '重新轉錄' });

/** 選檔並轉錄到完成 */
export const transcribe = async (page: Page, file = meetingWav()) => {
  await page.setInputFiles('input[type=file]', file);
  await startButton(page).click();
  await expect(restartButton(page)).toBeVisible({ timeout: 60_000 });
};

export const transcriptTexts = (page: Page) => page.locator('textarea').evaluateAll(ts => ts.map(t => (t as HTMLTextAreaElement).value));
export const timeInputs = (page: Page) => page.getByLabel('開始時間');
export const timeValues = (page: Page) => timeInputs(page).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));
export const progressInStorage = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('transcription_progress') ?? 'null'));
