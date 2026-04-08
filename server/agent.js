import { EventEmitter } from 'events';

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

// --- 統一應用狀態存儲 (App Store) ---
export class AppStore extends EventEmitter {
    constructor() {
        super();
        this.state = new Map(); 
        this.state.set('tasks', new Map());
    }

    setState(updater) {
        if (typeof updater === 'function') {
            updater(this.state);
            this.emit('state_update', { global: true });
        }
    }

    getState() {
        return this.state;
    }
}

export const appStore = new AppStore();

// --- Standalone Helpers ---

export function createTask({ role, agentId }) {
    const taskId = `TASK-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    const task = {
        id: taskId,
        agentId,
        role,
        status: 'pending',
        progress: 0,
        messages: [],
        createdAt: new Date()
    };
    
    appStore.setState((state) => {
        const tasks = state.get('tasks');
        if (tasks) tasks.set(taskId, task);
    });
    
    return taskId;
}

/**
 * 通用獨立的 Agent 上下文結構 (AgentContext)
 */
export class AgentContext {
    constructor(initFields = {}) {
        Object.assign(this, initFields);

        this.agentId = initFields.agentId || `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        this.taskId = initFields.taskId || null;
        
        this.status = initFields.status || 'pending';
        this.progress = initFields.progress || 0;
        this.round = initFields.round || 0;
        this.messages = initFields.messages || [];

        this.workDir = initFields.workDir || './';
        this.signaler = initFields.signaler || new Signaler();
    }

    clone(overrides = {}) {
        const newInstance = new AgentContext({
            ...this,
            ...overrides,
            messages: [...(overrides.messages || (this.messages || []))]
        });
        if (this.setState) newInstance.setState = this.setState.bind(newInstance);
        if (this.getState) newInstance.getState = this.getState.bind(newInstance);
        if (this.getAppState) newInstance.getAppState = this.getAppState.bind(newInstance);
        if (this.getCurrentTask) newInstance.getCurrentTask = this.getCurrentTask.bind(newInstance);
        if (this.updateTaskState) newInstance.updateTaskState = this.updateTaskState.bind(newInstance);
        return newInstance;
    }
}

/**
 * 建立具備狀態同步能力的 AgentContext
 */
export function createAgentContext(initFields = {}) {
    const context = new AgentContext(initFields);

    context.getCurrentTask = function() {
        if (!this.taskId) return null;
        const tasks = appStore.getState().get('tasks');
        return (tasks && tasks.get(this.taskId)) || null;
    };

    // 使用 AppStore 原生的 setState (接收 updater 函式)
    context.setState = appStore.setState.bind(appStore);

    // 專門用於更新當前任務狀態的方法
    context.updateTaskState = function(updater) {
        if (this.taskId) {
            appStore.setState((state) => {
                const tasks = state.get('tasks');
                const task = tasks?.get(this.taskId);
                if (task) {
                    if (typeof updater === 'function') {
                        updater(task);
                    } else {
                        Object.assign(task, {
                            ...this,
                            ...updater,
                            updatedAt: new Date()
                        });
                    }
                    // 同步回實體
                    Object.assign(this, task);
                }
            });
        }
    };

    context.getState = async function(key) {
        const state = appStore.getState();
        if (!key) {
            const latestTask = this.getCurrentTask();
            if (latestTask) {
                Object.assign(this, latestTask);
            }
            for (const [k, v] of state.entries()) {
                if (k !== 'tasks') this[k] = v;
            }
            return this;
        } else {
            const val = state.get(key);
            this[key] = val;
            return val;
        }
    };

    context.getAppState = function() {
        const state = appStore.getState();
        const stateObj = {};
        for (const [key, value] of state.entries()) {
            if (key !== 'tasks') stateObj[key] = value;
        }
        return stateObj;
    };

    return context;
}

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

export class AIEngine {
    constructor(inferenceModel) { this.model = inferenceModel; }
    
    async *generateStream(inputPrompt, context = {}) {
        const { getIsAborted } = context;

        const streamResponse = await aiQueue.enqueue(async () => {
            return await this.model.generateContentStream({
                contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
            });
        });

        try {
            let accumulatedText = "";

            for await (const chunk of streamResponse.stream) {
                if (getIsAborted?.()) break;
                const candidate = chunk.candidates?.[0];
                if (!candidate?.content?.parts) continue;

                for (const part of candidate.content.parts) {
                    if (part.text) accumulatedText += part.text;
                    if (part.functionCall) {
                        const action = { name: part.functionCall.name, args: part.functionCall.args };
                        yield { type: 'action', action };
                    }
                }
            }

            yield { type: 'final', text: accumulatedText };

        } finally {
            aiQueue.release();
        }
    }
}

export class Agent {
    constructor(config, taskRegistry) {
        this.roleName = config.name;
        this.model = config.model;
        this.systemPrompt = config.systemPrompt;
        this.toolPrompt = config.toolPrompt || "";
        this.toolType = config.type;
        this.toolbox = taskRegistry;
    }

    async *run(context) {
        if (!(context instanceof AgentContext)) {
            console.warn(`  [${this.roleName}] 🧱 警告：Context 非 AgentContext 實體。`);
        }
        
        const initialGoal = context.messages[0]?.text || "未定義任務";
        
        if (context.getState) await context.getState();
        if (context.status === 'pending') {
            if (context.updateTaskState) context.updateTaskState({ status: 'active' });
        }
        
        console.log(`  [${this.roleName}] (${context.agentId}) 🧠 開始任務：${initialGoal.substring(0, 50)}...`);

        if (!context.signaler) context.signaler = new Signaler();

        const engine = new AIEngine(this.model);
        const MAX_ROUNDS = context.loopCountLimit || 10;

        while (context.round < MAX_ROUNDS) {
            if (context.getState) await context.getState();
            
            // 解構 Context 屬性以便循環內使用
            const { round, status, progress, messages, workDir, signaler } = context;
            let currentRound = round + 1;

            console.log(`  [${this.roleName}] 🔄 第 ${currentRound} 輪循環啟動`);

            if (context.updateTaskState) {
                context.updateTaskState({
                    round: currentRound,
                    status: 'thinking',
                    progress: Math.min(10 + (currentRound * 10), 90),
                    messages: [...messages]
                });
            }

            const envInfo = `【目前工作目錄】：${workDir || "未定義"}`;
            const historyText = messages.map(m => m.text).join("\n\n");
            const statusHistory = `【任務歷史】：\n${historyText}`;
            const completeInstruction = `${this.systemPrompt}\n${this.toolPrompt}\n${envInfo}\n${statusHistory}`;

            await new Promise(resolve => setTimeout(resolve, 1000));

            const stream = engine.generateStream(completeInstruction, { ...context });
            let aiResponse = null;
            let pendingSleep = false;

            for await (const chunk of stream) {
                if (chunk.type === 'action') {
                    if (context.updateTaskState) context.updateTaskState({ status: 'executing_tool' });
                    const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    if (res && res.status === "workers_spawned") pendingSleep = true;
                } else if (chunk.type === 'final') {
                    aiResponse = chunk;
                    if (aiResponse?.text) {
                        const finalMsg = { role: 'assistant', text: aiResponse.text, time: Date.now() };
                        messages.push(finalMsg);
                        yield finalMsg;
                    }
                }
            }

            if (pendingSleep) {
                console.log(`  [${this.roleName}] 💤 進入休眠期，等待訊號喚醒...`);
                if (context.updateTaskState) context.updateTaskState({ status: 'waiting', messages: [...messages] });
                const subTasksResults = await signaler.wait('workers_done');
                console.log(`  [${this.roleName}] 🔔 喚醒點：獲取成果，解鎖循環。`);
                
                const resumeMsg = { 
                    role: 'tool', 
                    text: `Sub-agents results: ${JSON.stringify(subTasksResults).substring(0, 1000)}`, 
                    tool: 'spawn_workers', 
                    time: Date.now() 
                };
                messages.push(resumeMsg);
                yield resumeMsg;
            }

            if (context.updateTaskState) context.updateTaskState({ status: 'thinking_completed', messages: [...messages] });

            context = context.clone({
                round: context.round,
                status: context.status,
                progress: context.progress
            });

            if (!aiResponse) break;
            const hasStopTool = aiResponse.actions?.some(a => ['send_message', 'ask_user'].includes(a.name));
            if (hasStopTool || (aiResponse.text && !aiResponse.actions?.length)) {
                console.log(`  [${this.roleName}] ✨ 任務結束。`);
                break;
            }
        }

        if (context.updateTaskState) context.updateTaskState({ status: 'completed', progress: 100, messages: [...context.messages] });

        return { role: this.roleName, agent_id: context.agentId, status: "complete" };
    }
}
