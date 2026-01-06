import React, { useState, useEffect } from 'react';
import { Key, Save, X, Eye, EyeOff } from 'lucide-react';

interface ApiKeyModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (key: string) => void;
  currentKey: string;
}

const ApiKeyModal: React.FC<ApiKeyModalProps> = ({ isOpen, onClose, onSave, currentKey }) => {
  const [inputValue, setInputValue] = useState('');
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setInputValue(currentKey || '');
    }
  }, [isOpen, currentKey]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSave(inputValue.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-fade-in">
        <div className="bg-indigo-600 px-6 py-4 flex justify-between items-center">
          <h3 className="text-white font-bold text-lg flex items-center gap-2">
            <Key className="w-5 h-5" />
            API Key 設定
          </h3>
          <button onClick={onClose} className="text-white/80 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-6">
          <p className="text-slate-600 text-sm mb-4">
            請輸入您的 Google Gemini API Key。此金鑰僅會儲存於您的瀏覽器 LocalStorage 中，不會傳送至其他伺服器。
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
              className="w-full pl-4 pr-12 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <div className="flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors font-medium"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={!inputValue.trim()}
              className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white rounded-lg shadow-md transition-colors font-medium flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              儲存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ApiKeyModal;
