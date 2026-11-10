export interface TranscriptSegment {
  /** 畫面列表用的穩定識別碼；舊版保存的進度沒有，載入時補上 */
  id?: string;
  speaker: string;
  timestamp: string; // Original timestamp string from AI (e.g. "00:15")
  startTimeSeconds: number; // Calculated absolute seconds
  text: string;
  /** 轉錄失敗的佔位段落所屬的片段編號；重試時依此找出要重送的片段 */
  failedChunk?: number;
}

export interface ProcessingStats {
  totalChunks: number;
  processedChunks: number;
  currentAction: string;
  /** 標題下方的補充說明（例如預估剩餘時間、停止後怎麼繼續） */
  note?: string;
}

export enum AppStatus {
  IDLE = 'IDLE',
  PREPARING = 'PREPARING', // Decoding/Slicing
  PROCESSING = 'PROCESSING', // Uploading/Transcribing
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
  STOPPED = 'STOPPED'
}

/** 轉錄前填的講者：名字與角色。讓 Gemini 依角色分辨誰在說話，不是照誰先開口編號 */
export interface SpeakerHint {
  name: string;
  /** 角色或特徵，例如「提問的人」；可以空白 */
  role: string;
}
