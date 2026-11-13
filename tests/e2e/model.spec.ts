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

test('選的模型把某一段擋下時，自動改用另一個模型，整份照常完成', async ({ page, openApp, gemini }) => {
  gemini.blocked = ['gemini-3.8-flash'];
  gemini.available = ['gemini-3.6-flash', 'gemini-3.8-flash'];
  await openApp();
  await page.getByLabel('轉錄模型').selectOption('gemini-3.8-flash');
  await transcribe(page);
  await expect(page.getByRole('button', { name: /重試失敗的/ })).toHaveCount(0);
  await expect(page.getByText('轉錄失敗', { exact: true })).toHaveCount(0);
  expect(gemini.models.filter(m => m === 'gemini-3.6-flash')).toHaveLength(3);
  await page.getByText('詳細資訊').click();
  await expect(page.getByText(/有 3 段被 gemini-3\.8-flash 擋下，自動改用 gemini-3\.6-flash 轉錄/)).toBeVisible();
});

test('兩個模型都擋下時，那一段失敗並說明原因與模型', async ({ page, openApp, gemini, dialogs }) => {
  void dialogs;
  gemini.blocked = ['gemini-3.8-flash', 'gemini-3.6-flash'];
  await openApp();
  await page.getByLabel('轉錄模型').selectOption('gemini-3.8-flash');
  await page.setInputFiles('input[type=file]', (await import('./helpers')).meetingWav());
  await page.getByRole('button', { name: '開始轉錄' }).click();
  await expect(page.getByRole('button', { name: /重試失敗的 3 段/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('textarea').first()).toHaveValue(/內容安全規則.*gemini-3\.8-flash，結束原因 none/);
});
