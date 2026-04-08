# 專案開發歷程：後端架構現代化與 Agentic 協調系統

## 1. 核心技術遷移
- **TypeScript 化**：將所有後端核心組件（`server.ts`, `agent.ts`, `ai.ts`, `tools.ts`）從 JavaScript 遷移至 TypeScript，建立了嚴格的型別系統。
- **模組化解耦**：
    - 抽離 `AgentContext` 至 `context.ts`，標準化狀態管理與同步介面。
    - 抽離 `AIEngine` 至 `engine.ts`，封裝模型調用與推理流（Stream）處理邏輯。

## 2. Agentic 協調系統重構 (事件驅動架構)
目前系統已轉化為完全的「**按需執行、事件驅動**」模型

### 2026-04-08 架構極簡化與事件驅動重構

#### 核心變更
1.  **基礎設施極簡化**：
    *   移除 `CommandCenter` 封裝類別，改為全域 `commandQueue` (Array) 與 `queueChanged` (EventEmitter)。
    *   全面移除自定義的 `Signaler` 類別，改用原生 `Promise` 與事件監聽機制。
2.  **響應式調度優化**：
    *   `Coordinator` 現在改用 `await new Promise(resolve => queueChanged.once('changed', resolve))` 實現精確的按需喚醒。
    *   推理實例的啟動完全由全域隊列異動驅動，實現了極致的邏輯解耦。
3.  **通訊協定標準化**：
    *   所有訊息來源（WebSocket、異步工具）統一採用「推入陣列 + 發送訊號」的原子操作。
    *   推理循環透過 `commandQueue.splice(0)` 一次性提取所有待處理指令。

#### 目前狀態
*   系統已完全轉向「平直化」的全域響應式架構。
*   代碼複雜度大幅降低，通訊流動變得完全透明。
*   伺服器在中斷推理與背景任務合流方面表現更穩定。

### A. 指令隊列 (Command Queue) 機制
- 在 `AgentContext` 中引入了 `commandQueue`。
- **目標**：實現使用者輸入與子任務回傳的統一路由。
- **邏輯**：Agent 不再主動監控隊列，而是由調度者（Coordinator）在啟動 Agent 前將隊列內容併入訊息歷史。

### B. 訊號中心 (Signaler) 與 喚醒策略
- **去阻塞化**：Agent 內部完全移除了 `signaler.wait()` 呼叫，實現了「執行即停」的無狀態處理單元。
- **長駐型 Coordinator**：`Coordinator.coordinate` 轉化為長駐產生器，主動監聽 `Signaler` 訊號。
- **按需實例化**：每當有新指令或子任務完成，Coordinator 會派生一個新的 Agent 實例進行推理，處理完畢後立即銷毀。

### C. 子任務協調優化
- **子 Agent 回傳語意化**：子任務完成後，結果會封裝為 `tool` 角色的訊息推入父 Agent 的 `commandQueue`。
- **異步處理**：父 Agent 不再卡在 `spawn_workers` 呼叫點，而是結束當前執行並釋放資源，直到子任務全數完成觸發訊號後，再由新的實例接續處理。

## 3. 伺服器與會話持久化
- **WebSocket 強化**：`server.ts` 透過 `sessionId` 追蹤長連線，並僅在連線初期啟動一次 Coordinator 循環。
- **會話一致性**：利用 `sessionContexts` 保持跨指令的狀態連續性，讓 AI 像是「一直醒著」但實際上是資源按需調配。

---
*記錄時間：2026-04-08*
