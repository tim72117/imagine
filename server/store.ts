import { EventEmitter } from 'events';
import { Task } from './types.js';
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
