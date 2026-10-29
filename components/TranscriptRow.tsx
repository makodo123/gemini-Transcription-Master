import React, { memo } from 'react';
import { Clock, User } from 'lucide-react';
import { TranscriptSegment } from '../types';
import { formatTime, parseTimeStringToSeconds } from '../utils/audioUtils';
import AutoResizeTextarea from './AutoResizeTextarea';

interface TranscriptRowProps {
  segment: TranscriptSegment;
  index: number;
  onUpdate: (index: number, field: keyof TranscriptSegment, value: string | number) => void;
}

/**
 * 逐字稿的一段。用 memo 包起來：打字時只有正在編輯的這一段重新繪製，長會議也不會卡。
 * onUpdate 必須是穩定的函式，否則每次都會重繪。
 */
const TranscriptRow: React.FC<TranscriptRowProps> = ({ segment, index, onUpdate }) => (
  <div className="flex gap-4 group items-start hover:bg-slate-50/50 transition-colors">
    <div className="flex-shrink-0 w-24 sm:w-28 text-right pt-2">
      <div className="inline-flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded border border-transparent focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
        <Clock className="w-3 h-3 text-slate-400" />
        <input
          key={segment.startTimeSeconds}
          type="text"
          defaultValue={formatTime(segment.startTimeSeconds)}
          aria-label="開始時間"
          onBlur={(e) => {
            const seconds = parseTimeStringToSeconds(e.target.value);
            if (seconds !== null) {
              onUpdate(index, 'startTimeSeconds', seconds);
              e.target.value = formatTime(seconds);
            } else {
              e.target.value = formatTime(segment.startTimeSeconds); // Revert on fail
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
          className="w-14 bg-transparent text-xs font-mono text-slate-600 focus:outline-none text-center"
        />
      </div>
    </div>
    <div className="flex-grow min-w-0">
      <div className="flex items-center gap-2 mb-1">
        <User className="w-3 h-3 text-slate-400" />
        <input
          type="text"
          value={segment.speaker}
          onChange={(e) => onUpdate(index, 'speaker', e.target.value)}
          aria-label="說話者"
          className="text-xs font-bold text-slate-600 tracking-wide bg-transparent border-b border-transparent hover:border-slate-200 focus:border-indigo-400 focus:outline-none transition-colors w-full max-w-[200px]"
          placeholder="說話者"
        />
      </div>
      <AutoResizeTextarea
        value={segment.text}
        onChange={(e) => onUpdate(index, 'text', e.target.value)}
        aria-label="逐字稿內容"
        className={`w-full leading-relaxed bg-transparent border border-transparent hover:bg-white hover:border-slate-200 focus:bg-white focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50 rounded p-2 -ml-2 focus:outline-none transition-colors resize-none overflow-hidden ${
          segment.failedChunk !== undefined ? 'text-amber-700' : 'text-slate-800'
        }`}
      />
    </div>
  </div>
);

export default memo(TranscriptRow);
