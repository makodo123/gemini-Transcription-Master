import React, { useState, useRef, useEffect, useMemo } from 'react';
import { getChunkCountForDuration, getAudioDuration, generateSrtContent, isMediaFile } from './utils/audioUtils';
import { AppStatus, TranscriptSegment } from './types';
import ApiKeyModal from './components/ApiKeyModal';
import AppHeader from './components/AppHeader';
import UploadCard from './components/UploadCard';
import StatusCard from './components/StatusCard';
import TranscriptPanel from './components/TranscriptPanel';
import { useTranscription } from './hooks/useTranscription';
import { resetModelSelection, validateApiKey } from './services/geminiService';
import { clearProgress, peekProgress } from './utils/progressStorage';
import { loadSpeedHistory } from './utils/speedHistory';
import { toPlainText, baseFileName, downloadText } from './utils/transcriptExport';
import { CHUNK_DURATION, MAX_CONCURRENCY } from './constants';

function App() {
  const [apiKey, setApiKey] = useState<string>('');
  const [isKeyModalOpen, setKeyModalOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // 選檔後讀到的音檔長度（秒）；讀不到時為 null
  const [fileDuration, setFileDuration] = useState<number | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [includeTimestamps, setIncludeTimestamps] = useState(true);
  // 最後一次下載時的逐字稿；和目前的不同，代表有還沒下載的內容（新結果或修改）
  const [exportedTranscripts, setExportedTranscripts] = useState<TranscriptSegment[] | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  // 上次未完成的轉錄（重新打開頁面時提醒使用者）
  const [pendingProgress, setPendingProgress] = useState(() => peekProgress());
  // 最新選的檔案；讀長度期間又換檔時，舊檔的結果就不採用
  const selectedFileRef = useRef<File | null>(null);

  const transcription = useTranscription(file, apiKey);
  // 原始音檔的網址，讓逐字稿可以點時間播放；換檔時釋放舊的
  const audioUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  const { status, isBusy, transcripts, failedCount } = transcription;
  const hasUnexported = transcripts.length > 0 && transcripts !== exportedTranscripts;
  const pendingMatchesFile = !!(pendingProgress && file && pendingProgress.fileName === file.name && pendingProgress.fileSize === file.size);

  // Load API Key from local storage
  useEffect(() => {
    const storedKey = localStorage.getItem('gemini_api_key');
    if (storedKey) {
      setApiKey(storedKey);
    }
  }, []);

  const handleSaveKey = (key: string) => {
    // 換了 API Key，可用的模型可能不同，重新從預設模型開始
    if (key !== apiKey) resetModelSelection();
    setApiKey(key);
    localStorage.setItem('gemini_api_key', key);
  };

  const handleClearKey = () => {
    setApiKey('');
    localStorage.removeItem('gemini_api_key');
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

  // 狀態變化後（轉錄完成會清除進度、停止會留下進度）重新讀取
  useEffect(() => {
    if (!isBusy) setPendingProgress(peekProgress());
  }, [isBusy, status]);

  const discardPendingProgress = () => {
    if (!window.confirm('確定要捨棄上次未完成的轉錄嗎？已完成的段落也會一起刪除。')) return;
    clearProgress();
    setPendingProgress(null);
  };

  // 轉錄中、或有還沒下載的逐字稿時，關閉或重新整理頁面前先提醒
  useEffect(() => {
    if (!isBusy && !hasUnexported) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isBusy, hasUnexported]);

  /** 會清掉目前逐字稿的動作先確認；已下載且沒再修改就不用問 */
  const confirmDiscard = (action: string, extra = '') =>
    !hasUnexported ||
    window.confirm(`${action}會清除目前的逐字稿${extra}。\n\n這份逐字稿還沒下載，您做的修改也會一起消失。確定要繼續嗎？`);

  const selectFile = (selected: File) => {
    // 不是音訊或影片就不換檔，目前的檔案與逐字稿維持原樣
    if (!isMediaFile(selected)) {
      setFileError(`「${selected.name}」不是音訊或影片檔，請選擇 MP3、M4A、WAV 或 MP4 等格式。`);
      return;
    }
    setFileError(null);
    if (!confirmDiscard('換成新的檔案')) return;
    setFile(selected);
    transcription.reset();
    setFileDuration(null);
    selectedFileRef.current = selected;
    getAudioDuration(selected).then(duration => {
      if (selectedFileRef.current === selected) setFileDuration(duration);
    });
  };

  // 選檔後的長度、段數與預估時間；預估依這台裝置上次的轉錄速度
  const fileEstimate = useMemo(() => {
    if (fileDuration === null) return null;
    const chunks = getChunkCountForDuration(fileDuration, CHUNK_DURATION);
    const history = loadSpeedHistory();
    const seconds = history
      ? fileDuration * history.decodeSecondsPerAudioSecond + Math.ceil(chunks / MAX_CONCURRENCY) * history.secondsPerChunk
      : null;
    return { chunks, seconds };
    // status 變化時重算：轉錄完成後速度紀錄會更新
  }, [fileDuration, status]);

  const handleStart = () => {
    if (status !== AppStatus.COMPLETED) transcription.start('start');
    else if (confirmDiscard('重新轉錄', '，並重新使用 API 額度')) transcription.start('restart');
  };

  // 下載與複製都略過轉錄失敗的佔位段落
  const exportable = () => transcripts.filter(t => t.failedChunk === undefined);

  // 還有失敗的段落時先提醒
  const downloadFile = (extension: string, content: () => string) => {
    if (failedCount > 0 && !window.confirm(`還有 ${failedCount} 段轉錄失敗，下載的檔案會缺少這些段落。\n\n仍要下載嗎？`)) return;
    downloadText(`${baseFileName(file?.name)}.${extension}`, content());
    setExportedTranscripts(transcripts);
  };

  const copyAll = async () => {
    const text = toPlainText(exportable(), includeTimestamps);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 不支援 Clipboard API（例如非 HTTPS）時改用舊方法
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) {
        setCopyNotice('無法複製，請改用「下載 TXT」');
        setTimeout(() => setCopyNotice(null), 3000);
        return;
      }
    }
    setExportedTranscripts(transcripts);
    setCopyNotice(failedCount > 0 ? `已複製（略過 ${failedCount} 段轉錄失敗）` : '已複製');
    setTimeout(() => setCopyNotice(null), 2500);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center py-10 px-4 sm:px-6">
      <ApiKeyModal
        isOpen={isKeyModalOpen}
        onClose={() => setKeyModalOpen(false)}
        onSave={handleSaveKey}
        onClear={handleClearKey}
        currentKey={apiKey}
        validate={validateApiKey}
      />

      <AppHeader apiKey={apiKey} onOpenKeySettings={() => setKeyModalOpen(true)} />

      <main className="w-full max-w-4xl space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UploadCard
            file={file}
            fileDuration={fileDuration}
            fileEstimate={fileEstimate}
            status={status}
            isBusy={isBusy}
            canStart={!!file && !!apiKey}
            failedCount={failedCount}
            pendingProgress={pendingProgress}
            pendingMatchesFile={pendingMatchesFile}
            fileError={fileError}
            onSelectFile={selectFile}
            onDiscardPending={discardPendingProgress}
            onStart={handleStart}
            onRetryFailed={() => transcription.start('retryFailed')}
            onStop={transcription.stop}
          />
          <StatusCard
            status={status}
            isBusy={isBusy}
            stats={transcription.stats}
            failedCount={failedCount}
            errorMsg={transcription.errorMsg}
            perfReport={transcription.perfReport}
            hasApiKey={!!apiKey}
            hasFile={!!file}
          />
        </div>

        {transcripts.length > 0 && (
          <TranscriptPanel
            transcripts={transcripts}
            audioUrl={audioUrl}
            isBusy={isBusy}
            speakers={transcription.speakers}
            includeTimestamps={includeTimestamps}
            copyNotice={copyNotice}
            onIncludeTimestampsChange={setIncludeTimestamps}
            onRenameSpeaker={transcription.renameSpeaker}
            onUpdateSegment={transcription.updateSegment}
            onDeleteSegment={transcription.deleteSegment}
            undoLabel={transcription.lastUndo?.label ?? null}
            onUndo={transcription.undo}
            onCopy={copyAll}
            onDownloadTxt={() => downloadFile('txt', () => toPlainText(exportable(), includeTimestamps))}
            onDownloadSrt={() => downloadFile('srt', () => generateSrtContent(exportable()))}
          />
        )}
      </main>
    </div>
  );
}

export default App;
