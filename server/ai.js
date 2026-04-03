import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 路徑定義 (僅限系統日誌，工作樣本路徑由 context 傳入)
export const HISTORY_DIR = path.join(__dirname, 'history');
export const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// --- 信號機制 (Signal Mechanism) ---
// 用於管理協調者與執行者之間的非同步喚醒與解鎖
class Signaler {
    constructor() {
        this.pending = new Map();
    }
    // 休眠期：訂閱訊號並返回 Promise
    wait(name) {
        if (!this.pending.has(name)) {
            let resolve;
            const promise = new Promise((res) => { resolve = res; });
            this.pending.set(name, { promise, resolve });
        }
        return this.pending.get(name).promise;
    }
    // 喚醒點：發送訊號解鎖 Promise
    emit(name, data) {
        if (this.pending.has(name)) {
            const { resolve } = this.pending.get(name);
            this.pending.delete(name);
            resolve(data);
        }
    }
}

// --- 系統狀態追蹤 (平直化) ---
export const session_logs = new Map(); // 用於儲存各 session 的平直日誌摘要

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

// --- 工具清單指派 (Role Tool Assignments) ---
const COORDINATOR_TOOL_NAMES = ["spawn_workers"];
const EXPLORER_TOOL_NAMES = ["list_files", "read_file_content"];
const EDITOR_TOOL_NAMES = ["read_file_content", "update_file"];

// 助手函式：根據名稱列表產出 Gemini 所需的 tools 格式
function getTools(names) {
    const declarations = names.map(n => ALL_TOOL_DECLARATIONS[n]).filter(Boolean);
    return [{ functionDeclarations: declarations }];
}

// 助手函式：根據名稱列表產出 Gemini 所需的 tools 格式
function getToolDescriptionPrompt(role = 'agent') {
    let names = [];
    if (role === 'coordinator') names = COORDINATOR_TOOL_NAMES;
    else if (role === 'explorer') names = EXPLORER_TOOL_NAMES;
    else if (role === 'editor') names = EDITOR_TOOL_NAMES;

    const list = names.map(n => `- **${n}**: ${ALL_TOOL_DECLARATIONS[n].description}`).join('\n');
    return `【可用工具清單 (Toolkits)】：\n${list}\n\n請根據需求選擇最適合的工具組合。`;
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

// 簡單的日誌寫入鎖定隊列
const logQueue = [];
let isProcessingQueue = false;

async function processLogQueue() {
    if (isProcessingQueue || logQueue.length === 0) return;
    isProcessingQueue = true;
    while (logQueue.length > 0) {
        const { type, prompt, output, data, now } = logQueue.shift();
        try {
            const dateStr = now.toISOString().split('T')[0];
            const hourStr = now.getHours().toString().padStart(2, '0');
            let fileName = `log_${dateStr}_${hourStr}.json`;
            if (data?.session_id) fileName = `log_${data.session_id}.json`;
            const historyPath = path.join(HISTORY_DIR, fileName);

            let logs = [];
            if (await fs.pathExists(historyPath)) {
                try { logs = await fs.readJson(historyPath); } catch (e) { logs = []; }
            }
            logs.push({ timestamp: now.toLocaleString(), type, prompt, output, data });
            await fs.writeJson(historyPath, logs, { spaces: 2 });
        } catch (e) { console.error('[Log Error]', e); }
    }
    isProcessingQueue = false;
}

export async function recordGeminiResponse({ type = "CHAT", prompt, output, data = null }) {
    const now = new Date();
    // RAW 類型僅同步寫入 fixture
    if (type === "RAW_REQUEST") {
        if (data?.session_id) {
            try {
                await fs.ensureDir(FIXTURES_DIR);
                const fixturePath = path.join(FIXTURES_DIR, `fixture_${data.session_id}_${data.round}.json`);
                await fs.writeJson(fixturePath, { prompt, response: output }, { spaces: 2 });
            } catch (e) { }
        }
        return; // 從歷史日誌中排除
    }
    logQueue.push({ type, prompt, output, data, now });
    processLogQueue();
}

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
        await recordGeminiResponse({
            type: "TOOL_START",
            prompt: `【工具啟動】：${name}`,
            output: args,
            data: { id: stepId, name, args, session_id: context.sessionId }
        });

        const result = await handler(args, context);

        if (result.success) {
            console.log(`  [Tool] ✅ 執行成功: ${name}`);
        } else {
            console.log(`  [Tool] ❌ 執行失敗: ${name} (原因: ${result.error})`);
        }

        await recordGeminiResponse({
            type: "TOOL_RESULT",
            prompt: `【工具完成】：${name}`,
            output: result,
            data: { id: stepId, name, result, session_id: context.sessionId }
        });

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
            console.log(`  [Dispatcher]   -> ${roleConfig.name} #${index + 1} 啟動："${task.goal.substring(0, 30)}..."`);
            return await worker.run(task.goal, context);
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

// --- 獨立 AI 推論引擎 (AIEngine) ---
/**
 * TODO: 將 AIEngine 實作改為全域單一佇列請求方式。
 * 需支援：設定一次可並發請求數、每秒請求數 (Rate Limiting)。
 */
export class AIEngine {
    constructor(inferenceModel) { this.model = inferenceModel; }
    /**
     * 封裝產生器，維持傳統 Promise 介面 (用於不需要即時響應工具的場景)
     */
    async generate(inputPrompt, context = {}) {
        const stream = this.generateStream(inputPrompt, context);
        let finalResult = null;
        for await (const chunk of stream) {
            if (chunk.type === 'final') finalResult = chunk;
        }
        return finalResult;
    }

    /**
     * 非同步產生器：即時傳回工具呼叫，最後傳回完整結果
     */
    async *generateStream(inputPrompt, context = {}) {
        const { getIsAborted, sessionId, round } = context;

        const streamResponse = await this.model.generateContentStream({
            contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
        });

        const allActions = [];
        const rawChunks = []; // 用於紀錄原始反應
        let accumulatedText = "";

        for await (const chunk of streamResponse.stream) {
            if (getIsAborted?.()) break;
            const candidate = chunk.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            // 紀錄原始 Parts 用於回放測試
            rawChunks.push(...candidate.content.parts);

            for (const part of candidate.content.parts) {
                if (part.text) accumulatedText += part.text;
                if (part.functionCall) {
                    const action = { name: part.functionCall.name, args: part.functionCall.args };
                    allActions.push(action);
                    yield { type: 'action', action }; // 即時 yield 工具
                }
            }
        }

        // --- 紀錄到 Fixtures ---
        if (sessionId) {
            await recordGeminiResponse({
                type: "RAW_REQUEST",
                prompt: inputPrompt,
                output: rawChunks,
                data: { session_id: sessionId, round }
            });
        }

        yield { type: 'final', text: accumulatedText, actions: allActions };
    }
}

// --- 統一代理人元件 (Agent) ---
export class Agent {
    constructor(config, taskRegistry) {
        this.roleName = config.name;
        this.model = config.model;
        this.systemPrompt = config.systemPrompt;
        this.toolType = config.type;
        this.toolbox = taskRegistry;
    }

    async run(goal, context) {
        console.log(`  [${this.roleName}] 🧠 開始任務：${goal.substring(0, 50)}...`);

        // 確保 signaler 存在 (祖先代理人會初始化它)
        if (!context.signaler) context.signaler = new Signaler();

        const engine = new AIEngine(this.model);
        let currentStatus = `【目標】：${goal}`;
        let round = 0;
        const MAX_ROUNDS = context.loopCountLimit || 5;

        while (round < MAX_ROUNDS) {
            round++;
            console.log(`  [${this.roleName}] 🔄 第 ${round} 輪循環`);

            const stepId = `STEP-${Date.now()}`;
            const completeInstruction = `${this.systemPrompt}\n${getToolDescriptionPrompt(this.toolType)}\n${currentStatus}`;

            await recordGeminiResponse({
                type: "THINK_START",
                prompt: completeInstruction,
                data: { id: stepId, role: this.roleName, round, session_id: context.sessionId }
            });

            // 思考前的人為延遲
            await new Promise(resolve => setTimeout(resolve, 1000));

            // 1. 執行推論與工具執行
            const stream = engine.generateStream(completeInstruction, { ...context, round });
            let aiResponse = null;
            let toolResults = [];
            let pendingSleep = false;

            for await (const chunk of stream) {
                if (chunk.type === 'action') {
                    const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    toolResults.push({ name: chunk.action.name, output: res });

                    if (res && res.status === "workers_spawned") pendingSleep = true;
                } else if (chunk.type === 'final') {
                    aiResponse = chunk;
                }
            }

            // 2. 休眠與喚醒處理
            if (pendingSleep) {
                console.log(`  [${this.roleName}] 💤 進入休眠期，等待訊號喚醒...`);
                const subTasksResults = await context.signaler.wait('workers_done');
                console.log(`  [${this.roleName}] 🔔 喚醒點：獲取成果，解鎖循環。`);
                toolResults.push({ name: "sub_tasks_result", output: subTasksResults });
            }

            await recordGeminiResponse({
                type: "THINK_RESULT",
                prompt: `【思維完成】：${stepId}`,
                output: aiResponse,
                data: { id: stepId, role: this.roleName, session_id: context.sessionId }
            });

            if (!aiResponse) {
                console.error(`  [${this.roleName}] ❌ 無法獲取 AI 回應。`);
                break;
            }

            console.log(`  [${this.roleName}] 💭 分析：${aiResponse.text.substring(0, 150).replace(/\n/g, ' ')}${aiResponse.text.length > 150 ? '...' : ''}`);

            // 3. 更新狀態與終止判定 (限制反饋長度防止 Token 爆炸)
            const summaryResults = toolResults.map(r => {
                let outputStr = JSON.stringify(r.output);
                if (outputStr.length > 2000) outputStr = outputStr.substring(0, 2000) + "...(內容過長已截斷)";
                return { name: r.name, output: outputStr };
            });
            currentStatus += `\n[Round ${round} 分析]：${aiResponse.text}\n[Round ${round} 工具反饋]：${JSON.stringify(summaryResults)}`;

            // 終止條件：呼叫了結束類工具 (send_message/ask_user) 或是在無工具時給出了純文字總結
            const hasStopTool = aiResponse.actions.some(a => ['send_message', 'ask_user'].includes(a.name));
            const isDoneWithoutTools = aiResponse.actions.length === 0 && aiResponse.text.length > 0;

            if (hasStopTool || isDoneWithoutTools) {
                console.log(`  [${this.roleName}] ✨ 任務結束。`);
                break;
            }
        }
        return { role: this.roleName, status: "complete", final_text: currentStatus };
    }
}

// --- 主要入口 (EntryPoint) ---
export class Coordinator {
    constructor() {
        this.toolbox = toolbox;
    }

    async coordinate(userPrompt, executionContext = {}) {
        const sessionId = `SESSION-${Date.now()}`;
        const context = { ...executionContext, sessionId, signaler: new Signaler() };

        // 啟動身為 Coordinator 角色的主代理人
        const master = new Agent(ROLES.coordinator, this.toolbox);
        const result = await master.run(userPrompt, context);

        // 如果第一輪什麼都沒做，且沒呼叫工具，則啟動一個預設 Explorer (退避補償)
        if (result.status === "complete" && !result.final_text.includes('workers_spawned')) {
            console.log(`  [Master] ℹ️ 偵測到未自動分派，啟動手動補償 Explorer...`);
            const explorer = new Agent(ROLES.explorer, this.toolbox);
            await explorer.run(userPrompt, context);
        }

        return { success: true, sessionId };
    }
}

