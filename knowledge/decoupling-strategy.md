# AI 系統解耦架構策略 (AI Decoupling Strategy)

本文件定義「AI 核心推論」與「副作用處理」的解耦策略。

---

## 策略一：實作隔離 (Isolation)
將核心業務邏輯與系統副作用切開，保持代理人純粹。

-   **情境**：`Agent` 或 `AIEngine` 內部包含 `fs.writeJson` 或 `recordGeminiResponse`。
-   **機制**：類別設計為發布者，由外部註冊 Handler 或訂閱 Event。
-   **建議**：核心代碼不依賴 `fs` 或 DB SDK，僅依賴訊號傳遞。
-   **效益**：
    -   **測試性**：在測試環境掛載 Mock Handler，不更動生產代碼。
    -   **職責**：Agent 負責思考與分配，不負責存檔。

---

## 策略二：攔截器 (Interceptors)
介入 LLM 請求與回應生命週期，實現靜默日誌。

-   **情境**：在開發環境錄製真實流量為 `fixtures`，或在生產環境執行安全審查。
-   **機制**：封裝 `model.generateContentStream` 為攔截鏈架構 (Axios-style)。
-   **建議**：混合等待策略，數據修改用 `await`，日誌紀錄背景執行。
-   **參考**：[攔截器架構模式與範例](./patterns/interceptor-patterns.md)
-   **效益**：
    -   **紀錄**：不修改業務代碼，自動擷取測試數據。
    -   **擴展**：可加入 Prompt 修飾或回應快取。

---

## 策略三：流式紀錄 (Async Stream)
利用異步產生器處理 Streaming，解決 I/O 阻塞造成的 UI 延遲。

-   **情境**：在流進行時紀錄日誌，若紀錄過慢會導致 Socket 卡頓。
-   **機制**：配合 `async *` 與 `yield` 實現邊產出邊 Hook。
-   **建議**：`yield` 文字片段給前端後，再異步處理完整數據包存檔。
-   **參考**：[異步產生器與流式處理](./patterns/async-generators.md)
-   **效益**：
    -   **延遲**：存檔在背景執行，前端回應流暢。
    -   **記憶體**：不需要一次保存巨型 Response 即可開始後續動作。

---

## 策略四：上下文追蹤 (Unified context)
建立任務範圍內的隱含儲存區，避免層層傳遞參數。

-   **情境**：必須將 `sessionId` 與 `round` 傳進 AIEngine、Explorer 與 Editor，代碼簽名過於臃腫。
-   **機制**：採用 Node.js `AsyncLocalStorage` 建立任務隔離區。
-   **建議**：在任務進入點（如 Coordinator 或 Route）啟動 Context。
-   **參考**：[統一上下文追蹤實作](./patterns/unified-context-store.md)
-   **效益**：
    -   **純度**：函數關注業務邏輯，攔截器自行抓取 ID。
    -   **精確**：異步並行執行時，日誌與請求精準對齊。

---

## 5. 流程總結 (Unified Flow)
1. **注入**：Coordinator 啟動任務並注入 [Unified Context](./patterns/unified-context-store.md)。
2. **生成**：AIEngine 透過 [Async Generator](./patterns/async-generators.md) 生產內容。
3. **攔截**：[Interceptor](./patterns/interceptor-patterns.md) 在背景存檔。
