export interface TranscriptSegment {
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
}

export enum AppStatus {
  IDLE = 'IDLE',
  PREPARING = 'PREPARING', // Decoding/Slicing
  PROCESSING = 'PROCESSING', // Uploading/Transcribing
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
  STOPPED = 'STOPPED'
}
