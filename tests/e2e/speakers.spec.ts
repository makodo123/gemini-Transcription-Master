import { test, expect, transcribe, meetingWav, startButton } from './helpers';

const speakers = (page: import('@playwright/test').Page) =>
  page.getByLabel('講者', { exact: true }).evaluateAll(is => is.map(i => (i as HTMLInputElement).value));

test('轉錄前填講者：名字與角色送給 Gemini，重新整理後還在', async ({ page, openApp, gemini, dialogs }) => {
  gemini.handler = () => [{ speaker: '面試官', timestamp: '00:05', text: '請自我介紹' }, { speaker: '我', timestamp: '00:20', text: '大家好' }];
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.getByLabel('第 1 位講者的名字').fill('面試官');
  await page.getByLabel('第 1 位講者的角色').fill('提問的人');
  await page.getByLabel('第 2 位講者的名字').fill('我');
  await page.getByLabel('第 2 位講者的角色').fill('回答問題的人');
  await transcribe(page);

  expect(gemini.prompts).toHaveLength(3);
  for (const prompt of gemini.prompts) {
    expect(prompt).toContain('- 面試官：提問的人');
    expect(prompt).toContain('- 我：回答問題的人');
  }
  expect(new Set(await speakers(page))).toEqual(new Set(['面試官', '我']));

  dialogs.allowLeave = true;
  await page.reload();
  await expect(page.getByLabel('第 1 位講者的名字')).toHaveValue('面試官');
  await expect(page.getByLabel('第 2 位講者的角色')).toHaveValue('回答問題的人');
});

test('沒填講者就照舊編號；空白的列不會送出', async ({ page, openApp, gemini }) => {
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.getByLabel('第 1 位講者的角色').fill('只有角色沒有名字');
  await transcribe(page);
  expect(gemini.prompts[0]).toContain('講者 1, 講者 2');
  expect(gemini.prompts[0]).not.toContain('只有角色沒有名字');
});

test('手機上講者欄不會超出畫面', async ({ page, openApp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('轉錄中名單不能改', async ({ page, openApp, gemini }) => {
  gemini.handler = () => 'hang';
  await openApp();
  await page.getByRole('button', { name: /填寫講者/ }).click();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByLabel('第 1 位講者的名字')).toBeDisabled();
});

test.describe('對調這段的講者', () => {
  test('只對調那 5 分鐘裡的兩人，可以復原', async ({ page, openApp, gemini }) => {
    // 第 2 段把兩人標反了
    gemini.handler = chunk => [
      { speaker: chunk === 1 ? '講者 2' : '講者 1', timestamp: '00:05', text: `第${chunk}段提問` },
      { speaker: chunk === 1 ? '講者 1' : '講者 2', timestamp: '00:20', text: `第${chunk}段回答` },
    ];
    await openApp();
    await transcribe(page);
    expect(await speakers(page)).toEqual(['講者 1', '講者 2', '講者 2', '講者 1', '講者 1', '講者 2']);

    await page.getByRole('button', { name: '對調 05:00 起這段的講者' }).click();
    expect(await speakers(page)).toEqual(['講者 1', '講者 2', '講者 1', '講者 2', '講者 1', '講者 2']);
    await expect(page.getByRole('status')).toContainText('已對調 05:00 起這段的「講者 2」和「講者 1」（2 段）');

    await page.getByRole('button', { name: '復原' }).click();
    expect(await speakers(page)).toEqual(['講者 1', '講者 2', '講者 2', '講者 1', '講者 1', '講者 2']);
  });

  test('三位講者時先選要對調哪兩位', async ({ page, openApp, gemini }) => {
    gemini.handler = () => [
      { speaker: 'A', timestamp: '00:05', text: '一' },
      { speaker: 'B', timestamp: '00:20', text: '二' },
      { speaker: 'A', timestamp: '00:40', text: '三' },
      { speaker: 'C', timestamp: '01:00', text: '四' },
    ];
    await openApp();
    await transcribe(page);
    await page.getByRole('button', { name: '對調 00:00 起這段的講者' }).click();
    await expect(page.getByLabel('要對調的第一位講者')).toHaveValue('A');
    await page.getByLabel('要對調的第二位講者').selectOption('C');
    await page.getByRole('button', { name: '對調', exact: true }).click();
    expect((await speakers(page)).slice(0, 4)).toEqual(['C', 'B', 'C', 'A']);
    expect((await speakers(page)).slice(4, 8)).toEqual(['A', 'B', 'A', 'C']);
  });

  test('只有一位講者的段落沒有對調鈕', async ({ page, openApp }) => {
    await openApp();
    await transcribe(page); // 每段都只有「講者 1」
    await expect(page.getByText('05:00 起')).toBeVisible();
    await expect(page.getByRole('button', { name: /對調 .* 起這段的講者/ })).toHaveCount(0);
  });
});
