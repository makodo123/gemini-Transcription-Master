import React from 'react';
import { FileAudio, Settings } from 'lucide-react';

interface AppHeaderProps {
  apiKey: string;
  onOpenKeySettings: () => void;
}

/** 標題與 API Key 按鈕（設定後只顯示金鑰末四碼） */
const AppHeader: React.FC<AppHeaderProps> = ({ apiKey, onOpenKeySettings }) => (
  <header className="w-full max-w-4xl flex justify-between items-center gap-3 mb-8">
    <div>
      <h1 className="text-xl sm:text-3xl font-bold text-slate-800 tracking-tight flex items-center gap-2 sm:gap-3">
        <span className="bg-indigo-600 text-white p-2 rounded-lg">
          <FileAudio className="w-6 h-6" />
        </span>
        Gemini 逐字稿大師
      </h1>
      <p className="text-slate-500 mt-2">上傳錄音，自動產生逐字稿與 SRT 字幕檔</p>
    </div>
    <button
      onClick={onOpenKeySettings}
      aria-label={apiKey ? `API Key 設定（目前 API Key 結尾 ${apiKey.slice(-4)}）` : '設定 API Key'}
      className={`shrink-0 whitespace-nowrap flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg shadow-sm transition-colors ${
        apiKey
          ? 'bg-white border border-slate-200 hover:bg-slate-50 text-slate-700'
          : 'bg-indigo-600 hover:bg-indigo-700 text-white'
      }`}
    >
      <Settings className="w-4 h-4" />
      {apiKey ? (
        <span><span className="hidden sm:inline">API Key </span><span className="font-mono">…{apiKey.slice(-4)}</span></span>
      ) : (
        <span>設定 API Key</span>
      )}
    </button>
  </header>
);

export default AppHeader;
