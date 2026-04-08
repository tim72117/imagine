# AI 代理通訊架構實驗筆記 (TODO)

## 代理人架構重構：事件驅動與解耦 (Event-Driven & Decoupling Refactor)
### 實作日期：2026-04-08

### 核心變動摘要
完全移除 Agent 內部的 Signaler 喚醒機制，達成「極簡 Agent」與「強大 Coordinator」的協作模式。

#### 1. Agent 類別 (agent.ts) - 執行層
- **零阻塞運行**: 移除產生器內部的 `await signaler.wait(...)` 呼叫。
- **即取即停**: Agent 在每一輪開始時主動清空 `commandQueue`；一旦任務階段性完成、需要使用者介入、或是分配了子任務，立即結束實例 (break)。
- **純粹狀態機**: 不再關心指令來源，僅專注處理目前 `context.messages` 中的歷史紀錄。

#### 2. Coordinator 類別 (ai.ts) - 調度層
- **統一事件中心**: 作為長駐型產生器，外部統一監聽 `Signaler`。
- **先同步、後執行**: 偵測到指令異動後，先將 `commandQueue` 訊息合併至歷史紀錄，再投射新的 Agent 實例接續處理。
- **指令隊列維護**: 職責上移至 Coordinator，確保 Agent 啟動時看到完整狀態。

#### 3. spawn_workers 工具 (tools.ts) - 指令層
- **一致性回傳機制**: 子任務推論結束後，**由調派工具 (spawn_workers) 負責**將彙整後的推論資訊格式化為 tool 角色訊息，推入父 Agent 的 `commandQueue` 並觸發 `new_command` 訊號。
- **事件驅動流程**: 子任務處理完結後，訊息推入隊列，等待父 Agent 實例結束（或已結束）後，再由調度者啟動新的 Agent 實例接續處理。

### 架構優勢
- **各司其職**: Server 負責接收，Coordinator 負責排程與狀態同步，Agent 負責純粹推理。
- **資源效率**: Agent 執行完畢即銷毀，具備更強的可觀測性與資源回收效率。
- **測試便利**: Agent 不再依賴異步隊列，易於進行核心推理邏輯的單元測試。

---

## 實驗議題：流式時序執行 (Sequential Streaming Flush)
### 實作日期：2026-03-31

### 核心目標
達成「對話泡泡」與「動作泡泡」完全依據 AI 產出的原始時序交織排列，且不被強行合併。

### 邏輯方案 (暫予封存)
1. **緩衝區沖刷 (Flush Mechanism)**: 在 `for await` 大循環中維護一個 `textToFlush` 變數。
2. **斷點偵測**: 只要 AI 生成了一個 `functionCall`，就立即執行 `registry.execute([{ name: "stage_report", args: { summary: textToFlush } }])`。
3. **即時性**: 不再對工具進行 Batch 排序執行，改為單點即時調用。

### 優缺點分析
- **優點**: 極致的實時感，對話與動作的先後順序完全透明。
- **缺點**: 對後端 `while` 迴圈與 `registry` 的執行頻率要求較高，且文字片段過小時可能導致過多零碎泡泡（需加強 Trim/Buffer 判斷）。

Spawner (衍生器) 或 Orchestrator (協調者) 

worker 可以用文字的方式設定技能
---
### 目前狀態：已依要求還原至「穩定批次彙整版」。

---

## 待執行議題 (Pending Tasks)
1. **TODO: 將 AIEngine 實作改為全域單一佇列請求方式。**:
    - [ ] 支援設定一次可並發請求數。
    - [ ] 支援設定每秒請求數量 (Rate Limiting)，避免觸發 API 限制。
2. **規劃後細節詢問機制 (Post-Plan Detail Querying)**:
    - 當 `plan` 分解完畢後，若有模糊項應具備詢問細節的能力。
    - **持久化記憶 (Persistent Memory)**: 思考如何跨越 Task Lifecycle 將這些細節答案存入 `Framework.md` 或獨立的 `context.json` 中。
3. **`send_message` 重複出現問題 (Duplicate Output Loop)**:
    - AI 推論時似乎會重複產生文字片段或重複呼叫 `send_message` 任務。
    - 需檢查 `ai_request` 的解析邏輯與 `generateContentStream` 的 chunk 捕捉方式，確保不會對同一段文字重複派發任務。

---

## 日誌分析與架構問題 (Log Analysis: SESSION-1775139388515)
### 實作日期：2026-04-02

### 核心發現與原始分析內容
1. **路徑冗餘與沙盒路徑混淆 (Primary Technical Issue)**
   - **現象**: Worker 不斷收到 `ENOENT` (找不到檔案) 的錯誤，嘗試開啟的路徑為 `/.../imagine/src/sandbox/src/sandbox/Target.tsx`。
   - **理由**: 系統預設 `workDir` 為 `src/sandbox`，但 AI 在工具參數中又帶入了重複的路徑。兩者疊加後產生了雙重的 `src/sandbox/` 路徑。
   - **影響**: AI 耗費了 4-5 輪推論和多次 `list_files` 偵查才找到檔案，造成顯著的 Token 浪費與任務延遲。

2. **協調者的任務拆解邏輯錯誤 (Task Dependency Issue)**
   - **現象**: 協調者將「讀取 -> 修改 -> 寫回」這類具備 **強烈順序依賴** 的操作發派給了多個並行執行的 Worker。
   - **理由**: 分派任務時未評估子任務間的相依性，逕行將線性任務視為獨立任務發派。
   - **影響**: Worker 2 在 Worker 1 出現結果前就嘗試動作，導致競態條件 (Race Condition) 或各個 Worker 重複相同的錯誤流程。

3. **重複調派與多重 Worker 資源競爭 (Over-dispatching)**
   - **現象**: 在同一個 Session 中，針對同一個「刪除按鈕」目標，出現了多組 Worker 在 Round 1 與 Round 6 被重複啟動。
   - **影響**: 多個代理人實例在後台同時對同一個 `Target.tsx` 檔案進行操作，導致日誌混亂且工具反饋互相干擾。

4. **「詢問使用者」與「自問自答」的矛盾 (Signal Paradox)**
   - **現象**: Agent 在 Round 5 正確呼叫 `ask_user`，但在 Round 6 卻立刻表示：「使用者還沒回覆，我直接假設...」並強行推進。
   - **影響**: 使 `ask_user` 安全機制形同虛設。在自動化流程中，未經回傳訊號就自行下假設，可能導致非預期的破壞性改動。

    - **原因**: 顯示非同步寫入或併行紀錄時缺乏全域排序機制，這使得回溯「任務因果關係」變得困難。
