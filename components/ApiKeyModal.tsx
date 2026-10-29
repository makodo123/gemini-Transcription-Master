import React, { useState, useEffect } from 'react';
import { Key, Save, X, Eye, EyeOff, Trash2 } from 'lucide-react';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (key: string) => void;
  onClear: () => void;
  currentKey: string;
}

const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, onSave, onClear, currentKey }) => {
  const [inputValue, setInputValue] = useState('');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setInputValue(currentKey || '');
    }
  }, [isOpen, currentKey]);

  // 按 Esc 關閉
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // 用 form 送出，輸入框裡按 Enter 就會儲存
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    onSave(inputValue.trim());
    onClose();
  };

  const handleClear = () => {
    if (!window.confirm('確定要從這台裝置清除 API Key 嗎？之後要轉錄時需要重新輸入。')) return;
    onClear();
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="api-key-title" className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in">
        <div className="bg-indigo-600 px-6 py-4 flex justify-between items-center">
          <h3 id="api-key-title" className="text-white font-bold text-lg flex items-center gap-2">
            <Key className="w-5 h-5" />
            API Key 設定
          </h3>
          <button type="button" onClick={onClose} aria-label="關閉" className="text-white/80 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6">
          <p className="text-slate-600 text-sm mb-4">
            請輸入您的 Google Gemini API Key。金鑰只會存在這台裝置的瀏覽器裡，只用來呼叫 Google Gemini 轉錄，不會傳到其他地方。
            <br />
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 hover:underline mt-1 inline-block"
            >
              取得 API Key &rarr;
            </a>
          </p>

          <div className="relative mb-6">
            <input
              type={showKey ? "text" : "password"}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="貼上您的 API Key"
              aria-label="API Key"
              autoFocus
              className="w-full pl-4 pr-12 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey ? '隱藏金鑰' : '顯示金鑰'}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <div className="flex items-center gap-3">
            {currentKey && (
              <button
                type="button"
                onClick={handleClear}
                className="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors text-sm flex items-center gap-1.5"
              >
                <Trash2 className="w-4 h-4" />
                清除金鑰
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors font-medium"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={!inputValue.trim()}
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg shadow-md transition-colors font-medium flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              儲存
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ApiKeyModal;
