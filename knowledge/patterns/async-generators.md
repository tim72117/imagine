# 異步產生器與流式處理 (Async Generators & Streaming)

在 AI 應用開發中，為了提供使用者「打字機效果」般的即時反饋，我們大量使用了 JavaScript 的 **Async Generators (`async *`)** 與 `yield` 關鍵字。

## 為什麼需要異步產生器？
傳統的 `Promise` 必須等待整個請求（例如：1000 個 Token）全部生成完畢後才能一次回傳，這會導致數秒甚至數十秒的等待感。
透過 `async *` 與 `yield`，我們可以在 Gemini 每生成一個字節或一個「工具呼叫 Part」時，就立即將其推送到前端。

---

## 關鍵語法說明

### 1. 產生器函數 (`async *function`)
定義一個帶有星號的異步函數，這意謂著它不只回傳一個值，而是回傳一個 **迭代對象 (Iterator)**。

### 2. `yield` 關鍵字
`yield` 用於發送出一個當前的狀態或數據塊。
在 `AIEngine` 中，我們使用 `yield` 來發送兩類數據：
-   **`{ type: 'action', action }`**: 即時發送 AI 請求的工具呼叫。
-   **`{ type: 'final', text, actions }`**: 當流結束時，發送最終彙整的結果。

---

## 代碼實例剖析 (AIEngine.js)

```javascript
async *generateStream(prompt, context) {
    // 獲取 Gemini 的流式回應
    const streamResponse = await this.model.generateContentStream({ ... });

    for await (const chunk of streamResponse.stream) {
        // ... 解析 Chunk ...
        
        if (part.functionCall) {
            // 每當偵測到工具呼叫，立即 yield 給上層 Agent
            yield { type: 'action', action: part.functionCall }; 
        }
    }
    
    // 最終總結 yield
    yield { type: 'final', text: accumulatedText };
}
```

---

## 呼叫端的處理 (Agent.js)
呼叫端必須使用 `for await...of` 來迭代這些即時產出的資料區塊：

```javascript
const stream = engine.generateStream(prompt);

for await (const chunk of stream) {
    if (chunk.type === 'action') {
        // 1. 如果是工具，立即執行 (如：寫檔)
        await this.toolbox.execute_tool(chunk.action.name, ...);
    } else if (chunk.type === 'final') {
        // 2. 如果是最終文字，更新狀態
        aiResponse = chunk;
    }
}
```

---

## 優點總結
-   **低延遲 (Low Latency)**：使用者不需要等待 AI 全部思考完畢就能看到結果。
-   **高效並行**：我們可以在流進行的同時，背景執行工具操作（例如：一邊生成代碼，一邊透過 Socket 通知 UI 進入 Loading 狀態）。
-   **記憶體友善**：不需要在記憶體中一次快取所有的 Chunk 數據。
