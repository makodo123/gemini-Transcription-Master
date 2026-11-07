import fs from 'node:fs';
import { Page } from '@playwright/test';
import { test, expect, meetingWav, transcribe, startButton, restartButton, transcriptTexts, serverError } from './helpers';

const download = async (page: Page, button: string) => {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: button }).click();
  return fs.readFileSync((await (await pending).path())!, 'utf8');
};

const toSeconds = (t: string) => {
  const [h, m, s] = t.replace(',', '.').split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

test('SRT：依時間排序、每條字幕 1.5–7 秒且不超過下一句', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => [
    { speaker: 'A', timestamp: '00:05', text: `第${chunk}段的開場，這一句比較長一點，用來測試字幕顯示時間會不會依字數調整。` },
    { speaker: 'B', timestamp: '01:00', text: '好' },
  ];
  await openApp();
  await transcribe(page);
  const second = page.getByLabel('開始時間').nth(1);
  await second.fill('20:00');
  await second.press('Enter');
  await page.locator('textarea').first().fill('第一行\n\n\n第二行');

  const cues = (await download(page, '下載 SRT 字幕')).trim().split('\n\n').map(c => c.split('\n'));
  const spans = cues.map(c => c[1].split(' --> ').map(toSeconds));
  expect(cues.map(c => Number(c[0]))).toEqual([1, 2, 3, 4, 5, 6]);
  spans.forEach(([start, end], i) => {
    expect(end - start).toBeGreaterThanOrEqual(1.5);
    expect(end - start).toBeLessThanOrEqual(7);
    if (i > 0) expect(start).toBeGreaterThanOrEqual(spans[i - 1][0]);
    if (i < spans.length - 1) expect(end).toBeLessThanOrEqual(spans[i + 1][0]);
  });
  expect(cues[0].slice(2)).toEqual(['A: 第一行', '第二行']);
});

test('下載時略過轉錄失敗的段落，並先提醒', async ({ page, openApp, gemini, dialogs }) => {
  gemini.handler = chunk => (chunk === 1 ? serverError : [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }]);
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByRole('button', { name: /重試失敗的 1 段/ })).toBeVisible({ timeout: 60_000 });

  const txt = await download(page, '下載 TXT');
  expect(dialogs.last()).toContain('還有 1 段轉錄失敗');
  expect(txt).toBe('[00:05] A: 第0段\n[10:05] A: 第2段');

  const srt = await download(page, '下載 SRT 字幕');
  expect(srt).not.toContain('轉錄失敗');
  expect(srt.trim().split('\n\n')).toHaveLength(2);
});

test('TXT 可以不含時間戳記', async ({ page, openApp }) => {
  await openApp();
  await transcribe(page);
  await page.getByLabel('TXT 與複製含時間戳記').uncheck();
  expect(await download(page, '下載 TXT')).toBe('講者 1: 第0段\n講者 1: 第1段\n講者 1: 第2段');
});

test.describe('防止誤刪還沒下載的逐字稿', () => {
  test('重新轉錄、換檔前先確認，取消就什麼都不變', async ({ page, openApp, gemini, dialogs }) => {
    await openApp();
    await transcribe(page);
    dialogs.answer = false;
    const before = gemini.requests.length;

    await restartButton(page).click();
    await expect.poll(() => dialogs.last()).toContain('重新轉錄會清除目前的逐字稿，並重新使用 API 額度');
    expect(await transcriptTexts(page)).toHaveLength(3);
    expect(gemini.requests.length).toBe(before);

    await page.setInputFiles('input[type=file]', meetingWav(900));
    await expect.poll(() => dialogs.last()).toContain('換成新的檔案會清除目前的逐字稿');
    await expect(page.getByText(/meeting-660s\.wav/)).toBeVisible();
    expect(await transcriptTexts(page)).toHaveLength(3);
  });

  test('關閉頁面前提醒', async ({ page, openApp, dialogs }) => {
    await openApp();
    await transcribe(page);
    await page.close({ runBeforeUnload: true });
    await expect.poll(() => dialogs.messages.some(d => d.type === 'beforeunload')).toBe(true);
  });

  test('下載過就不再問', async ({ page, openApp, gemini, dialogs }) => {
    await openApp();
    await transcribe(page);
    await download(page, '下載 TXT');
    const asked = dialogs.messages.length;
    await restartButton(page).click();
    await expect(restartButton(page)).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => gemini.requests.length).toBe(6);
    expect(dialogs.messages.length).toBe(asked);
  });
});
