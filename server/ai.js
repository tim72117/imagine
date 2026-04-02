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

// --- 系統狀態追蹤 (平直化) ---
export const session_logs = new Map(); // 用於儲存各 session 的平直日誌摘要

// --- 工具描述中央庫 (Central Tool Declarations) ---
const ALL_TOOL_DECLARATIONS = {
    "list_files": {
        name: "list_files",
        description: "獲取專案目錄清單（資料夾與檔案）。需指定路徑、說明原因與下一步計畫。",
        parameters: {
            type: "OBJECT",
            properties: {
                path: { type: "STRING", description: "要讀取的目錄路徑（例如: src/sandbox/ 或 server/）" },
                explanation: { type: "STRING", description: "說明為何此時需要獲取此清單。" },
                next_step: { type: "STRING", description: "獲取清單後預計執行的下一步分析動作。" }
            },
            required: ["path", "explanation", "next_step"]
        }
    },
    "read_file_content": {
        name: "read_file_content",
        description: "讀取專案內特定檔案內容進行深度分析。需說明讀取原因與接下來的計畫。",
        parameters: {
            type: "OBJECT",
            properties: {
                path: { type: "STRING", description: "檔案路徑 (例如: src/sandbox/Target.tsx)" },
                explanation: { type: "STRING", description: "【極簡】說明為何此時需要調閱此檔案內容。" },
                next_step: { type: "STRING", description: "讀取並分析內容後，預計要執行的下一步動作。" }
            },
            required: ["path", "explanation", "next_step"]
        }
    },
    "update_file": {
        name: "update_file",
        description: "修改檔案內容或產出全新的組件代碼。遵循極簡沙盒規範。",
        parameters: {
            type: "OBJECT",
            properties: {
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
2. **指揮與分派**: 你本身不進行任何具體的開發或檔案操作。你必須呼叫 \`spawn_workers\` 工具並指派不同的任務目標給執行者（Worker）。
3. **策略優先**: 如果目前對專案結構一無所知，請優先指派一個分析型的 Worker 進行偵查。
4. **結束訊號**: 當所有 Worker 任務交辦完畢後，請產出目標總結。
`;

const AGENT_SYSTEM_PROMPT = `你是一個具備「思考與執行合一」能力的高級前端工程師 Agent (Worker)。
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

// 註冊工具
toolbox.register("list_files", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(base, args.path);
        const files = await fs.readdir(absPath);
        const relativeFiles = files.map(file => path.relative(base, path.join(absPath, file)));
        return { success: true, path: args.path, files: relativeFiles, fileList: relativeFiles.join(', ') };
    } catch (err) { return { success: false, error: err.message }; }
});

toolbox.register("read_file_content", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(base, args.path);
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
        const targetPath = path.join(base, 'Target.tsx');
        await fs.writeFile(targetPath, args.code);
        return { success: true, path: targetPath, explanation: args.explanation };
    } catch (err) { return { success: false, error: err.message }; }
});

toolbox.register("send_message", async (args) => ({ success: true, text: args.text }));
toolbox.register("ask_user", async (args) => ({ success: true, question: args.question }));

toolbox.register("spawn_workers", async (args, context) => {
    const taskCount = args.tasks.length;
    console.log(`  [Dispatcher] 🚀 啟動 ${taskCount} 個並行 Worker...`);

    // 使用 Promise.all 並行執行所有 Worker 任務
    const workerPromises = args.tasks.map(async (goal, index) => {
        const executor = new Executor(agentModel, toolbox);
        console.log(`  [Dispatcher]   -> Worker #${index + 1} 啟動："${goal.substring(0, 30)}..."`);
        return await executor.run(goal, context);
    });

    const results = await Promise.all(workerPromises);
    return { success: true, workers_count: taskCount, details: results };
});

// --- 獨立協調者元件 (Coordinator) ---
export class Coordinator {
    constructor(coordinatorModel, agentModel, taskRegistry) {
        this.coordinatorModel = coordinatorModel;
        this.agentModel = agentModel;
        this.toolbox = taskRegistry;
    }

    async reasoning(args, context) {
        const { getIsAborted } = context;
        const userInstruction = args.prompt;
        context.lastUserPrompt = userInstruction;
        const completeInstruction = `${AGENT_SYSTEM_PROMPT}\n${getToolDescriptionPrompt('agent')}\nUser Request: ${userInstruction}`;
        const engine = new AIEngine(this.agentModel);
        return await engine.generate(completeInstruction, { getIsAborted });
    }

    async coordinate(userPrompt, executionContext = {}) {
        console.log(`  [Coordinator] 🧠 正在分析與轉化需求...`);
        const sessionId = `SESSION-${Date.now()}`;
        const context = { ...executionContext, sessionId };

        // 使用 Coordinator 專用模型與工具 (如 plan, spawn_worker)
        const engine = new AIEngine(this.coordinatorModel);
        const completeInstruction = `${COORDINATOR_SYSTEM_PROMPT}\n${getToolDescriptionPrompt('coordinator')}\n需求：${userPrompt}`;

        // 協調者開始推論，可能會直接呼叫工具或產出文字
        const stream = engine.generateStream(completeInstruction);
        let analyzedGoal = "";
        let actions = [];

        for await (const chunk of stream) {
            if (chunk.type === 'action') {
                // 如果協調者選擇呼叫工具 (例如直接 spawn_workers)
                const res = await this.toolbox.execute_tool(chunk.action.name, chunk.action.actionArgs || chunk.action.args, context);
                actions.push({ name: chunk.action.name, output: res });
            } else if (chunk.type === 'final') {
                analyzedGoal = chunk.text;
            }
        }

        const finalGoal = analyzedGoal || userPrompt;

        // 紀錄完整任務目標與 Session 啟動
        await recordGeminiResponse({
            type: "MISSION_START",
            prompt: userPrompt,
            output: finalGoal,
            data: { session_id: sessionId, analyzed_goal: analyzedGoal, coordinator_actions: actions }
        });

        // 預設行為：如果 Coordinator 沒有呼叫任何工具 (例如 spawn_worker)，則手動啟動一個預設 Worker
        if (actions.length === 0) {
            console.log(`  [Coordinator] ℹ️ 未偵測到特殊調派動作，啟動預設執行者 (Default Worker)。`);
            const executor = new Executor(this.agentModel, this.toolbox);
            await executor.run(finalGoal, context);
        }

        return { success: true, sessionId };
    }
}

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

// --- 獨立執行器 (Executor) ---
// 職責：接收目標，透過連鎖思維與工具調用「達成目標」，達成後才結束並回覆。
export class Executor {
    constructor(inferenceModel, taskRegistry) {
        this.model = inferenceModel;
        this.toolbox = taskRegistry;
    }

    async run(targetGoal, context) {
        let nextInput = `【最終目標】：${targetGoal}\n\n請開始第一輪思考。`;
        const MAX_ROUNDS = context.loopCountLimit || 5;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            console.log(`  [Executor] 🔄 第 ${round + 1} 輪 (Streaming)`);
            const stepId = `STEP-${Date.now()}`;
            await recordGeminiResponse({
                type: "THINK_START",
                prompt: nextInput,
                data: { id: stepId, session_id: context.sessionId, target_goal: targetGoal }
            });

            let aiResponse = null;
            let toolResults = [];

            // 開始迭代 AI 的串流回應
            const thinkStream = this._think(nextInput, context);
            for await (const chunk of thinkStream) {
                if (chunk.type === 'action') {
                    // 【即時執行工具】：工具一被產出就立刻執行，不需要等整段話講完
                    const result = await this.toolbox.execute_tool(chunk.action.name, chunk.action.args, context);
                    toolResults.push({ name: chunk.action.name, output: result });
                } else if (chunk.type === 'final') {
                    // 取得最終彙整結果
                    aiResponse = chunk;
                }
            }

            await recordGeminiResponse({
                type: "THINK_RESULT",
                prompt: `【思維完成】：${stepId}`,
                output: aiResponse,
                data: { id: stepId, session_id: context.sessionId }
            });

            // 如果 AI 呼叫了回報類工具，則視為達成目標或需要中斷，結束循環
            if (aiResponse.actions.some(a => ['send_message', 'ask_user'].includes(a.name))) break;

            nextInput = `【最終目標】：${targetGoal}\n\n【分析】：${aiResponse.text}\n【工具結果】：${JSON.stringify(toolResults)}\n下一步？`;
        }
    }

    /**
     * 執行一次 AI 推論分析 (Agent 思維路徑)，傳回串流產生器
     */
    _think(prompt, context) {
        const { getIsAborted } = context;
        context.lastUserPrompt = prompt;
        const completeInstruction = `${AGENT_SYSTEM_PROMPT}\n${getToolDescriptionPrompt()}\nUser Request: ${prompt}`;
        const engine = new AIEngine(this.model);
        return engine.generateStream(completeInstruction, { getIsAborted });
    }
}

