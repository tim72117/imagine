// --- 訊號中心 (Signaler) 與 上下文定義 (Context) ---
export class Signaler {
    constructor() {
        this.events = new Map();
    }
    on(event, callback) {
        if (!this.events.has(event)) this.events.set(event, []);
        this.events.get(event).push(callback);
    }
    emit(event, data) {
        const callbacks = this.events.get(event) || [];
        callbacks.forEach(cb => cb(data));
        this.events.set(event, []); // 觸發後清空 (一次性訊號)
    }
    wait(event) {
        return new Promise(resolve => this.on(event, resolve));
    }
}

/**
 * 通用獨立的 Agent 上下文結構 (AgentContext)
 * 適用於不同場景在做複寫 (Override) 以存取全域 Store
 */
export class AgentContext {
    constructor(initFields = {}) {
        this.sessionId = initFields.sessionId || 'default';
        this.agentId = initFields.agentId || `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        this.taskId = initFields.taskId || null;
        
        // --- 核心狀態 (State) ---
        this.status = initFields.status || 'pending';
        this.progress = initFields.progress || 0;
        this.round = initFields.round || 0;
        this.goal = initFields.goal || '';
        this.messages = initFields.messages || []; // 存放推論過程的訊息陣列

        this.workDir = initFields.workDir || './';
        this.signaler = initFields.signaler || new Signaler();

        // 強制實作獲取全域 Store 方法 (預設拋錯以確保場景複寫)
        // 強制實作獲取全域 Store 方法 (預設拋錯以確保場景複寫)
        this.updateStatus = initFields.updateStatus || ((_updates) => { throw new Error("updateStatus not implemented in context."); });
        this.getHistory = initFields.getHistory || (() => "");
        this.getState = initFields.getState || (async (_key) => undefined); // 獲取/同步全域狀態的唯一入口
        this.setAppState = initFields.setAppState || ((_updates) => { throw new Error("setAppState not implemented in context."); });
    }

    /**
     * 組裝並產生一個全新的 Context 實例 (不可變性模式)
     */
    clone(overrides = {}) {
        const newInstance = new AgentContext({
            ...this,
            ...overrides,
            // 確保訊息陣列是深拷貝，避免參照污染
            messages: [...(overrides.messages || (this.messages || []))]
        });
        
        // 確保克隆後，方法內部抓取的依然是當前實例的閉包或指針 (如果是由外部注入)
        newInstance.updateStatus = overrides.updateStatus || this.updateStatus;
        newInstance.getHistory = overrides.getHistory || this.getHistory;
        newInstance.getState = overrides.getState || this.getState;
        
        return newInstance;
    }
}

// --- 全域 AI 請求佇列 (AIRequestQueue) ---
class AIRequestQueue {
    constructor(maxConcurrent = 2, minIntervalMs = 1000) {
        this.maxConcurrent = maxConcurrent;
        this.minIntervalMs = minIntervalMs;
        this.currentCount = 0;
        this.queue = [];
        this.lastCallTime = 0;
    }

    async enqueue(requestTask) {
        return new Promise((resolve, reject) => {
            this.queue.push({ requestTask, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.currentCount >= this.maxConcurrent || this.queue.length === 0) return;

        const now = Date.now();
        const timeSinceLast = now - this.lastCallTime;
        if (timeSinceLast < this.minIntervalMs) {
            setTimeout(() => this.process(), this.minIntervalMs - timeSinceLast);
            return;
        }

        const { requestTask, resolve } = this.queue.shift();
        this.currentCount++;
        this.lastCallTime = now;

        try {
            const result = await requestTask();
            resolve(result);
        } catch (err) {
            this.release();
            throw err;
        }
    }

    release() {
        this.currentCount--;
        this.process();
    }
}

export const aiQueue = new AIRequestQueue(2, 1000);

// --- 獨立 AI 推論引擎 (AIEngine) ---
export class AIEngine {
    constructor(inferenceModel) { this.model = inferenceModel; }
    
    async *generateStream(inputPrompt, context = {}) {
        const { getIsAborted, sessionId, round } = context;

        const streamResponse = await aiQueue.enqueue(async () => {
            return await this.model.generateContentStream({
                contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
            });
        });

        try {
            const allActions = [];
            let rawChunks = [];
            let accumulatedText = "";

            for await (const chunk of streamResponse.stream) {
                if (getIsAborted?.()) break;
                const candidate = chunk.candidates?.[0];
                if (!candidate?.content?.parts) continue;

                rawChunks.push(...candidate.content.parts);

                for (const part of candidate.content.parts) {
                    if (part.text) accumulatedText += part.text;
                    if (part.functionCall) {
                        const action = { name: part.functionCall.name, args: part.functionCall.args };
                        allActions.push(action);
                        yield { type: 'action', action };
                    }
                }
            }

            yield { type: 'final', text: accumulatedText, actions: allActions };

        } finally {
            aiQueue.release();
        }
    }
}

const TOOL_DESCRIPTIONS = {
    "list_files": "獲取專案目錄清單。會為每個檔案產生唯一代碼（如 [F1]），後續工具應優先使用此代碼代替路徑。",
    "read_file_content": "讀取專案內特定檔案內容。支援使用 list_files 生成的檔案代碼（例如 [F1]）進行精確定位。",
    "update_file": "編修特定檔案內容（目前僅支援覆寫）。亦支援使用檔案代碼。",
    "spawn_workers": "由協調者調派一或多個專屬執行者來處理子任務。你必須根據任務性質選擇「偵查者 (explorer)」或「編修者 (editor)」。",
    "plan": "生成一份多步驟計畫，用於引導後續行動。",
    "send_message": "向用戶發送最終結果或任務報告。",
    "ask_user": "當資訊不足或需要確認時，向用戶提問。"
};

export const COORDINATOR_TOOL_NAMES = ["spawn_workers"];
export const EXPLORER_TOOL_NAMES = ["list_files", "read_file_content"];
export const EDITOR_TOOL_NAMES = ["read_file_content", "update_file", "send_message", "ask_user", "plan"];

export function getToolDescriptionPrompt(role = 'agent') {
    let names = [];
    if (role === 'coordinator') names = COORDINATOR_TOOL_NAMES;
    else if (role === 'explorer') names = EXPLORER_TOOL_NAMES;
    else if (role === 'editor') names = EDITOR_TOOL_NAMES;

    const list = names.map(n => `- **${n}**: ${TOOL_DESCRIPTIONS[n] || n}`).join('\n');
    return `【可用工具清單 (Toolkits)】：\n${list}\n\n請根據需求選擇最適合的工具組合。`;
}

// --- 統一代理人元件 (Agent) ---
export class Agent {
    constructor(config, taskRegistry) {
        this.roleName = config.name;
        this.model = config.model;
        this.systemPrompt = config.systemPrompt;
        this.toolType = config.type;
        this.toolbox = taskRegistry;
    }

    async *run(goal, context) {
        // 確保 context 符合類別實體，若非實體則可能需要包裝
        if (!(context instanceof AgentContext)) {
            console.warn(`  [${this.roleName}] 🧱 警告：Context 非 AgentContext 實體，強制轉化。`);
        }
        
        // 1. 直接更新 Context 狀態，不再使用本地解構
        context.goal = goal;
        
        console.log(`  [${this.roleName}] (${context.agentId}) 🧠 開始任務：${goal.substring(0, 50)}...`);

        if (!context.signaler) context.signaler = new Signaler();

        // --- 0. 等待啟動訊號 (Wait for Start Signal) ---
        while (true) {
            await context.getState();
            if (context.status !== 'pending') break;
            console.log(`  [${this.roleName}] ⏳ 狀態為 pending，等待全域 Store 指令啟動...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const engine = new AIEngine(this.model);
        const MAX_ROUNDS = context.loopCountLimit || 5;

        while (context.round < MAX_ROUNDS) {
            // 0. 在每一輪開始前，取得全域 Store 的最新狀態 (使用 getState 無參數進行全域同步)
            await context.getState();

            // 1. 全解構快照 (Snapshot ALL used states + Methods)
            let { round, status, progress, messages, goal, workDir, signaler, setAppState } = context;
            
            // 拷貝訊息陣列以供本地操作 (避免直接修改 context.messages 引用)
            let localMessages = [...messages];
            let currentRound = round + 1;

            console.log(`  [${this.roleName}] 🔄 第 ${currentRound} 輪循環啟動`);

            // --- 階段性提交：紀錄輪次啟動 ---
            status = 'thinking';
            progress = Math.min(10 + (currentRound * 15), 90);
            const thinkingMsg = { role: 'system', text: `🧠 Thinking started (Round ${currentRound})...`, time: Date.now() };
            localMessages.push(thinkingMsg);
            yield thinkingMsg;
            
            // 使用 setAppState 一鍵同步回全域
            setAppState({
                round: currentRound,
                status,
                progress,
                messages: localMessages
            });

            const stepId = `STEP-${Date.now()}`;
            const envInfo = `【目前工作目錄】：${workDir || "未定義"}`;
            
            // 從 Context 直接獲取推論歷史資訊
            const currentHistory = context.getHistory ? context.getHistory() : "";
            const statusHistory = `【目標】：${goal}\n${currentHistory}`;
            const completeInstruction = `${this.systemPrompt}\n${getToolDescriptionPrompt(this.toolType)}\n${envInfo}\n${statusHistory}`;

            await new Promise(resolve => setTimeout(resolve, 1000));

            // AI 推理階段
            const stream = engine.generateStream(completeInstruction, { ...context });
            let aiResponse = null;
            let pendingSleep = false;

            for await (const chunk of stream) {
                if (chunk.type === 'action') {
                    // --- 工具執行 ---
                    status = 'executing_tool';
                    setAppState({ status });

                    // 工具內部會更新 context.messages
                    const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    
                    // 從 context.messages 中抓取最新加入的工具相關訊息並 yield
                    // 一般 execute_tool 會推入 2 條訊息：started 與 result
                    const newMessages = context.messages.slice(localMessages.length);
                    for (const msg of newMessages) {
                        yield msg;
                    }

                    // 同步本地副本
                    localMessages = [...context.messages];
                    
                    if (res && res.status === "workers_spawned") pendingSleep = true;
                } else if (chunk.type === 'final') {
                    aiResponse = chunk;
                    if (aiResponse?.text) {
                        const finalMsg = { role: 'assistant', text: aiResponse.text, time: Date.now() };
                        localMessages.push(finalMsg);
                        yield finalMsg;
                    }
                }
            }

            if (pendingSleep) {
                console.log(`  [${this.roleName}] 💤 進入休眠期，等待訊號喚醒...`);
                status = 'waiting';
                const waitMsg = { role: 'system', text: `⏳ Waiting for sub-agents to complete tasks...`, time: Date.now() };
                localMessages.push(waitMsg);
                yield waitMsg;
                
                setAppState({
                    status,
                    messages: localMessages
                });
                
                const subTasksResults = await signaler.wait('workers_done');
                console.log(`  [${this.roleName}] 🔔 喚醒點：獲取成果，解鎖循環。`);
                const resumeMsg = { role: 'tool', text: `Sub-agents results: ${JSON.stringify(subTasksResults).substring(0, 500)}`, tool: 'spawn_workers', time: Date.now() };
                localMessages.push(resumeMsg);
                yield resumeMsg;
            }

            status = 'thinking_completed';
            setAppState({
                status: status,
                messages: localMessages
            });

            // 3. 這一輪結束，重新組裝 Context 並賦值回變數，讓下一輪使用全新的實體 (情況二模式)
            context = context.clone({
                round: context.round,
                status: context.status,
                progress: context.progress
            });

            if (!aiResponse) {
                console.error(`  [${this.roleName}] ❌ 無法獲取 AI 回應。`);
                break;
            }

            console.log(`  [${this.roleName}] 💭 分析：${aiResponse.text.substring(0, 150).replace(/\n/g, ' ')}${aiResponse.text.length > 150 ? '...' : ''}`);

            // 狀態變更已交由 Store 的 THINK_RESULT/TOOL_RESULT 日誌自動處理彙整
            // (Agent 本地不再維護與拼接 statusHistory 變數)
            
            const hasStopTool = aiResponse.actions.some(a => ['send_message', 'ask_user'].includes(a.name));
            const isDoneWithoutTools = aiResponse.actions.length === 0 && aiResponse.text.length > 0;

            if (hasStopTool || isDoneWithoutTools) {
                console.log(`  [${this.roleName}] ✨ 任務結束。`);
                break;
            }

            if (aiResponse.actions.length === 0 && !aiResponse.text) {
                console.log(`  [${this.roleName}] ⚠️ 偵測到空回應，強制結束以防空轉。`);
                break;
            }
        }

        // --- 已完成 ---
        status = 'completed';
        progress = 100;
        const completeMsg = { role: 'system', text: `✅ Task goal achieved. Finalizing.`, time: Date.now() };
        localMessages.push(completeMsg);
        yield completeMsg;

        // 最後組裝回報
        setAppState({
            status,
            progress,
            messages: localMessages
        });

        return { role: this.roleName, agent_id: context.agentId, status: "complete" };
    }
}
