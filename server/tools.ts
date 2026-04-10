import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { appStore } from './store.js';
import { Message, ActionResult, AgentContext, Task } from './types.js';
import { AIEngine } from './agent.js';

/**
 * 建立任務 (Task) 的核心函式
 */
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

    context.setState = appStore.setState.bind(appStore);

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
                    Object.assign(this, task);
                }
            });
        }
    };

    context.getState = async function (this: AgentContext, key?: string) {
        const state = appStore.getState();
        if (!key) {
            const latestTask = this.getCurrentTask!();
            if (latestTask) Object.assign(this, latestTask);
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

/**
 * 非同步工具執行邏輯 (作為改寫依據)
 * 原內容保留供參考，移除 Toolbox class 限制
 */
export async function runAsyncTool(name: string, handler: Function, args: any, context: AgentContext): Promise<ActionResult> {
    context.updateTaskState({ status: 'executing_async_tool' });
    const result = await handler(args, context);

    if (result.success && result.promise) {
        result.promise.then((data: any) => {
            const finalResult = { success: true, ...data };
            // recordToolMessage(name, finalResult, context);
            // runHooks(name, 'complete', { toolName: name, result: finalResult, context });

            /*
            commandQueue.push({
                role: 'tool',
                text: `[${name}] 非同步任務執行報告已送達。`,
                time: Date.now()
            });
            queueChanged.emit('changed');
            */
        }).catch((err: any) => {
            const errorResult = { success: false, error: err.message };
            // recordToolMessage(name, errorResult, context);
            // runHooks(name, 'error', { toolName: name, error: errorResult, context });
        });
    }
    return result;
}

/**
 * spawn_workers 實作範例 (作為改寫依據)
 */
export const spawn_workers_handler = async (args: any, context: AgentContext) => {
    const taskCount = args.workers?.length || 0;
    console.log(`  [Dispatcher] 🚀 啟動 ${taskCount} 個並行 Worker...`);

    const workerPromises = (args.workers || []).map(async (task: any, index: number) => {
        try {
            const engine = new AIEngine();
            const taskId = createTask({ role: task.role, agentId: '' });

            const promptMessage: Message = {
                role: 'user',
                text: task.task,
                time: Date.now()
            };

            console.log(`  [Dispatcher]   -> ${task.role} #${index + 1} 啟動 (Task: ${taskId})`);

            const childContext = createAgentContext({
                taskId,
                agentId: `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
                messages: [[promptMessage], []],
                status: 'pending',
                progress: 0,
                round: 0,
                workDir: context.workDir
            });

            const it = engine.generateStream("", {
                taskId,
                role: task.role,
                workDir: context.workDir,
                userMessages: [promptMessage],
                assistantMessages: []
            });

            let lastOutput = "";
            for await (const chunk of it) {
                if (chunk.type === 'chunk') lastOutput += chunk.text;
            }
            return { task: task.task, result: lastOutput };
        } catch (err: any) {
            return { task: task.task, error: err.message };
        }
    });

    return {
        success: true,
        explanation: args.explanation,
        promise: Promise.all(workerPromises)
    };
};
