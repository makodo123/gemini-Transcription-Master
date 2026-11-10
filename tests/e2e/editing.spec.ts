import { test, expect, transcribe, timeInputs, timeValues, meetingWav, serverError, transcriptTexts } from './helpers';

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

  const speakers = () => page.getByLabel('講者', { exact: true }).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));
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

test('播放器：點時間旁的播放鈕從那一段開始播放，播放中的段落會標示', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段開頭` }, { speaker: 'B', timestamp: '01:00', text: `第${chunk}段後面` }];
  await openApp();
  await transcribe(page);
  const audio = page.getByLabel('原始音檔');
  await expect(audio).toBeVisible();

  await page.getByRole('button', { name: '從 05:05 開始播放' }).click();
  await expect.poll(() => audio.evaluate(a => !(a as HTMLAudioElement).paused)).toBe(true);
  const time = await audio.evaluate(a => (a as HTMLAudioElement).currentTime);
  expect(time).toBeGreaterThanOrEqual(304.4);
  expect(time).toBeLessThan(307);
  await expect(page.locator('[data-active]')).toContainText('第1段開頭');
  await audio.evaluate(a => (a as HTMLAudioElement).pause());
});

test('轉錄失敗的佔位段落沒有播放鈕', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => (chunk === 1 ? serverError : [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }]);
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await page.getByRole('button', { name: '開始轉錄' }).click();
  await expect(page.getByRole('button', { name: /重試失敗的 1 段/ })).toBeVisible({ timeout: 60_000 });
  // 失敗的佔位段落沒有播放鈕
  await expect(page.getByRole('button', { name: /開始播放/ })).toHaveCount(2);
});

test.describe('刪除段落與復原', () => {
  test.beforeEach(({ gemini }) => {
    gemini.handler = chunk => [
      { speaker: '講者 1', timestamp: '00:05', text: `第${chunk}段開頭` },
      { speaker: '講者 2', timestamp: '01:00', text: `第${chunk}段雜音` },
    ];
  });

  test('刪除一段後可以復原，之後做的其他修改不會被蓋掉', async ({ page, openApp }) => {
    await openApp();
    await transcribe(page);
    await page.getByRole('button', { name: '刪除這一段' }).nth(1).click();
    expect(await transcriptTexts(page)).not.toContain('第0段雜音');
    await expect(page.getByRole('status')).toContainText('已刪除「第0段雜音」');

    await page.locator('textarea').first().fill('改過的開頭');
    await page.getByRole('button', { name: '復原' }).click();
    expect(await transcriptTexts(page)).toEqual(['改過的開頭', '第0段雜音', '第1段開頭', '第1段雜音', '第2段開頭', '第2段雜音']);
    await expect(page.getByRole('status')).toHaveCount(0);
  });

  test('連續刪除可以一步一步復原', async ({ page, openApp }) => {
    await openApp();
    await transcribe(page);
    await page.getByRole('button', { name: '刪除這一段' }).first().click();
    await page.getByRole('button', { name: '刪除這一段' }).first().click();
    expect(await transcriptTexts(page)).toHaveLength(4);
    await page.getByRole('button', { name: '復原' }).click();
    expect((await transcriptTexts(page))[0]).toBe('第0段雜音');
    await page.getByRole('button', { name: '復原' }).click();
    expect(await transcriptTexts(page)).toHaveLength(6);
  });

  test('講者改名合併後可以復原，只改回被改名的那幾段', async ({ page, openApp }) => {
    await openApp();
    await transcribe(page);
    const speakers = () => page.getByLabel('講者', { exact: true }).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));
    await page.getByRole('button', { name: '重新命名講者' }).click();
    await page.getByLabel('講者 2 的新名稱').fill('講者 1');
    await page.getByLabel('講者 2 的新名稱').press('Enter');
    expect(new Set(await speakers())).toEqual(new Set(['講者 1']));
    await expect(page.getByRole('status')).toContainText('已將「講者 2」改名為「講者 1」（3 段）');

    await page.getByRole('button', { name: '復原' }).click();
    expect(await speakers()).toEqual(['講者 1', '講者 2', '講者 1', '講者 2', '講者 1', '講者 2']);
  });

  test('轉錄失敗的佔位段落不能刪除（才能重試）', async ({ page, openApp, gemini }) => {
    gemini.handler = chunk => (chunk === 1 ? serverError : [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }]);
    await openApp();
    await page.setInputFiles('input[type=file]', meetingWav());
    await page.getByRole('button', { name: '開始轉錄' }).click();
    await expect(page.getByRole('button', { name: /重試失敗的 1 段/ })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: '刪除這一段' })).toHaveCount(2);
  });
});
