import { useState, useRef, useMemo, useCallback } from 'react';
import { decodeAudio, getChunkCount, pcmChunkToWav, chunkWindow, formatTime, TRANSCRIBE_SAMPLE_RATE } from '../utils/audioUtils';
import { keepOwnedSegments, removeBoundaryDuplicates } from '../utils/chunkBoundary';
import { transcribeChunk, MODEL_NAME, getActiveModel, requestLog } from '../services/geminiService';
import { AppStatus, TranscriptSegment, ProcessingStats } from '../types';
import { saveProgress, loadProgress, clearProgress } from '../utils/progressStorage';
import { parseGeminiError, parseAudioError, ErrorType } from '../utils/errorHandling';
import { saveSpeedHistory } from '../utils/speedHistory';
import { CHUNK_DURATION, CHUNK_OVERLAP, MAX_CONCURRENCY } from '../constants';

export type TranscribeMode = 'start' | 'retryFailed' | 'restart';

/** 可以復原的編輯：只記下改了什麼，復原時只把那部分改回來，不影響之後的其他修改 */
export type UndoEntry =
  | { kind: 'delete'; segment: TranscriptSegment; label: string }
  | { kind: 'rename'; ids: string[]; from: string; to: string; label: string };

const MAX_UNDO = 20;
const preview = (text: string) => (text.length > 12 ? `${text.slice(0, 12)}…` : text);
export interface PerfReport { summary: string; details: string }

// 每一段逐字稿的穩定 id，讓列表在插入新段落、重新排序時不會把輸入框對錯段落。
// id 會跟著進度保存，加上每次載入頁面不同的前綴，續傳時新舊段落的 id 才不會重複
const segmentIdPrefix = Math.random().toString(36).slice(2, 8);
let nextSegmentId = 0;
const withId = (segment: TranscriptSegment): TranscriptSegment =>
  segment.id ? segment : { ...segment, id: `seg-${segmentIdPrefix}-${nextSegmentId++}` };

// 轉錄結束後的摘要；詳細數據用來判斷時間花在解碼、等待 API，還是重試
const buildPerfReport = (totalMs: number, decodeMs: number, minConcurrency: number, chunkCount: number): PerfReport => {
  const ok = requestLog.filter(r => r.ok);
  const failed = requestLog.filter(r => !r.ok);
  const rateLimited = failed.filter(r => /429|quota|rate|RESOURCE_EXHAUSTED/i.test(r.error || ''));
  const secs = (ms: number) => (ms / 1000).toFixed(1);
  const times = ok.map(r => r.ms);
  const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;
  console.table(requestLog);
  const summary = `這次轉錄了 ${chunkCount} 段（每段 ${CHUNK_DURATION / 60} 分鐘），共花 ${secs(totalMs)} 秒`;
  const details = [
    getActiveModel() === MODEL_NAME
      ? `模型：${MODEL_NAME}`
      : `模型：${getActiveModel()}（預設的 ${MODEL_NAME} 已無法使用，自動改用）`,
    `總耗時 ${secs(totalMs)} 秒（讀取音檔 ${secs(decodeMs)} 秒）`,
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
  return { summary, details };
};

/**
 * 轉錄流程與它的狀態：讀取音檔、分段並行送出、重試、續傳、停止，以及逐字稿的編輯。
 */
export const useTranscription = (file: File | null, apiKey: string) => {
  const [status, setStatus] = useState<AppStatus>(AppStatus.IDLE);
  const [stats, setStats] = useState<ProcessingStats>({ totalChunks: 0, processedChunks: 0, currentAction: '' });
  const [transcripts, setTranscripts] = useState<TranscriptSegment[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [perfReport, setPerfReport] = useState<PerfReport | null>(null);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  // 讓穩定的 callback（useCallback）也能讀到最新的逐字稿
  const transcriptsRef = useRef(transcripts);
  transcriptsRef.current = transcripts;

  // 每一輪轉錄各用一個 AbortController：停止後馬上重新開始，上一輪還沒結束的工作也不會混進新的一輪
  const abortControllerRef = useRef<AbortController | null>(null);
  // 轉錄完成後設為 true，避免延後執行的 state 更新又把進度寫回 localStorage
  const progressClosedRef = useRef<boolean>(false);

  const isBusy = status === AppStatus.PROCESSING || status === AppStatus.PREPARING;
  const failedCount = transcripts.filter(t => t.failedChunk !== undefined).length;

  /** 換檔時回到初始狀態 */
  const reset = () => {
    setStatus(AppStatus.IDLE);
    setTranscripts([]);
    setUndoStack([]);
    setErrorMsg(null);
    setPerfReport(null);
  };

  const stop = () => {
    abortControllerRef.current?.abort();
    setStatus(AppStatus.STOPPED);
    setStats(prev => ({ ...prev, currentAction: '已停止', note: '已完成的段落都已保存，按「繼續轉錄」可以從中斷處接著做。' }));
  };

  // 依出現順序列出講者與段數（不含轉錄失敗的佔位段落）
  const speakers = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of transcripts) {
      if (t.failedChunk === undefined) counts.set(t.speaker, (counts.get(t.speaker) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }, [transcripts]);

  const pushUndo = (entry: UndoEntry) => setUndoStack(stack => [...stack.slice(-(MAX_UNDO - 1)), entry]);

  const renameSpeaker = (from: string, to: string) => {
    const ids = transcripts.filter(t => t.speaker === from && t.failedChunk === undefined).map(t => t.id!);
    if (ids.length === 0) return;
    setTranscripts(prev => prev.map(t => ids.includes(t.id!) ? { ...t, speaker: to } : t));
    pushUndo({ kind: 'rename', ids, from, to, label: `已將「${from}」改名為「${to}」（${ids.length} 段）` });
  };

  // 穩定的函式，逐字稿每一段（memo）不會因此重繪
  const deleteSegment = useCallback((index: number) => {
    const segment = transcriptsRef.current[index];
    if (!segment) return;
    setTranscripts(prev => prev.filter(t => t !== segment));
    setUndoStack(stack => [...stack.slice(-(MAX_UNDO - 1)), { kind: 'delete', segment, label: `已刪除「${preview(segment.text)}」` }]);
  }, []);

  /** 打開自動保存的逐字稿 */
  const restore = (segments: TranscriptSegment[]) => {
    setTranscripts(segments.map(withId));
    setStatus(AppStatus.IDLE);
    setErrorMsg(null);
    setPerfReport(null);
    setUndoStack([]);
  };

  /** 復原最近一次刪除或改名；之後做的其他修改保留 */
  const undo = () => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack(stack => stack.slice(0, -1));
    if (entry.kind === 'delete') {
      setTranscripts(prev => [...prev, entry.segment].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds));
    } else {
      setTranscripts(prev => prev.map(t => entry.ids.includes(t.id!) && t.speaker === entry.to ? { ...t, speaker: entry.from } : t));
    }
  };

  // 用 useCallback 保持同一個函式，逐字稿每一段（memo）才不會在打字時全部重繪
  const updateSegment = useCallback((index: number, field: keyof TranscriptSegment, value: string | number) => {
    setTranscripts(prev => {
      const newTranscripts = [...prev];
      newTranscripts[index] = { ...newTranscripts[index], [field]: value };
      // 改了時間就依時間重新排序，畫面順序和匯出一致
      return field === 'startTimeSeconds'
        ? newTranscripts.sort((a, b) => a.startTimeSeconds - b.startTimeSeconds)
        : newTranscripts;
    });
  }, []);

  // start：開始（有未完成進度時詢問是否續傳）；retryFailed：只重送失敗的段落，沿用畫面上（可能已編輯過）的逐字稿；
  // restart：捨棄目前結果與進度，整個重新轉錄
  const start = async (mode: TranscribeMode = 'start') => {
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
    setUndoStack([]);

    const retryChunks = mode === 'retryFailed'
      ? new Set(transcripts.flatMap(t => t.failedChunk !== undefined ? [t.failedChunk] : []))
      : null;
    if (mode === 'restart') clearProgress();

    // 检查是否有保存的进度
    let savedProgress = mode === 'start' ? loadProgress(file.name, file.size) : null;
    if (retryChunks) {
      setTranscripts(prev => prev.filter(t => t.failedChunk === undefined));
    } else if (savedProgress && savedProgress.transcripts.length > 0) {
      const shouldResume = window.confirm(
        `這個檔案有上次未完成的轉錄（已完成 ${savedProgress.processedChunks} / ${savedProgress.totalChunks} 段）。\n\n` +
        `按「確定」：從中斷處繼續\n按「取消」：捨棄先前的進度，從頭開始`
      );

      if (shouldResume) {
        // 失敗片段的佔位段落拿掉，這些片段會重送
        setTranscripts(savedProgress.transcripts.filter(t => t.failedChunk === undefined).map(withId));
        setStats({
          totalChunks: savedProgress.totalChunks,
          processedChunks: savedProgress.processedChunks,
          currentAction: '從上次中斷處繼續…'
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
      setStats({ totalChunks: 0, processedChunks: 0, currentAction: '正在讀取音檔…' });
      const decodeStartedAt = performance.now();
      let decodePercent = -1;
      const pcm = await decodeAudio(file, {
        signal,
        onProgress: fraction => {
          const percent = Math.floor(fraction * 100);
          if (percent === decodePercent || signal.aborted) return;
          decodePercent = percent;
          setStats({ totalChunks: 0, processedChunks: 0, currentAction: `正在讀取音檔 ${percent}%…` });
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
      const chunksThisRun = queue.length;
      let inFlight = 0;
      // 這一輪已處理完的段數與開始時間，用來估算還要多久
      let doneThisRun = 0;
      const processingStartedAt = performance.now();

      const remainingNote = () => {
        if (doneThisRun === 0 || doneThisRun >= chunksThisRun) return undefined;
        const msPerChunk = (performance.now() - processingStartedAt) / doneThisRun;
        const seconds = ((chunksThisRun - doneThisRun) * msPerChunk) / 1000;
        return `預估還要${seconds < 60 ? '不到 1 分鐘' : `約 ${Math.round(seconds / 60)} 分鐘`}`;
      };

      const updateStats = () => {
        if (signal.aborted) return;
        setStats({
          totalChunks,
          processedChunks: completed.size + failed.size,
          currentAction: `轉錄中：已完成 ${completed.size} / ${totalChunks} 段（同時處理 ${inFlight} 段）`,
          note: remainingNote(),
        });
      };

      setStats({ totalChunks, processedChunks: completed.size, currentAction: '準備開始轉錄…' });
      setStatus(AppStatus.PROCESSING);

      // 3. Process chunks with a small worker pool
      const addSegments = (segments: TranscriptSegment[], chunkIndex: number) => {
        const chunkFailed = segments.some(seg => seg.failedChunk !== undefined);
        (chunkFailed ? failed : completed).add(chunkIndex);
        doneThisRun++;
        const completedList = [...completed];
        setTranscripts(prev => {
          // 片段完成順序不固定，依時間排序後再顯示（sort 為穩定排序，同段內順序不變）；
          // 以 prev 為基礎，保留使用者在轉錄途中做的編輯
          const sorted = [...prev, ...segments.map(withId)].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
          // 切點附近前後兩段都轉到的同一句只留一次
          const updated = removeBoundaryDuplicates(sorted, CHUNK_DURATION);
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
            // 前後各多帶 CHUNK_OVERLAP 秒；模型標的時間從送出的音訊開頭算起
            const range = chunkWindow(pcm.length / TRANSCRIBE_SAMPLE_RATE, i, CHUNK_DURATION, CHUNK_OVERLAP);
            const chunkBlob = pcmChunkToWav(pcm, i, CHUNK_DURATION, CHUNK_OVERLAP);
            // 使用带重试的转录函数
            const newSegments = await transcribeChunk(chunkBlob, apiKey, i, range.audioStart, { maxRetries: 3, onRateLimited, signal });
            // 已停止：結果不寫入，這段之後續傳會再送
            if (signal.aborted) return;
            onChunkSucceeded();
            // 重疊部分的句子歸前後段負責
            addSegments(keepOwnedSegments(newSegments, range.ownStart, range.ownEnd), i);
          } catch (err) {
            if (signal.aborted) return;
            console.error(err);
            const appError = parseGeminiError(err);

            // API Key 無效、或重試後仍超過配額：後面的片段也只會失敗，整輪暫停
            if (appError.type === ErrorType.INVALID_API_KEY) {
              fatalError = `${appError.userMessage}。請按右上角的「API Key」重新輸入後再試；已完成的段落都已保存。`;
              controller.abort();
              return;
            }
            if (appError.type === ErrorType.MODEL_UNAVAILABLE) {
              fatalError = `${appError.userMessage}，網站需要更新才能繼續使用。請按頁面最下方的「回報問題」通知我們；已完成的段落都已保存。`;
              controller.abort();
              return;
            }
            if (appError.type === ErrorType.QUOTA_EXCEEDED) {
              fatalError = `${appError.userMessage}。請稍後再試，或換一組 API Key；已完成的段落都已保存。`;
              controller.abort();
              return;
            }

            // 添加错误标记到转录结果
            const chunkEnd = i === totalChunks - 1 ? pcm.length / TRANSCRIBE_SAMPLE_RATE : (i + 1) * CHUNK_DURATION;
            addSegments([{
              speaker: '系統',
              timestamp: 'Error',
              startTimeSeconds: startTimeOffset,
              text: `[第 ${i + 1} 段（${formatTime(startTimeOffset)}–${formatTime(chunkEnd)}）轉錄失敗：${appError.userMessage}。請按上方的「重試」按鈕重新轉錄。]`,
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
        setErrorMsg(fatalError);
        setStats(prev => ({ ...prev, currentAction: '已暫停' }));
        setStatus(AppStatus.ERROR);
        return;
      }

      // 使用者按了停止，狀態已由 stop 設定
      if (signal.aborted) return;

      setStatus(AppStatus.COMPLETED);
      setPerfReport(buildPerfReport(performance.now() - runStartedAt, decodeMs, minConcurrency, chunksThisRun));
      const okRequests = requestLog.filter(r => r.ok);
      if (okRequests.length > 0) {
        saveSpeedHistory({
          secondsPerChunk: okRequests.reduce((sum, r) => sum + r.ms, 0) / okRequests.length / 1000,
          decodeSecondsPerAudioSecond: decodeMs / 1000 / (pcm.length / TRANSCRIBE_SAMPLE_RATE),
        });
      }
      if (failed.size > 0) {
        // 保留進度，重新整理頁面後也能只重送失敗的片段
        setStats(prev => ({ ...prev, currentAction: `完成，但有 ${failed.size} 段轉錄失敗` }));
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

  return {
    status, isBusy, stats, transcripts, errorMsg, perfReport, failedCount, speakers,
    lastUndo: undoStack[undoStack.length - 1] ?? null,
    start, stop, reset, restore, updateSegment, renameSpeaker, deleteSegment, undo,
  };
};
