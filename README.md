# Gemini 逐字稿大師

[![Deploy to GitHub Pages](https://github.com/makodo123/gemini-Transcription-Master/actions/workflows/deploy.yml/badge.svg)](https://github.com/makodo123/gemini-Transcription-Master/actions/workflows/deploy.yml) [![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://makodo123.github.io/gemini-Transcription-Master/)



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
