# AI 代理通訊架構實驗筆記 (TODO)

## 🚀 已完成里程碑 (Completed Milestones)

### 2026-04-14: 訊息序列驗證與架構修復
- **核心變更**: 
    - 實現 `TestMessageSequenceIncrementalCheck` 與 `CaptureProxyProvider`，達成對推論輸入序列的精確捕獲與驗證。
    - 修復了 `git pull` 後的型別衝突，將引擎完全對齊 `types.ToolUseContextInterface` 規範。
    - 確立了 `agent.go` 作為單一推論循環控制者的地位。

### 2026-04-08: 事件驅動與解耦重構 (Event-Driven & Decoupling Refactor)
- **核心變動摘要**: 完全移除 Agent 內部的 Signaler 喚醒機制，達成「極簡 Agent」與「強大 Coordinator」的協作模式。
- **1. Agent 類別 (agent.ts) - 執行層**:
    - **零阻塞運行**: 移除產生器內部的 `await signaler.wait(...)` 呼叫。
    - **即取即停**: Agent 在每一輪開始時主動清空 `commandQueue`；一旦任務階段性完成、需要使用者介入、或是分配了子任務，立即結束實例 (break)。
    - **純粹狀態機**: 不再關心指令來源，僅專注處理目前 `context.messages` 中的歷史紀錄。
- **2. Coordinator 類別 (ai.ts) - 調度層**:
    - **統一事件中心**: 作為長駐型產生器，外部統一監聽 `Signaler`。
    - **先同步、後執行**: 偵測到指令異動後，先將 `commandQueue` 訊息合併至歷史紀錄，再投射新的 Agent 實例接續處理。
    - **指令隊列維護**: 職責上移至 Coordinator，確保 Agent 啟動時看到完整狀態。
- **3. spawn_workers 工具 (tools.ts) - 指令層**:
    - **一致性回傳機制**: 子任務推論結束後，**由調派工具 (spawn_workers) 負責**將彙整後的推論資訊格式化為 tool 角色訊息，推入父 Agent 的 `commandQueue` 並觸發 `new_command` 訊號。
    - **事件驅動流程**: 子任務處理完結後，訊息推入隊列，等待父 Agent 實例結束（或已結束）後，再由調度者啟動新的 Agent 實例接續處理。

### 2026-04-02: 日誌分析與架構問題 (Log Analysis: SESSION-1775139388515)
- **1. 路徑冗餘與沙盒路徑混淆 (Primary Technical Issue)**
    - **現象**: Worker 不斷收到 `ENOENT` (找不到檔案) 的錯誤，嘗試開啟的路徑為 `/.../imagine/src/sandbox/src/sandbox/Target.tsx`。
    - **理由**: 系統預設 `workDir` 為 `src/sandbox`，但 AI 在工具參數中又帶入了重複的路徑。兩者疊加後產生了雙重的 `src/sandbox/` 路徑。
    - **影響**: AI 耗費了 4-5 輪推論和多次 `list_files` 偵查才找到檔案，造成顯著的 Token 浪費與任務延遲。
- **2. 協調者的任務拆解邏輯錯誤 (Task Dependency Issue)**
    - **現象**: 協調者將「讀取 -> 修改 -> 寫回」這類具備 **強烈順序依賴** 的操作發派給了多個並行執行的 Worker。
    - **理由**: 分派任務時未評估子任務間的相依性，逕行將線性任務視為獨立任務發派。
    - **影響**: Worker 2 在 Worker 1 出現結果前就嘗試動作，導致競態條件 (Race Condition) 或各個 Worker 重複相同的錯誤流程。
- **3. 重複調派與多重 Worker 資源競爭 (Over-dispatching)**
    - **現象**: 在同一個 Session 中，針對同一個「刪除按鈕」目標，出現了多組 Worker 在 Round 1 與 Round 6 被重複啟動。
    - **影響**: 多個代理人實例在後台同時對同一個 `Target.tsx` 檔案進行操作，導致日誌混亂且工具反饋互相干擾。
- **4. 「詢問使用者」與「自問自答」的矛盾 (Signal Paradox)**
    - **現象**: Agent 在 Round 5 正確呼叫 `ask_user`，但在 Round 6 卻立刻表示：「使用者還沒回覆，我直接假設...」並強行推進。
    - **影響**: 使 `ask_user` 安全機制形同虛設。在自動化流程中，未經回傳訊號就自行下假設，可能導致非預期的破壞性改動。
- **原因分析**: 顯示非同步寫入或併行紀錄時缺乏全域排序機制，這使得回溯「任務因果關係」變得困難。

### 2026-03-31: 流式時序執行 (Sequential Streaming Flush)
- **核心目標**: 達成「對話泡泡」與「動作泡泡」完全依據 AI 產出的原始時序交織排列，且不被強行合併。
- **邏輯方案 (暫予封存)**: 
    1. **緩衝區沖刷 (Flush Mechanism)**: 在 `for await` 大循環中維護一個 `textToFlush` 變數。
    2. **斷點偵測**: 只要 AI 生成了一個 `functionCall`，就立即執行 `registry.execute([{ name: "stage_report", args: { summary: textToFlush } }])`。
    3. **即時性**: 不再對工具進行 Batch 排序執行，改為單點即時調用。
- **目前狀態**: 已依要求還原至「穩定批次彙整版」。

Spawner (衍生器) 或 Orchestrator (協調者)

worker 可以用文字的方式設定技能

---

## 🛠️ 待執行議題 (Pending Tasks)

### 1. 代理人推論效能與連續循環優化 (新)
- **問題分析**: 模型 (如 Gemma 4) 傾向於在文字中幻想執行劇本，而非觸發真實工具調用。
- **TODO**: 
    - [ ] **硬性指令**: 在 `ToolPrompt` 中嚴禁文字模擬工具結果。
    - [ ] **自動推進**: 研發迭代偵測邏輯，若中間輪次未調用工具則自動追加「請繼續」指令。
    - [ ] **完成標記**: 要求模型在徹底完成時輸出 `[[DONE]]` 關鍵字。
    - [ ] **角色強化**: 優化 `explorer.agent` 指令，使其更具行動導向。

### 2. TODO: 將 AIEngine 實作改為全域單一佇列請求方式。
- [ ] 支援設定一次可並發請求數。
- [ ] 支援設定每秒請求數量 (Rate Limiting)，避免觸發 API 限制。

### 3. 規劃後細節詢問機制 (Post-Plan Detail Querying)
- [ ] 當 `plan` 分解完畢後，若有模糊項應具備詢問細節的能力。
- [ ] **持久化記憶 (Persistent Memory)**: 思考如何跨越 Task Lifecycle 將這些細節答案存入 `Framework.md` 或獨立的 `context.json` 中。

### 4. `send_message` 重複出現問題 (Duplicate Output Loop)
- [ ] 修正 `ai_request` 的解析邏輯與 `generateContentStream` 的 chunk 捕捉方式，確保不會對同一段文字重複派發任務。

### 5. 子任務隔離與 Context 管理 (New)
- [ ] **TODO: 隔離子任務的 context**：確保派發出的 Worker 擁有獨立的 `agentContext` 空間，避免對話紀錄 (Messages) 與父代理人交叉污染。

---

## 💡 靈感與想法 (Ideas & Future Visions)

### 跨代理人通訊架構與工作流
調度開始時，message內有一個參數是agent id，user 發送的對話沒有agent id，這時就產生一個，將id包在context送進agent作為agentContext，在 agent 內循環時，呼叫context.SetState將agentContext同步進store內的一筆資料，這筆資料可以用agent id找到，agent 若有非同步工具呼叫，就要新增一個task推進agentContext.tasks，將task id agent_id送進執行工具，工具使用結束時將執行結果更新到task中 並將 agent id包進message送進GlobalCommandQueue，調度者這時啟用的agent，就從store取得agent 上一次的資訊作為這次的agentContext，若非同步呼叫是產生新調度時，子agent的context.SetState會被置換成綁定UpdateTaskState，將agentContext同步進父agent在store的context.task內。

- GoogleGenerativeAI

### 多目錄分析支援
idea
常常會有多目錄工作的情況，且可能要分析其他目錄作為這個專案的依據。

---