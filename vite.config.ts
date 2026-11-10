import path from 'path';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 內容安全政策：網頁只能執行自己的程式、只能連到 Google Gemini。
 * 就算哪天某個套件被植入惡意程式，也無法把 API Key 或逐字稿送到別的地方。
 * 只加在正式版：開發伺服器需要內嵌的程式碼（熱更新）。
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "connect-src 'self' https://generativelanguage.googleapis.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

const contentSecurityPolicy = (): Plugin => ({
  name: 'content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY }, injectTo: 'head-prepend' },
  ],
});

export default defineConfig({
  base: '/gemini-Transcription-Master/',
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), contentSecurityPolicy()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    }
  }
});
