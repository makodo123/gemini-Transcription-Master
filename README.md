# Gemini 逐字稿大師

> 上傳音檔，自動切片、轉錄、輸出 SRT 字幕 — 支援長達數小時的錄音，中途中斷也能續傳。
>
> [**Live Demo**](https://makodo123.github.io/gemini-Transcription-Master/) · [回報問題](https://github.com/makodo123/gemini-Transcription-Master/issues)
>
> ---
>
> ## 為什麼做這個
>
> Gemini API 單次請求有音訊長度限制，直接送一個一小時的會議錄音會失敗。市面上的轉錄服務要付費，而且上傳大檔案到雲端有隱私疑慮。
>
> 這個工具的核心想法很簡單：**在瀏覽器端把音檔切成 5 分鐘一段，逐片送給 Gemini，再把結果重新拼回來**。全程在本機執行，音訊不會離開你的電腦。
>
> ---
>
> ## 功能
>
> - **長音檔分段轉錄** — 自動將音訊切割為 5 分鐘片段，繞過 API 長度限制
> - - **斷點續傳** — 轉錄中途停止或網路斷線，重新開啟可從上次進度繼續
>   - - **自動重試** — 網路不穩時以指數退避策略自動重試最多 3 次
>     - - **可編輯逐字稿** — 轉錄完成後可直接在頁面修改時間戳記、說話者名稱與文字
>       - - **多格式匯出** — 支援匯出 `.txt`（含時間戳記）與 `.srt` 字幕檔
>         - - **支援主流格式** — MP3、WAV、M4A 等常見音訊格式
>          
>           - ---
>
> ## 技術架構
>
> ```
> 音訊檔案 (瀏覽器端)
>     │
>     ▼
> Web Audio API (AudioContext)
>     │  解碼 → PCM 音訊資料
>     ▼
> splitAudioBuffer()
>     │  切割成 300 秒片段
>     ▼
> audioBufferToWav()
>     │  每個片段重新編碼為 WAV
>     ▼
> Gemini Flash API
>     │  逐片送出轉錄請求（含重試邏輯）
>     ▼
> TranscriptSegment[]
>     │  每片結果附帶時間偏移量
>     ▼
> localStorage (progressStorage)
>     │  斷點續傳用
>     ▼
> UI 呈現 + 匯出 (.txt / .srt)
> ```
>
> ### 關鍵技術決策
>
> **AudioContext 單例模式**：每個音訊片段共用同一個 `AudioContext` 實例，而非每次切割都建立新物件，減少約 95% 的 Context 建立開銷。
>
> **進度持久化**：每處理完一個片段就呼叫 `saveProgress()` 寫入 `localStorage`，儲存格式包含檔案名稱、大小 checksum、已完成片段數及現有逐字稿。重新載入同一個檔案時可判斷是否為同一份錄音並提供續傳選項。
>
> **錯誤分類**：統一的 `errorHandling.ts` 將 API 錯誤分為 `NETWORK_ERROR`、`API_ERROR`、`QUOTA_EXCEEDED`、`INVALID_API_KEY` 等類型，並標記是否可重試（`retryable`），讓主流程可以決定是中斷還是跳過該片段繼續。
>
> ---
>
> ## 技術棧
>
> | 分類 | 技術 |
> |------|------|
> | 前端框架 | React 18 + TypeScript |
> | 建置工具 | Vite |
> | 樣式 | Tailwind CSS |
> | 音訊處理 | Web Audio API（純瀏覽器端）|
> | AI 模型 | Gemini 2.5 Flash |
> | CI | GitHub Actions |
>
> ---
>
> ## 本機執行
>
> **前置需求**：Node.js 18+、Gemini API Key（[免費申請](https://aistudio.google.com/apikey)）
>
> ```bash
> git clone https://github.com/makodo123/gemini-Transcription-Master.git
> cd gemini-Transcription-Master
> npm install
> ```
>
> 建立 `.env.local`：
>
> ```
> GEMINI_API_KEY=你的金鑰
> ```
>
> 啟動開發伺服器：
>
> ```bash
> npm run dev
> ```
>
> ---
>
> ## 使用方式
>
> 1. 點擊右上角「API Key 設定」輸入你的 Gemini API Key
> 2. 2. 上傳音訊檔案（MP3 / WAV / M4A）
>    3. 3. 點擊「開始辨識」
>       4. 4. 轉錄過程中可隨時停止，下次上傳同一個檔案會詢問是否繼續
>          5. 5. 完成後可在頁面編輯逐字稿，再匯出 `.txt` 或 `.srt`
>            
>             6. ---
>            
>             7. ## 效能比較
>            
>             8. | 指標 | 優化前 | 優化後 |
> |------|--------|--------|
> | AudioContext 建立次數 | 每片段 1 次 | 全程 1 次 |
> | 網路失敗處理 | 手動重試 | 自動重試 3 次（指數退避）|
> | 中斷後重新開始 | 從頭轉錄 | 從中斷點繼續 |
>
> ---
>
> ## 已知限制
>
> - 大部分免費 Gemini API 額度有每分鐘請求數限制，超長錄音（2 小時以上）可能需要暫停
> - - 目前說話者辨識為 AI 推測，準確度取決於錄音品質
>   - - 需要瀏覽器支援 Web Audio API（現代瀏覽器均支援）
>    
>     - ---
>
> ## License
>
> MIT
