import { Page } from '@playwright/test';
import { test, expect, meetingWav, transcribe, startButton, restartButton, transcriptTexts, serverError, sleep } from './helpers';

/** 轉錄完成、改一段後重新整理頁面，並打開自動保存的逐字稿 */
const restoreAfterReload = async (page: Page) => {
  await transcribe(page);
  await page.locator('textarea').first().fill('我改過的內容');
  await page.waitForTimeout(1500); // 自動保存停一秒才寫入
  await page.reload();
  await page.getByRole('button', { name: '打開' }).click();
};

test.describe('找回的逐字稿', () => {
  test.beforeEach(({ dialogs }) => { dialogs.allowLeave = true; });

  test('說明怎麼接上音檔，按鈕是「重新轉錄」；下載沿用原檔名', async ({ page, openApp }) => {
    await openApp();
    await restoreAfterReload(page);
    await expect(page.getByText('上次保存的逐字稿')).toBeVisible();
    await expect(page.getByText(/選回同一個音檔（meeting-660s\.wav）/)).toBeVisible();
    await expect(page.getByText('使用步驟')).toHaveCount(0);
    await expect(restartButton(page)).toBeDisabled(); // 還沒有音檔

    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: '下載 TXT' }).click();
    expect((await pending).suggestedFilename()).toBe('meeting-660s.txt');

    await page.setInputFiles('input[type=file]', meetingWav());
    await expect(page.getByText('已接上音檔，按時間旁的 ▶ 就能邊聽邊校對。')).toBeVisible();
    await expect(restartButton(page)).toBeEnabled();
  });

  test('按「重新轉錄」前先確認，取消就保留逐字稿', async ({ page, openApp, gemini, dialogs }) => {
    await openApp();
    await restoreAfterReload(page);
    await page.setInputFiles('input[type=file]', meetingWav());
    const requests = gemini.requests.length;
    dialogs.answer = false;
    await restartButton(page).click();
    await expect.poll(() => dialogs.last()).toContain('重新轉錄會清除目前的逐字稿');
    await sleep(500);
    expect((await transcriptTexts(page))[0]).toBe('我改過的內容');
    expect(gemini.requests.length).toBe(requests);
  });
});

test('轉錄中顯示預估還要多久', async ({ page, openApp, gemini }) => {
  gemini.handler = async chunk => {
    if (chunk > 0) await sleep(4000);
    return [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }];
  };
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByText(/預估還要(不到 1 分鐘|約 \d+ 分鐘)/)).toBeVisible();
  await expect(restartButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/預估還要/)).toHaveCount(0); // 完成後不再顯示
});

test('手機上只固定播放器，工具列跟著捲走', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => Array.from({ length: 30 }, (_, i) => ({ speaker: 'A', timestamp: `00:${String(i).padStart(2, '0')}`, text: `第${chunk}段第${i}句` }));
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp();
  await transcribe(page);
  await page.mouse.wheel(0, 4000);
  const player = page.getByLabel('原始音檔');
  await expect.poll(() => player.evaluate(a => a.getBoundingClientRect().top)).toBeLessThan(40);
  expect(await page.getByRole('button', { name: '下載 TXT' }).evaluate(b => b.getBoundingClientRect().bottom)).toBeLessThan(0);
});

test('桌機上工具列與播放器都固定，播放器在工具列下方', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => Array.from({ length: 30 }, (_, i) => ({ speaker: 'A', timestamp: `00:${String(i).padStart(2, '0')}`, text: `第${chunk}段第${i}句` }));
  await openApp();
  await transcribe(page);
  await page.mouse.wheel(0, 4000);
  const downloadBottom = () => page.getByRole('button', { name: '下載 TXT' }).evaluate(b => b.getBoundingClientRect().bottom);
  await expect.poll(downloadBottom).toBeGreaterThan(0);
  const playerTop = await page.getByLabel('原始音檔').evaluate(a => a.getBoundingClientRect().top);
  expect(playerTop).toBeGreaterThan(await downloadBottom());
});

test('點視窗外關閉 API Key 視窗', async ({ page, openApp }) => {
  await openApp();
  await page.locator('header button').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('失敗的段落顯示「轉錄失敗」，沒有可編輯的講者欄', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => (chunk === 1 ? serverError : [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }]);
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByRole('button', { name: /重試失敗的 1 段/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('轉錄失敗', { exact: true })).toBeVisible();
  await expect(page.getByLabel('講者', { exact: true })).toHaveCount(2);
});

test('刪除鈕不用滑過就看得到；頁尾有使用說明與回報問題', async ({ page, openApp }) => {
  await openApp();
  await transcribe(page);
  await page.mouse.move(0, 0);
  await expect(page.getByRole('button', { name: '刪除這一段' }).first()).toHaveCSS('opacity', '1');
  await expect(page.getByRole('link', { name: '回報問題' })).toHaveAttribute('href', 'https://github.com/makodo123/gemini-Transcription-Master/issues');
  await expect(page.getByRole('link', { name: '使用說明' })).toHaveAttribute('href', /#readme$/);
});
