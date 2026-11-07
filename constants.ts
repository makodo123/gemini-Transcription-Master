// Chunk duration in seconds.
// 實測 Gemini 端的處理量有上限，片段切更短不會更快，反而多了斷句與講者編號不一致；維持 5 分鐘。
export const CHUNK_DURATION = 300;

// 同時送出的片段上限。實測同時 8 段時每段反而變慢（Gemini 端排隊處理），總時間沒有縮短，因此設 3。
// 遇到請求次數過多（429）時會自動減半，免費方案也不會一直失敗。
export const MAX_CONCURRENCY = 3;
