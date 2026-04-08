import { EventEmitter } from 'events';
import { Message, Task, TaskStatus } from './types.js';
import { AgentContext } from './context.js';

export class AppStore extends EventEmitter {
    private state: Map<string, any>;
    constructor() {
        super();
        this.state = new Map();
        this.state.set('tasks', new Map<string, Task>());
    }

    setState(updater: (state: Map<string, any>) => void | any) {
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

// --- 全域指令隊列與異動訊號 ---
export const commandQueue: Message[] = [];
export const queueChanged = new EventEmitter();

// --- Standalone Helpers ---

export function createTask({ role, agentId }: { role: string, agentId: string }) {
    const taskId = `TASK-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
    const task: Task = {
        id: taskId,
        agentId,
        role,
        status: 'pending',
        progress: 0,
        messages: [],
        createdAt: new Date()
    };

    appStore.setState((state) => {
        const tasks = state.get('tasks') as Map<string, Task>;
        if (tasks) tasks.set(taskId, task);
    });

    return taskId;
}

/**
 * 建立具備狀態同步能力的 AgentContext
 */
export function createAgentContext(initFields: any = {}): AgentContext {
    const context = new AgentContext(initFields);

    context.getCurrentTask = function (this: AgentContext) {
        if (!this.taskId) return null;
        const tasks = appStore.getState().get('tasks') as Map<string, Task>;
        return (tasks && tasks.get(this.taskId)) || null;
    };

    // 使用 AppStore 原生的 setState (接收 updater 函式)
    context.setState = appStore.setState.bind(appStore);

    // 專門用於更新當前任務狀態的方法
    context.updateTaskState = function (this: AgentContext, updater: any) {
        if (this.taskId) {
            appStore.setState((state) => {
                const tasks = state.get('tasks') as Map<string, Task>;
                const task = tasks?.get(this.taskId!);
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

    context.getState = async function (this: AgentContext, key?: string) {
        const state = appStore.getState();
        if (!key) {
            const latestTask = this.getCurrentTask!();
            if (latestTask) {
                Object.assign(this, latestTask);
            }
            for (const [k, v] of state.entries()) {
                if (k !== 'tasks') (this as any)[k] = v;
            }
            return this;
        } else {
            const val = state.get(key);
            (this as any)[key] = val;
            return val;
        }
    };

    context.getAppState = function () {
        const state = appStore.getState();
        const stateObj: any = {};
        for (const [key, value] of state.entries()) {
            if (key !== 'tasks') stateObj[key] = value;
        }
        return stateObj;
    };

    return context;
}

import { AIEngine } from './engine.js';

export class Agent {
    private roleName: string;
    private model: any;
    private systemPrompt: string;
    private toolPrompt: string;
    private toolType: string;
    private toolbox: any;

    constructor(config: any, taskRegistry: any) {
        this.roleName = config.name;
        this.model = config.model;
        this.systemPrompt = config.systemPrompt;
        this.toolPrompt = config.toolPrompt || "";
        this.toolType = config.type;
        this.toolbox = taskRegistry;
    }

    async *run(context: AgentContext) {
        const initialGoal = context.messages[0]?.text || "未定義任務";

        await context.getState();
        if (context.status === 'pending') {
            context.updateTaskState({ status: 'active' });
        }

        console.log(`  [${this.roleName}] (${context.agentId}) 🧠 開始任務：${initialGoal.substring(0, 50)}...`);

        const engine = new AIEngine(this.model);
        const MAX_ROUNDS = context.loopCountLimit || 10;

        while (context.round < MAX_ROUNDS) {
            await context.getState();

            // 解構 Context 屬性以便循環內使用
            const { round, status, progress, messages, workDir } = context;
            let currentRound = round + 1;
            console.log(`  [${this.roleName}] 🔄 第 ${currentRound} 輪循環啟動`);

            context.updateTaskState({
                round: currentRound,
                status: 'thinking',
                progress: Math.min(10 + (currentRound * 10), 90),
                messages: [...messages]
            });

            const envInfo = `【目前工作目錄】：${workDir || "未定義"}`;
            const historyText = messages.map(m => m.text).join("\n\n");
            const statusHistory = `【任務歷史】：\n${historyText}`;
            const completeInstruction = `${this.systemPrompt}\n${this.toolPrompt}\n${envInfo}\n${statusHistory}\n\n請根據以上資訊更新開發進展或執行工具。`;

            const stream = engine.generateStream(completeInstruction, { ...context });
            let aiResponse: any = null;

            for await (const chunk of stream) {
                if (chunk.type === 'action' && chunk.action) {
                    const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    if (res && (res.deferred || res.async)) {
                         console.log(`  [Agent] ⏳ 偵測到非同步工具 (${chunk.action.name})，中斷當前推理輪次。`);
                         return { role: this.roleName, agent_id: context.agentId, status: "deferred" };
                    }
                } else if (chunk.type === 'chunk') {
                    yield chunk;
                } else if (chunk.type === 'final') {
                    aiResponse = chunk;
                    if (aiResponse?.text) {
                        const finalMsg: Message = { role: 'assistant', text: aiResponse.text, time: Date.now() };
                        messages.push(finalMsg);
                        yield finalMsg;
                    }
                }
            }



            context.updateTaskState({ status: 'thinking_completed', messages: [...messages] });

            context = context.clone({
                round: currentRound,
                status: context.status,
                progress: context.progress
            });

            if (!aiResponse) break;
            const actions = aiResponse.actions || [];
            if (aiResponse.text && !actions.length) {
                console.log(`  [${this.roleName}] ✨ 本階段任務完成 (文字回報)。`);
                context.updateTaskState({ status: 'completed', progress: 100, messages: [...context.messages] });
                return { role: this.roleName, agent_id: context.agentId, status: "success" }; 
            }
        }

        return { role: this.roleName, agent_id: context.agentId, status: "max_rounds_reached" };
    }
}
