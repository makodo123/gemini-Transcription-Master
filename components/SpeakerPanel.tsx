import React, { useState } from 'react';
import { Users } from 'lucide-react';

interface SpeakerPanelProps {
  speakers: { name: string; count: number }[];
  onRename: (from: string, to: string) => void;
}

/** 一位講者的改名欄：按 Enter 或離開欄位時套用到所有同名段落 */
const SpeakerRow: React.FC<{ name: string; count: number; onRename: SpeakerPanelProps['onRename'] }> = ({ name, count, onRename }) => {
  const [draft, setDraft] = useState(name);

  const apply = () => {
    const next = draft.trim();
    if (next && next !== name) onRename(name, next);
    else setDraft(name);
  };

  return (
    <li className="flex items-center gap-2">
      <span className="w-28 shrink-0 truncate text-slate-500" title={name}>{name}</span>
      <span className="text-slate-300">→</span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        aria-label={`${name} 的新名稱`}
        className="flex-grow min-w-0 px-2 py-1 border border-slate-200 rounded focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 focus:outline-none"
      />
      <span className="shrink-0 text-xs text-slate-400">{count} 段</span>
    </li>
  );
};

/**
 * 批次重新命名講者：把所有「講者 1」一次改成真名。
 */
const SpeakerPanel: React.FC<SpeakerPanelProps> = ({ speakers, onRename }) => (
  <div className="px-6 py-4 border-b border-slate-100 bg-indigo-50/40 text-sm">
    <h4 className="font-medium text-slate-700 flex items-center gap-2 mb-1">
      <Users className="w-4 h-4 text-indigo-600" />
      重新命名講者
    </h4>
    <p className="text-xs text-slate-500 mb-3">
      輸入新名稱後按 Enter，所有同名的段落會一起改。改成已有的名稱會合併成同一位講者。
      每 5 分鐘一段的講者編號是分別判斷的，不同段落的「講者 1」不一定是同一人，改完請抽查。
    </p>
    <ul className="space-y-2">
      {speakers.map(s => <SpeakerRow key={s.name} name={s.name} count={s.count} onRename={onRename} />)}
    </ul>
  </div>
);

export default SpeakerPanel;
