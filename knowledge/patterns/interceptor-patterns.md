# AI 請求與回應攔截器方案 (AI Interceptor Patterns)

本文件整理了用於 AI 開發中，將推論邏輯與副作用（如日誌紀錄、測試流量擷取）解耦的優雅方案。

## 核心問題 (Problem)
-   **程式碼散落**：日誌存取與流量錄製邏輯直接寫在 `AIEngine` 或 `Agent` 內部，導致維護困難。
-   **同步阻塞**：頻繁的檔案 I/O 可能影響 AI 的即時回應速度。
-   **測試耦合**：為了重寫測試所需的 Mock，必須手動修改生產代碼來輸出日誌。

---

## 方案一：攔截器架構 (Interceptor Pattern) - 推薦（高度控制）

攔截器允許在請求發出（Request）與回應返回（Response）的生命週期中插入自定義代碼。這與 `Axios` 或 `gRPC` 的架構類似。

### 代碼結構範例
```javascript
export class AIEngine {
  constructor(model) {
    this.model = model;
    this.interceptors = { request: [], response: [] };
  }

  useRequest(fn) { this.interceptors.request.push(fn); }
  useResponse(fn) { this.interceptors.response.push(fn); }

  async *generateStream(prompt, context) {
    // 請求前：修改 Prompt 或注入 Context (等待執行完畢)
    let finalPrompt = prompt;
    for (const hook of this.interceptors.request) {
      finalPrompt = await hook(finalPrompt, context);
    }

    // 核心業務：Gemini 呼叫
    const stream = await this.model.generateContentStream({ ... });

    const rawChunks = [];
    // ... 收集回應數據 ...

    // 回應後：執行日誌紀錄或流量錄製
    // (可加 await 確保錄製成功，或不加 await 以確保 UI 流暢度)
    for (const hook of this.interceptors.response) {
      await hook({ prompt: finalPrompt, response: rawChunks, context });
    }

    yield { type: 'final', ... };
  }
}
```

---

## 方案二：事件發步/訂閱模式 (Event-Driven / Observer) - 簡潔（低耦合）

適用於「純紀錄」場景，完全不需要修改 AI 請求或回應數據，只需知道對話發生了。

### 代碼結構範例
```javascript
import { EventEmitter } from 'events';
const engineEvents = new EventEmitter();

// 紀錄器（訂閱者）：獨立於 AI 邏輯之外
engineEvents.on('llm_exchange', async ({ prompt, response, context }) => {
    // 專職處理 Fixture 生成
    await fs.writeJson(`./fixtures/fx_${context.sessionId}.json`, { prompt, response });
});

// AIEngine (發布者)
engineEvents.emit('llm_exchange', { prompt, response, context });
```

---

## 總結與決策指南

| 特性 | 攔截器 (Interceptor) | 觀察者 (Observer) |
| :--- | :--- | :--- |
| **控制權** | 高（可修改傳入傳出的數據） | 低（僅能讀取數據） |
| **耦合度** | 中（需在類別內加入處理鏈） | 極低（代碼僅有一行 emit） |
| **適用場景** | **流量錄製、Prompt 注入、安全審查** | **單純監控、發送報警、非即時紀錄** |

### 錄製流量以用於測試 (Fixture Recording)
為了穩定的重現測試 (Reproduction), 建議在開發環境中使用 **`useResponse` 攔截器**，並將 `context.sessionId` 與 `round` 作為檔案名稱索引。
