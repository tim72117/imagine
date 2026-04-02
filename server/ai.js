import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 路徑定義
export const TARGET_FILE = path.join(__dirname, '../src/sandbox/Target.tsx');
export const HISTORY_DIR = path.join(__dirname, 'history');

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
                path: { type: "STRING", description: "目標檔案路徑或代碼（例：[F1]，預設為 Target.tsx）" },
                code: {
                    type: "STRING",
                    description: "完整的 React 組件代碼。規範：\n1. 絕對禁止 import。\n2. 僅限一個名為 App 的組件。\n3. 無須 export。\n4. 僅限 React 18 語法與 Tailwind CSS。\n5. 不支援第三方圖示，請用 Emoji 或 Tailwind 組件圖形。"
                },
                explanation: { type: "STRING", description: "【極簡】說明本次代碼變更的核心邏輯與修改點。" },
                next_step: { type: "STRING", description: "檔案更新完成後，預計的後續開發動作。" }
            },
            required: ["code", "explanation", "next_step"]
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
        description: "由協調者調派一或多個「執行者（Workers）」來並行處理子任務。適合用於將大計畫拆解後同時執行多個獨立環節。",
        parameters: {
            type: "OBJECT",
            properties: {
                tasks: {
                    type: "ARRAY",
                    items: { type: "STRING" },
                    description: "要指派給各執行者的具體工作目標列表（繁體中文）。列表中的每項任務都會啟動一個獨立的執行器。"
                },
                explanation: { type: "STRING", description: "說明為何需要此時調派這些執行者，以及它們分工的邏輯。" }
            },
            required: ["tasks", "explanation"]
        }
    }
};

// --- 工具清單指派 (Role Tool Assignments) ---
const COORDINATOR_TOOL_NAMES = ["spawn_workers"];
const AGENT_TOOL_NAMES = ["list_files", "read_file_content", "update_file", "send_message", "ask_user"];

// 助手函式：根據名稱列表產出 Gemini 所需的 tools 格式
function getTools(names) {
    const declarations = names.map(n => ALL_TOOL_DECLARATIONS[n]).filter(Boolean);
    return [{ functionDeclarations: declarations }];
}

// --- 自動生成工具清單指令的輔助函式 ---
function getToolDescriptionPrompt(target = 'agent') {
    const names = (target === 'coordinator' ? COORDINATOR_TOOL_NAMES : AGENT_TOOL_NAMES);
    const list = names.map(n => `- **${n}**: ${ALL_TOOL_DECLARATIONS[n].description}`).join('\n');
    return `【可用工具清單 (Toolkits)】：\n${list}\n\n請根據需求選擇最適合的工具組合。`;
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
export const coordinatorModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", tools: getTools(COORDINATOR_TOOL_NAMES) });
export const agentModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite", tools: getTools(AGENT_TOOL_NAMES) });

// --- 系統提示詞範本 (Prompts) ---
const COORDINATOR_SYSTEM_PROMPT = `你是一個強大的【任務協調者 (Coordinator)】。你的職責是根據使用者需求制定全局策略，並「調派專屬執行者 (Spawn Workers)」來落實任務。

【執行準則】：
1. **分析與目標定義**: 深入理解需求，將其轉化為一個或多個具備明確技術細節的【執行目標 (Goal)】。
2. **指揮與分派**: 你本身不進行任何具體的開發或檔案操作。你必須呼叫 \`spawn_workers\` 工具並指派不同的任務目標給開發者（Worker）。
3. **策略優先**: 如果目前對專案結構一無所知，請優先指派一個分析型的 Worker 進行偵查。
4. **結束訊號**: 當所有 Worker 任務交辦完畢後，請產出目標總結（繁體中文）。
`;

const WORKER_SYSTEM_PROMPT = `你是一個具備「思考與執行合一」能力的高級前端工程師 Worker。
注意：【禁止憑空推論】。如果你的上下文不足以支撐對現有專案實作的精確理解，【必須】立刻呼叫工具進行主動偵查。

【專案執行原則】：
1. **分析先行**: 接收到需求後，若未掌握具體檔案結構或編碼細節，或是需求本身過於空泛抽象，請優先使用偵查類工具或 \`plan\` 工具。
2. **透明度**: 所有說明與分析流程請一律使用【繁體中文】。

【執行流程 (SOP)】：
1. **探索與釐理階段 (Discovery & Clarify)**: 調用偵查工具與 \`list_files\` 獲取現況。
2. **決議與規劃階段 (Reasoning & Plan)**: 使用 \`plan\` 工具梳理多階段開發步驟。
3. **執行階段 (Implementation)**: 呼叫 \`update_file\` 套用代碼變動。
4. **回報階段 (Reporting)**: 完成所有變動後，【必須】呼叫 \`send_message\` 提供彙報並結束連鎖。
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
    worker: {
        name: "Worker",
        model: agentModel,
        systemPrompt: WORKER_SYSTEM_PROMPT,
        allowedTools: AGENT_TOOL_NAMES,
        type: 'worker'
    }
};

// 紀錄回應資訊的函式
export async function recordGeminiResponse({ type = "CHAT", prompt, output, data = null }) {
    try {
        await fs.ensureDir(HISTORY_DIR);
        const now = new Date();
        const dateStr = now.toISOString().split('T')[0];
        const hourStr = now.getHours().toString().padStart(2, '0');

        let fileName = `log_${dateStr}_${hourStr}.json`;
        if (data?.session_id) {
            fileName = `log_${data.session_id}.json`;
        }
        const historyPath = path.join(HISTORY_DIR, fileName);

        let logs = [];
        if (await fs.pathExists(historyPath)) {
            try { logs = await fs.readJson(historyPath); } catch (e) { logs = []; }
        }

        logs.push({
            timestamp: now.toLocaleString(),
            type,
            prompt,
            output,
            data
        });
        await fs.writeJson(historyPath, logs, { spaces: 2 });
    } catch (error) {
        console.error('[Error] 紀錄失敗:', error);
    }
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

    // 1. 優先匹配檔案代號 (File Key)，例如 [F1] 或 F1
    const fileMap = context.session?.file_map || {};
    const cleanKey = inputPath.replace(/[\[\]]/g, ''); // 支援 [F1] 或 F1
    if (fileMap[cleanKey]) {
        console.log(`  [Resolve] 🚀 使用檔案代碼轉義: ${inputPath} -> ${fileMap[cleanKey]}`);
        return fileMap[cleanKey];
    }

    if (path.isAbsolute(inputPath)) return inputPath;

    const normalizedInput = inputPath.replace(/\\/g, '/');
    const root = path.join(__dirname, '../');
    const relativeBase = path.relative(root, base).replace(/\\/g, '/');

    // 如果輸入路徑包含了當前工作的相對起點，則進行剪裁
    if (relativeBase && normalizedInput.startsWith(relativeBase)) {
        const cleanedPath = normalizedInput.slice(relativeBase.length).replace(/^\/+/, '');
        return path.join(base, cleanedPath || '.');
    }

    return path.join(base, inputPath);
};

// 註冊工具
toolbox.register("list_files", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
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
        const base = context.workDir || path.join(__dirname, '../');
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
        const base = context.workDir || path.join(__dirname, '../src/sandbox');
        // 優先使用 AI 指定的路徑，若無則預設 Target.tsx
        const inputPath = args.path || 'Target.tsx';
        const targetPath = resolveSafePath(base, inputPath, context);

        await fs.ensureDir(path.dirname(targetPath));
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
    const workerPromises = args.tasks.map(async (goal, index) => {
        const worker = new Agent(ROLES.worker, toolbox);
        console.log(`  [Dispatcher]   -> Worker #${index + 1} 啟動："${goal.substring(0, 30)}..."`);
        return await worker.run(goal, context);
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
    async *generateStream(inputPrompt, { getIsAborted } = {}) {
        const streamResponse = await this.model.generateContentStream({
            contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
        });
        const allActions = [];
        let accumulatedText = "";

        for await (const chunk of streamResponse.stream) {
            if (getIsAborted?.()) break;
            const candidate = chunk.candidates?.[0];
            if (!candidate?.content?.parts) continue;

            for (const part of candidate.content.parts) {
                if (part.text) accumulatedText += part.text;
                if (part.functionCall) {
                    const action = { name: part.functionCall.name, args: part.functionCall.args };
                    allActions.push(action);
                    yield { type: 'action', action }; // 即時 yield 工具
                }
            }
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
        this.toolType = config.type === 'coordinator' ? 'coordinator' : 'agent';
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

            // 1. 執行推論與工具執行
            const stream = engine.generateStream(completeInstruction);
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

            // 3. 更新狀態與終止判定
            currentStatus += `\n[Round ${round} 分析]：${aiResponse.text}\n[Round ${round} 工具反饋]：${JSON.stringify(toolResults)}`;

            // 終止條件：呼叫了結束類工具 (send_message/ask_user) 或是在協調模式下給出了純文字總結
            const hasStopTool = aiResponse.actions.some(a => ['send_message', 'ask_user'].includes(a.name));
            const isCoordinatorDone = this.toolType === 'coordinator' && aiResponse.actions.length === 0 && aiResponse.text.length > 0;

            if (hasStopTool || isCoordinatorDone) {
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

        // 如果第一輪什麼都沒做，且沒呼叫工具，則啟動一個預設 Worker (退避補償)
        if (result.status === "complete" && !result.final_text.includes('workers_spawned')) {
            console.log(`  [Master] ℹ️ 偵測到未自動分派，啟動手動補償 Worker...`);
            const worker = new Agent(ROLES.worker, this.toolbox);
            await worker.run(userPrompt, context);
        }

        return { success: true, sessionId };
    }
}

