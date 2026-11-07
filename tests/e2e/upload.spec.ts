import fs from 'node:fs';
import { test, expect, meetingWav, transcribe, startButton, sleep } from './helpers';

test.describe('首次開啟', () => {
  test('沒有 API Key 時：醒目的「設定 API Key」、使用步驟與隱私說明', async ({ page, openApp }) => {
    await openApp({ apiKey: null });
    await expect(page.getByRole('button', { name: '設定 API Key' })).toBeVisible();
    await expect(page.getByText('使用步驟')).toBeVisible();
    await expect(page.getByText('直接傳送給 Google Gemini 轉錄')).toBeVisible();
    await expect(startButton(page)).toBeDisabled();
  });
});

test.describe('選擇音檔', () => {
  test('拖曳到上傳區可以選檔；拖到上傳區外放開不會離開頁面', async ({ page, openApp }) => {
    await openApp();
    const bytes = fs.readFileSync(meetingWav()).subarray(0, 44 + 16000).toString('base64');
    const dataTransfer = await page.evaluateHandle(b64 => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.wav', { type: 'audio/wav' }));
      return dt;
    }, bytes);
    const zone = page.getByRole('button', { name: '選擇音檔' });
    await zone.dispatchEvent('dragover', { dataTransfer });
    await zone.dispatchEvent('drop', { dataTransfer });
    await expect(page.getByText('dropped.wav')).toBeVisible();

    const url = page.url();
    await page.locator('h1').dispatchEvent('drop', { dataTransfer });
    expect(page.url()).toBe(url);
  });

  test('可以只用鍵盤選檔', async ({ page, openApp }) => {
    await openApp();
    await page.getByRole('button', { name: '選擇音檔' }).focus();
    const chooser = page.waitForEvent('filechooser');
    await sleep(300); // 等 Playwright 開始攔截檔案選擇視窗
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(meetingWav());
    await expect(page.getByText(/meeting-660s\.wav/)).toBeVisible();
  });

  test('顯示長度與段數；轉錄過一次後顯示預估時間', async ({ page, openApp }) => {
    await openApp();
    await page.setInputFiles('input[type=file]', meetingWav());
    await expect(page.getByText(/長度 11:00・會分成 3 段/)).toBeVisible();
    await expect(page.getByText('第一次轉錄完成後，這裡會依您的轉錄速度顯示預估時間')).toBeVisible();

    await startButton(page).click();
    await expect(page.getByRole('button', { name: '重新轉錄' })).toBeVisible();
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem('transcription_speed') ?? 'null'));
    expect(history.secondsPerChunk).toBeGreaterThan(0);

    await page.setInputFiles('input[type=file]', meetingWav(900));
    await expect(page.getByText(/會分成 3 段/)).toBeVisible();
    await expect(page.getByText(/預估需要(不到 1 分鐘|約 \d+ 分鐘)（依您上次在這台裝置的轉錄速度估算）/)).toBeVisible();
  });

  test('轉錄中不能換檔', async ({ page, openApp, gemini }) => {
    gemini.handler = () => 'hang';
    await openApp();
    await page.setInputFiles('input[type=file]', meetingWav());
    await startButton(page).click();
    await expect(page.getByText(/轉錄中：/)).toBeVisible();
    await expect(page.locator('input[type=file]')).toBeDisabled();
    await page.getByRole('button', { name: '停止轉錄' }).click();
  });

  test('結尾不到 1 秒不會多送一段', async ({ page, openApp, gemini }) => {
    await openApp();
    await transcribe(page, meetingWav(600.5));
    expect(gemini.requests.sort()).toEqual([0, 1]);
  });
});
