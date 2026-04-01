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

// --- 全域任務樹資料結構 (支援雙向探訪) ---
export const taskTreeMap = new Map(); // Key: NodeID, Value: Node{ name, args, parent, children, status }

// --- Function Calling 定義 ---
const tools = [{
    functionDeclarations: [
        {
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
        {
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
        {
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
        {
            name: "plan",
            description: "當接收到的需求過於龐大，可能需要拆解進行多步驟處理時呼叫。進行架構分析與開發步驟的拆解。",
            parameters: {
                type: "OBJECT",
                properties: {
                    analysis: { type: "STRING", description: "針對大型任務的現狀分析，或針對空泛需求的澄清、假設與困難點拆解邏輯。" },
                    next_steps_plan: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "預計執行的後續具體計畫步驟，每個步驟將會轉化為一個獨立的推論任務 (ai_request)"
                    }
                },
                required: ["analysis", "next_steps_plan"]
            }
        },
        {
            name: "ask_user",
            description: "當目前的資訊不足、需求不全或存在多種實作路徑需要使用者決策時呼叫。發送特定的問題給使用者並暫停目前的自動化開發流程。",
            parameters: {
                type: "OBJECT",
                properties: {
                    question: { type: "STRING", description: "要詢問使用者的具體問題。說明清楚為何需要停下問這個問題。" }
                },
                required: ["question"]
            }
        }
    ]
}];

// 自動生成工具清單指令的輔助函式
function getToolDescriptionPrompt() {
    const decls = tools[0].functionDeclarations;
    const list = decls.map(t => `- **${t.name}**: ${t.description}`).join('\n');
    return `【可用工具清單 (Toolkits)】：\n${list}\n\n請根據需求選擇最適合的工具組合，可依序執行多個步驟。`;
}

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools: tools });



// 紀錄回應資訊的函式 (堆疊式，每小時一個檔案)
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

// --- 階層型 Task 領域模型 ---
class Task {
    constructor(id, name, args = {}, targetPrompt = null) {
        this.id = id;
        this.name = name;
        this.args = args;
        this.targetPrompt = targetPrompt; // 若有 prompt 就是高階推論任務
        this.tasks = []; // 子任務列表 (向前探訪)
        this.status = 'pending';
        this.result = null;
        this.createdAt = new Date().toISOString();
        this.parent = null; // 父節點物件引用 (向後探訪)

        // 自動註冊至全域任務樹
        taskTreeMap.set(this.id, this);
    }

    addTask(name, args) {
        // 子任務 ID 直接繼承父任務
        const childId = `${this.id}-${this.tasks.length + 1}`;
        const task = new Task(childId, name, args);
        task.parent = this; // 建立雙向鏈結 (向後)
        this.tasks.push(task); // 建立雙向鏈結 (向前)
        return task;
    }
}

class TaskManager {
    constructor() {
        this.handlers = new Map();
        this.hooks = new Map();
        this.rootTasks = new Map();
        this.priorities = {
            "bootstrap_request": 1,
            "ai_request": 2,          // 最高優先，發出推論請求並展開新任務
            "list_files": 4,
            "read_file_content": 5,
            "plan": 20,
            "update_file": 30,
            "ask_user": 99,
            "send_message": 99
        };
    }

    createTask(name, args = {}, prompt = null) {
        const id = `TASK-${Date.now()}`;
        const task = new Task(id, name, args, prompt);
        task.status = 'active';
        this.rootTasks.set(id, task);
        console.log(`\n[Task] 🚀 建立高階任務 (Task ID: ${id})`);
        return task;
    }

    // 註冊鉤子方法
    on(toolName, stage, callback) {
        const key = `${toolName}:${stage}`;
        if (!this.hooks.has(key)) this.hooks.set(key, []);
        this.hooks.get(key).push(callback);
    }

    // 執行鉤子的內部方法
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

    // 支援遞迴的 Task 執行器
    async executeTask(parentTask, task, context = {}) {
        // 確保 session 存在於 context 中，供所有 Task 共用狀態 (如 isAlreadySpoken)
        if (!context.session) context.session = {};

        const handler = this.handlers.get(task.name);

        if (!handler) {
            console.error(`  [Task] ❌ 找不到任務處理器: ${task.name} (Task ID: ${task.id})`);
            task.status = 'error';
            return;
        }

        let result = null;
        task.status = 'running';
        console.log(`  [Task] 派發任務: ${task.name} (Task ID: ${task.id})`);

        // 1. 執行 Before Hook
        await this.runHooks(task.name, 'before', { toolName: task.name, args: task.args, context, parentTask, task });

        // 1.5 在啟動 Handler 前先行日誌紀錄
        await recordGeminiResponse({
            type: "TASK_START",
            prompt: `【Task 啟動】：${task.name}`,
            output: task.args,
            data: {
                id: task.id,
                parentId: parentTask?.id,
                name: task.name,
                args: task.args,
                session_id: context.sessionId
            }
        });

        // 2. 執行核心工具邏輯 (Handler)
        // 將當前 task 本身注入 context，供 ai_request 等需要遞迴建立子任務的工具使用
        result = await handler(task.args, { ...context, currentTask: task });
        task.result = result;

        // 2.5 紀錄執行完成日誌 (包含結果)
        await recordGeminiResponse({
            type: "TASK_RESULT",
            prompt: `【Task 完成】：${task.name}`,
            output: result,
            data: {
                id: task.id,
                parentId: parentTask?.id,
                name: task.name,
                result: result,
                session_id: context.sessionId
            }
        });

        // 3. 執行 After Hook 並標記完成
        await this.runHooks(task.name, 'after', { toolName: task.name, args: task.args, result, context, parentTask, task });
        task.status = 'completed';

        return result;
    }

    // 新增方法：深度優先探訪並執行 (支援動態擴展)
    async traverseAndExecute(rootTask, context = {}) {
        let current = rootTask;
        context.session = context.session || {};
        context.visitCount = 0; // 追蹤已執行的任務總數

        console.log(`  [Walker] 🚶 啟動指標走訪器 (Root: ${rootTask.id})`);

        while (current) {
            // 0. 如果已執行超過 10 個任務，基於預算限制主動停止
            if (context.visitCount >= 10) {
                console.warn(`  [Walker] ⚠️ 達到最大造訪任務數限制 (10)，終止走訪流程。`);
                break;
            }

            // 1. 執行目前節點 (如果尚未執行)
            if (current.status === 'pending' || current.status === 'active') {
                context.visitCount++; // 累計執行次數
                const result = await this.executeTask(current.parent, current, context);

                // --- 核心進化：動態偵測連鎖反饋 (Next Step Chaining) ---
                if (current.parent && current.args?.next_step) {
                    console.log(`  [Walker] 🔗 偵測到 ${current.name} 帶有 next_step，動態掛載回饋...`);
                    const feedbackPrompt = `【工具執行完成回報】\n原始計畫：${current.args.next_step}\n實際產出數據：\n${JSON.stringify(result, null, 2)}\n\n請根據以上真實情況，繼續進行開發或判斷下一步。`;
                    current.parent.addTask("ai_request", { prompt: feedbackPrompt });
                }
            }

            // 2. 判斷下一個移動指標 (DFS 順序)

            // A. 向下探訪 (Down)
            const unvisitedChild = current.tasks.find(t => t.status === 'pending' || t.status === 'active');
            if (unvisitedChild) {
                current = unvisitedChild;
                continue;
            }

            // B. 子節點跑完，嘗試移動至下一個兄弟節點 (Right) 或 回溯 (Up)
            if (current === rootTask) break; // 根部完成

            let foundNext = false;
            let tracer = current;

            while (tracer && tracer !== rootTask) {
                // 彙總結果至父節點 (模擬遞迴回傳)
                if (tracer.parent && (tracer.status === 'completed' || tracer.status === 'error')) {
                    tracer.parent.result = tracer.parent.result || {};
                    tracer.parent.result.subResults = tracer.parent.result.subResults || [];
                    if (!tracer.parent.result.subResults.find(r => r.id === tracer.id)) {
                        tracer.parent.result.subResults.push({ id: tracer.id, name: tracer.name, result: tracer.result });
                    }
                }

                const siblings = tracer.parent.tasks;
                const myIndex = siblings.indexOf(tracer);

                if (myIndex < siblings.length - 1) {
                    current = siblings[myIndex + 1];
                    foundNext = true;
                    break;
                }

                // 無兄弟則繼續向上
                tracer = tracer.parent;
            }

            if (!foundNext) {
                current = null;
            }
        }

        console.log(`  [Walker] 🏁 指標走訪結束。`);
        return rootTask.result;
    }
}

export const registry = new TaskManager();

// 註冊：目錄清單讀取 (通用版)
registry.register("list_files", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(base, args.path);
        const files = await fs.readdir(absPath);

        // 將檔案轉換為相對於工作目錄的相對路徑
        const relativeFiles = files.map(file => {
            const fullPath = path.join(absPath, file);
            return path.relative(base, fullPath);
        });

        return {
            success: true,
            path: args.path,
            files: relativeFiles, // 回傳相對路徑陣列
            fileList: relativeFiles.join(', ') // 回傳相對路徑字串
        };
    } catch (err) {
        return {
            success: false,
            error: `獲取目錄「${args.path}」失敗：${err.message}`
        };
    }
});

// 註冊：讀取檔案內容並針對性分析
registry.register("read_file_content", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(base, args.path);
        const content = await fs.readFile(absPath, 'utf8');
        return {
            success: true,
            path: args.path,
            content: content
        };
    } catch (err) {
        return {
            success: false,
            error: `讀取檔案「${args.path}」失敗：${err.message}`
        };
    }
});

// 註冊：任務拆解與規劃 (內部執行器版)
// 註冊：規劃工具 (將複雜計畫分解為多個推論分支)
registry.register("plan", async (args, context) => {
    const parent = context.currentTask;

    console.log(`  [Plan] 🛠️ 為當前節點掛載計畫分支 (${args.next_steps_plan.length} 個步驟)`);

    // 動態掛載計畫好的推論步驟
    for (const step of args.next_steps_plan) {
        parent.addTask("ai_request", { prompt: step });
    }

    return {
        success: true,
        message: `已建立 ${args.next_steps_plan.length} 個計畫步驟並掛載。`
    };
});

// 註冊：更新檔案內容 (實體寫入版)
registry.register("update_file", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../src/sandbox');
        const targetPath = path.join(base, 'Target.tsx');

        await fs.writeFile(targetPath, args.code);
        console.log(`  [File] 📁 已更新檔案內容至: ${targetPath}`);

        return {
            success: true,
            path: targetPath,
            explanation: args.explanation,
            next_step: args.next_step
        };
    } catch (err) {
        console.error(`  [File] ❌ 更新失敗:`, err);
        return { success: false, error: err.message };
    }
});

// 註冊：通用子任務執行器 (Batch Executor)
// 已移除：run_subtasks (已被全域分岔走訪器取代)

// 註冊：對話發送工具 (切斷 chain)
registry.register("send_message", async (args) => {
    return { success: true, text: args.text };
});

// 註冊：詢問使用者工具 (暫停 chain)
registry.register("ask_user", async (args) => {
    return { success: true, question: args.question };
});

// 註冊：初始入口 (自動化思維迴圈與執行主控)
registry.register("bootstrap_request", async (args, context) => {
    const finalGoal = args.user_prompt;
    let currentInput = `【最終目標】：${finalGoal}\n\n請根據目標開始第一輪思考與偵查。`;
    const MAX_ROUNDS = context.loopCountLimit || 5;

    console.log(`  [Bootstrap] 🚀 啟動執行主控迴圈 (上限 ${MAX_ROUNDS} 輪)`);

    for (let i = 0; i < MAX_ROUNDS; i++) {
        console.log(`  [Bootstrap] 🔄 進入第 ${i + 1} 輪推論與執行`);

        // 1. 向 AI 請求推論
        const aiTask = context.currentTask.addTask("ai_request", { prompt: currentInput });
        const inference = await registry.executeTask(context.currentTask, aiTask, context);

        // 2. 在內部解析並執行 AI 要求的動作 (Function Calls)
        let actionResults = [];
        if (inference.actions && inference.actions.length > 0) {
            console.log(`  [Bootstrap] 🛠️ 偵測到 ${inference.actions.length} 個動作，開始序列執行...`);
            for (const action of inference.actions) {
                const subTask = context.currentTask.addTask(action.name, action.args);
                const res = await registry.executeTask(context.currentTask, subTask, context);
                actionResults.push({ tool: action.name, result: res, next_step: action.args?.next_step });
            }
        }

        // 3. 判斷主動終止
        const hasTerminator = inference.actions?.some(a => a.name === 'send_message' || a.name === 'ask_user');
        if (hasTerminator) {
            console.log(`  [Bootstrap] 🛑 AI 已發出終端指標，結束主控迴圈。`);
            break;
        }

        // 4. 彙整結果至下一輪 (包含思考與結構化的工具回饋)
        let feedback = `【上一步推論分析】：\n${inference.text || "(無分析背景)"}\n\n`;
        if (actionResults.length > 0) {
            feedback += `【實時工具執行回傳】：\n`;
            actionResults.forEach(ar => {
                feedback += `🛠️ 調用工具：[${ar.tool}]\n結果數據：\n${JSON.stringify(ar.result, null, 2)}\n\n`;
            });
        }

        currentInput = `【最終目標】：${finalGoal}\n\n${feedback}請根據以上推論分析與工具執行結果，判斷是否需要繼續執行後續步驟、或直接回報完成。`;
    }

    return { success: true };
});

// 註冊：執行 AI 推論請求 (將 AI 請求本身包裝為任務)
registry.register("ai_request", async (args, context) => {
    const { getIsAborted } = context;
    const currentPrompt = args.prompt;

    // --- 關鍵修復：將推論上下文注入 context，供衍生任務參考 ---
    context.currentPrompt = currentPrompt;

    const workDir = context.workDir || path.join(__dirname, '../src/sandbox');

    const systemInstruction = `你是一個具備「思考與執行合一」能力的高級前端工程師 Agent。
注意：【禁止憑空推論】。如果你的上下文不足以支撐對現有專案實作的精確理解，【必須】立刻呼叫工具進行主動偵查。

【專案執行原則】：
1. **分析先行**: 接收到需求後，若未掌握具體檔案結構或編碼細節，或是需求本身過於空泛抽象，請優先使用偵查類工具或 \`plan\` 工具。
2. **透明度**: 所有說明與分析流程請一律使用【繁體中文】。

【執行流程 (SOP)】：
1. **探索與釐理階段 (Discovery & Clarify)**: 調用偵查工具與 \`list_files\` 獲取現況。
2. **決議與規劃階段 (Reasoning & Plan)**: 使用 \`plan\` 工具梳理多階段開發步驟。
3. **執行階段 (Implementation)**: 呼叫 \`update_file\` 套用代碼變動。
4. **回報階段 (Reporting)**: 完成所有變動後，【必須】呼叫 \`send_message\` 提供彙報並結束連鎖。

${getToolDescriptionPrompt()}
`;

    const result = await model.generateContentStream({
        contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${currentPrompt}` }] }]
    });
    // 3. 收集結果並回傳建議 Action，不主動掛載子任務
    const actions = [];
    let textResult = "";

    for await (const chunk of result.stream) {
        if (getIsAborted && getIsAborted()) {
            console.log("[Flow] 生成過程中偵測到中斷。");
            break;
        }

        const cand = chunk.candidates?.[0];
        if (!cand?.content?.parts) continue;

        for (const part of cand.content.parts) {
            if (part.text) {
                textResult += part.text;
            }
            if (part.functionCall) {
                actions.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args
                });
            }
        }
    }

    return { text: textResult, actions };
});

