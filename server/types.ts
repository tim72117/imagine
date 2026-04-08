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
    messages: Message[];
    createdAt: Date;
    updatedAt?: Date;
}

export interface AgentConfig {
    name: string;
    model: any;
    systemPrompt: string;
    toolPrompt?: string;
    type: 'coordinator' | 'explorer' | 'editor';
    allowedTools?: string[];
}

export interface ActionResult {
    success: boolean;
    status?: string;
    error?: string;
    [key: string]: any;
}
