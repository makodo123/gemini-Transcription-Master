import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(viteConfig, defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    // 預設在 Node 執行；需要 DOM 或 localStorage 的測試檔在開頭用 @vitest-environment jsdom
    environment: 'node',
  },
}));
