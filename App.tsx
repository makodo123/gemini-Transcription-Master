import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FileAudio, Play, Loader2, StopCircle, Settings, FileText, Clock, User, FileOutput, FileDown, RefreshCw } from 'lucide-react';
import { decodeAudio, getChunkCount, extractChunk, audioBufferToWav, formatTime, generateSrtContent, parseTimeStringToSeconds } from './utils/audioUtils';
import { transcribeChunk, MODEL_NAME, requestLog } from './services/geminiService';
import { AppStatus, TranscriptSegment, ProcessingStats } from './types';
import ApiKeyModal from './components/ApiKeyModal';
import QuotaDisplay from './components/QuotaDisplay';
import { saveProgress, loadProgress, clearProgress } from './utils/progressStorage';
import { parseGeminiError, parseAudioError } from './utils/errorHandling';

// Chunk duration in seconds.
// 每段的回應時間主要花在逐字產生文字，片段越短單段越快；3 分鐘兼顧速度與斷句。
const CHUNK_DURATION = 180;

// 同時送出的片段上限。片段彼此獨立，並行可大幅縮短長音檔的總時間。
// 遇到請求次數過多（429）時會自動減半，免費方案也不會一直失敗。
const MAX_CONCURRENCY = 8;

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
  const [quota, setQuota] = useState(100);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);

  // Refs
  const abortControllerRef = useRef<boolean>(false);
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
    setQuota(100); // Reset simulation
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus(AppStatus.IDLE);
      setTranscripts([]);
      setErrorMsg(null);
    }
  };

  const stopProcessing = () => {
    abortControllerRef.current = true;
    setStatus(AppStatus.STOPPED);
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
      minConcurrency < MAX_CONCURRENCY
        ? `同時數：從 ${MAX_CONCURRENCY} 自動降到 ${minConcurrency}（遇到請求次數限制）`
        : `同時數：${MAX_CONCURRENCY}`,
      failed.length ? `第一個失敗原因：${failed[0].error}` : '',
    ].filter(Boolean).join('\n');
  };

  const processAudio = async () => {
    if (!file || !apiKey) return;
    
    abortControllerRef.current = false;
    progressClosedRef.current = false;
    requestLog.length = 0;
    setPerfReport(null);
    const runStartedAt = performance.now();
    let decodeMs = 0;
    let minConcurrency = MAX_CONCURRENCY;
    setStatus(AppStatus.PREPARING);
    setErrorMsg(null);
    
    // 检查是否有保存的进度
    let savedProgress = loadProgress(file.name, file.size);
    if (savedProgress && savedProgress.transcripts.length > 0) {
      const shouldResume = window.confirm(
        `找到未完成的轉錄進度 (${savedProgress.processedChunks}/${savedProgress.totalChunks} 個片段已完成)。是否要繼續？`
      );
      
      if (shouldResume) {
        setTranscripts(savedProgress.transcripts);
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
      const audioBuffer = await decodeAudio(file);
      decodeMs = performance.now() - decodeStartedAt;
      
      if (abortControllerRef.current) return;

      // 2. Plan chunks (each chunk is cut and resampled only when it is sent)
      const totalChunks = getChunkCount(audioBuffer, CHUNK_DURATION);
      const resuming = !!(savedProgress && savedProgress.transcripts.length > 0 && savedProgress.totalChunks === totalChunks);
      const completed = new Set<number>(resuming ? savedProgress!.completedChunks : []);
      if (!resuming) setTranscripts([]);
      const queue = Array.from({ length: totalChunks }, (_, i) => i).filter(i => !completed.has(i));
      let inFlight = 0;

      const updateStats = () => setStats({
        totalChunks,
        processedChunks: completed.size,
        currentAction: `正在同時轉錄 ${inFlight} 個片段（已完成 ${completed.size} / ${totalChunks}）...`
      });

      setStats({ totalChunks, processedChunks: completed.size, currentAction: '準備開始轉錄...' });
      setStatus(AppStatus.PROCESSING);

      // 3. Process chunks with a small worker pool
      const addSegments = (segments: TranscriptSegment[], chunkIndex: number) => {
        completed.add(chunkIndex);
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
        while (!abortControllerRef.current) {
          // 同時數被調低時，多出來的 worker 先等其他片段完成
          while (inFlight >= concurrencyLimit && !abortControllerRef.current) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          if (abortControllerRef.current) return;
          const i = queue.shift();
          if (i === undefined) return;

          inFlight++;
          updateStats();
          const startTimeOffset = i * CHUNK_DURATION;

          // Decrease quota simulation
          setQuota(prev => Math.max(0, prev - (2 + Math.random() * 2)));

          try {
            const chunkBlob = audioBufferToWav(await extractChunk(audioBuffer, i, CHUNK_DURATION));
            // 使用带重试的转录函数
            const newSegments = await transcribeChunk(chunkBlob, apiKey, i, startTimeOffset, { maxRetries: 3, onRateLimited });
            onChunkSucceeded();
            addSegments(newSegments, i);
          } catch (err) {
            console.error(err);
            const appError = parseGeminiError(err);

            // 如果错误可重试，则记录但继续；否则显示错误消息
            if (!appError.retryable) {
              setErrorMsg(appError.userMessage);
            }

            // 添加错误标记到转录结果
            addSegments([{
              speaker: 'System',
              timestamp: 'Error',
              startTimeSeconds: startTimeOffset,
              text: `[轉錄此片段時發生錯誤 (${i + 1}): ${appError.userMessage}]`
            }], i);
          } finally {
            inFlight--;
            updateStats();
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, worker));

      if (abortControllerRef.current) {
        setStatus(AppStatus.STOPPED);
        return;
      }

      if (!abortControllerRef.current) {
        setStatus(AppStatus.COMPLETED);
        setStats(prev => ({ ...prev, currentAction: '完成！' }));
        // 完成后清除保存的进度
        progressClosedRef.current = true;
        clearProgress();
        setPerfReport(buildPerfReport(performance.now() - runStartedAt, decodeMs, minConcurrency));
      }

    } catch (err: any) {
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
          className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-slate-50 text-slate-700 transition-colors"
        >
          <Settings className="w-4 h-4" />
          <span>API Key 設定</span>
        </button>
      </header>

      <main className="w-full max-w-4xl space-y-6">
        
        {/* Quota and Status Bar */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
             <h2 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
               <Upload className="w-5 h-5 text-indigo-600" />
               上傳音訊檔案
             </h2>
             
             <div 
               onClick={() => fileInputRef.current?.click()}
               className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
                 file ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50'
               }`}
             >
               <input 
                 type="file" 
                 ref={fileInputRef} 
                 onChange={handleFileChange} 
                 accept="audio/*" 
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
                {status === AppStatus.PROCESSING || status === AppStatus.PREPARING ? (
                  <button 
                    onClick={stopProcessing}
                    className="px-6 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <StopCircle className="w-5 h-5" />
                    停止辨識
                  </button>
                ) : (
                  <button 
                    onClick={processAudio}
                    disabled={!file || !apiKey}
                    className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    {status === AppStatus.COMPLETED ? '重新辨識' : '開始辨識'}
                    <Play className="w-4 h-4 fill-current" />
                  </button>
                )}
             </div>
          </div>

          <div className="md:col-span-1">
             <QuotaDisplay quotaPercentage={Math.round(quota)} apiKey={apiKey} />
             
             {/* Progress Status Card */}
             {status !== AppStatus.IDLE && (
               <div className="mt-4 bg-white rounded-xl shadow-sm border border-slate-200 p-4">
                 <div className="flex items-center gap-2 mb-2 font-medium text-slate-700">
                    {status === AppStatus.PROCESSING || status === AppStatus.PREPARING ? (
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-600" />
                    ) : status === AppStatus.COMPLETED ? (
                      <div className="w-2 h-2 rounded-full bg-green-500" />
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
                   <div className="flex-shrink-0 w-24 text-right pt-2">
                      <div className="inline-flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded border border-transparent focus-within:border-indigo-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
                        <Clock className="w-3 h-3 text-slate-400" />
                        <input
                          key={segment.startTimeSeconds}
                          type="text"
                          defaultValue={formatTime(segment.startTimeSeconds)}
                          onBlur={(e) => {
                             const seconds = parseTimeStringToSeconds(e.target.value);
                             if (seconds >= 0) {
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
                          className="w-12 bg-transparent text-xs font-mono text-slate-600 focus:outline-none text-center"
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
              
              {(status === AppStatus.PROCESSING || status === AppStatus.PREPARING) && (
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