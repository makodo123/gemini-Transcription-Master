import React from 'react';
import { Loader2, CheckCircle2, Circle, FileText } from 'lucide-react';
import { AppStatus, ProcessingStats } from '../types';
import { PerfReport } from '../hooks/useTranscription';

interface StatusCardProps {
  status: AppStatus;
  isBusy: boolean;
  stats: ProcessingStats;
  failedCount: number;
  errorMsg: string | null;
  perfReport: PerfReport | null;
  hasApiKey: boolean;
  hasFile: boolean;
  /** 畫面上已有逐字稿（例如找回上次保存的） */
  hasTranscript: boolean;
  /** 找回的逐字稿原本是哪個音檔 */
  restoredFileName: string | null;
}

/** 右側卡片：還沒開始時顯示使用步驟，之後顯示進度、錯誤與完成摘要 */
const StatusCard: React.FC<StatusCardProps> = ({
  status, isBusy, stats, failedCount, errorMsg, perfReport, hasApiKey, hasFile, hasTranscript, restoredFileName,
}) => (
  <div className="md:col-span-1">
     {/* 找回的逐字稿：告訴使用者怎麼接上音檔，而不是引導重新轉錄 */}
     {status === AppStatus.IDLE && hasTranscript && (
       <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 text-sm text-slate-700 space-y-2">
         <h3 className="font-medium flex items-center gap-2">
           <FileText className="w-4 h-4 text-indigo-600" />
           上次保存的逐字稿
         </h3>
         {hasFile ? (
           <p>已接上音檔，按時間旁的 ▶ 就能邊聽邊校對。</p>
         ) : (
           <p>
             選回同一個音檔{restoredFileName && <>（<span className="break-all">{restoredFileName}</span>）</>}，就能按時間旁的 ▶ 邊聽邊校對；也可以直接下載或複製。
           </p>
         )}
       </div>
     )}

     {/* 使用步驟：還沒開始時告訴使用者下一步 */}
     {status === AppStatus.IDLE && !hasTranscript && (
       <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
         <h3 className="font-medium text-slate-700 mb-3">使用步驟</h3>
         <ol className="space-y-2 text-sm">
           {[
             { done: hasApiKey, label: '設定 Gemini API Key（右上角）' },
             { done: hasFile, label: '選擇或拖曳音檔' },
             { done: false, label: '按「開始轉錄」' },
           ].map((step, i) => (
             <li key={i} className={`flex items-center gap-2 ${step.done ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
               {step.done
                 ? <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                 : <Circle className="w-4 h-4 text-slate-300 shrink-0" />}
               {step.label}
             </li>
           ))}
         </ol>
       </div>
     )}

     {/* Progress Status Card */}
     {status !== AppStatus.IDLE && (
       <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
         <div className="flex items-center gap-2 mb-2 font-medium text-slate-700">
            {isBusy ? (
              <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
            ) : status === AppStatus.COMPLETED ? (
              <div className={`w-2 h-2 rounded-full ${failedCount > 0 ? 'bg-amber-500' : 'bg-green-500'}`} />
            ) : (
              // 自己按停止不是錯誤，用灰色；出錯暫停才用紅色
              <div className={`w-2 h-2 rounded-full shrink-0 ${status === AppStatus.STOPPED ? 'bg-slate-400' : 'bg-red-500'}`} />
            )}
            {stats.currentAction || '準備中…'}
         </div>
         {stats.note && <p className="text-sm text-slate-600 mb-2">{stats.note}</p>}
         {stats.totalChunks > 0 && (
           <div className="w-full bg-slate-100 rounded-full h-2 mt-2">
             <div
               className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
               style={{ width: `${(stats.processedChunks / stats.totalChunks) * 100}%` }}
             />
           </div>
         )}
         {errorMsg && (
           <p className="text-xs text-red-500 mt-2">{errorMsg}</p>
         )}
         {perfReport && (
           <div className="mt-3 text-sm text-slate-600">
             <p>{perfReport.summary}</p>
             <details className="mt-2">
               <summary className="text-xs text-slate-400 cursor-pointer select-none">詳細資訊</summary>
               <pre className="text-xs text-slate-500 mt-2 whitespace-pre-wrap bg-slate-50 rounded p-2">{perfReport.details}</pre>
             </details>
           </div>
         )}
       </div>
     )}
  </div>
);

export default StatusCard;
