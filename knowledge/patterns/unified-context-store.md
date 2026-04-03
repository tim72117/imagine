# 統一上下文追蹤 (Unified Context Store)

在複雜的 AI 協作系統中，任務往往會跨越多層代理人（如: Coordinator -> Agent -> AIEngine -> Toolbox）。為了避免在每個函數參數中傳遞 `sessionId` 或 `round` 等元數據，我們採用統一的上下文管理。

## 核心概念：參數傳遞 (Prop Drilling) vs. 統一儲存
目前的實作偏向於在每個 `run` 或 `generateStream` 函數中傳遞 `context` 物件。為了使代碼更優雅，更建議採用 **Scoped Store**。

---

## 推薦方案：Node.js 內建的 `AsyncLocalStorage`

這是一種能在整個異步調用鏈中共享數據的機制，不需要手動傳遞參數。

### 程式碼範例

```javascript
import { AsyncLocalStorage } from 'node:async_hooks';

// 1. 建立一個全域的 Storage 實例
const als = new AsyncLocalStorage();

// 2. 在 Coordinator 入口處啟動 Context
export async function startTask(userPrompt) {
  const sessionId = `SESSION-${Date.now()}`;
  
  // 透過 run 啟動一個隔離的上下文區塊
  return als.run({ sessionId, round: 1 }, async () => {
    const coordinator = new Coordinator();
    await coordinator.coordinate(userPrompt);
  });
}

// 3. 在深層的 AIEngine 中直接獲取 (無需透過參數)
export class AIEngine {
  async *generateStream(prompt) {
    const store = als.getStore(); // 直接獲取目前的上下文
    console.log(`[Engine] 正在處理 Session: ${store.sessionId}`);
    // ... 後續邏輯 ...
  }
}
```

---

## 優缺點分析

| 優點 | 缺點 |
| :--- | :--- |
| **函數簽名簡潔**：不需要為了日誌需求增加參數。 | **隱含性強**：追蹤數據來源可能變得稍微困難。 |
| **日誌一致性**：確保異步過程中的 log 全部都能打上正確的 ID。 | **效能開銷**：在極高頻率下會有微小的 Context Switch 更新成本。 |

---

## 相關參考
- [解耦日誌實作策略 (Decoupling Strategy)](./decoupling-strategy.md)
- [攔截器架構 (Interceptor Patterns)](./interceptor-patterns.md)
