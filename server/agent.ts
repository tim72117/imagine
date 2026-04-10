import path from 'path';
import { Message, Task, TaskStatus } from './types.js';
import { AgentContext } from './context.js';
import { appStore, createTask, createAgentContext } from './store.js';
import { commandQueue, queueChanged } from './bus.js';
import { AIEngine, AIProvider, activeProvider } from './engine.js';
import { ROLES, getTools } from './tools.js';

// --- 導出與橋接 ---
export { appStore, createTask, createAgentContext, commandQueue, queueChanged };

/**
 * Agent 執行核心
 * 負責處理單個代理人的生命週期與推論循環
 */
export class Agent {
    private roleName: string;
    private roleType: string;
    private provider: AIProvider;
    private systemPrompt: string;
    private toolPrompt: string;
    private allowedTools: string[];
    private toolbox: any;

    constructor(config: any, taskRegistry: any) {
        this.roleName = config.name;
        this.roleType = config.type;
        this.provider = config.model || activeProvider;
        this.systemPrompt = config.systemPrompt;
        this.toolPrompt = config.toolPrompt || "";
        this.allowedTools = config.allowedTools || [];
        this.toolbox = taskRegistry;
    }

    async *run(context: AgentContext) {
        const initialGoal = context.messages[0]?.[0]?.text || "未定義任務";

        // 確保上下文狀態已同步
        await context.getState();
        if (context.status === 'pending') {
            context.updateTaskState({ status: 'active' });
        }

        console.log(`  [${this.roleName}] (${context.agentId}) 🧠 開始任務：${initialGoal.substring(0, 50)}...`);

        const engine = new AIEngine(this.provider);
        
        // 呼叫 Go 引擎。Go 端的 Agent.Run 會自動處理多輪推論 (Round Loop) 與工具執行。
        const iteratorStream = engine.generateStream("", {
            ...context,
            role: this.roleType,
            userMessages: context.messages[0],
            assistantMessages: context.messages[1]
        });

        // 直接轉發來自 Go 核心的所有事件 (每一輪的文字塊、工具紀錄等)
        for await (const chunk of iteratorStream) {
            yield chunk;
        }

        console.log(`  [${this.roleName}] ✨ 本階段任務由 Go 核心處理完成。`);
        return { role: this.roleName, agent_id: context.agentId, status: "completed" };
    }
}

