import React, { useRef, useState } from 'react';
import { Upload, FileAudio, Play, StopCircle, RefreshCw, Info, History, AlertCircle } from 'lucide-react';
import { AppStatus, SpeakerHint } from '../types';
import SpeakerHintsEditor from './SpeakerHintsEditor';
import { formatTime } from '../utils/audioUtils';
import { CHUNK_DURATION } from '../constants';

interface PendingProgress {
  fileName: string;
  processedChunks: number;
  totalChunks: number;
}

interface UploadCardProps {
  file: File | null;
  fileDuration: number | null;
  /** 會分成幾段、預估秒數（沒有速度紀錄時為 null） */
  fileEstimate: { chunks: number; seconds: number | null } | null;
  status: AppStatus;
  isBusy: boolean;
  canStart: boolean;
  /** 開始按鈕：重新轉錄會清掉目前的逐字稿，用次要樣式 */
  startLabel: '開始轉錄' | '繼續轉錄' | '重新轉錄';
  failedCount: number;
  pendingProgress: PendingProgress | null;
  pendingMatchesFile: boolean;
  /** 選到無法使用的檔案時的說明 */
  fileError: string | null;
  /** 轉錄前填的講者 */
  speakerHints: SpeakerHint[];
  onSpeakerHintsChange: (hints: SpeakerHint[]) => void;
  /** 名單是上一場錄音留下的，提醒確認 */
  speakerHintsFromBefore: boolean;
  /** 已有逐字稿：改名單只影響下一次轉錄 */
  speakerHintsApplyNextTime: boolean;
  onSelectFile: (file: File) => void;
  onDiscardPending: () => void;
  onStart: () => void;
  onRetryFailed: () => void;
  onStop: () => void;
}

/** 上傳區：未完成進度提醒、選檔（點擊、拖曳、鍵盤）、音檔資訊與開始／停止按鈕 */
const UploadCard: React.FC<UploadCardProps> = ({
  file, fileDuration, fileEstimate, status, isBusy, canStart, startLabel, failedCount,
  pendingProgress, pendingMatchesFile, fileError, speakerHints, onSpeakerHintsChange, speakerHintsFromBefore, speakerHintsApplyNextTime, onSelectFile, onDiscardPending, onStart, onRetryFailed, onStop,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      onSelectFile(e.target.files[0]);
    }
    // 清空選取，再選同一個檔案時也會觸發
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    // 轉錄中換檔會讓進行中的結果寫到新檔案上
    if (isBusy) return;
    const dropped = e.dataTransfer.files[0];
    if (dropped) onSelectFile(dropped);
  };

  return (
    <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
       <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
         <Upload className="w-5 h-5 text-indigo-600" />
         上傳錄音
       </h2>

       {status === AppStatus.IDLE && pendingProgress && (
         <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900 flex items-start gap-2">
           <History className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
           {pendingMatchesFile ? (
             <p>這個檔案有上次未完成的轉錄（已完成 {pendingProgress.processedChunks} / {pendingProgress.totalChunks} 段），按「繼續轉錄」可從中斷處接著做。</p>
           ) : (
             <div className="flex-grow">
               <p>
                 有未完成的轉錄：<span className="font-medium break-all">{pendingProgress.fileName}</span>
                 （已完成 {pendingProgress.processedChunks} / {pendingProgress.totalChunks} 段）。重新選擇這個檔案即可從中斷處繼續。
               </p>
               <button onClick={onDiscardPending} className="mt-1 text-xs text-amber-700 underline hover:text-amber-900">
                 捨棄這份進度
               </button>
             </div>
           )}
         </div>
       )}

       <div
         role="button"
         tabIndex={isBusy ? -1 : 0}
         aria-disabled={isBusy}
         aria-label={file ? `已選擇 ${file.name}，按下可換成其他音檔` : '選擇音檔'}
         onClick={() => !isBusy && fileInputRef.current?.click()}
         onKeyDown={(e) => {
           if (isBusy || (e.key !== 'Enter' && e.key !== ' ')) return;
           e.preventDefault();
           fileInputRef.current?.click();
         }}
         onDragOver={(e) => {
           e.preventDefault();
           if (!isBusy) setIsDragging(true);
         }}
         onDragLeave={(e) => {
           // 移到子元素上也會觸發 dragleave，真的離開上傳區才取消
           if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
         }}
         onDrop={handleDrop}
         className={`border-2 border-dashed rounded-xl p-8 text-center transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 ${
           isBusy ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
         } ${
           isDragging ? 'border-indigo-500 bg-indigo-100'
             : file ? 'border-indigo-500 bg-indigo-50'
             : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'
         }`}
       >
         <input
           type="file"
           ref={fileInputRef}
           onChange={handleFileChange}
           accept="audio/*,video/*"
           disabled={isBusy}
           className="hidden"
         />
         {file ? (
           <div className="text-indigo-700 font-medium flex flex-col items-center">
             <FileAudio className="w-10 h-10 mb-2" />
             {file.name}
             <span className="text-xs text-indigo-500 mt-1">
               {(file.size / 1024 / 1024).toFixed(1)} MB
               {fileDuration !== null && fileEstimate && <>・長度 {formatTime(fileDuration)}・會分成 {fileEstimate.chunks} 段</>}
             </span>
             {fileEstimate && (
               <span className="text-xs text-slate-500 font-normal mt-1">
                 {fileEstimate.seconds === null
                   ? '第一次轉錄完成後，這裡會依您的轉錄速度顯示預估時間'
                   : `預估需要${fileEstimate.seconds < 60 ? '不到 1 分鐘' : `約 ${Math.round(fileEstimate.seconds / 60)} 分鐘`}（依您上次在這台裝置的轉錄速度估算）`}
               </span>
             )}
           </div>
         ) : (
           <div className="text-slate-500 flex flex-col items-center">
             <Upload className="w-10 h-10 mb-2 text-slate-300" />
             <span>點擊選擇，或把音檔、影片拖曳到這裡</span>
             <span className="text-xs text-slate-400 mt-1">支援 MP3、M4A、WAV，以及 MP4、MOV 影片的聲音</span>
           </div>
         )}
       </div>

       {fileError && (
         <p role="alert" className="mt-3 text-sm text-red-600 flex items-start gap-1.5">
           <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
           {fileError}
         </p>
       )}

       <SpeakerHintsEditor
         hints={speakerHints}
         disabled={isBusy}
         fromBefore={speakerHintsFromBefore}
         applyNextTime={speakerHintsApplyNextTime && !isBusy}
         onChange={onSpeakerHintsChange}
       />

       <p className="mt-3 text-xs text-slate-600 flex items-start gap-1.5">
         <Info className="w-3.5 h-3.5 mt-px shrink-0" />
         音訊會在您的瀏覽器中切成每 {CHUNK_DURATION / 60} 分鐘一段，直接傳送給 Google Gemini 轉錄。
       </p>

       <div className="mt-6 flex justify-end gap-3">
          {isBusy ? (
            <button
              onClick={onStop}
              className="px-6 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
            >
              <StopCircle className="w-5 h-5" />
              停止轉錄
            </button>
          ) : (
            <>
              {status === AppStatus.COMPLETED && failedCount > 0 && (
                <button
                  onClick={onRetryFailed}
                  disabled={!canStart}
                  className="px-6 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                >
                  重試失敗的 {failedCount} 段
                  <RefreshCw className="w-4 h-4" />
                </button>
              )}
              <button
                onClick={onStart}
                disabled={!canStart}
                className={`px-6 py-2.5 rounded-lg font-medium flex items-center gap-2 transition-colors disabled:cursor-not-allowed ${
                  // 已有逐字稿時主要該做的是校對、下載，重新轉錄會重花額度，改成次要樣式
                  startLabel === '重新轉錄'
                    ? 'bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:text-slate-400'
                    : 'bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white shadow-sm'
                }`}
              >
                {startLabel}
                {startLabel === '重新轉錄' ? <RefreshCw className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current" />}
              </button>
            </>
          )}
       </div>
    </div>
  );
};

export default UploadCard;
