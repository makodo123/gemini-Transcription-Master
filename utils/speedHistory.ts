/** 這台裝置上次轉錄的速度，用來在選檔後預估所需時間 */
export interface SpeedHistory {
  /** 單段 API 請求平均秒數 */
  secondsPerChunk: number;
  /** 讀取（解碼）每秒音訊所需秒數 */
  decodeSecondsPerAudioSecond: number;
}

const STORAGE_KEY = 'transcription_speed';

export const saveSpeedHistory = (history: SpeedHistory): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch (error) {
    console.error('Failed to save speed history:', error);
  }
};

export const loadSpeedHistory = (): SpeedHistory | null => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const history: SpeedHistory = JSON.parse(saved);
    return history.secondsPerChunk > 0 && history.decodeSecondsPerAudioSecond >= 0 ? history : null;
  } catch (error) {
    console.error('Failed to load speed history:', error);
    return null;
  }
};
