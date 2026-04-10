export interface Message {
    role: 'user' | 'assistant' | 'system' | 'tool';
    text: string;
    parts?: any[];
    time: number;
    data?: any;
    tool?: string;
}

export type TaskStatus = 'pending' | 'active' | 'thinking' | 'thinking_completed' | 'executing_tool' | 'waiting' | 'completed' | 'error' | 'tool_completed' | 'tool_failed';

export interface Task {
    id: string;
    agentId: string;
    role: string;
    goal?: string;
    status: TaskStatus;
    progress: number;
    round?: number;
    messages: Message[][];
    createdAt: Date;
    updatedAt?: Date;
}

export interface AgentConfig {
    name: string;
    model?: any;
    systemPrompt: string;
    toolPrompt?: string;
    type: 'coordinator' | 'explorer' | 'editor';
    allowedTools?: string[];
}

export interface ActionResult {
    success: boolean;
    status?: string;
    error?: string;
    promise?: Promise<any>;
    [key: string]: any;
}

/**
 * 通用獨立的 Agent 上下文結構 (AgentContext)
 */
export class AgentContext {
    agentId: string;
    taskId: string | null;
    status: TaskStatus;
    progress: number;
    round: number;
    messages: Message[][];
    workDir: string;
    loopCountLimit?: number;

    getCurrentTask(): Task | null { return null; }
    setState(updater: any): void {}
    updateTaskState(updater: any): void {}
    async getState(key?: string): Promise<any> { return this; }
    getAppState(): any { return {}; }

    [key: string]: any;

    constructor(initFields: any = {}) {
        Object.assign(this, initFields);
        this.agentId = initFields.agentId || `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        this.taskId = initFields.taskId || null;
        this.status = initFields.status || 'pending';
        this.progress = initFields.progress || 0;
        this.round = initFields.round || 0;
        this.messages = initFields.messages || [[], []];
        this.workDir = initFields.workDir || './';

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
        newInstance.setState = this.setState.bind(newInstance);
        newInstance.getState = this.getState.bind(newInstance);
        newInstance.getAppState = this.getAppState.bind(newInstance);
        newInstance.getCurrentTask = this.getCurrentTask.bind(newInstance);
        newInstance.updateTaskState = this.updateTaskState.bind(newInstance);
        return newInstance;
    }
}
