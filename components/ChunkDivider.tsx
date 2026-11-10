import React, { memo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { formatTime } from '../utils/audioUtils';
import { CHUNK_DURATION } from '../constants';

interface ChunkDividerProps {
  chunk: number;
  /** 這一段的講者，依段落數由多到少 */
  speakers: string[];
  onSwap?: (chunk: number, a: string, b: string) => void;
}

/**
 * 每 5 分鐘一段的分隔線。各段是分開辨識講者的，偶爾會把兩人對調，這裡可以整段對調回來。
 * 兩位講者時直接對調；三位以上先選要對調哪兩位。
 */
const ChunkDivider: React.FC<ChunkDividerProps> = ({ chunk, speakers, onSwap }) => {
  const [choosing, setChoosing] = useState(false);
  const [a, setA] = useState(speakers[0] ?? '');
  const [b, setB] = useState(speakers[1] ?? '');
  const start = formatTime(chunk * CHUNK_DURATION);
  const canSwap = !!onSwap && speakers.length >= 2;
  // 講者名單變了（例如改名）時，選單沿用仍存在的名字
  const pickA = speakers.includes(a) ? a : speakers[0];
  const pickB = speakers.includes(b) && b !== pickA ? b : speakers.find(s => s !== pickA) ?? '';

  const swap = () => {
    if (!onSwap) return;
    if (speakers.length === 2) onSwap(chunk, speakers[0], speakers[1]);
    else setChoosing(true);
  };

  const select = (value: string, onChange: (v: string) => void, label: string) => (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label={label}
      className="max-w-[8rem] px-1 py-0.5 border border-slate-200 rounded bg-white text-slate-700"
    >
      {speakers.map(s => <option key={s} value={s}>{s}</option>)}
    </select>
  );

  return (
    <div className="flex items-center gap-3 pt-2 text-xs text-slate-400 flex-wrap">
      <span className="font-mono">{start} 起</span>
      <span className="flex-grow h-px bg-slate-100" />
      {canSwap && !choosing && (
        <button
          type="button"
          onClick={swap}
          title={speakers.length === 2 ? `把這段的「${speakers[0]}」和「${speakers[1]}」對調` : '選擇這段要對調的兩位講者'}
          aria-label={`對調 ${start} 起這段的講者`}
          className="flex items-center gap-1 px-2 py-1 rounded text-slate-500 hover:text-indigo-700 hover:bg-indigo-50"
        >
          <ArrowLeftRight className="w-3.5 h-3.5" />
          對調這段的講者
        </button>
      )}
      {canSwap && choosing && (
        <span className="flex items-center gap-1.5 text-slate-600">
          把 {select(pickA, setA, '要對調的第一位講者')} 和 {select(pickB, setB, '要對調的第二位講者')}
          <button
            type="button"
            disabled={!pickB || pickA === pickB}
            onClick={() => { onSwap!(chunk, pickA, pickB); setChoosing(false); }}
            className="px-2 py-0.5 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-slate-300"
          >
            對調
          </button>
          <button type="button" onClick={() => setChoosing(false)} className="px-1 text-slate-500 hover:text-slate-800">取消</button>
        </span>
      )}
    </div>
  );
};

export default memo(ChunkDivider);
