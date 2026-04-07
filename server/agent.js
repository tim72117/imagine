// --- 訊號中心 (Signaler) ---
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

    async run(goal, context) {
        const agentId = context.agentId || `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        console.log(`  [${this.roleName}] (${agentId}) 🧠 開始任務：${goal.substring(0, 50)}...`);

        if (!context.store) {
            console.error("  [Agent] ❌ 遺失工作流 Store，無法紀錄狀態。");
            return { error: 'missing_store' };
        }

        // 1. 紀錄 Agent 啟動
        await context.store.log("AGENT_START", {
            prompt: this.roleName,
            data: { role: this.roleName, agent_id: agentId, goal, session_id: context.sessionId }
        });

        if (!context.signaler) context.signaler = new Signaler();

        const engine = new AIEngine(this.model);
        const MAX_ROUNDS = context.loopCountLimit || 5;
        let round = 0;

        while (round < MAX_ROUNDS) {
            round++;
            console.log(`  [${this.roleName}] 🔄 第 ${round} 輪循環`);

            // 將當前狀態注入 context，供工具日誌使用
            context.role = this.roleName;
            context.round = round;
            context.agentId = agentId;

            const stepId = `STEP-${Date.now()}`;
            const envInfo = `【目前工作目錄】：${context.workDir || "未定義"}`;
            
            // 從 Store 實時獲取本 Agent 或 Session 的推論歷史 (實現跨 Agent 共用)
            const currentHistory = context.store.getInferenceHistory(context.sessionId);
            const statusHistory = `【目標】：${goal}\n${currentHistory}`;
            const completeInstruction = `${this.systemPrompt}\n${getToolDescriptionPrompt(this.toolType)}\n${envInfo}\n${statusHistory}`;

            // --- 精確除錯斷點：在正式請求 AI 之前停頓 ---
            if (context.isDebugMode) {
                console.log(`  [${this.roleName}] 🚧 準備執行 AI 推理...`);
                await context.store.log("DEBUG_PAUSE", {
                    prompt: `request_api_round_${round}`,
                    data: { role: this.roleName, round, session_id: context.sessionId, agent_id: agentId }
                });
                await context.signaler.wait('debug_continue'); // 進入休眠，直到接到 debug_continue 訊號
            }

            await context.store.log("THINK_START", {
                prompt: completeInstruction,
                data: { id: stepId, role: this.roleName, round, session_id: context.sessionId, agent_id: agentId }
            });

            await new Promise(resolve => setTimeout(resolve, 1000));

            const stream = engine.generateStream(completeInstruction, { ...context, round });
            let aiResponse = null;
            let toolResults = [];
            let pendingSleep = false;

            for await (const chunk of stream) {
                if (chunk.type === 'action') {

                    const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    toolResults.push({ name: chunk.action.name, output: res });


                    if (res && res.status === "workers_spawned") pendingSleep = true;
                } else if (chunk.type === 'final') {
                    aiResponse = chunk;
                }
            }

            if (pendingSleep) {
                console.log(`  [${this.roleName}] 💤 進入休眠期，等待訊號喚醒...`);
                const subTasksResults = await context.signaler.wait('workers_done');
                console.log(`  [${this.roleName}] 🔔 喚醒點：獲取成果，解鎖循環。`);
                toolResults.push({ name: "sub_tasks_result", output: subTasksResults });
            }

            await context.store.log("THINK_RESULT", {
                prompt: stepId,
                output: aiResponse,
                data: { id: stepId, role: this.roleName, round, session_id: context.sessionId, agent_id: agentId }
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

        // 2. 紀錄 Agent 關閉
        await context.store.log("AGENT_END", {
            prompt: this.roleName,
            data: { role: this.roleName, agent_id: agentId, session_id: context.sessionId }
        });

        return { role: this.roleName, agent_id: agentId, status: "complete", final_text: statusHistory };
    }
}
