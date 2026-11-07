import {
  test, expect, meetingWav, transcribe, startButton, restartButton, transcriptTexts, timeValues,
  progressInStorage, serverError, invalidKey, quotaExceeded, sleep,
} from './helpers';

test('三段都成功：依時間排序、HH:MM:SS 換算正確、顯示白話摘要', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => [{ speaker: '講者 1', timestamp: chunk === 0 ? '00:01:30' : '00:10', text: `第${chunk}段` }];
  await openApp();
  await transcribe(page);
  expect(await transcriptTexts(page)).toEqual(['第0段', '第1段', '第2段']);
  expect(await timeValues(page)).toEqual(['01:30', '05:10', '10:10']);
  await expect(page.getByText(/這次轉錄了 3 段/)).toBeVisible();
  expect(await progressInStorage(page)).toBeNull(); // 全部成功後清除進度
});

test('一段失敗：重試 4 次後顯示白話訊息，進度保留，「重試」只重送那一段並保留修改', async ({ page, openApp, gemini }) => {
  let failChunk1 = true;
  gemini.handler = chunk => (chunk === 1 && failChunk1 ? serverError : [{ speaker: 'A', timestamp: '00:05', text: `第${chunk}段` }]);
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  const retry = page.getByRole('button', { name: /重試失敗的 1 段/ });
  await expect(retry).toBeVisible({ timeout: 60_000 });

  expect(gemini.requests.filter(c => c === 1)).toHaveLength(4);
  const texts = await transcriptTexts(page);
  expect(texts[1]).toBe('[第 2 段（05:00–10:00）轉錄失敗：Gemini 伺服器暫時忙碌或發生問題。請按上方的「重試」按鈕重新轉錄。]');
  expect((await progressInStorage(page)).completedChunks.sort()).toEqual([0, 2]);

  await page.locator('textarea').first().fill('改過的第0段');
  failChunk1 = false;
  gemini.requests.length = 0;
  await retry.click();
  await expect(restartButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: /重試失敗的/ })).toHaveCount(0);
  expect(gemini.requests).toEqual([1]);
  expect(await transcriptTexts(page)).toEqual(['改過的第0段', '第1段', '第2段']);
  expect(await progressInStorage(page)).toBeNull();
});

test('API Key 無效：不重試、整輪暫停並說明下一步', async ({ page, openApp, gemini }) => {
  gemini.handler = () => invalidKey;
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByText(/API 金鑰無效或已過期。請按右上角的「API Key」重新輸入/)).toBeVisible({ timeout: 30_000 });
  await sleep(1000);
  expect(gemini.requests.length).toBeLessThanOrEqual(3); // 最多就是同時送出的那幾段
  await expect(startButton(page)).toBeEnabled();
});

test('額度用完：重試後暫停，已完成的段落保留', async ({ page, openApp, gemini }) => {
  test.setTimeout(120_000); // 請求次數限制的重試要等 5 + 10 + 20 秒
  gemini.handler = chunk => (chunk === 0 ? [{ speaker: 'A', timestamp: '00:01', text: 'c0' }] : quotaExceeded);
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByText(/已達到 Gemini API 的使用額度上限/)).toBeVisible({ timeout: 100_000 });
  expect((await progressInStorage(page)).completedChunks).toEqual([0]);
});

test('停止後馬上重新開始：舊的一輪不再送請求，結果不重複', async ({ page, openApp, gemini }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { fetchTimes: number[]; stopAt?: number };
    w.fetchTimes = [];
    // 記錄「停止」實際被處理的時間（主執行緒忙碌時點擊會延後處理）
    document.addEventListener('click', e => {
      if ((e.target as Element).closest('button')?.textContent?.includes('停止')) w.stopAt = Date.now();
    }, true);
    const original = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]).includes('generativelanguage')) w.fetchTimes.push(Date.now());
      return original(...args);
    };
  });
  let firstRound = true;
  gemini.handler = async chunk => {
    if (firstRound) return 'hang';
    await sleep(300);
    return [{ speaker: 'A', timestamp: '00:01', text: `第${chunk}段` }];
  };
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.getByText(/轉錄中：/)).toBeVisible();
  await page.getByRole('button', { name: '停止轉錄' }).click();
  firstRound = false;
  await startButton(page).click();
  await expect(restartButton(page)).toBeVisible({ timeout: 60_000 });
  await sleep(1000);

  expect(await transcriptTexts(page)).toEqual(['第0段', '第1段', '第2段']);
  const { fetchTimes, stopAt } = await page.evaluate(() => {
    const w = window as unknown as { fetchTimes: number[]; stopAt: number };
    return { fetchTimes: w.fetchTimes, stopAt: w.stopAt };
  });
  expect(fetchTimes.filter(t => t > stopAt)).toHaveLength(3);
});

test('停止時說明進度已保存；再開始會問要不要續傳，並寫清楚「取消」的後果', async ({ page, openApp, gemini, dialogs }) => {
  gemini.handler = async chunk => (chunk === 0 ? [{ speaker: 'A', timestamp: '00:05', text: 'c0' }] : 'hang');
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  await expect(page.locator('textarea')).toHaveCount(1);
  await page.getByRole('button', { name: '停止轉錄' }).click();
  await expect(page.getByText('已停止。已完成的段落都已保存')).toBeVisible();

  dialogs.answer = false;
  await startButton(page).click();
  await expect.poll(() => dialogs.last()).toContain('按「取消」：捨棄先前的進度，從頭開始');
  expect(dialogs.last()).toContain('已完成 1 / 3 段');
  expect(dialogs.last()).toContain('按「確定」：從中斷處繼續');
});

test('重新打開頁面時提醒未完成的轉錄，可以捨棄', async ({ page, openApp }) => {
  const size = (await import('node:fs')).statSync(meetingWav()).size;
  await openApp({
    progress: {
      fileName: 'meeting-660s.wav', fileSize: size, processedChunks: 1, completedChunks: [0], totalChunks: 3, timestamp: Date.now(),
      transcripts: [{ speaker: 'A', timestamp: '00:01', startTimeSeconds: 1, text: '已完成的第一段' }],
    },
  });
  await expect(page.getByText('有未完成的轉錄：')).toBeVisible();
  await expect(page.getByText(/已完成 1 \/ 3 段/)).toBeVisible();

  await page.setInputFiles('input[type=file]', meetingWav());
  await expect(page.getByText(/這個檔案有上次未完成的轉錄/)).toBeVisible();

  await page.setInputFiles('input[type=file]', meetingWav(900));
  await page.getByRole('button', { name: '捨棄這份進度' }).click();
  await expect(page.getByText(/未完成的轉錄/)).toHaveCount(0);
  expect(await progressInStorage(page)).toBeNull();
});

test('前面的段落比較晚完成時，正在編輯的段落不會被換掉', async ({ page, openApp, gemini }) => {
  gemini.handler = async chunk => {
    if (chunk === 1) await sleep(3000);
    return [{ speaker: 'A', timestamp: '00:05', text: `chunk${chunk}` }];
  };
  await openApp();
  await page.setInputFiles('input[type=file]', meetingWav());
  await startButton(page).click();
  const editing = page.locator('textarea', { hasText: 'chunk2' });
  await editing.click();
  await editing.press('End');
  await page.keyboard.type('X');
  await expect(page.locator('textarea')).toHaveCount(3, { timeout: 30_000 }); // 第 1 段插到前面
  await page.keyboard.type('Y');
  expect(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value)).toBe('chunk2XY');
  expect(await transcriptTexts(page)).toEqual(['chunk0', 'chunk1', 'chunk2XY']);
});
