import { test, expect, transcribe } from './helpers';

test('選轉錄模型：請求用選的模型，下次打開還記得', async ({ page, openApp, gemini, dialogs }) => {
  await openApp();
  await expect(page.getByLabel('轉錄模型')).toHaveValue('gemini-3-flash-preview');
  await page.getByLabel('轉錄模型').selectOption('gemini-3.8-flash');
  await transcribe(page);
  expect(gemini.models).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.8-flash']);
  await expect(page.getByText('模型：gemini-3.8-flash')).toBeHidden(); // 詳細資訊預設收合
  await page.getByText('詳細資訊').click();
  await expect(page.getByText('模型：gemini-3.8-flash')).toBeVisible();

  dialogs.allowLeave = true;
  await page.reload();
  await expect(page.getByLabel('轉錄模型')).toHaveValue('gemini-3.8-flash');
});

test('選的模型停用時自動改用其他模型，並在詳細資訊說明', async ({ page, openApp, gemini }) => {
  gemini.available = ['gemini-3.6-flash', 'gemini-3.8-flash'];
  gemini.retired = ['gemini-3.6-flash'];
  await openApp();
  await page.getByLabel('轉錄模型').selectOption('gemini-3.6-flash');
  await transcribe(page);
  await page.getByText('詳細資訊').click();
  await expect(page.getByText(/您選的 gemini-3\.6-flash 已無法使用，自動改用/)).toBeVisible();
});
