import React, { useState } from 'react';
import { Users, X, Plus } from 'lucide-react';
import { SpeakerHint } from '../types';

interface SpeakerHintsEditorProps {
  hints: SpeakerHint[];
  disabled: boolean;
  /** 名單是上一場錄音留下的 */
  fromBefore?: boolean;
  /** 已有逐字稿：改了名單只影響下一次轉錄 */
  applyNextTime?: boolean;
  onChange: (hints: SpeakerHint[]) => void;
}

const EXAMPLES = [
  { name: '例如：面試官', role: '例如：提問的人' },
  { name: '例如：應徵者', role: '例如：回答問題的人' },
];

/**
 * 轉錄前填講者（選填）。每 5 分鐘一段是分開辨識的，只給編號時各段可能把兩人對調；
 * 給了名字和角色，Gemini 會依角色判斷是誰。
 */
const SpeakerHintsEditor: React.FC<SpeakerHintsEditorProps> = ({ hints, disabled, fromBefore = false, applyNextTime = false, onChange }) => {
  const [open, setOpen] = useState(() => hints.some(h => h.name.trim()));
  // 還沒填過時先給兩列空白
  const rows = hints.length > 0 ? hints : [{ name: '', role: '' }, { name: '', role: '' }];
  const update = (index: number, field: keyof SpeakerHint, value: string) =>
    onChange(rows.map((h, i) => (i === index ? { ...h, [field]: value } : h)));

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className="mt-4 text-sm text-indigo-600 hover:text-indigo-800 disabled:text-slate-400 flex items-center gap-1.5"
      >
        <Users className="w-4 h-4" />
        填寫講者（選填，可避免把兩人對調）
      </button>
    );
  }

  return (
    <fieldset disabled={disabled} className="mt-4 p-4 min-w-0 rounded-lg border border-slate-200 bg-slate-50 disabled:opacity-60">
      <legend className="px-1 text-sm font-medium text-slate-700 flex items-center gap-1.5">
        <Users className="w-4 h-4 text-indigo-600" />
        講者（選填）
      </legend>
      <p className="text-xs text-slate-600 mb-3">
        填上每個人的名字和角色，Gemini 會依角色分辨誰在說話，比較不會把兩人對調，逐字稿也會直接用這些名字。不填就標成「講者 1」「講者 2」。
      </p>
      {fromBefore && (
        <div role="status" className="mb-3 p-2 rounded bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center gap-2">
          <span className="flex-grow">這是上次轉錄時填的講者。換了錄音請確認是否還適用，不適用就清空或修改。</span>
          <button type="button" onClick={() => onChange([])} className="shrink-0 px-2 py-1 rounded bg-white border border-amber-300 hover:bg-amber-100 font-medium">
            清空
          </button>
        </div>
      )}
      {applyNextTime && (
        <p className="mb-3 text-xs text-slate-500">
          改了名單會在下次轉錄時套用，不會改到目前的逐字稿；要改目前的名字，請用下方逐字稿的「重新命名講者」。
        </p>
      )}
      <ul className="space-y-2">
        {rows.map((hint, i) => (
          <li key={i} className="flex items-center gap-2">
            <input
              type="text"
              value={hint.name}
              onChange={e => update(i, 'name', e.target.value)}
              placeholder={EXAMPLES[i]?.name ?? '名字'}
              aria-label={`第 ${i + 1} 位講者的名字`}
              className="w-28 sm:w-36 shrink-0 px-2 py-1.5 text-sm border border-slate-200 rounded bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
            <input
              type="text"
              value={hint.role}
              onChange={e => update(i, 'role', e.target.value)}
              placeholder={EXAMPLES[i]?.role ?? '角色或特徵（選填）'}
              aria-label={`第 ${i + 1} 位講者的角色`}
              className="flex-grow min-w-0 px-2 py-1.5 text-sm border border-slate-200 rounded bg-white focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              aria-label={`移除第 ${i + 1} 位講者`}
              className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
            >
              <X className="w-4 h-4" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => onChange([...rows, { name: '', role: '' }])}
        className="mt-2 text-sm text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
      >
        <Plus className="w-4 h-4" />
        新增講者
      </button>
    </fieldset>
  );
};

export default SpeakerHintsEditor;
