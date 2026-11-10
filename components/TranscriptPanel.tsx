import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { FileText, FileOutput, FileDown, Loader2, Copy, Check, Users, Undo2 } from 'lucide-react';
import { TranscriptSegment } from '../types';
import TranscriptRow from './TranscriptRow';
import SpeakerPanel from './SpeakerPanel';
import ChunkDivider from './ChunkDivider';
import { chunkIndexOf, speakersByChunk } from '../utils/speakerSwap';

interface TranscriptPanelProps {
  transcripts: TranscriptSegment[];
  /** 原始音檔的網址，用來播放；沒有檔案（例如找回的逐字稿）時為 null */
  audioUrl: string | null;
  isBusy: boolean;
  speakers: { name: string; count: number }[];
  includeTimestamps: boolean;
  copyNotice: string | null;
  onIncludeTimestampsChange: (value: boolean) => void;
  onRenameSpeaker: (from: string, to: string) => void;
  /** 把某一段（每 5 分鐘）裡的兩位講者互換 */
  onSwapSpeakers: (chunk: number, a: string, b: string) => void;
  onUpdateSegment: (index: number, field: keyof TranscriptSegment, value: string | number) => void;
  onDeleteSegment: (index: number) => void;
  /** 最近一次可以復原的動作說明 */
  undoLabel: string | null;
  onUndo: () => void;
  onCopy: () => void;
  onDownloadTxt: () => void;
  onDownloadSrt: () => void;
}

/** 逐字稿結果：工具列（改講者、複製、下載）與每一段的編輯欄 */
const TranscriptPanel: React.FC<TranscriptPanelProps> = ({
  transcripts, audioUrl, isBusy, speakers, includeTimestamps, copyNotice,
  onIncludeTimestampsChange, onRenameSpeaker, onSwapSpeakers, onUpdateSegment, onDeleteSegment, undoLabel, onUndo, onCopy, onDownloadTxt, onDownloadSrt,
}) => {
  const [showSpeakerPanel, setShowSpeakerPanel] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  // 瀏覽器無法播放這個檔案時（少見的格式）隱藏播放器與播放鈕
  const [playable, setPlayable] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const canPlay = !!audioUrl && playable;

  // 手機只固定播放器與復原列（工具列太高）；桌機工具列也固定，播放器接在工具列下方
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [playerTop, setPlayerTop] = useState(0);
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const desktop = window.matchMedia('(min-width: 640px)');
    const update = () => setPlayerTop(desktop.matches ? toolbar.offsetHeight : 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    desktop.addEventListener('change', update);
    return () => {
      observer.disconnect();
      desktop.removeEventListener('change', update);
    };
  }, []);

  // 往前多播半秒，避免開頭的字被切掉
  const playFrom = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, seconds - 0.5);
    void audio.play();
  }, []);

  // 目前播放到的那一段：開始時間不晚於播放位置的最後一段
  const activeIndex = useMemo(() => {
    if (currentTime <= 0) return -1;
    let active = -1;
    for (let i = 0; i < transcripts.length && transcripts[i].startTimeSeconds <= currentTime; i++) {
      if (transcripts[i].failedChunk === undefined) active = i;
    }
    return active;
  }, [transcripts, currentTime]);

  // 每 5 分鐘一段的講者；超過一段、或這段有兩位以上講者時，在段落開頭放分隔線與「對調講者」
  const chunkSpeakers = useMemo(() => speakersByChunk(transcripts), [transcripts]);
  const multiChunk = transcripts.some(t => chunkIndexOf(t.startTimeSeconds) > 0);

  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200">
      {/* 桌機工具列固定在畫面頂端，往下捲也能下載；整份逐字稿跟著頁面捲動，不再有第二層捲軸 */}
      <div ref={toolbarRef} className="px-6 py-4 border-b border-slate-100 bg-slate-50 rounded-t-xl flex justify-between items-center sm:sticky sm:top-0 z-20 flex-wrap gap-3">
        <h3 className="font-bold text-slate-700 flex items-center gap-2">
          <FileText className="w-5 h-5 text-indigo-600" />
          逐字稿結果
        </h3>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            onClick={() => setShowSpeakerPanel(v => !v)}
            aria-expanded={showSpeakerPanel}
            className={`text-xs sm:text-sm font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 ${
              showSpeakerPanel ? 'bg-indigo-100 text-indigo-800' : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            <Users className="w-4 h-4" />
            重新命名講者
          </button>
          <button
            onClick={onCopy}
            className="text-xs sm:text-sm text-slate-600 hover:bg-slate-100 font-medium px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1"
          >
            {copyNotice ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
            {copyNotice ?? '複製全文'}
          </button>
          <div className="h-5 w-px bg-slate-200 mx-1"></div>
          <label className="flex items-center gap-1.5 text-xs sm:text-sm text-slate-600 cursor-pointer select-none hover:text-slate-900 transition-colors">
            <input
              type="checkbox"
              checked={includeTimestamps}
              onChange={(e) => onIncludeTimestampsChange(e.target.checked)}
              className="accent-indigo-600 w-4 h-4 rounded border-slate-300 focus:ring-indigo-500"
            />
            <span>含時間戳記（TXT、複製）</span>
          </label>
          <div className="h-5 w-px bg-slate-200 mx-1"></div>
          <button
            onClick={onDownloadTxt}
            className="text-xs sm:text-sm text-indigo-600 hover:text-indigo-800 font-medium px-3 py-1.5 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1"
          >
            <FileDown className="w-4 h-4" />
            下載 TXT
          </button>
          <button
            onClick={onDownloadSrt}
            className="text-xs sm:text-sm text-white hover:bg-indigo-700 font-medium px-3 py-1.5 bg-indigo-600 rounded-lg transition-colors flex items-center gap-1 shadow-sm"
          >
            <FileOutput className="w-4 h-4" />
            下載 SRT 字幕
          </button>
        </div>
      </div>

      {(canPlay || undoLabel) && (
        <div className="px-6 py-2 border-b border-slate-100 bg-slate-50 sticky z-10 space-y-2" style={{ top: playerTop }}>
        {audioUrl && playable && (
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            preload="metadata"
            aria-label="原始音檔"
            onTimeUpdate={e => setCurrentTime(e.currentTarget.currentTime)}
            onError={() => setPlayable(false)}
            className="w-full h-9"
          />
        )}
        {undoLabel && (
          <div role="status" className="flex items-center gap-3 text-sm text-slate-600">
            <span className="truncate">{undoLabel}</span>
            <button onClick={onUndo} className="shrink-0 flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium">
              <Undo2 className="w-4 h-4" />
              復原
            </button>
          </div>
        )}
        </div>
      )}

      {showSpeakerPanel && <SpeakerPanel speakers={speakers} onRename={onRenameSpeaker} />}

      <div className="divide-y divide-slate-100 p-4 space-y-4">
        {transcripts.map((segment, idx) => {
          const chunk = chunkIndexOf(segment.startTimeSeconds);
          const firstOfChunk = idx === 0 || chunkIndexOf(transcripts[idx - 1].startTimeSeconds) !== chunk;
          const speakersHere = chunkSpeakers.get(chunk) ?? [];
          return (
            <React.Fragment key={segment.id ?? idx}>
              {firstOfChunk && (multiChunk || speakersHere.length >= 2) && (
                <ChunkDivider chunk={chunk} speakers={speakersHere} onSwap={onSwapSpeakers} />
              )}
              <TranscriptRow
                segment={segment}
                index={idx}
                onUpdate={onUpdateSegment}
                onPlay={canPlay ? playFrom : undefined}
                isActive={idx === activeIndex}
                onDelete={onDeleteSegment}
              />
            </React.Fragment>
          );
        })}

        {isBusy && (
           <div className="flex justify-center py-8">
             <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
           </div>
        )}
      </div>
    </div>
  );
};

export default TranscriptPanel;
