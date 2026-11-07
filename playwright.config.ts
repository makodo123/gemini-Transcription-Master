import { defineConfig, devices } from '@playwright/test';

const PREVIEW_URL = 'http://localhost:4173/gemini-Transcription-Master/';
const DEV_URL = 'http://localhost:5173/gemini-Transcription-Master/';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  // 解碼與多段並行在 CI 上可能較慢
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: PREVIEW_URL,
    trace: 'retain-on-failure',
  },
  webServer: [
    // 測建置後的正式版本
    {
      command: 'npm run build && npx vite preview --port 4173 --strictPort',
      url: PREVIEW_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    // 開發伺服器：解碼比對測試直接在瀏覽器載入 TypeScript 模組
    {
      command: 'npx vite --port 5173 --strictPort',
      url: DEV_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
