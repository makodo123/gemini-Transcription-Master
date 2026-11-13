import { test as base, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHUNK_OVERLAP } from '../../constants';

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

/** 從送給 Gemini 的 WAV（base64）讀出音量，換算成第幾段；讀中間的樣本，避開前後與相鄰段重疊的部分 */
const chunkOf = (base64: string) => {
  const wav = Buffer.from(base64, 'base64');
  const middle = 44 + 2 * Math.floor((wav.length - 44) / 4);
  return Math.round(wav.readInt16LE(middle) / 32767 / 0.1) - 1;
};

/**
 * 真正的 Gemini 從送出的音訊開頭算時間，而第 2 段起前面多了 CHUNK_OVERLAP 秒。
 * 測試裡的時間寫成「從這段負責範圍開頭算」比較直觀，送回前在這裡補上那幾秒。
 */
const shiftTimestamp = (timestamp: string, seconds: number) => {
  const parts = timestamp.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length < 2) return timestamp;
  const total = parts.reduce((sum, part) => sum * 60 + part, 0) + seconds;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

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
  /** 每次請求用的模型 */
  readonly models: string[] = [];
  /** 每次請求給模型的指示 */
  readonly prompts: string[] = [];
  /** 這組 API Key 列得出的模型；listError 設定時列模型會失敗 */
  available = ['gemini-3-flash-preview', 'gemini-2.5-flash'];
  listError: { error: { code: number; message: string; status: string } } | null = null;
  /** 這些模型會回 404（模擬已停用） */
  retired: string[] = [];
  /** 這些模型會把音訊擋下（沒有內容，blockReason=OTHER） */
  blocked: string[] = [];
  /** 每段送出的音訊長度（秒） */
  readonly audioSeconds: Record<number, number> = {};
  /** false：handler 回傳的時間已是「從送出的音訊開頭算」，不再補上重疊秒數 */
  shiftTimestamps = true;
  handler: (chunk: number) => GeminiReply | Promise<GeminiReply> =
    chunk => [{ speaker: '講者 1', timestamp: '00:05', text: `第${chunk}段` }];
}

// ---------- 對話框 ----------

export class Dialogs {
  readonly messages: { type: string; message: string }[] = [];
  /** confirm 要回答「確定」還是「取消」 */
  answer = true;
  /** 離開頁面的提醒要回答「離開」（重新整理頁面時需要），預設留在頁面 */
  allowLeave = false;
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
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('http://localhost')) return route.continue();
      if (url.includes('generativelanguage.googleapis.com') && route.request().method() === 'GET') {
        // 列出模型：驗證 API Key、模型停用時找替代模型
        if (mock.listError) return route.fulfill({ status: mock.listError.error.code, contentType: 'application/json', body: JSON.stringify(mock.listError) });
        return route.fulfill({
          contentType: 'application/json',
          // 真正的 REST API 回傳 supportedGenerationMethods，SDK 會轉成 supportedActions
          body: JSON.stringify({ models: mock.available.map(name => ({ name: `models/${name}`, supportedGenerationMethods: ['generateContent'] })) }),
        });
      }
      if (url.includes('generativelanguage.googleapis.com')) {
        const model = url.match(/models\/([^:]+):generateContent/)?.[1] ?? '';
        mock.models.push(model);
        if (mock.retired.includes(model)) {
          const error = { error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: 'NOT_FOUND' } };
          return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify(error) });
        }
        if (mock.blocked.includes(model)) {
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ promptFeedback: { blockReason: 'OTHER' } }) });
        }
        const body = JSON.parse(route.request().postData() ?? '{}');
        const audio = body.contents[0].parts[0].inlineData.data;
        const chunk = chunkOf(audio);
        mock.requests.push(chunk);
        mock.prompts.push(body.contents[0].parts[1]?.text ?? '');
        mock.audioSeconds[chunk] = (Buffer.from(audio, 'base64').length - 44) / 2 / 16000;
        const reply = await mock.handler(chunk);
        if (reply === 'hang') return; // 不回應
        if ('error' in reply) {
          return route.fulfill({ status: reply.error.code, contentType: 'application/json', body: JSON.stringify(reply) });
        }
        const shifted = chunk > 0 && mock.shiftTimestamps ? reply.map(s => ({ ...s, timestamp: shiftTimestamp(s.timestamp, CHUNK_OVERLAP) })) : reply;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(shifted) }] } }] }),
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
      if (dialog.type() === 'beforeunload') {
        if (dialogs.allowLeave) dialog.accept();
        else dialog.dismiss();
      } else if (!dialogs.answer) dialog.dismiss();
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
      await expect(page.getByRole('heading', { name: '上傳錄音' })).toBeVisible();
    });
  },
});

// ---------- 常用操作 ----------

export const startButton = (page: Page) => page.getByRole('button', { name: '開始轉錄' });
export const continueButton = (page: Page) => page.getByRole('button', { name: '繼續轉錄' });
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
