import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FileAudio, Play, Loader2, StopCircle, Settings, FileText, Clock, User, FileOutput, FileDown, RefreshCw } from 'lucide-react';
import { decodeAudio, getChunkCount, pcmChunkToWav, formatTime, generateSrtContent, parseTimeStringToSeconds } from './utils/audioUtils';
import { transcribeChunk, MODEL_NAME, requestLog } from './services/geminiService';
import { AppStatus, TranscriptSegment, ProcessingStats } from './types';
import ApiKeyModal from './components/ApiKeyModal';
import { saveProgress, loadProgress, clearProgress } from './utils/progressStorage';
import { parseGeminiError, parseAudioError, ErrorType } from './utils/errorHandling';

// Chunk duration in seconds.
// 實測 Gemini 端的處理量有上限，片段切更短不會更快，反而多了斷句與講者編號不一致；維持 5 分鐘。
const CHUNK_DURATION = 300;

// 同時送出的片段上限。實測同時 8 段時每段反而變慢（Gemini 端排隊處理），總時間沒有縮短，因此設 3。
// 遇到請求次數過多（429）時會自動減半，免費方案也不會一直失敗。
const MAX_CONCURRENCY = 3;

function App() {
  // State
  const [apiKey, setApiKey] = useState<string>('');
  const [isKeyModalOpen, setKeyModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [stats, setStats] = useState<ProcessingStats>({ totalChunks: 0, processedChunks: 0, currentAction: '' });
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [perfReport, setPerfReport] = useState<string | null>(null);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  // Refs
  // 每一輪轉錄各用一個 AbortController：停止後馬上重新開始，上一輪還沒結束的工作也不會混進新的一輪
  const abortControllerRef = useRef<AbortController | null>(null);
  // 轉錄完成後設為 true，避免延後執行的 state 更新又把進度寫回 localStorage
  const progressClosedRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load API Key from local storage or environment
  useEffect(() => {
    const storedKey = localStorage.getItem('gemini_api_key');
    if (storedKey) {
      setApiKey(storedKey);
    }
  }, []);

  const handleSaveKey = (key: string) => {
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  // 檔案沒拖進上傳區就放開時，瀏覽器預設會直接開啟該檔案、離開本頁，先擋掉
  useEffect(() => {
    const preventDefault = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', preventDefault);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', preventDefault);
    };
  }, []);

  const isBusy = status === AppStatus.PROCESSING || status === AppStatus.PREPARING;
  const failedCount = transcripts.filter(t => t.failedChunk !== undefined).length;

  const selectFile = (selected: File) => {
    setFile(selected);
    setStatus(AppStatus.IDLE);
    setTranscripts([]);
    setErrorMsg(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      selectFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    // 轉錄中換檔會讓進行中的結果寫到新檔案上
    if (isBusy) return;
    const dropped = e.dataTransfer.files[0];
    if (dropped) selectFile(dropped);
  };

  const stopProcessing = () => {
    abortControllerRef.current?.abort();
    setStatus(AppStatus.STOPPED);
    setStats(prev => ({ ...prev, currentAction: '已停止，已完成的片段已保存' }));
  };

  const updateTranscriptSegment = (index: number, field: keyof TranscriptSegment, value: string | number) => {
    setTranscripts(prev => {
      const newTranscripts = [...prev];
      newTranscripts[index] = { ...newTranscripts[index], [field]: value };
      return newTranscripts;
    });
  };

  // 轉錄結束後的效能摘要：用來判斷時間花在解碼、等待 API，還是重試
  const buildPerfReport = (totalMs: number, decodeMs: number, minConcurrency: number): string => {
    const ok = requestLog.filter(r => r.ok);
    const failed = requestLog.filter(r => !r.ok);
    const rateLimited = failed.filter(r => /429|quota|rate|RESOURCE_EXHAUSTED/i.test(r.error || ''));
    const secs = (ms: number) => (ms / 1000).toFixed(1);
    const times = ok.map(r => r.ms);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
    console.table(requestLog);
    return [
      `總耗時 ${secs(totalMs)} 秒（解碼音檔 ${secs(decodeMs)} 秒）`,
      `API 請求 ${requestLog.length} 次：成功 ${ok.length}、失敗 ${failed.length}（其中請求次數過多 ${rateLimited.length} 次）`,
      times.length ? `單段請求耗時：平均 ${secs(avg)} 秒，最短 ${secs(Math.min(...times))} 秒，最長 ${secs(Math.max(...times))} 秒` : '',
      ok.length ? `每段 ${CHUNK_DURATION / 60} 分鐘、上傳約 ${ok[0].uploadMB} MB` : '',
      ok.some(r => r.outputTokens !== undefined)
        ? `每段平均輸出 ${Math.round(ok.reduce((a, r) => a + (r.outputTokens || 0), 0) / ok.length)} tokens、思考 ${Math.round(ok.reduce((a, r) => a + (r.thinkingTokens || 0), 0) / ok.length)} tokens`
        : '',
      minConcurrency < MAX_CONCURRENCY
        ? `同時數：從 ${MAX_CONCURRENCY} 自動降到 ${minConcurrency}（遇到請求次數限制）`
        : `同時數：${MAX_CONCURRENCY}`,
      failed.length ? `第一個失敗原因：${failed[0].error}` : '',
    ].filter(Boolean).join('\n');
  };

  // retryFailed：只重送失敗的片段，沿用畫面上（可能已編輯過）的逐字稿
  const processAudio = async (retryFailed = false) => {
    if (!file || !apiKey) return;
    
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const { signal } = controller;
    // API Key 無效或配額用盡時整輪暫停，記下原因
    let fatalError: string | null = null;
    progressClosedRef.current = false;
    requestLog.length = 0;
    setPerfReport(null);
    const runStartedAt = performance.now();
    let decodeMs = 0;
    let minConcurrency = MAX_CONCURRENCY;
    setStatus(AppStatus.PREPARING);
    setErrorMsg(null);
    
    const retryChunks = retryFailed
      ? new Set(transcripts.flatMap(t => t.failedChunk !== undefined ? [t.failedChunk] : []))
      : null;

    // 检查是否有保存的进度
    let savedProgress = retryChunks ? null : loadProgress(file.name, file.size);
    if (retryChunks) {
      setTranscripts(prev => prev.filter(t => t.failedChunk === undefined));
    } else if (savedProgress && savedProgress.transcripts.length > 0) {
      const shouldResume = window.confirm(
        `找到未完成的轉錄進度 (${savedProgress.processedChunks}/${savedProgress.totalChunks} 個片段已完成)。是否要繼續？`
      );
      
      if (shouldResume) {
        // 失敗片段的佔位段落拿掉，這些片段會重送
        setTranscripts(savedProgress.transcripts.filter(t => t.failedChunk === undefined));
        setStats({
          totalChunks: savedProgress.totalChunks,
          processedChunks: savedProgress.processedChunks,
          currentAction: '從上次進度繼續...'
        });
      } else {
        clearProgress();
        savedProgress = null;
        setTranscripts([]);
      }
    } else {
      setTranscripts([]);
    }
    
    try {
      // 1. Decode
      setStats({ totalChunks: 0, processedChunks: 0, currentAction: '正在解碼音訊檔案 (這可能需要一點時間)...' });
      const decodeStartedAt = performance.now();
      let decodePercent = -1;
      const pcm = await decodeAudio(file, {
        signal,
        onProgress: fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent === decodePercent || signal.aborted) return;
          decodePercent = percent;
          setStats({ totalChunks: 0, processedChunks: 0, currentAction: `正在解碼音訊檔案 ${percent}%...` });
        }
      });
      decodeMs = performance.now() - decodeStartedAt;
      
      if (signal.aborted) return;

      // 2. Plan chunks (each chunk is wrapped as WAV only when it is sent)
      const totalChunks = getChunkCount(pcm, CHUNK_DURATION);
      const resuming = !!(savedProgress && savedProgress.transcripts.length > 0 && savedProgress.totalChunks === totalChunks);
      const allChunks = Array.from({ length: totalChunks }, (_, i) => i);
      const completed = new Set<number>(
        retryChunks ? allChunks.filter(i => !retryChunks.has(i))
          : resuming ? savedProgress!.completedChunks
          : []
      );
      // 失敗的片段不算完成，續傳或「重試失敗片段」時會再送一次
      const failed = new Set<number>();
      if (!resuming && !retryChunks) setTranscripts([]);
      const queue = allChunks.filter(i => !completed.has(i));
      let inFlight = 0;

      const updateStats = () => {
        if (signal.aborted) return;
        setStats({
          totalChunks,
          processedChunks: completed.size + failed.size,
          currentAction: `正在同時轉錄 ${inFlight} 個片段（已完成 ${completed.size} / ${totalChunks}）...`
        });
      };

      setStats({ totalChunks, processedChunks: completed.size, currentAction: '準備開始轉錄...' });
      setStatus(AppStatus.PROCESSING);

      // 3. Process chunks with a small worker pool
      const addSegments = (segments: TranscriptSegment[], chunkIndex: number) => {
        const chunkFailed = segments.some(seg => seg.failedChunk !== undefined);
        (chunkFailed ? failed : completed).add(chunkIndex);
        const completedList = [...completed];
        setTranscripts(prev => {
          // 片段完成順序不固定，依時間排序後再顯示（sort 為穩定排序，同段內順序不變）；
          // 以 prev 為基礎，保留使用者在轉錄途中做的編輯
          const updated = [...prev, ...segments].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
          if (!progressClosedRef.current) {
            saveProgress(file.name, file.size, updated, completedList, totalChunks);
          }
          return updated;
        });
        updateStats();
      };

      // 目前允許的同時數：遇到 429 減半（同一波被拒只算一次），之後每連續成功 4 段加回 1
      let concurrencyLimit = MAX_CONCURRENCY;
      let lastCutAt = 0;
      let successesSinceCut = 0;
      const onRateLimited = () => {
        successesSinceCut = 0;
        if (Date.now() - lastCutAt < 5000) return;
        lastCutAt = Date.now();
        concurrencyLimit = Math.max(1, Math.floor(concurrencyLimit / 2));
        minConcurrency = Math.min(minConcurrency, concurrencyLimit);
      };
      const onChunkSucceeded = () => {
        if (concurrencyLimit >= MAX_CONCURRENCY) return;
        successesSinceCut++;
        if (successesSinceCut >= 4) {
          successesSinceCut = 0;
          concurrencyLimit++;
        }
      };

      const worker = async () => {
        while (!signal.aborted) {
          // 同時數被調低時，多出來的 worker 先等其他片段完成
          while (inFlight >= concurrencyLimit && !signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          if (signal.aborted) return;
          const i = queue.shift();
          if (i === undefined) return;

          inFlight++;
          updateStats();
          const startTimeOffset = i * CHUNK_DURATION;

          try {
            const chunkBlob = pcmChunkToWav(pcm, i, CHUNK_DURATION);
            // 使用带重试的转录函数
            const newSegments = await transcribeChunk(chunkBlob, apiKey, i, startTimeOffset, { maxRetries: 3, onRateLimited, signal });
            // 已停止：結果不寫入，這段之後續傳會再送
            if (signal.aborted) return;
            onChunkSucceeded();
            addSegments(newSegments, i);
          } catch (err) {
            if (signal.aborted) return;
            console.error(err);
            const appError = parseGeminiError(err);

            // API Key 無效、或重試後仍超過配額：後面的片段也只會失敗，整輪暫停
            if (appError.type === ErrorType.INVALID_API_KEY || appError.type === ErrorType.QUOTA_EXCEEDED) {
              fatalError = appError.userMessage;
              controller.abort();
              return;
            }

            // 添加错误标记到转录结果
            addSegments([{
              speaker: 'System',
              timestamp: 'Error',
              startTimeSeconds: startTimeOffset,
              text: `[轉錄此片段時發生錯誤 (${i + 1}): ${appError.userMessage}]`,
              failedChunk: i
            }], i);
          } finally {
            inFlight--;
            updateStats();
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, worker));

      // 已有新的一輪開始，這一輪的結果不再更新畫面
      if (abortControllerRef.current !== controller) return;

      if (fatalError) {
        setErrorMsg(`${fatalError}。已完成的片段已保存，處理後再按「開始辨識」即可從中斷處繼續。`);
        setStats(prev => ({ ...prev, currentAction: '已暫停' }));
        setStatus(AppStatus.ERROR);
        return;
      }

      // 使用者按了停止，狀態已由 stopProcessing 設定
      if (signal.aborted) return;

      setStatus(AppStatus.COMPLETED);
      setPerfReport(buildPerfReport(performance.now() - runStartedAt, decodeMs, minConcurrency));
      if (failed.size > 0) {
        // 保留進度，重新整理頁面後也能只重送失敗的片段
        setStats(prev => ({ ...prev, currentAction: `完成，但有 ${failed.size} 個片段失敗` }));
      } else {
        setStats(prev => ({ ...prev, currentAction: '完成！' }));
        // 完成后清除保存的进度
        progressClosedRef.current = true;
        clearProgress();
      }

    } catch (err: any) {
      if (signal.aborted) return;
      console.error("Processing error:", err);
      const appError = err.name === 'AppError' ? err : parseAudioError(err);
      setErrorMsg(appError.userMessage);
      setStatus(AppStatus.ERROR);
    }
  };

  const getBaseFileName = () => {
    if (!file) return 'transcript';
    const name = file.name;
    const lastDot = name.lastIndexOf('.');
    return lastDot === -1 ? name : name.substring(0, lastDot);
  };

  const downloadTxt = () => {
    const content = transcripts
      .map(t => {
        const timeStr = includeTimestamps ? `[${formatTime(t.startTimeSeconds)}] ` : '';
        return `${timeStr}${t.speaker}: ${t.text}`;
      })
      .join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getBaseFileName()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadSrt = () => {
    const content = generateSrtContent(transcripts);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${getBaseFileName()}.srt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4 sm:px-6">
      <ApiKeyModal 
        isOpen={isKeyModalOpen} 
        onClose={() => setKeyModalOpen(false)} 
        onSave={handleSaveKey}
        currentKey={apiKey}
      />

      <header className="w-full max-w-4xl flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight flex items-center gap-3">
            <span className="bg-indigo-600 text-white p-2 rounded-lg">
              <FileAudio className="w-6 h-6" />
            </span>
            Gemini 逐字稿大師
          </h1>
          <div className="text-slate-500 mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
            <span>使用 Gemini 3 Flash 模型進行長音檔分割與精確轉錄</span>
            <span className="hidden sm:inline text-slate-300">|</span>
            <span className="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full font-mono">
              Model: {MODEL_NAME}
            </span>
          </div>
        </div>
        <button 
          onClick={() => setKeyModalOpen(true)}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg shadow-sm transition-colors ${
            apiKey
              ? 'bg-white border border-slate-200 hover:bg-slate-50 text-slate-700'
              : 'bg-indigo-600 hover:bg-indigo-700 text-white'
          }`}
        >
          <Settings className="w-4 h-4" />
          {apiKey ? (
            <span>API Key <span className="font-mono">…{apiKey.slice(-4)}</span></span>
          ) : (
            <span>設定 API Key</span>
          )}
        </button>
      </header>

      <main className="w-full max-w-4xl space-y-6">
        
        {/* Upload and Status */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
             <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
               <Upload className="w-5 h-5 text-indigo-600" />
               上傳音訊檔案
             </h2>
             
             <div 
               onClick={() => !isBusy && fileInputRef.current?.click()}
               onDragOver={(e) => {
                 e.preventDefault();
                 if (!isBusy) setIsDragging(true);
               }}
               onDragLeave={(e) => {
                 // 移到子元素上也會觸發 dragleave，真的離開上傳區才取消
                 if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
               }}
               onDrop={handleDrop}
               className={`border-2 border-dashed rounded-xl p-8 text-center transition-all ${
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
                 accept="audio/*" 
                 disabled={isBusy}
                 className="hidden" 
               />
               {file ? (
                 <div className="text-indigo-700 font-medium flex flex-col items-center">
                   <FileAudio className="w-10 h-10 mb-2" />
                   {file.name}
                   <span className="text-xs text-indigo-500 mt-1">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                 </div>
               ) : (
                 <div className="text-slate-500 flex flex-col items-center">
                   <Upload className="w-10 h-10 mb-2 text-slate-300" />
                   <span>點擊或拖曳上傳音檔 (MP3, WAV, M4A)</span>
                 </div>
               )}
             </div>

             <div className="mt-6 flex justify-end gap-3">
                {isBusy ? (
                  <button 
                    onClick={stopProcessing}
                    className="px-6 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <StopCircle className="w-5 h-5" />
                    停止辨識
                  </button>
                ) : (
                  <>
                    {status === AppStatus.COMPLETED && failedCount > 0 && (
                      <button 
                        onClick={() => processAudio(true)}
                        disabled={!file || !apiKey}
                        className="px-6 py-2.5 bg-amber-500 hover:bg-amber-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                      >
                        重試失敗的 {failedCount} 段
                        <RefreshCw className="w-4 h-4" />
                      </button>
                    )}
                    <button 
                      onClick={() => processAudio()}
                      disabled={!file || !apiKey}
                      className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                    >
                      {status === AppStatus.COMPLETED ? '重新辨識' : '開始辨識'}
                      <Play className="w-4 h-4 fill-current" />
                    </button>
                  </>
                )}
             </div>
          </div>

          <div className="md:col-span-1">
             {/* Progress Status Card */}
             {status !== AppStatus.IDLE && (
               <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                 <div className="flex items-center gap-2 mb-2 font-medium text-slate-700">
                    {isBusy ? (
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                    ) : status === AppStatus.COMPLETED ? (
                      <div className={`w-2 h-2 rounded-full ${failedCount > 0 ? 'bg-amber-500' : 'bg-green-500'}`} />
                    ) : (
                      <div className="w-2 h-2 rounded-full bg-red-500" />
                    )}
                    {stats.currentAction || '準備中...'}
                 </div>
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
                   <pre className="text-xs text-slate-500 mt-3 whitespace-pre-wrap bg-slate-50 rounded p-2">{perfReport}</pre>
                 )}
               </div>
             )}
          </div>
        </div>

        {/* Transcript Results */}
        {transcripts.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex justify-between items-center sticky top-0 z-10 flex-wrap gap-2">
              <h3 className="font-bold text-slate-700 flex items-center gap-2">
                <FileText className="w-5 h-5 text-indigo-600" />
                逐字稿結果
              </h3>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs sm:text-sm text-slate-600 cursor-pointer select-none hover:text-slate-900 transition-colors">
                  <input 
                    type="checkbox" 
                    checked={includeTimestamps}
                    onChange={(e) => setIncludeTimestamps(e.target.checked)}
                    className="accent-indigo-600 w-4 h-4 rounded border-slate-300 focus:ring-indigo-500"
                  />
                  <span>包含時間戳記</span>
                </label>
                <div className="h-5 w-px bg-slate-200 mx-1"></div>
                <button 
                  onClick={downloadTxt}
                  className="text-xs sm:text-sm text-indigo-600 hover:text-indigo-800 font-medium px-3 py-1.5 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors flex items-center gap-1"
                >
                  <FileDown className="w-4 h-4" />
                  下載 .txt
                </button>
                <button 
                  onClick={downloadSrt}
                  className="text-xs sm:text-sm text-white hover:bg-indigo-700 font-medium px-3 py-1.5 bg-indigo-600 rounded-lg transition-colors flex items-center gap-1 shadow-sm"
                >
                  <FileOutput className="w-4 h-4" />
                  匯出 SRT
                </button>
              </div>
            </div>
            
            <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto p-4 space-y-4">
              {transcripts.map((segment, idx) => (
                <div key={idx} className="flex gap-4 group items-start hover:bg-slate-50/50 transition-colors">
                   <div className="flex-shrink-0 w-28 text-right pt-2">
                      <div className="inline-flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded border border-transparent focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
                        <Clock className="w-3 h-3 text-slate-400" />
                        <input
                          key={segment.startTimeSeconds}
                          type="text"
                          defaultValue={formatTime(segment.startTimeSeconds)}
                          onBlur={(e) => {
                             const seconds = parseTimeStringToSeconds(e.target.value);
                             if (seconds !== null) {
                               updateTranscriptSegment(idx, 'startTimeSeconds', seconds);
                               // Force re-render of formatted value if strictly needed, 
                               // but normally we just need the model to update.
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
                          onChange={(e) => updateTranscriptSegment(idx, 'speaker', e.target.value)}
                          className="text-xs font-bold text-slate-600 uppercase tracking-wide bg-transparent border-b border-transparent hover:border-slate-200 focus:border-indigo-400 focus:outline-none transition-colors w-full max-w-[200px]"
                          placeholder="說話者"
                        />
                      </div>
                      <textarea
                        value={segment.text}
                        onChange={(e) => updateTranscriptSegment(idx, 'text', e.target.value)}
                        className="w-full text-slate-800 leading-relaxed bg-transparent border border-transparent hover:bg-white hover:border-slate-200 focus:bg-white focus:border-indigo-300 focus:ring-2 focus:ring-indigo-50 rounded p-2 -ml-2 focus:outline-none transition-all resize-y min-h-[60px]"
                      />
                   </div>
                </div>
              ))}
              
              {isBusy && (
                 <div className="flex justify-center py-8">
                   <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
                 </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;