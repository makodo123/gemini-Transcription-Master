import React from 'react';
import { Cpu } from 'lucide-react';
import { MODEL_CHOICES } from '../services/geminiService';

interface ModelSelectProps {
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}

/** 選轉錄用的模型：想比較哪個模型的逐字稿比較準時，同一段錄音換模型各轉一次 */
const ModelSelect: React.FC<ModelSelectProps> = ({ value, disabled, onChange }) => (
  <div className="mt-4 flex items-center gap-2 text-sm text-slate-700 flex-wrap">
    <label htmlFor="model-select" className="flex items-center gap-1.5 font-medium">
      <Cpu className="w-4 h-4 text-indigo-600" />
      轉錄模型
    </label>
    <select
      id="model-select"
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className="min-w-0 max-w-full px-2 py-1.5 border border-slate-200 rounded bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none disabled:opacity-60"
    >
      {MODEL_CHOICES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  </div>
);

export default ModelSelect;
