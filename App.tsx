import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Upload, FileAudio, Play, Loader2, StopCircle, Settings, FileText, Clock, User, FileOutput, FileDown, RefreshCw } from 'lucide-react';
import { decodeAudio, splitAudioBuffer, audioBufferToWav, formatTime, generateSrtContent, parseTimeStringToSeconds } from './utils/audioUtils';
import { transcribeChunk, MODEL_NAME } from './services/geminiService';
import { AppStatus, TranscriptSegment, ProcessingStats } from './types';
import ApiKeyModal from './components/ApiKeyModal';
import QuotaDisplay from './components/QuotaDisplay';
import { saveProgress, loadProgress, clearProgress } from './utils/progressStorage';
import { parseGeminiError, parseAudioError } from './utils/errorHandling';

// Chunk duration in seconds. 
// Gemini 3 Flash has large context, but splitting helps with progress updates and stability.
// 5 minutes is a safe balance.
const CHUNK_DURATION = 300; 

function App() {
  // State
  const [apiKey, setApiKey] = useState<string>('');
  const [isKeyModalOpen, setKeyModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [stats, setStats] = useState<ProcessingStats>({ totalChunks: 0, processedChunks: 0, currentAction: '' });
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [quota, setQuota] = useState(100);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);

  // Refs
  const abortControllerRef = useRef<boolean>(false);
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

  const processAudio = async () => {
    if (!file || !apiKey) return;
    
    abortControllerRef.current = false;
    setStatus(AppStatus.PREPARING);
    setErrorMsg(null);
    
    // 检查是否有保存的进度
    const savedProgress = loadProgress(file.name, file.size);
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
        setTranscripts([]);
      }
    } else {
      setTranscripts([]);
    }
    
    try {
      // 1. Decode
      setStats({ totalChunks: 0, processedChunks: 0, currentAction: '正在解碼音訊檔案 (這可能需要一點時間)...' });
      const audioBuffer = await decodeAudio(file);
      
      if (abortControllerRef.current) return;

      // 2. Split
      setStats(prev => ({ ...prev, currentAction: '正在分割音訊...' }));
      const chunks = splitAudioBuffer(audioBuffer, CHUNK_DURATION);
      const totalChunks = chunks.length;
      
      // 确定起始位置
      const startChunk = savedProgress && savedProgress.transcripts.length > 0 
        ? savedProgress.processedChunks 
        : 0;
      
      setStats({ totalChunks, processedChunks: startChunk, currentAction: '準備開始轉錄...' });
      setStatus(AppStatus.PROCESSING);

      // 3. Process loop
      for (let i = startChunk; i < totalChunks; i++) {
        if (abortControllerRef.current) {
          setStatus(AppStatus.STOPPED);
          // 保存当前进度
          saveProgress(file.name, file.size, transcripts, i, totalChunks);
          break;
        }

        setStats({ 
          totalChunks, 
          processedChunks: i + 1, 
          currentAction: `正在轉錄第 ${i + 1} / ${totalChunks} 個片段...` 
        });

        const chunkBlob = audioBufferToWav(chunks[i]);
        const startTimeOffset = i * CHUNK_DURATION;

        // Decrease quota simulation
        setQuota(prev => Math.max(0, prev - (2 + Math.random() * 2)));

        try {
          // 使用带重试的转录函数
          const newSegments = await transcribeChunk(chunkBlob, apiKey, i, startTimeOffset, { maxRetries: 3 });
          setTranscripts(prev => {
            const updated = [...prev, ...newSegments];
            // 每处理一个块就保存进度
            saveProgress(file.name, file.size, updated, i + 1, totalChunks);
            return updated;
          });
        } catch (err) {
          console.error(err);
          const appError = parseGeminiError(err);
          
          // 如果错误可重试，则记录但继续；否则显示错误消息
          if (!appError.retryable) {
            setErrorMsg(appError.userMessage);
          }
          
          // 添加错误标记到转录结果
          setTranscripts(prev => [...prev, {
            speaker: 'System',
            timestamp: 'Error',
            startTimeSeconds: startTimeOffset,
            text: `[轉錄此片段時發生錯誤 (${i + 1}): ${appError.userMessage}]`
          }]);
        }
      }

      if (!abortControllerRef.current) {
        setStatus(AppStatus.COMPLETED);
        setStats(prev => ({ ...prev, currentAction: '完成！' }));
        // 完成后清除保存的进度
        clearProgress();
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