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
        messages: [[], []],
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
export function createAgentContext(initialFields: any = {}): AgentContext {
    const context = new AgentContext(initialFields);

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
import { ROLES } from './tools.js';

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
        const initialGoal = context.messages[0]?.[0]?.text || "未定義任務";

        await context.getState();
        if (context.status === 'pending') {
            context.updateTaskState({ status: 'active' });
        }

        console.log(`  [${this.roleName}] (${context.agentId}) 🧠 開始任務：${initialGoal.substring(0, 50)}...`);

        const engine = new AIEngine(this.model);
        const MAX_ROUNDS = context.loopCountLimit || 10;

        while (context.round < MAX_ROUNDS) {
            await context.getState();

            // 迴圈內先解構 context
            const { round, messages, workDir } = context;
            const [userMessages, assistantMessages] = messages;
            let currentRound = round + 1;
            console.log(`  [${this.roleName}] 🔄 第 ${currentRound} 輪循環啟動`);

            context.updateTaskState({
                round: currentRound,
                status: 'thinking',
                progress: Math.min(10 + (currentRound * 10), 90),
                messages: [userMessages, assistantMessages]
            });

            const envInfo = `【目前工作目錄】：${workDir || "未定義"}`;
            // 組合兩邊的訊息形成完整歷史以便推論 (依時間或交替排序)
            const flattenedHistory = [...userMessages, ...assistantMessages].sort((a, b) => (a.time || 0) - (b.time || 0));
            
            const historyText = flattenedHistory.map(m => {
                const content = m.text || m.parts?.map(p => (p as any).text || '').join('') || '';
                return content;
            }).join("\n\n");

            const statusHistory = `【任務歷史】：\n${historyText}`;
            const completeInstruction = `${this.systemPrompt}\n${this.toolPrompt}\n${envInfo}\n${statusHistory}\n\n請根據以上資訊更新開發進展或執行工具。`;

            // 準備這一輪的 Assistant 回應物件，並即時推入 assistantMessages 陣列中
            const assistantMessage: Message = { role: 'assistant', text: '', parts: [], time: Date.now() };
            assistantMessages.push(assistantMessage);

            const iteratorStream = engine.generateStream(completeInstruction, { ...context });
            let toolCalled = false;

            for await (const chunk of iteratorStream) {
                if (chunk.type === 'action' && chunk.action) {
                    toolCalled = true;
                    // 同步記錄工具調用以便模型上下文完整
                    assistantMessage.parts!.push({ functionCall: chunk.action });
                    
                    const result = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    
                    // 將工具執行回報包裝成 tool 角色訊息，直接推入 userMessages
                    const toolMessage: Message = {
                        role: 'tool',
                        text: result.async ? `[${chunk.action.name}] 非同步任務已啟動` : `[${chunk.action.name}] 執行完成`,
                        time: Date.now(),
                        data: result,
                        tool: chunk.action.name
                    };
                    
                    userMessages.push(toolMessage);
                    yield toolMessage; // 即時送出工具結果訊號

                    // 若是同步工具，即時回傳執行摘要
                    if (!result.deferred && !result.async) {
                        yield result;
                    }
                } else if (chunk.type === 'chunk') {
                    assistantMessage.parts!.push({ text: chunk.text });
                    yield chunk;
                }
            }

            context.updateTaskState({ status: 'thinking_completed', messages: [userMessages, assistantMessages] });

            context = context.clone({
                round: currentRound,
                status: context.status,
                progress: context.progress
            });

            // 當沒有調用工具時，停止循環
            if (!toolCalled) {
                console.log(`  [${this.roleName}] ✨ 本階段任務完成 (無工具調用)。`);
                break;
            }
        }

        return { role: this.roleName, agent_id: context.agentId, status: "max_rounds_reached" };
    }
}
