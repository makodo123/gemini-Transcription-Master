import { test, expect } from './helpers';

test('API Key 視窗：自動聚焦、Enter 儲存、Esc 關閉、清除前確認', async ({ page, openApp, dialogs }) => {
  await openApp({ apiKey: null });
  await page.getByRole('button', { name: '設定 API Key' }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toBeFocused();

  await page.keyboard.type('AIza-new-key-7777');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('gemini_api_key'))).toBe('AIza-new-key-7777');
  await expect(page.locator('header button')).toContainText('7777');

  await page.locator('header button').click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.locator('header button').click();
  await page.getByRole('button', { name: '清除金鑰' }).click();
  expect(dialogs.last()).toContain('清除 API Key');
  await expect(page.getByRole('button', { name: '設定 API Key' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('gemini_api_key'))).toBeNull();

  await page.getByRole('button', { name: '設定 API Key' }).click();
  await expect(page.getByRole('button', { name: '清除金鑰' })).toHaveCount(0);
});
