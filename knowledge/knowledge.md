# Claude Code 狀態管理與代理架構知識庫

本文總結了 Claude Code 中關於 AppState、工具 (Tool) 執行上下文以及 Coordinator-Worker 協作的核心機制。

## 1. AppState 核心機制

### 1.1 Store 實作 (`src/state/store.ts`)
系統使用一個簡單的 `Store<T>` 模式：
*   **`getState()`**：直接回傳目前記憶體中的 `state` 參照。
*   **`setState(updater)`**：
    1.  執行 `updater(prev)` 產生新狀態。
    2.  使用 `Object.is` 進行引用檢查（Immutability Check）。若引用相同則跳過更新。
    3.  **副作用 (Side Effects)**：觸發 `onChangeAppState` 同步到磁碟或遠端。
    4.  **通知 (Listener)**：通知所有 React 訂閱者重新渲染。

*   **核心實作片段 (`src/state/store.ts`)**：
```typescript
setState: (updater: (prev: T) => T) => {
  const prev = state
  const next = updater(prev)
  if (Object.is(next, prev)) return // 引用相同則跳過更新
  state = next
  onChange?.({ newState: next, oldState: prev })
  for (const listener of listeners) listener()
},
```

### 1.2 全域變動總閘口 (`src/state/onChangeAppState.ts`)
所有狀態變更後的副作用都在此處統一處理：
*   **同步權限模式**：當 `permission_mode` 改變時，會通知 CCR (Cloud Contextual Runtime) 與 SDK。
*   **自動持久化**：自動將 `verbose`、`model` 等設定寫入磁碟。
*   **快取清理**：當 `settings` 改變時，清除 API 金鑰或憑證快取。

*   **核心實作片段 (`src/state/onChangeAppState.ts`)**：
```typescript
// 以權限模式變更為例
if (prevMode !== newMode) {
  const prevExternal = toExternalPermissionMode(prevMode)
  const newExternal = toExternalPermissionMode(newMode)
  if (prevExternal !== newExternal) {
    notifySessionMetadataChanged({ permission_mode: newExternal })
  }
  notifyPermissionModeChanged(newMode)
}
```

---

## 2. 任務 (Task) 管理與更新

### 2.1 專用 Helper (`src/utils/task/framework.ts`)
針對 `AppState.tasks` 的更新，系統提供了專用方法，以確保效能與型別安全：
*   **`updateTaskState<T>(taskId, setAppState, updater)`**：更新特定 ID 的任務狀態，內含引用檢查優化。

```typescript
// src/utils/task/framework.ts
export function updateTaskState<T extends TaskState>(
  taskId: string,
  setAppState: SetAppState,
  updater: (task: T) => T,
): void {
  setAppState(prev => {
    const task = prev.tasks?.[taskId] as T | undefined
    if (!task) return prev
    const updated = updater(task)
    if (updated === task) return prev // 引用沒變則跳過更新
    return { ...prev, tasks: { ...prev.tasks, [taskId]: updated } }
  })
}
```
*   **`registerTask(task, setAppState)`**：將新任務加入 Store 並發送 SDK 開始事件。
*   **`evictTerminalTask(taskId, setAppState)`**：在寬限期過後，從記憶體中移除已結束的任務。

### 2.2 `setAppStateForTasks`
由於 Agent 內部的 `setAppState` 可能是受限的（No-op），系統提供這個專用方法，確保任務狀態的更新（如殺死任務、回傳進度）能繞過隔離層直接到達根 Store (Root Store)。

---

## 3. Agent 內部循環與 Message 處理

### 3.1 訊息累積 (`src/query.ts`)
Agent 的 `queryLoop` 是一個 `while(true)` 循環：
1.  **收集**：在每輪 API 呼叫後，收集 `AssistantMessage` 與工具執行的 `toolResults`。
2.  **遞移**：在循環末端，將新舊訊息合併 `[...old, ...new]` 並寫入下一個 `state.messages`，然後 `continue` 進入下一輪。
3.  **壓縮**：在每輪開始前，會執行 `autocompact`（摘要化）或 `snip`（剪裁），以符合脈絡視窗限制。

*   **循環末端實作 (`src/query.ts`)**：
```typescript
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  turnCount: nextTurnCount,
  transition: { reason: 'next_turn' },
  // ...
}
state = next
continue // 進入下一輪 while (true)
```

---

## 4. Coordinator 與 Worker (子代理) 協作

### 4.1 上下文隔離 (Isolation)
Coordinator 在呼叫 Worker 時，會建立一個**全新且隔離**的 `ToolUseContext`：
*   **不繼承歷史**：Worker 只會收到專屬的 `prompt` 訊息，看不到 Coordinator 的對話歷史。
*   **隔離寫入**：預設封鎖對全域 React 狀態的 `setAppState` 權限。
*   **策略過濾 (`getAppState`)**：Worker 的 `getAppState` 被包裝過，讀取時永遠會強制設定 `shouldAvoidPermissionPrompts: true`，防止子代理在地端彈出詢問視窗。

*   **隔離實作片段 (`src/utils/forkedAgent.ts`)**：
```typescript
return {
  ...parentContext,
  // 隔離 setAppState
  setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {},

  // 策略性 getAppState 覆蓋
  getAppState: () => {
    const state = parentContext.getAppState()
    return {
      ...state,
      toolPermissionContext: {
        ...state.toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      },
    }
  },
}
```

### 4.2 調用準備 (`AgentTool.tsx`)
啟動 Worker 前，Coordinator 必須將所需的背景資訊（檔案路徑、規格等）合成到 `prompt` 中，因為 Worker 是以**失憶狀態**啟動的獨立對話流。

---

---

## 5. Agent 訊號與喚醒機制 (Wake-up Mechanism)

### 5.1 統一指令隊列 (`src/utils/messageQueueManager.ts`)
系統維護一個全域的 `commandQueue`，作為非同步事件的「降落場」：
*   **用途**：接收使用者輸入、子 Agent 完成通知、或是非同步工具的結果。
*   **觸發通報**：
    1.  訊息進入隊列：執行 `commandQueue.push()`。
    2.  發出訊號：呼叫 `notifySubscribers()` ➜ `queueChanged.emit()`。
*   **設計優點**：解耦 (Decoupling)，訊息產生者（如背景任務）不需要知道處理者（REPL）在哪裡。

### 5.2 隊列處理器 (`src/hooks/useQueueProcessor.ts`)
這是位於 UI 外殼的監聽器，負責監控「紅綠燈」並喚醒 Agent：
*   **訂閱模式**：使用 `useSyncExternalStore` 監聽 `queueChanged` 訊號。
*   **喚醒條件**：
    1.  `isQueryActive === false`（Agent 處於閒置狀態）。
    2.  `commandQueue` 中有待處理訊息。
*   **處理流程**：`processQueueIfReady` ➜ `executeQueuedInput` ➜ `onQuery` ➜ 啟動新的 `query()` 實例。

---

## 6. 溝通管道與工具執行 (Communication & Tools)

### 6.1 Yield vs. Store
Agent 對外傳遞資訊有兩條並行路徑：
*   **`yield` (流式輸出)**：用於傳遞對話文字、工具呼叫事件。優點是能實現即時的「逐字噴出」效果。
*   **Store (AppState)**：用於同步系統狀態，如 Token 消耗、檔案快照、背景任務進度。

### 6.2 同步與非同步工具處理
*   **同步工具 (Synchronous Tools)**：如 `read_file`。Agent 直接 `await` 工具結果，回傳後延續**同一個推論回合**。
*   **非同步工具 (Asynchronous Tools)**：如 `agent_tool`。
    1.  工具啟動後，Agent 當前回合結束並進入閒置。
    2.  背景任務完成後，將結果送入 `commandQueue`。
    3.  透過 **5.2** 的機制喚醒 Agent 開啟**新的推論回合**。

---

## 7. 知識總結對應表 (更新版)

| 功能節點 | 核心檔案 | 關鍵點 |
| :--- | :--- | :--- |
| **狀態讀取/寫入** | `store.ts` | 簡單參照回傳、不可變更新 + 引用檢查。 |
| **全域副作用** | `onChangeAppState.ts` | 同步 CCR、持久化、清理快取。 |
| **子代理建立** | `forkedAgent.ts` | `createSubagentContext` 建立受控複本（環境隔離）。 |
| **訊息遞移** | `query.ts` | 在循環終端合併陣列並遞回至下一輪。 |
| **任務更新** | `framework.ts` | `updateTaskState` 用於安全修改 `AppState.tasks`。 |
| **訊息傳遞** | `REPL.tsx` / `query.ts` | 對話走 `yield` 流，元數據走 `store`。 |
| **異步喚醒** | `useQueueProcessor.ts` | 監聽 `commandQueue` 訊號，於閒置時啟動新推論。 |
| **工具執行** | `AgentTool.tsx` | 同步直接回傳，異步走 `commandQueue` 流程。 |
