import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { EventEmitter } from 'events';
import { Agent, Signaler, AgentContext } from './agent.js';

dotenv.config();

// --- 集中定義工作空間與日誌目錄 ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');
export const HISTORY_DIR = path.join(__dirname, 'history');

// --- 系統狀態追蹤 (平直化) ---

// --- 工具描述中央庫 (Central Tool Declarations) ---
const ALL_TOOL_DECLARATIONS = {
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
        }
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
        }
    },
    "update_file": {
        name: "update_file",
        description: "修改檔案內容或產出全新的組件代碼。支援使用檔案代碼（例：[F1]）定位目標。",
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
        }
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
        }
    },
    "send_message": {
        name: "send_message",
        description: "發送最後的回報、分析總結或開發進度報告給使用者。這是一個開發結束的訊號。",
        parameters: {
            type: "OBJECT",
            properties: {
                text: { type: "STRING", description: "要傳送給使用者的詳細訊息（繁體中文）。" }
            },
            required: ["text"]
        }
    },
    "ask_user": {
        name: "ask_user",
        description: "當目前的資訊不足、需求不全或存在多種實作路徑需要使用者決策時呼叫。發送特定的問題給使用者並暫停目前的自動化開發流程。",
        parameters: {
            type: "OBJECT",
            properties: {
                question: { type: "STRING", description: "要詢問使用者的具體問題。說明清楚為何需要停下問這個問題。" }
            },
            required: ["question"]
        }
    },
    "spawn_workers": {
        name: "spawn_workers",
        description: "由協調者調派一或多個專屬執行者來處理子任務。你必須根據任務性質選擇「偵查者 (explorer)」或「編修者 (editor)」。",
        parameters: {
            type: "OBJECT",
            properties: {
                tasks: {
                    type: "ARRAY",
                    items: {
                        type: "OBJECT",
                        properties: {
                            goal: { type: "STRING", description: "指派給該執行者的具體工作目標（繁體中文）。" },
                            role: { type: "STRING", enum: ["explorer", "editor"], description: "指派的執行者角色類型。" }
                        },
                        required: ["goal", "role"]
                    },
                    description: "任務列表。每項任務都會啟動一個獨立的執行器。"
                },
                explanation: { type: "STRING", description: "說明為何需要此時調派這些執行者，以及它們分工的邏輯。" }
            },
            required: ["tasks", "explanation"]
        }
    }
};

// 工具與提示詞輔助現由 agent.js 提供
import { COORDINATOR_TOOL_NAMES, EXPLORER_TOOL_NAMES, EDITOR_TOOL_NAMES, getToolDescriptionPrompt } from './agent.js';

function getTools(names) {
    const declarations = names.map(n => ALL_TOOL_DECLARATIONS[n]).filter(Boolean);
    return [{ functionDeclarations: declarations }];
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
export const coordinatorModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", tools: getTools(COORDINATOR_TOOL_NAMES) });
export const explorerModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", tools: getTools(EXPLORER_TOOL_NAMES) });
export const editorModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", tools: getTools(EDITOR_TOOL_NAMES) });

// --- 系統提示詞範本 (Prompts) ---
const COORDINATOR_SYSTEM_PROMPT = `你是一個強大的【協調者 (Coordinator)】。你的職責是制定策略，並透過「調派 (Spawn Workers)」落實任務。

【執行者角色】：
1. **偵查者 (Explorer)**: 探索目錄、讀取檔案、報告分析結果。結構不明時優先調派。
2. **編修者 (Editor)**: 根據已知結構與需求，編修代碼。

【執行準則】：
1. **探訪優先**: 接收指令後，應先「調派」偵查者去理解專案架構，掌握檔案現況。
2. **行動導向**: 首輪回應應包含工具調派，避免僅輸出規劃文字。
3. **理解後詢問**: 在進行初步探訪後，若需求仍無法理解或執行細節不足，方可尋求使用者協助。
4. **指揮分派**: 你不進行開發或檔案操作。必須呼叫 \`spawn_workers\` 指派任務。
5. **結束訊號**: Worker 任務結束後，產出總結（繁體中文）。
`;

const EXPLORER_SYSTEM_PROMPT = `你是一個【偵查者 (Explorer)】。你的主要職責是探索現有的程式碼庫，掌握專案結構，以便為後續的編修提供情報。
你的任務目標是釐清檔案位置、分析組件關係或確認實作細節。

【執行準則】：
- 使用 \`list_files\` 與 \`read_file_content\` 來偵察專案。
- 嚴禁憑空推論，所有結論必須基於讀取到的檔案內容。
- **具體報備**: 偵查結束時，你必須回報目標檔案的**具體內容摘要或結構**，嚴禁僅回報「我已讀完」。
- **環境資訊**: 你目前操作於指定的【工作目錄】內，所有路徑皆應相對於此。
- 完成偵查後，請直接在對話中詳述你的發現與分析結果。
`;

const EDITOR_SYSTEM_PROMPT = `你是一個【編修者 (Editor)】。你的主要職責是根據明確的需求與檔案路徑，進行具體的代碼實作或修正。

【執行準則】：
- 在修改前，請確保你已經掌握了目標檔案的相關上下文（如路徑與內容）。
- 使用 \`update_file\` 進行代碼變更。
- 變更完成後，請直接在對話中回報你的實作重點。
`;

// --- 代理人配置定義 (Role Configs) ---
const ROLES = {
    coordinator: {
        name: "Coordinator",
        model: coordinatorModel,
        systemPrompt: COORDINATOR_SYSTEM_PROMPT,
        allowedTools: COORDINATOR_TOOL_NAMES,
        type: 'coordinator'
    },
    explorer: {
        name: "Explorer",
        model: explorerModel,
        systemPrompt: EXPLORER_SYSTEM_PROMPT,
        allowedTools: EXPLORER_TOOL_NAMES,
        type: 'explorer'
    },
    editor: {
        name: "Editor",
        model: editorModel,
        systemPrompt: EDITOR_SYSTEM_PROMPT,
        allowedTools: EDITOR_TOOL_NAMES,
        type: 'editor'
    }
};


export const onLogEvent = (callback) => { globalStore.on('update', callback); };
export const onStateUpdate = (callback) => { globalStore.on('state_update', callback); };

// --- 統一工作狀態存儲 (Workflow Store) ---
class WorkflowStore extends EventEmitter {
    constructor() {
        super();
        this.sessions = new Map(); // sessionId -> { events: [], inferenceHistory: Map, nodes: Map<nodeId, Node> }
    }

    getOrCreateSession(sessionId) {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                tasks: new Map(),
                state: new Map()
            });
        }
        return this.sessions.get(sessionId);
    }

    // --- Redux-like State Management ---

    getInferenceHistory(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.tasks) return "";

        // 從該 Session 的所有 Tasks 中彙整推論歷史 (按時間排序)
        const allEvents = Array.from(session.tasks.values())
            .flatMap(t => t.history || [])
            .sort((a, b) => a.time - b.time);

        return allEvents
            .map(e => e.text)
            .join("\n\n");
    }

    // --- Redux-like State Management ---
    setState(sessionId, key, value) {
        const session = this.getOrCreateSession(sessionId);
        session.state.set(key, value);
        
        // 廣播狀態異動，供監聽器 (如同步給前端或其他 Agent) 使用
        this.emit('state_update', { sessionId, key, value });
    }

    getState(sessionId, key) {
        const session = this.sessions.get(sessionId);
        if (!session) return undefined;
        return session.state.get(key);
    }

    // --- Task Lifecycle Management ---
    createTask(sessionId, { goal, role, agentId }) {
        const session = this.getOrCreateSession(sessionId);
        if (!session.tasks) session.tasks = new Map();
        
        const taskId = `TASK-${Date.now()}-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
        const task = {
            id: taskId,
            agentId,
            role,
            goal,
            status: 'pending',
            progress: 0,
            history: [],
            createdAt: new Date()
        };
        session.tasks.set(taskId, task);
        
        this.emit('state_update', { sessionId, key: 'tasks', value: Array.from(session.tasks.values()) });
        return taskId;
    }

    updateTask(sessionId, taskId, updates) {
        const session = this.getOrCreateSession(sessionId);
        if (!session.tasks || !session.tasks.get(taskId)) return;
        
        const task = session.tasks.get(taskId);
        
        // 僅進行狀態合併 (messages 現在會隨著 updates 同步進來)
        Object.assign(task, updates, { updatedAt: new Date() });
        
        this.emit('state_update', { sessionId, key: 'tasks', value: Array.from(session.tasks.values()) });
    }

    getTask(sessionId, taskId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.tasks) return null;
        return session.tasks.get(taskId) || null;
    }

    // 獲取 Session 下所有的全域狀態 (用於全局同步)
    getSessionState(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.state) return {};
        // 將 Map 轉為 Plain Object
        const stateObj = {};
        for (const [key, value] of session.state.entries()) {
            stateObj[key] = value;
        }
        return stateObj;
    }
}

export const globalStore = new WorkflowStore();

// --- 日誌監聽器備註 ---
// 磁碟寫入邏輯已完全移出，改由訂閱者（如 server.js）自行決定持久化方式。

class Toolbox {
    constructor() {
        this.handlers = new Map();
        this.hooks = new Map();
    }

    on(toolName, stage, callback) {
        const key = `${toolName}:${stage}`;
        if (!this.hooks.has(key)) this.hooks.set(key, []);
        this.hooks.get(key).push(callback);
    }

    async runHooks(toolName, stage, data) {
        const hooks = this.hooks.get(`${toolName}:${stage}`) || [];
        const globalHooks = this.hooks.get(`*:${stage}`) || [];
        for (const hook of [...globalHooks, ...hooks]) {
            await hook(data);
        }
    }

    register(toolName, handler) {
        this.handlers.set(toolName, handler);
    }

    async execute_tool(name, args, context = {}) {
        if (!context.session) context.session = {};
        const handler = this.handlers.get(name);
        if (!handler) {
            console.error(`  [Tool] ❌ 找不到工具處理器: ${name}`);
            return { success: false, error: 'unknown_tool' };
        }

        const stepId = `STEP-${Date.now()}`;
        console.log(`  [Tool] 🔧 執行工具: ${name} (${stepId})`);

        await this.runHooks(name, 'before', { toolName: name, args, context });

        // 透過 messages 紀錄工具啟動 (取代 event)
        context.messages.push({
            role: 'system',
            text: `🛠️ Tool execution started: ${name}`,
            data: { name, args },
            time: Date.now()
        });
        
        context.status = 'executing_tool';
        context.updateStatus();

        const result = await handler(args, context);

        if (result.success) {
            console.log(`  [Tool] ✅ 執行成功: ${name}`);
        } else {
            console.log(`  [Tool] ❌ 執行失敗: ${name} (原因: ${result.error})`);
        }
        
        // 透過 messages 紀錄工具結果 (role: tool)
        const toolText = result.success ? `Tool Output from ${name}: ${JSON.stringify(result).substring(0, 500)}` : `Error in ${name}: ${result.error}`;
        context.messages.push({
            role: 'tool',
            text: toolText,
            data: { name, result },
            time: Date.now()
        });

        context.status = result.success ? 'tool_completed' : 'tool_failed';
        context.updateStatus();

        await this.runHooks(name, 'after', { toolName: name, args, result, context });
        return result;
    }
}

export const toolbox = new Toolbox();

// --- 輔助函式：路徑智慧感知與代碼轉換 (File Key Mapping) ---
const resolveSafePath = (base, inputPath, context = {}) => {
    if (!inputPath || inputPath === '.' || inputPath === './') return base;

    // 1. 優先提取並匹配工作階段中的檔案代號 (File Key)，例如 [F1], F1 或 [F1] Target.tsx
    const fileMap = context.session?.file_map || {};
    const keyMatch = inputPath.match(/F\d+/);
    const key = keyMatch ? keyMatch[0] : null;

    if (key && fileMap[key]) {
        console.log(`  [Resolve] 🚀 檔案代碼轉義: ${inputPath} -> ${fileMap[key]}`);
        return fileMap[key];
    }

    if (path.isAbsolute(inputPath)) return inputPath;

    const root = path.join(__dirname, '../');
    const relativeBase = path.relative(root, base).replace(/\\/g, '/');
    const normalizedInput = inputPath.replace(/\\/g, '/');

    // 若輸入已包含相對路徑起點，進行處理
    if (relativeBase && normalizedInput.startsWith(relativeBase)) {
        const cleanedPath = normalizedInput.slice(relativeBase.length).replace(/^\/+/, '');
        return path.join(base, cleanedPath || '.');
    }

    return path.join(base, inputPath);
};

// 註冊工具
toolbox.register("list_files", async (args, context) => {
    try {
        const base = context.workDir;
        if (!base) return { success: false, error: "未指定工作目錄 (workDir)" };
        const absPath = resolveSafePath(base, args.path, context);
        const files = await fs.readdir(absPath);

        // 初始化或獲取檔案代碼映射
        if (!context.session.file_map) context.session.file_map = {};
        if (!context.session.file_counter) context.session.file_counter = 0;

        const resultList = files.map(file => {
            const fileAbsPath = path.join(absPath, file);
            const isDir = fs.statSync(fileAbsPath).isDirectory();

            // 為非目錄檔案產生唯一 ID
            if (!isDir) {
                context.session.file_counter++;
                const key = `F${context.session.file_counter}`;
                context.session.file_map[key] = fileAbsPath;
                return `[${key}] ${file}`;
            }
            return `[DIR] ${file}`;
        });

        return {
            success: true,
            path: args.path,
            files: resultList,
            fileList: resultList.join(', '),
            note: "請優先使用檔案代碼（例：[F1]）來引用檔案。"
        };
    } catch (err) { return { success: false, error: err.message }; }
});

toolbox.register("read_file_content", async (args, context) => {
    try {
        const base = context.workDir;
        if (!base) return { success: false, error: "未指定工作目錄 (workDir)" };
        const absPath = resolveSafePath(base, args.path, context);
        const content = await fs.readFile(absPath, 'utf8');
        return { success: true, path: args.path, content };
    } catch (err) { return { success: false, error: err.message }; }
});

toolbox.register("plan", async (args) => {
    console.log(`  [Plan] 🛠️ 生成計畫 (${args.next_steps_plan.length} 步)`);
    return { success: true, plan: args.next_steps_plan };
});

toolbox.register("update_file", async (args, context) => {
    try {
        const base = context.workDir;
        if (!base) return { success: false, error: "未指定工作目錄 (workDir)" };
        if (!args.path) {
            return { success: false, error: "未指定目標檔案路徑" };
        }
        const targetPath = resolveSafePath(base, args.path, context);

        if (!(await fs.pathExists(targetPath))) {
            return { success: false, error: "無檔案" };
        }

        await fs.writeFile(targetPath, args.code);
        return { success: true, path: targetPath, explanation: args.explanation };
    } catch (err) { return { success: false, error: err.message }; }
});

toolbox.register("send_message", async (args) => ({ success: true, text: args.text }));
toolbox.register("ask_user", async (args) => ({ success: true, question: args.question }));

toolbox.register("spawn_workers", async (args, context) => {
    const taskCount = args.tasks.length;
    console.log(`  [Dispatcher] 🚀 啟動 ${taskCount} 個並行 Worker...`);

    // 背景執行所有 Worker 任務
    const workerPromises = args.tasks.map(async (task, index) => {
        try {
            const roleConfig = ROLES[task.role] || ROLES.explorer;
            const worker = new Agent(roleConfig, toolbox);
            
            // 1. 在全局 Store 建立 Task
            const taskId = context.store.createTask(context.sessionId, {
                goal: task.goal,
                role: roleConfig.name
            });

            // 1.5 立即更新為啟動狀態並推入 system 訊息
            context.store.updateTask(context.sessionId, taskId, {
                status: 'pending',
                progress: 0,
                messages: [{
                    role: 'system',
                    text: `🚀 Agent [${roleConfig.name}] spawned to solve: ${task.goal}`,
                    time: Date.now()
                }]
            });

            console.log(`  [Dispatcher]   -> ${roleConfig.name} #${index + 1} 啟動 (Task: ${taskId})`);
            
            // 2. 建立具備高度封裝的 AgentContext (通用獨立結構)
            const childContext = new AgentContext({
                sessionId: context.sessionId,
                taskId,
                workDir: context.workDir,
                signaler: context.signaler,
                // 直接取用 Context 下下的 messages 進行文字拚接以作為推論歷史
                getHistory: () => childContext.messages.map(m => m.text).join("\n\n"),
                // 獲取與主動同步全域狀態的唯一入口 (合併了原有的 refresh 功能)
                getState: async (key) => {
                    if (!key) {
                        // 無 Key 情境：執行全域同步 (任務 + 全域 Session)
                        const latestTask = context.store.getTask(context.sessionId, taskId);
                        if (latestTask) {
                            childContext.status = latestTask.status;
                            childContext.progress = latestTask.progress;
                            childContext.messages = [...(latestTask.messages || [])];
                        }
                        const globalState = context.store.getSessionState(context.sessionId);
                        Object.assign(childContext, globalState);
                        return childContext;
                    } else {
                        // 有 Key 情境：同步特定全域變數並賦值回到實例上
                        const val = context.store.getState(context.sessionId, key);
                        childContext[key] = val;
                        return val;
                    }
                }
            });

            // 複寫 Store 存取方法 (偵測實例狀態並自動組裝)
            childContext.updateStatus = (updates) => context.store.updateTask(context.sessionId, taskId, {
                status: childContext.status,
                progress: childContext.progress,
                round: childContext.round,
                goal: childContext.goal,
                messages: childContext.messages, // 同步訊息陣列到全域 Store
                ...updates
            });
            
            const it = worker.run(task.goal, childContext);
            let result;
            while (true) {
                const { value, done } = await it.next();
                if (done) {
                    result = value;
                    break;
                }
                // 在背景運行的 worker，訊息會透過 state_update 自動廣播，
                // 但若需要亦可在此處理每一條 yielded message。
            }
            return result;
        } catch (err) {
            console.error(`  [Dispatcher] ❌ Worker 執行崩潰:`, err);
            return { role: task.role, status: "error", error: err.message };
        }
    });

    // 訊號機制：當背景工人全數完成時，喚醒父代理人
    Promise.all(workerPromises).then(results => {
        console.log(`  [Dispatcher] 🔔 子任務已全數解鎖，發送訊號。`);
        context.signaler.emit('workers_done', results);
    });
    return {
        success: true,
        status: "workers_spawned",
        message: "Workers launched in background.",
        workers_count: taskCount
    };
});

// --- 全域 AI 請求佇列 (AIRequestQueue) ---

// --- 主要入口 (EntryPoint) ---
export class Coordinator {
    constructor() {
        this.toolbox = toolbox;
    }

    async *coordinate(userPrompt, executionContext = {}) {
        const sessionId = executionContext.sessionId || `SESSION-${Date.now()}`;
        // 優先使用自定義訊號器，否則建立新的
        const context = {
            ...executionContext,
            sessionId,
            signaler: executionContext.signaler || new Signaler(),
            store: executionContext.store || globalStore, // 確保 context 內有統一 Store
            agentId: executionContext.masterAgentId // 使用傳入的主代理人 ID
        };

        // 1. 為主代理人 (Master/Coordinator) 建立任務
        const taskId = context.store.createTask(sessionId, {
            goal: userPrompt,
            role: 'Coordinator',
            agentId: context.agentId
        });

        // 1.5 指揮者啟動回報
        context.store.updateTask(sessionId, taskId, {
            status: 'pending',
            progress: 0,
            messages: [{
                role: 'system',
                text: `🎮 Coordinator started master mission: ${userPrompt}`,
                time: Date.now()
            }]
        });

        // 2. 啟動身為 Coordinator 角色的主代理人 (Master Context)
        const masterContext = new AgentContext({
            sessionId,
            taskId,
            agentId: context.agentId,
            workDir: context.workDir,
            signaler: context.signaler,
            getHistory: function() { return this.messages.map(m => m.text).join("\n\n"); }
        });

        masterContext.updateStatus = function(updates) {
            return context.store.updateTask(sessionId, taskId, {
                status: this.status,
                progress: this.progress,
                round: this.round,
                goal: this.goal,
                messages: this.messages,
                ...updates
            });
        };

        masterContext.getState = function(key) {
            if (!key) {
                const latestTask = context.store.getTask(sessionId, taskId);
                if (latestTask) {
                    this.status = latestTask.status;
                    this.progress = latestTask.progress;
                    this.messages = [...(latestTask.messages || [])];
                }
                const globalState = context.store.getSessionState(sessionId);
                Object.assign(this, globalState);
                return this;
            } else {
                const val = context.store.getState(sessionId, key);
                this[key] = val;
                return val;
            }
        };

        masterContext.setAppState = function(updates) {
            Object.assign(this, updates);
            return this.updateStatus();
        };

        const master = new Agent(ROLES.coordinator, this.toolbox);
        
        // 疊代產生器並 yield 訊息，最後捕捉 return 值
        const it = master.run(userPrompt, masterContext);
        let result;
        while (true) {
            const { value, done } = await it.next();
            if (done) {
                result = value;
                break;
            }
            yield value;
        }

        // 如果第一輪什麼都沒做，且沒呼叫工具，則啟動一個預設 Explorer (退避補償)
        // 註：Explorer 此處若也改為 generator 則須比照處理，暫維持現狀或亦改為消耗 Iterator
        if (result.status === "complete" && !context.store.getTask(sessionId, taskId).messages.some(m => m.data?.name === 'spawn_workers')) {
            console.log(`  [Master] ℹ️ 偵測到未自動分派，啟動手動補償 Explorer...`);
            const explorer = new Agent(ROLES.explorer, this.toolbox);
            const expIt = explorer.run(userPrompt, context);
            while (true) {
                const { value, done } = await expIt.next();
                if (done) break;
                yield value;
            }
        }

        return { success: true, sessionId };
    }
}

