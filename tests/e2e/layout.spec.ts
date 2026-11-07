import { test, expect, transcribe, restartButton } from './helpers';

// 這些測試需要 Tailwind 樣式（線上從 CDN 載入；本機沒有網路時用 TAILWIND_BROWSER_JS）

const LONG = '這是一段很長的發言，用來測試文字框會不會把內容切掉。'.repeat(6);

test('長句子不會被文字框切掉；視窗變寬後高度重新計算', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => [{ speaker: '講者 1', timestamp: '00:05', text: chunk === 0 ? LONG : `第${chunk}段` }];
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp();
  await transcribe(page);
  const clipped = () => page.locator('textarea').evaluateAll(ts => ts.filter(t => t.scrollHeight > t.clientHeight + 1).length);
  const firstHeight = () => page.locator('textarea').first().evaluate(t => t.clientHeight);
  expect(await clipped()).toBe(0);
  const mobileHeight = await firstHeight();

  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(firstHeight).toBeLessThan(mobileHeight);
  expect(await clipped()).toBe(0);

  await page.locator('textarea').nth(1).fill('多一行\n再多一行\n第三行');
  expect(await clipped()).toBe(0);
});

test('逐字稿跟著頁面捲動，工具列固定在頂端', async ({ page, openApp, gemini }) => {
  gemini.handler = chunk => Array.from({ length: 40 }, (_, i) => ({ speaker: 'A', timestamp: `00:${String(i).padStart(2, '0')}`, text: `第${chunk}段第${i}句` }));
  await openApp();
  await transcribe(page);
  const list = page.locator('.divide-y');
  expect(await list.evaluate(el => [getComputedStyle(el).overflowY, getComputedStyle(el).maxHeight])).toEqual(['visible', 'none']);

  await page.mouse.wheel(0, 3000);
  await expect.poll(() => page.getByRole('button', { name: '下載 TXT' }).evaluate(b => b.getBoundingClientRect().top))
    .toBeLessThan(80);
  expect(await page.getByRole('button', { name: '下載 TXT' }).evaluate(b => b.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
});

test('完成後「重新轉錄」是次要按鈕', async ({ page, openApp }) => {
  await openApp();
  await transcribe(page);
  await page.mouse.move(0, 0);
  await expect(restartButton(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test.describe('手機標題列', () => {
  for (const width of [320, 390]) {
    test(`${width}px：不會左右捲動，金鑰按鈕只佔一行`, async ({ page, openApp }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const button = page.locator('header button');
      // 「API Key」字樣在手機上隱藏，只看畫面上看得到的文字
      expect(await button.evaluate(b => (b as HTMLElement).innerText.trim())).toBe('…1234');
      expect(await button.evaluate(b => (b as HTMLElement).offsetHeight)).toBeLessThanOrEqual(44);
      if (width === 390) expect(await page.locator('h1').evaluate(h => (h as HTMLElement).offsetHeight)).toBeLessThanOrEqual(44);
    });
  }
});
