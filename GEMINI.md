# Google Gemini 開發規範 (GEMINI.md)

本文件定義了「AI UI Builder」專案與 Google Gemini 模型的協作標準與規則。

---

## 1. 核心模型配置
- **指定模型**: `gemini-2.5-flash`
- **使用情境**: 所有的 UI 生成、修改與對話解析皆優先使用此型號。

## 2. 工具與函式呼叫 (Function Calling)
為了精確區分「代碼修改」與「一般對話」，系統必須實作並使用以下兩項 Tool：

1.  **`update_ui(code)`**:
    - **用途**: 更新、優化或重寫 `src/sandbox/Target.tsx` 檔案。
    - **規則**: 必須回傳完整的 React 組件代碼，且使用 Tailwind CSS 及 Lucide-React 圖示。
2.  **`send_message(text)`**:
    - **用途**: 回答問題、進行規劃或單純與使用者溝通。
    - **規則**: 使用此功能時，不應變更任何原始碼檔案。

## 3. 上下文參考規範 (Context-Awareness)
- 發送任何請求至模型前，系統必須先讀取 `src/sandbox/Target.tsx` 的目前內容。
- 將目前代碼作為對話背景（Context）提供給模型，以實現「增量修改」而非「全套覆蓋」。

## 4. 監測與歷史紀錄
- 模型的所有回應（包含 Prompt 與 Output）皆必須以 JSON 格式紀錄至 `server/history/`。
- 每個紀錄檔檔名必須包含準確的時間戳記。

## 5. 實作原則
- **UI 先行**: 所有的 UI 反饋必須能即時渲染在前端畫面上。
- **Tailwind 為主**: 所有樣式建構強制使用 Tailwind CSS 類名。
- **安全保護**: 模型應避免生成會造成系統掛點的無窮迴圈或非法代碼。

---
*最後更新日期: 2026-03-29 (Antigravity)*
