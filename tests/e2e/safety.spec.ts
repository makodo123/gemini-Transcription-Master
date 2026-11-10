import { test, expect, transcribe, meetingWav, startButton, continueButton, invalidKey } from './helpers';

const speakers = (page: import('@playwright/test').Page) =>
  page.getByLabel('講者', { exact: true }).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));

test('全部刪光後還能復原，也不會跳出「找到上次的逐字稿」', async ({ page, openApp }) => {
  await openApp();
  await transcribe(page);
  await page.waitForTimeout(1500); // 讓自動保存寫入
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '刪除這一段' }).first().click();
  await expect(page.getByText('逐字稿是空的')).toBeVisible();
  await expect(page.getByText('找到上次的逐字稿：')).toHaveCount(0);
  await page.getByRole('button', { name: '復原' }).click();
  await expect(page.locator('textarea')).toHaveCount(1);
});

test('停止後改了講者名單再繼續，續傳的段落仍用原本的名單', async ({ page, openApp, gemini }) => {
  let hang = true;
  gemini.handler = chunk => (chunk === 0 || !hang ? [{ speaker: '面試官', timestamp: '00:05', text: `c${chunk}` }] : 'hang');
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.getByLabel('第 1 位講者的名字').fill('面試官');
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.locator('textarea')).toHaveCount(1);
  await page.getByRole('button', { name: '停止轉錄' }).click();
  await page.getByLabel('第 1 位講者的名字').fill('王');
  hang = false;
  const before = gemini.prompts.length;
  await continueButton(page).click();
  await expect(page.getByRole('button', { name: '重新轉錄' })).toBeVisible({ timeout: 60_000 });
  const resumed = gemini.prompts.slice(before);
  expect(resumed.length).toBeGreaterThan(0);
  for (const prompt of resumed) {
    expect(prompt).toContain('- 面試官');
    expect(prompt).not.toContain('- 王');
  }
});

test('換了新錄音時提醒名單是上次留下的，可以一鍵清空；已有逐字稿時說明下次才套用', async ({ page, openApp }) => {
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.getByLabel('第 1 位講者的名字').fill('面試官');
  await transcribe(page);
  await expect(page.getByText(/改了名單會在下次轉錄時套用/)).toBeVisible();
  await expect(page.getByText(/這是上次轉錄時填的講者/)).toHaveCount(0);

  await page.setInputFiles('input[type=file]', meetingWav(900));
  await expect(page.getByText(/這是上次轉錄時填的講者/)).toBeVisible();
  await page.getByRole('button', { name: '清空', exact: true }).click();
  await expect(page.getByLabel('第 1 位講者的名字')).toHaveValue('');
  await expect(page.getByText(/這是上次轉錄時填的講者/)).toHaveCount(0);
});

test('重新打開頁面時，上次的名單也會提醒確認', async ({ page, openApp, dialogs }) => {
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.getByLabel('第 1 位講者的名字').fill('面試官');
  dialogs.allowLeave = true;
  await page.reload();
  await expect(page.getByText(/這是上次轉錄時填的講者/)).toBeVisible();
  await page.getByLabel('第 1 位講者的角色').fill('提問的人');
  await expect(page.getByText(/這是上次轉錄時填的講者/)).toHaveCount(0);
});

test('講者欄清空後匯出不留冒號', async ({ page, openApp }) => {
  await openApp();
  await transcribe(page);
  await page.getByLabel('講者', { exact: true }).first().fill('');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '下載 TXT' }).click();
  const fs = await import('node:fs');
  expect(fs.readFileSync((await (await pending).path())!, 'utf8').split('\n')[0]).toBe('[00:05] 第0段');
  expect((await speakers(page))[1]).toBe('講者 1');
});

test('自動保存的資料壞掉時不提示找回，頁面正常', async ({ page, openApp }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await openApp();
  await page.evaluate(() => localStorage.setItem('transcription_last', JSON.stringify({
    fileName: 'a.mp3', fileSize: 1, savedAt: Date.now(), transcripts: [null],
  })));
  await page.reload();
  await expect(page.getByRole('heading', { name: '上傳錄音' })).toBeVisible();
  await expect(page.getByText('找到上次的逐字稿：')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('錯誤訊息用較大的字並會被讀出', async ({ page, openApp, gemini }) => {
  gemini.handler = () => invalidKey;
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  const alert = page.getByRole('alert').filter({ hasText: 'API Key 無效' });
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toHaveCSS('font-size', '14px');
});

test('內容安全政策：不能連到 Google Gemini 以外的網站，也不載入外部字型', async ({ page, openApp }) => {
  const requested: string[] = [];
  page.on('request', r => requested.push(r.url()));
  await openApp();
  expect(requested.filter(u => !u.startsWith('http://localhost'))).toEqual([]);
  const blocked = await page.evaluate(async () => {
    const violation = new Promise<string>(resolve =>
      document.addEventListener('securitypolicyviolation', e => resolve(e.violatedDirective), { once: true }));
    fetch('https://example.com/steal').catch(() => {});
    return violation;
  });
  expect(blocked).toBe('connect-src');
});
