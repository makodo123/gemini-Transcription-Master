import React, { memo } from 'react';
import { Clock, User, Play, Trash2 } from 'lucide-react';
import { TranscriptSegment } from '../types';
import { formatTime, parseTimeStringToSeconds } from '../utils/audioUtils';
import AutoResizeTextarea from './AutoResizeTextarea';

interface TranscriptRowProps {
  segment: TranscriptSegment;
  index: number;
  onUpdate: (index: number, field: keyof TranscriptSegment, value: string | number) => void;
  /** 從這段開始播放；沒有可播放的音檔時不給 */
  onPlay?: (seconds: number) => void;
  /** 播放到這一段 */
  isActive?: boolean;
  onDelete?: (index: number) => void;
}

/**
 * 逐字稿的一段。用 memo 包起來：打字時只有正在編輯的這一段重新繪製，長會議也不會卡。
 * onUpdate 必須是穩定的函式，否則每次都會重繪。
 */
const TranscriptRow: React.FC<TranscriptRowProps> = ({ segment, index, onUpdate, onPlay, isActive = false, onDelete }) => (
  <div
    data-active={isActive || undefined}
    className={`flex gap-4 group items-start transition-colors rounded ${isActive ? 'bg-indigo-50' : 'hover:bg-slate-50/50'}`}
  >
    <div className="flex-shrink-0 w-28 sm:w-32 text-right pt-2 flex items-center justify-end gap-1">
      {onPlay && segment.failedChunk === undefined && (
        <button
          type="button"
          onClick={() => onPlay(segment.startTimeSeconds)}
          aria-label={`從 ${formatTime(segment.startTimeSeconds)} 開始播放`}
          className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
        >
          <Play className="w-3 h-3 fill-current" />
        </button>
      )}
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
        {segment.failedChunk !== undefined ? (
          // 失敗的佔位段落沒有講者，不顯示可編輯的講者欄，避免被當成一位講者
          <span className="text-xs font-bold text-amber-700">轉錄失敗</span>
        ) : (
          <>
            <User className="w-3 h-3 text-slate-400" />
            <input
              type="text"
              value={segment.speaker}
              onChange={(e) => onUpdate(index, 'speaker', e.target.value)}
              aria-label="講者"
              className="text-xs font-bold text-slate-600 tracking-wide bg-transparent border-b border-transparent hover:border-slate-200 focus:border-indigo-400 focus:outline-none transition-colors w-full max-w-[200px]"
              placeholder="講者"
            />
          </>
        )}
        {onDelete && segment.failedChunk === undefined && (
          <button
            type="button"
            onClick={() => onDelete(index)}
            aria-label="刪除這一段"
            className="ml-auto p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
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
