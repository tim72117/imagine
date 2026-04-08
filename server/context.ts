import { Message, Task, TaskStatus } from './types.js';

/**
 * 通用獨立的 Agent 上下文結構 (AgentContext)
 */
export class AgentContext {
    agentId: string;
    taskId: string | null;
    status: TaskStatus;
    progress: number;
    round: number;
    messages: Message[];
    workDir: string;
    loopCountLimit?: number;

    // Methods injected by createAgentContext or manually assigned
    getCurrentTask(): Task | null { return null; }
    setState(updater: any): void {}
    updateTaskState(updater: any): void {}
    async getState(key?: string): Promise<any> { return this; }
    getAppState(): any { return {}; }

    [key: string]: any; // Allow dynamic fields

    constructor(initFields: any = {}) {
        Object.assign(this, initFields);

        this.agentId = initFields.agentId || `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        this.taskId = initFields.taskId || null;
        
        this.status = initFields.status || 'pending';
        this.progress = initFields.progress || 0;
        this.round = initFields.round || 0;
        this.messages = initFields.messages || [];

        this.workDir = initFields.workDir || './';

        // 複寫方法 (若 initFields 中已有實作)
        if (initFields.getCurrentTask) this.getCurrentTask = initFields.getCurrentTask;
        if (initFields.setState) this.setState = initFields.setState;
        if (initFields.updateTaskState) this.updateTaskState = initFields.updateTaskState;
        if (initFields.getState) this.getState = initFields.getState;
        if (initFields.getAppState) this.getAppState = initFields.getAppState;
    }

    clone(overrides: any = {}): AgentContext {
        const newInstance = new AgentContext({
            ...this,
            ...overrides,
            messages: [...(overrides.messages || (this.messages || []))]
        });
        // 確保克隆後關鍵方法依然正確綁定
        newInstance.setState = this.setState.bind(newInstance);
        newInstance.getState = this.getState.bind(newInstance);
        newInstance.getAppState = this.getAppState.bind(newInstance);
        newInstance.getCurrentTask = this.getCurrentTask.bind(newInstance);
        newInstance.updateTaskState = this.updateTaskState.bind(newInstance);
        return newInstance;
    }
}
