import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { Agent, createTask, createAgentContext } from './agent.js';
import { AgentContext } from './context.js';
import { Message, AgentConfig, ActionResult } from './types.js';
import { geminiProviders, ollamaProviders, setGlobalEngine } from './engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 工具描述中央庫 (Central Tool Declarations) ---
export const ALL_TOOL_DECLARATIONS: any = {
    "list_files": {
        name: "list_files",
        description: "獲取專案目錄清單。會為每個檔案產生唯一代碼（如 [F1]），後續工具應優先使用此代碼代替路徑。",
        parameters: {
            type: "OBJECT",
            properties: {
                path: { type: "STRING", description: "要讀取的目錄路徑（例如: . 或 src/sandbox/）" },
                explanation: { type: "STRING", description: "說明為何此時需要獲取此清單。" },
                next_step: { type: "STRING", description: "獲取清單後預計執行的下一步分析動作。" }
            },
            required: ["path", "explanation", "next_step"]
        },
        type: "sync"
    },
    "read_file_content": {
        name: "read_file_content",
        description: "讀取專案內特定檔案內容。支援使用 list_files 生成的檔案代碼（例如 [F1]）進行精確定位。",
        parameters: {
            type: "OBJECT",
            properties: {
                path: { type: "STRING", description: "檔案路徑或檔案代碼（例：[F1]）" },
                explanation: { type: "STRING", description: "【極簡】說明為何此時需要調閱此檔案內容。" },
                next_step: { type: "STRING", description: "讀取並分析內容後，預計要執行的下一步動作。" }
            },
            required: ["path", "explanation", "next_step"]
        },
        type: "sync"
    },
    "update_file": {
        name: "update_file",
        description: "修改檔案內容 or 產出全新的組件代碼。支援使用檔案代碼（例：[F1]）定位目標。",
        parameters: {
            type: "OBJECT",
            properties: {
                path: { type: "STRING", description: "目標檔案路徑或代碼（例：[F1]）。" },
                code: {
                    type: "STRING",
                    description: "完整的 React 組件代碼。規範：\n1. 絕對禁止 import。\n2. 僅限一個名為 App 的組件。\n3. 無須 export。\n4. 僅限 React 18 語法與 Tailwind CSS。\n5. 不支援第三方圖示，請用 Emoji 或 Tailwind 組件圖形。"
                },
                explanation: { type: "STRING", description: "【極簡】說明本次代碼變更的核心邏輯與修改點。" },
                next_step: { type: "STRING", description: "檔案更新完成後，預計的後續開發動作。" }
            },
            required: ["path", "code", "explanation", "next_step"]
        },
        type: "sync"
    },
    "plan": {
        name: "plan",
        description: "當接收到的需求過於龐大，可能需要拆解進行多步驟處理時呼叫。進行架構分析與開發步驟的拆解。",
        parameters: {
            type: "OBJECT",
            properties: {
                analysis: { type: "STRING", description: "針對大型任務的現狀分析，或針對空泛需求的澄清、假設與困難點拆解邏輯。" },
                next_steps_plan: {
                    type: "ARRAY",
                    items: { type: "STRING" },
                    description: "預計執行的後續具體計畫步驟"
                }
            },
            required: ["analysis", "next_steps_plan"]
        },
        type: "sync"
    },
    "spawn_workers": {
        name: "spawn_workers",
        description: "由協調者調派一或多個專屬執行者來處理子任務。你必須根據任務性質選擇「偵查者 (explorer)」，他負責探索專案、閱讀代碼或收集資訊；或選擇「編修者 (editor)」，他負責實作功能、修復錯誤或修改代碼。你可以根據需要同時調派多個執行者並行工作。",
        parameters: {
            type: "OBJECT",
            properties: {
                workers: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            task: { type: "STRING", description: "指派給該執行者的具體工作目標。請使用繁體中文描述任務細節。" },
                            role: { type: "STRING", enum: ["explorer", "editor"], description: "指派的執行者角色類型。" }
                        },
                        required: ["task", "role"]
                    },
                    description: "執行者列表。每項任務都會啟動一個獨立的執行器。"
                },
                explanation: { type: "STRING", description: "說明為何需要此時調派這些執行者，以及它們分工的邏輯。" }
            },
            required: ["workers", "explanation"]
        },
        type: "async"
    }
};

export const COORDINATOR_TOOL_NAMES = ["spawn_workers"];
export const EXPLORER_TOOL_NAMES = ["list_files", "read_file_content"];
export const EDITOR_TOOL_NAMES = ["read_file_content", "update_file", "plan"];

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
    return [{ functionDeclarations: declarations }];
}

// --- 系統提示詞範本 (Prompts) ---
const COORDINATOR_SYSTEM_PROMPT = `你是一個強大的【協調者 (Coordinator)】。你的職職責是制定策略，並透過「調派 (Spawn Workers)」落實任務。

【執行者角色】：
1. **偵查者 (Explorer)**: 探索目錄、讀取檔案、報告分析結果。結構不明時優先調派。
2. **編修者 (Editor)**: 根據已知結構與需求，編修代碼。

【執行準則】：
1. **探訪優先**: 接收指令後，應先「調派」偵查者去理解專案架構，掌握檔案現況。
2. **行動導向**: 首輪回應應包含工具調派，避免僅輸出規劃文字。
3. **指揮分派**: 你不進行開發或檔案操作。必須呼叫 'spawn_workers' 指派任務。

【工具範例】：
spawn_workers({ 
    explanation: "初步探索專案結構", 
    workers: [{ role: "explorer", task: "列出 src 夾下的所有檔案" }] 
})
`;

const EXPLORER_SYSTEM_PROMPT = `你是一個【偵查者 (Explorer)】。你的主要職責是探索現有的程式碼庫，掌握專案結構，以便為後續的編修提供情報。
你的任務目標是釐清檔案位置、分析組件關係或確認實作細節。

【執行準則】：
- 使用 'list_files' 與 'read_file_content' 來偵察專案。
- 嚴禁憑空推論，所有結論必須基於讀取到的檔案內容。
- **具體報備**: 偵查結束時，你必須回報目標檔案的**具體內容摘要或結構**，嚴禁僅回報「我已讀完」。
- **環境資訊**: 你目前操作於指定的【工作目錄】內，所有路徑皆應相對於此。
- 完成偵查後，請直接在對話中詳述你的發現與分析結果。
`;

const EDITOR_SYSTEM_PROMPT = `你是一個【編修者 (Editor)】。你的主要職責是根據明確的需求與檔案路徑，進行具體的代碼實作或修正。

【執行準則】：
- 在修改前，請確保你已經掌握了目標檔案的相關上下文（如路徑與內容）。
- 使用 'update_file' 進行代碼變更。
- 變更完成後，請直接在對話中回報你的實作重點。
`;

// --- 代理人配置定義 (Role Configs) ---
export const ROLES: Record<string, AgentConfig> = {
    coordinator: {
        name: "Coordinator",
        model: geminiProviders.coordinator,
        systemPrompt: COORDINATOR_SYSTEM_PROMPT,
        toolPrompt: getToolDescriptionPrompt('coordinator'),
        allowedTools: COORDINATOR_TOOL_NAMES,
        type: 'coordinator'
    },
    explorer: {
        name: "Explorer",
        model: geminiProviders.explorer,
        systemPrompt: EXPLORER_SYSTEM_PROMPT,
        toolPrompt: getToolDescriptionPrompt('explorer'),
        allowedTools: EXPLORER_TOOL_NAMES,
        type: 'explorer'
    },
    editor: {
        name: "Editor",
        model: geminiProviders.editor,
        systemPrompt: EDITOR_SYSTEM_PROMPT,
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
