import React, { useState, useRef, useEffect, useMemo } from 'react';
import { getChunkCountForDuration, getAudioDuration, generateSrtContent, isMediaFile } from './utils/audioUtils';
import { AppStatus, TranscriptSegment, SpeakerHint } from './types';
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
import { saveLastTranscript, loadLastTranscript, clearLastTranscript } from './utils/transcriptStore';
import { loadSpeakerHints, saveSpeakerHints } from './utils/speakerHints';
import { CHUNK_DURATION, MAX_CONCURRENCY } from './constants';

const REPO_URL = 'https://github.com/makodo123/gemini-Transcription-Master';

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
  // 自動保存的上一份逐字稿（重新打開頁面時可以找回）
  const [savedTranscript, setSavedTranscript] = useState(() => loadLastTranscript());
  // 目前逐字稿屬於哪個檔案：選了檔就是那個檔；找回的逐字稿在選檔前沿用保存時的資訊
  const [restoredFrom, setRestoredFrom] = useState<{ fileName: string; fileSize: number } | null>(null);
  // 最新選的檔案；讀長度期間又換檔時，舊檔的結果就不採用
  const selectedFileRef = useRef<File | null>(null);

  // 轉錄前填的講者，記在這台裝置上
  const [speakerHints, setSpeakerHints] = useState<SpeakerHint[]>(() => loadSpeakerHints());
  useEffect(() => saveSpeakerHints(speakerHints), [speakerHints]);

  const transcription = useTranscription(file, apiKey, speakerHints);
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

  // 逐字稿有變動就自動保存（停一秒再存，打字時不會一直寫入）
  const transcriptOwner = file ? { fileName: file.name, fileSize: file.size } : restoredFrom;
  useEffect(() => {
    if (transcripts.length === 0 || !transcriptOwner) return;
    const timer = setTimeout(() => saveLastTranscript(transcriptOwner.fileName, transcriptOwner.fileSize, transcripts), 1000);
    return () => clearTimeout(timer);
  }, [transcripts, transcriptOwner?.fileName, transcriptOwner?.fileSize]);

  // 畫面上沒有逐字稿時（例如換了新檔案），重新讀取保存的那一份，提供找回
  const hasTranscripts = transcripts.length > 0;
  useEffect(() => {
    if (!hasTranscripts) setSavedTranscript(loadLastTranscript());
  }, [hasTranscripts]);

  const openSavedTranscript = () => {
    if (!savedTranscript) return;
    if (transcripts.length > 0 && !confirmDiscard('打開上次的逐字稿')) return;
    transcription.restore(savedTranscript.transcripts);
    setRestoredFrom({ fileName: savedTranscript.fileName, fileSize: savedTranscript.fileSize });
    setFile(null);
    setFileDuration(null);
    setExportedTranscripts(null);
    setSavedTranscript(null);
  };

  const deleteSavedTranscript = () => {
    if (!window.confirm('確定要刪除上次的逐字稿嗎？刪除後無法找回。')) return;
    clearLastTranscript();
    setSavedTranscript(null);
  };

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
    // 找回的逐字稿選回同一個音檔：保留逐字稿，只是加上播放器
    // restoredFrom 留著：畫面仍要說明這是找回的逐字稿，下載也沿用原檔名
    if (restoredFrom && restoredFrom.fileName === selected.name && restoredFrom.fileSize === selected.size) {
      setFile(selected);
      setFileDuration(null);
      selectedFileRef.current = selected;
      getAudioDuration(selected).then(duration => {
        if (selectedFileRef.current === selected) setFileDuration(duration);
      });
      return;
    }
    if (!confirmDiscard('換成新的檔案')) return;
    setRestoredFrom(null);
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

  // 開始按鈕：已有逐字稿（轉錄完成或找回的）是「重新轉錄」，有這個檔案的未完成進度是「繼續轉錄」
  const startLabel = status === AppStatus.COMPLETED || (status === AppStatus.IDLE && transcripts.length > 0)
    ? '重新轉錄'
    : pendingMatchesFile ? '繼續轉錄' : '開始轉錄';

  const handleStart = () => {
    if (startLabel !== '重新轉錄') {
      transcription.start('start');
    } else if (confirmDiscard('重新轉錄', '，並重新使用 API 額度')) {
      setRestoredFrom(null);
      transcription.start('restart');
    }
  };

  // 下載與複製都略過轉錄失敗的佔位段落
  const exportable = () => transcripts.filter(t => t.failedChunk === undefined);

  // 還有失敗的段落時先提醒
  const downloadFile = (extension: string, content: () => string) => {
    if (failedCount > 0 && !window.confirm(`還有 ${failedCount} 段轉錄失敗，下載的檔案會缺少這些段落。\n\n仍要下載嗎？`)) return;
    // 找回的逐字稿還沒選音檔時，沿用保存時的原檔名
    downloadText(`${baseFileName(file?.name ?? restoredFrom?.fileName)}.${extension}`, content());
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
        {/* 上次自動保存的逐字稿；同一個檔案還有未完成的轉錄時，交給續傳提醒處理 */}
        {savedTranscript && transcripts.length === 0 && !isBusy &&
          !(pendingProgress && pendingProgress.fileName === savedTranscript.fileName && pendingProgress.fileSize === savedTranscript.fileSize) && (
          <div className="p-4 rounded-xl bg-indigo-50 border border-indigo-200 text-sm text-indigo-900 flex flex-wrap items-center gap-x-4 gap-y-2">
            <p className="flex-grow">
              找到上次的逐字稿：<span className="font-medium break-all">{savedTranscript.fileName}</span>
              （{new Date(savedTranscript.savedAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}，共 {savedTranscript.transcripts.length} 段）。
              打開後再選同一個音檔，就能邊聽邊校對。逐字稿只存在這台裝置的瀏覽器，7 天後自動刪除。
            </p>
            <div className="flex gap-2">
              <button onClick={openSavedTranscript} className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-medium">打開</button>
              <button onClick={deleteSavedTranscript} className="px-3 py-1.5 rounded-lg text-indigo-700 hover:bg-indigo-100">刪除</button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UploadCard
            file={file}
            fileDuration={fileDuration}
            fileEstimate={fileEstimate}
            status={status}
            isBusy={isBusy}
            canStart={!!file && !!apiKey}
            startLabel={startLabel}
            failedCount={failedCount}
            pendingProgress={pendingProgress}
            pendingMatchesFile={pendingMatchesFile}
            fileError={fileError}
            speakerHints={speakerHints}
            onSpeakerHintsChange={setSpeakerHints}
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
            hasTranscript={transcripts.length > 0}
            restoredFileName={restoredFrom?.fileName ?? null}
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
            onSwapSpeakers={transcription.swapSpeakers}
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

      <footer className="w-full max-w-4xl mt-10 pt-4 border-t border-slate-200 text-sm text-slate-500 flex flex-wrap gap-x-4 gap-y-1">
        <a href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" className="hover:text-indigo-600 hover:underline">使用說明</a>
        <a href={`${REPO_URL}/issues`} target="_blank" rel="noreferrer" className="hover:text-indigo-600 hover:underline">回報問題</a>
      </footer>
    </div>
  );
}

export default App;
