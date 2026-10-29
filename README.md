# Gemini 逐字稿大師

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://makodo123.github.io/gemini-Transcription-Master/)

上傳錄音，自動產生逐字稿與 SRT 字幕檔。支援長達數小時的錄音，中途中斷也能從斷點繼續。

**[開始使用](https://makodo123.github.io/gemini-Transcription-Master/)** · [回報問題](https://github.com/makodo123/gemini-Transcription-Master/issues)

## 為什麼做這個

Gemini API 單次請求能處理的音訊長度有限，直接送一小時的會議錄音會失敗；市面上的轉錄服務要付費，上傳大檔案到第三方也有隱私疑慮。

這個工具在**瀏覽器裡**把音檔切成每 5 分鐘一段，直接送給 Gemini API 轉錄，再把結果依時間合併。網站本身沒有後端伺服器，音檔不會經過本專案；使用自己的 Gemini API Key。

## 使用方式

1. 到 [Google AI Studio](https://aistudio.google.com/app/apikey) 取得 Gemini API Key，在網頁右上角「設定 API Key」貼上。
2. 點擊或拖曳音檔到上傳區。選好後會顯示長度、會分成幾段；轉錄過一次後還會依您的速度顯示預估時間。
3. 按「開始轉錄」。結果會邊轉錄邊出現，可以隨時按「停止轉錄」。
4. 直接在頁面上修改文字、時間與講者；用「重新命名講者」把「講者 1」一次改成真名。
5. 用「下載 TXT」「下載 SRT 字幕」或「複製全文」帶走結果。

## 功能

- **長音檔分段轉錄**：每 5 分鐘一段、最多同時處理 3 段；遇到請求次數限制會自動放慢。
- **長音檔也不吃記憶體**：MP3、M4A、WAV 會分段讀取，一小時的錄音讀取時約只多用 200 MB 記憶體。
- **斷點續傳**：停止、斷線或關掉頁面後，重新選同一個檔案按「開始轉錄」即可從中斷處繼續。
- **失敗段落重試**：個別段落失敗不會中斷整份轉錄，完成後按「重試失敗的 N 段」只重送那幾段。API Key 無效或額度用完時會暫停並保留進度。
- **可編輯逐字稿**：文字、時間、講者都能改；「重新命名講者」可批次替換同名講者。
- **匯出**：TXT（可選擇是否含時間戳記）、SRT 字幕檔、複製全文。轉錄失敗的段落不會被匯出。
- **防止誤刪**：還沒下載的逐字稿在重新轉錄、換檔或關閉頁面前都會先提醒。

## 支援格式

| 格式 | 說明 |
|---|---|
| MP3、M4A／MP4（AAC）、WAV | 分段讀取，長檔案也不佔大量記憶體（需要支援 WebCodecs 的瀏覽器；不支援時自動改用整檔讀取） |
| FLAC、OGG 等其他格式 | 整檔讀取，可否使用取決於瀏覽器；很長的檔案可能會讓分頁記憶體不足，建議先轉成 MP3 或 M4A |

建議使用最新版的 Chrome、Edge、Firefox 或 Safari。

## 隱私

- 音訊在您的瀏覽器中切段後，**直接傳送給 Google Gemini** 轉錄，不經過本專案的任何伺服器。Google 如何處理送出的資料，依您的 Gemini API 使用條款而定。
- API Key 只存在這台裝置的瀏覽器裡（localStorage），可在「API Key 設定」中按「清除金鑰」刪除。
- 轉錄進度（含已完成的逐字稿）會暫存在瀏覽器裡以便續傳，全部完成後自動清除，暫存超過 24 小時也會失效。

## 常見問題

**不同段落的「講者 1」是同一個人嗎？**
不一定。每 5 分鐘一段是分別辨識的，講者編號在段落之間不保證一致。用「重新命名講者」批次改名後，建議抽查段落交界處。

**出現「已達到 Gemini API 的使用額度上限」怎麼辦？**
已完成的段落都已保存。稍等一段時間或換一組 API Key，再按「開始轉錄」即可從中斷處繼續。

**時間戳記準確嗎？**
時間以秒為單位，來自 Gemini 對每一句的判斷，可能有幾秒誤差；可以直接在頁面上修改。

## 本機開發

```bash
npm install
npm run dev       # 開發伺服器 http://localhost:3000/gemini-Transcription-Master/
npm run build     # 建置到 dist/
```

網站部署在 GitHub Pages，來源是 `gh-pages` 分支：

```bash
npm run deploy    # 建置後把 dist/ 推到 gh-pages 分支
```

提交前可啟用專案內建的 hook，避免不小心把 API Key 提交進去：

```bash
git config core.hooksPath .githooks
```
