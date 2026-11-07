import fs from 'node:fs';
import os from 'node:os';
import { test, expect, meetingWav, transcribe, startButton, transcriptTexts, invalidKey, FIXTURES } from './helpers';
import path from 'node:path';

test('預設模型停用時自動改用替代模型，轉錄照常完成', async ({ page, openApp, gemini }) => {
  gemini.retired = ['gemini-3-flash-preview'];
  gemini.available = ['gemini-3-flash-preview', 'gemini-2.5-flash', 'gemini-3-flash'];
  await openApp();
  await transcribe(page);
  expect(await transcriptTexts(page)).toEqual(['第0段', '第1段', '第2段']);
  expect(gemini.models.filter(m => m !== 'gemini-3-flash-preview').every(m => m === 'gemini-3-flash')).toBe(true);
  await page.getByText('詳細資訊').click();
  await expect(page.getByText(/模型：gemini-3-flash（預設的 gemini-3-flash-preview 已無法使用，自動改用）/)).toBeVisible();
});

test('找不到替代模型時整輪暫停，說明網站需要更新', async ({ page, openApp, gemini }) => {
  gemini.retired = ['gemini-3-flash-preview'];
  gemini.available = ['gemini-3-flash-preview', 'gemini-3-pro'];
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByText(/目前使用的 Gemini 模型已停用，也找不到可以替代的模型，網站需要更新/)).toBeVisible({ timeout: 30_000 });
  expect(gemini.requests.length).toBeLessThanOrEqual(3); // 不重試
});

test.describe('API Key 驗證', () => {
  test('無效的金鑰不儲存，在視窗裡說明', async ({ page, openApp, gemini }) => {
    gemini.listError = invalidKey;
    await openApp({ apiKey: null });
    await page.getByRole('button', { name: '設定 API Key' }).click();
    await page.getByLabel('API Key', { exact: true }).fill('wrong-key');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('這組 API Key 無效');
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('gemini_api_key'))).toBeNull();
  });

  test('有效的金鑰儲存後關閉視窗', async ({ page, openApp }) => {
    await openApp({ apiKey: null });
    await page.getByRole('button', { name: '設定 API Key' }).click();
    await page.getByLabel('API Key', { exact: true }).fill('AIza-good-1111');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('gemini_api_key'))).toBe('AIza-good-1111');
  });
});

test.describe('選檔格式', () => {
  test('選檔視窗可以選影片檔', async ({ page, openApp }) => {
    await openApp();
    expect(await page.locator('input[type=file]').getAttribute('accept')).toBe('audio/*,video/*');
  });

  test('影片檔（MP4/MOV）可以轉錄', async ({ page, openApp, gemini }) => {
    gemini.handler = () => [{ speaker: 'A', timestamp: '00:01', text: '影片裡的聲音' }];
    await openApp();
    await transcribe(page, path.join(FIXTURES, 'mov-aac-48k.mov'));
    expect(await transcriptTexts(page)).toEqual(['影片裡的聲音']);
  });

  test('選到不是音訊的檔案：不換檔，立刻說明', async ({ page, openApp }) => {
    await openApp();
    await page.setInputFiles('input[type=file]', meetingWav());
    await expect(page.getByText(/meeting-660s\.wav/)).toBeVisible();
    // 放在純英文路徑：測試輸出資料夾名稱含中文與全形冒號時，Playwright 讀不到檔案
    const doc = path.join(os.tmpdir(), 'gtm-e2e', 'notes.docx');
    fs.mkdirSync(path.dirname(doc), { recursive: true });
    fs.writeFileSync(doc, 'not audio');
    await page.setInputFiles('input[type=file]', doc);
    await expect(page.getByRole('alert')).toContainText('「notes.docx」不是音訊或影片檔');
    await expect(page.getByText(/meeting-660s\.wav/)).toBeVisible();
  });
});
