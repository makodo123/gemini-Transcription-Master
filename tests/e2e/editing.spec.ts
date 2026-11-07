import { test, expect, transcribe, timeInputs, timeValues } from './helpers';

test('改時間後依時間重新排序；無效的時間會還原', async ({ page, openApp, gemini }) => {
  gemini.handler = () => [{ speaker: 'A', timestamp: '00:05', text: '開場' }, { speaker: 'B', timestamp: '01:00', text: '回應' }];
  await openApp();
  await transcribe(page);
  expect(await timeValues(page)).toEqual(['00:05', '01:00', '05:05', '06:00', '10:05', '11:00']);

  const second = timeInputs(page).nth(1);
  await second.fill('abc');
  await second.press('Enter');
  await expect(second).toHaveValue('01:00');

  await second.fill('1:02:03');
  await second.press('Enter');
  await expect.poll(() => timeValues(page)).toEqual(['00:05', '05:05', '06:00', '10:05', '11:00', '1:02:03']);
});

test('重新命名講者：所有同名段落一起改，改成已有名稱會合併，空白不套用', async ({ page, openApp, gemini }) => {
  gemini.handler = () => [
    { speaker: '講者 1', timestamp: '00:05', text: '一' },
    { speaker: '講者 2', timestamp: '00:20', text: '二' },
    { speaker: '講者 1', timestamp: '01:00', text: '三' },
  ];
  await openApp();
  await transcribe(page);
  await page.getByRole('button', { name: '重新命名講者' }).click();
  await expect(page.getByText('6 段')).toBeVisible();
  await expect(page.getByText('3 段', { exact: true })).toBeVisible();

  const speakers = () => page.getByLabel('說話者', { exact: true }).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));
  await page.getByLabel('講者 1 的新名稱').fill('王經理');
  await page.getByLabel('講者 1 的新名稱').press('Enter');
  expect((await speakers()).filter(s => s === '王經理')).toHaveLength(6);

  await page.getByLabel('講者 2 的新名稱').fill('王經理');
  await page.getByLabel('講者 2 的新名稱').press('Enter');
  expect(new Set(await speakers())).toEqual(new Set(['王經理']));
  await expect(page.getByText('9 段')).toBeVisible();

  await page.getByLabel('王經理 的新名稱').fill('   ');
  await page.getByLabel('王經理 的新名稱').press('Enter');
  await expect(page.getByLabel('王經理 的新名稱')).toHaveValue('王經理');
});

test('複製全文：依「含時間戳記」選項，算作已匯出', async ({ page, context, openApp, dialogs }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp();
  await transcribe(page);
  await page.getByRole('button', { name: '複製全文' }).click();
  await expect(page.getByRole('button', { name: '已複製' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    '[00:05] 講者 1: 第0段\n[05:05] 講者 1: 第1段\n[10:05] 講者 1: 第2段',
  );

  // 複製過就不再於離開頁面時提醒
  await page.close({ runBeforeUnload: true });
  expect(dialogs.messages.filter(d => d.type === 'beforeunload')).toHaveLength(0);
});

test('長會議（1,440 段）打字不卡：只重繪正在編輯的那一段', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => Array.from({ length: 480 }, (_, i) => ({
    speaker: `講者 ${(i % 3) + 1}`,
    timestamp: `${String(Math.floor((i * 0.6) / 60)).padStart(2, '0')}:${String(Math.floor((i * 0.6) % 60)).padStart(2, '0')}`,
    text: `第 ${chunk} 段第 ${i} 句，這是一段模擬的會議發言內容，長度大約三十個字左右。`,
  }));
  await openApp();
  await transcribe(page);
  await expect(page.locator('textarea')).toHaveCount(1440);
  const median = await page.evaluate(async () => {
    const textarea = document.querySelectorAll('textarea')[5];
    textarea.focus();
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const start = performance.now();
      setValue.call(textarea, textarea.value + 'x');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      times.push(performance.now() - start);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    return times.sort((a, b) => a - b)[10];
  });
  // 改善前每個字約 45 毫秒，改善後約 5 毫秒；門檻放寬給較慢的 CI 機器
  expect(median).toBeLessThan(25);
});
