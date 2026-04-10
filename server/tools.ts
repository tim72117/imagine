import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, createTask, createAgentContext } from './agent.js';
import { AgentContext } from './context.js';
import { Message, AgentConfig, ActionResult } from './types.js';
import { geminiProviders, ollamaProviders, setGlobalEngine } from './engine.js';
import { commandQueue, queueChanged } from './bus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 工具描述庫 (從 JSON 載入) ---
const TOOLS_CONFIG = fs.readJsonSync(path.join(__dirname, 'tools.json'));

export const ALL_TOOL_DECLARATIONS = TOOLS_CONFIG.declarations;

export const COORDINATOR_TOOL_NAMES = TOOLS_CONFIG.role_tools.coordinator;
export const EXPLORER_TOOL_NAMES = TOOLS_CONFIG.role_tools.explorer;
export const EDITOR_TOOL_NAMES = TOOLS_CONFIG.role_tools.editor;


export function getToolDescriptionPrompt(role: string = 'agent') {
    let names: string[] = [];
    if (role === 'coordinator') names = COORDINATOR_TOOL_NAMES;
    else if (role === 'explorer') names = EXPLORER_TOOL_NAMES;
    else if (role === 'editor') names = EDITOR_TOOL_NAMES;

    const list = names.map(n => {
        const t = ALL_TOOL_DECLARATIONS[n];
        const typeStr = t?.type === 'async' ? '【非同步】' : '【同步】';
        return `- **${n}** ${typeStr}: ${t?.description || n}`;
    }).join('\n');
    return `【可用工具清單 (Toolkits)】：\n${list}\n\n註：若是呼叫【非同步】工具，系統會在中斷當前對話並於背景執行，執行完畢後會將結果回傳至下一輪對話。`;
}

export function getTools(names: string[]) {
    const declarations = names.map(n => ALL_TOOL_DECLARATIONS[n]).filter(Boolean);
}

// --- 代理人配置定義 (Role Configs) ---
export const ROLES: Record<string, AgentConfig> = {
    coordinator: {
        name: "Coordinator",
        systemPrompt: TOOLS_CONFIG.prompts.coordinator,
        toolPrompt: getToolDescriptionPrompt('coordinator'),
        allowedTools: COORDINATOR_TOOL_NAMES,
        type: 'coordinator'
    },
    explorer: {
        name: "Explorer",
        systemPrompt: TOOLS_CONFIG.prompts.explorer,
        toolPrompt: getToolDescriptionPrompt('explorer'),
        allowedTools: EXPLORER_TOOL_NAMES,
        type: 'explorer'
    },
    editor: {
        name: "Editor",
        systemPrompt: TOOLS_CONFIG.prompts.editor,
        toolPrompt: getToolDescriptionPrompt('editor'),
        allowedTools: EDITOR_TOOL_NAMES,
        type: 'editor'
    }
};


export class Toolbox {
    private handlers: Map<string, (args: any, context: AgentContext) => Promise<ActionResult>>;
    private hooks: Map<string, ((data: any) => Promise<void>)[]>;
    constructor() {
        this.handlers = new Map();
        this.hooks = new Map();
    }

    on(toolName: string, stage: string, callback: (data: any) => Promise<void>) {
        const key = `${toolName}:${stage}`;
        if (!this.hooks.has(key)) this.hooks.set(key, []);
        this.hooks.get(key)!.push(callback);
    }

    async runHooks(toolName: string, stage: string, data: any) {
        const hooks = this.hooks.get(`${toolName}:${stage}`) || [];
        const globalHooks = this.hooks.get(`*:${stage}`) || [];
        for (const hook of [...globalHooks, ...hooks]) {
            await hook(data);
        }
    }

    register(toolName: string, handler: (args: any, context: AgentContext) => Promise<ActionResult>) {
        this.handlers.set(toolName, handler);
    }

    async execute_tool(name: string, args: any, context: AgentContext = {} as any): Promise<any> {
        const toolDef = ALL_TOOL_DECLARATIONS[name];
        const isAsync = toolDef?.type === 'async';
        const handler = this.handlers.get(name);

        if (!handler) {
            return { success: false, error: `Tool ${name} not found` };
        }

        // --- 前置 Hook ---
        await this.runHooks(name, 'before', { toolName: name, args, context });

        // --- 執行階段 (分流處理) ---
        const result = isAsync 
            ? await this.runAsyncTool(name, handler, args, context)
            : await this.runSyncTool(name, handler, args, context);

        // --- 後置 Hook ---
        await this.runHooks(name, 'after', { toolName: name, args, result, context });

        return result;
    }

    private async runSyncTool(name: string, handler: Function, args: any, context: AgentContext): Promise<ActionResult> {
        context.updateTaskState({ status: 'executing_tool' });
        const result = await handler(args, context);
        this.recordToolMessage(name, result, context);
        return result;
    }

    private async runAsyncTool(name: string, handler: Function, args: any, context: AgentContext): Promise<ActionResult> {
        context.updateTaskState({ status: 'executing_async_tool' });
        const result = await handler(args, context);
        
        if (result.success && result.promise) {
            // 在背景監聽 Promise 完成
            result.promise.then((data: any) => {
                const finalResult = { success: true, ...data };
                this.recordToolMessage(name, finalResult, context);
                this.runHooks(name, 'complete', { toolName: name, result: finalResult, context });
                
                // 喚醒機制：將結果訊號路由至全域 Queue，觸發下一輪推理
                commandQueue.push({
                    role: 'tool',
                    text: `[${name}] 非同步任務執行報告已送達。`,
                    time: Date.now()
                });
                queueChanged.emit('changed');
            }).catch((err: any) => {
                const errorResult = { success: false, error: err.message };
                this.recordToolMessage(name, errorResult, context);
                this.runHooks(name, 'error', { toolName: name, error: errorResult, context });
            });
        }
        return result;
    }

    private recordToolMessage(name: string, result: ActionResult, context: AgentContext) {
        const toolText = result.success
            ? `Tool Output from ${name}: ${JSON.stringify(result).substring(0, 500)}`
            : `Error in ${name}: ${result.error}`;
            
        if (context.messages.length === 0) context.messages = [[], []];
        
        context.messages[0].push({
            role: 'tool',
            text: toolText,
            time: Date.now()
        });
    }
}

export const toolbox = new Toolbox();

// --- 工具實作註冊 (Tool Implementations) ---

toolbox.register("list_files", async (args: any, context: AgentContext) => {
    try {
        const targetPath = path.resolve(context.workDir || ".", args.path);
        const files = await fs.readdir(targetPath);
        return { success: true, files, path: args.path, explanation: args.explanation };
    } catch (err: any) { return { success: false, error: err.message }; }
});

toolbox.register("read_file_content", async (args: any, context: AgentContext) => {
    try {
        const targetPath = path.resolve(context.workDir || ".", args.path);
        const content = await fs.readFile(targetPath, 'utf8');
        return { success: true, content, path: args.path, explanation: args.explanation };
    } catch (err: any) { return { success: false, error: err.message }; }
});

toolbox.register("update_file", async (args: any, context: AgentContext) => {
    try {
        const targetPath = path.resolve(context.workDir || ".", args.path);
        const dir = path.dirname(targetPath);
        if (!await fs.pathExists(dir)) {
            await fs.ensureDir(dir);
        }

        await fs.writeFile(targetPath, args.code);
        return { success: true, path: targetPath, explanation: args.explanation };
    } catch (err: any) { return { success: false, error: err.message }; }
});


toolbox.register("spawn_workers", async (args: any, context: AgentContext) => {
    const taskCount = args.workers?.length || 0;
    console.log(`  [Dispatcher] 🚀 啟動 ${taskCount} 個並行 Worker...`);

    const workerPromises = (args.workers || []).map(async (task: any, index: number) => {
        try {
            const roleConfig = ROLES[task.role] || ROLES.explorer;
            const worker = new Agent(roleConfig, toolbox);
            
            const taskId = createTask({
                role: roleConfig.name,
                agentId: ''
            });

            const promptMessage: Message = {
                role: 'user',
                text: task.task,
                time: Date.now()
            };

            console.log(`  [Dispatcher]   -> ${roleConfig.name} #${index + 1} 啟動 (Task: ${taskId})`);

            const childContext = createAgentContext({
                taskId,
                agentId: `AGENT-${Math.random().toString(36).substring(2, 7).toUpperCase()}`,
                messages: [[promptMessage], []],
                status: 'pending',
                progress: 0,
                round: 0,
                workDir: context.workDir
            });

            const it = worker.run(childContext);
            let result;
            while (true) {
                const next = await it.next();
                if (next.done) {
                    result = next.value;
                    break;
                }
            }
            return { task: task.task, result };
        } catch (err: any) {
            return { task: task.task, error: err.message };
        }
    });

    return { 
        success: true, 
        explanation: args.explanation,
        promise: Promise.all(workerPromises) 
    };
});
