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
            name: "update_ui",
            description: "修改現有代碼或產出全新的組件。遵循極簡沙盒規範。",
            parameters: {
                type: "OBJECT",
                properties: {
                    code: {
                        type: "STRING",
                        description: "完整的 React 組件代碼。規範：\n1. 絕對禁止 import。\n2. 僅限一個名為 App 的組件。\n3. 無須 export。\n4. 僅限 React 18 語法與 Tailwind CSS。\n5. 不支援第三方圖示，請用 Emoji 或 Tailwind 組件圖形。"
                    },
                    explanation: { type: "STRING", description: "【極簡】說明本次 UI 變更的核心邏輯與設計重點。" },
                    next_step: { type: "STRING", description: "UI 產出/修復後，預計的後續開發動作。" }
                },
                required: ["code", "explanation", "next_step"]
            }
        },
        {
            name: "plan",
            description: "當接收到的需求過於龐大、複雜、涉及多階段變動，或是需求本身描述過於空泛、抽象、不明確時呼叫。進行全局架構分析、需求澄清、步驟拆解並更新開發手冊以明確後續計畫。",
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
        const fileName = `log_${dateStr}_${hourStr}.json`;
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
            "list_sandbox_files": 4,
            "read_file_content": 5,
            "plan": 20,
            "update_ui": 30,
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
                args: task.args
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
                result: result
            }
        });

        // 3. 執行 After Hook 並標記完成
        await this.runHooks(task.name, 'after', { toolName: task.name, args: task.args, result, context, parentTask, task });
        task.status = 'completed';

        return result;
    }

    // 新增方法：深度優先探訪並執行 (支援動態擴展)
    async traverseAndExecute(task, context = {}) {
        const parentTask = context.currentParent || null;
        
        // 0. 深度限制與 Session 初始化
        context.session = context.session || {};
        context.depth = (context.depth || 0) + 1;
        
        if (context.depth > 25) {
            console.error(`  [Walker] ⚠️ 達到最大遞迴深度 (depth: ${context.depth})，終止執行。`);
            task.status = 'error';
            task.result = { error: "Max depth exceeded" };
            return task.result;
        }

        // 1. 執行目前節點 (使用既有的核心執行邏輯)
        const result = await this.executeTask(parentTask, task, context);

        // 2. 檢查執行完後是否產生了新的分岔 (子任務)
        // 注意：使用 for (let i = 0; ...) 是為了支援在執行過程中動態 addTask
        if (task.tasks && task.tasks.length > 0) {
            console.log(`  [Walker] 🌳 節點 ${task.id} 執行完畢，發現 ${task.tasks.length} 個分岔，準備深入探訪...`);

            const subResults = []; 
            for (let i = 0; i < task.tasks.length; i++) {
                const subTask = task.tasks[i];
                
                // 3. 遞迴探訪各個分岔
                const subRes = await this.traverseAndExecute(subTask, { ...context, currentParent: task });
                subResults.push({ id: subTask.id, name: subTask.name, result: subRes });

                // --- 核心進化：自動偵測連鎖反饋 (Next Step Chaining) ---
                // 如果目前的子任務參數中帶有 next_step，代表需要基於結果進行下一步思考
                // 我們在此動態「長出」一個新的 ai_request 任務
                if (subTask.args && subTask.args.next_step) {
                    console.log(`  [Walker] 🔗 偵測到 ${subTask.name} 帶有 next_step，動態掛載推論反饋...`);
                    
                    const feedbackPrompt = `【工具執行完成回報】\n原始計畫：${subTask.args.next_step}\n實際產出數據：\n${JSON.stringify(subRes, null, 2)}\n\n請根據以上真實情況，繼續進行開發或判斷下一步。`;
                    
                    // 動態增加一個子任務，迴圈下次會自動跑它
                    task.addTask("ai_request", { prompt: feedbackPrompt });
                }
            }

            // 4. 將子節點的彙總結果帶回目前的 result 物件中
            if (task.result && typeof task.result === 'object') {
                task.result.subResults = subResults;
            }
        }

        // 5. 返回結果
        return task.result;
    }
}

export const registry = new TaskManager();

// 註冊：目錄清單讀取 (通用版)
registry.register("list_files", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../');
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(base, args.path);
        const files = await fs.readdir(absPath);

        return {
            success: true,
            path: args.path,
            files: files, // 回傳原始陣列，方便程式處理
            fileList: files.join(', ') // 回傳字串，方便 AI 閱讀
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

// 註冊：更新 UI
// 註冊：更新 UI 代碼 (實體寫入版)
registry.register("update_ui", async (args, context) => {
    try {
        const base = context.workDir || path.join(__dirname, '../src/sandbox');
        const targetPath = path.join(base, 'Target.tsx');
        
        await fs.writeFile(targetPath, args.code);
        console.log(`  [UI] 📁 已更新 UI 代碼至: ${targetPath}`);

        return { 
            success: true, 
            path: targetPath,
            explanation: args.explanation, 
            next_step: args.next_step 
        };
    } catch (err) {
        console.error(`  [UI] ❌ 更新失敗:`, err);
        return { success: false, error: err.message };
    }
});

// 註冊：通用子任務執行器 (Batch Executor)
// 已移除：run_subtasks (已被全域分岔走訪器取代)

// 註冊：對話發送工具 (切斷 chain)
registry.register("send_message", async (args) => {
    return { success: true, text: args.text };
});

// 註冊：初始入口 (直接掛載版)
registry.register("bootstrap_request", async (args, context) => {
    // 1. 直發推論任務至當前節點下 (長出第一個子分岔)
    context.currentTask.addTask("ai_request", { prompt: args.user_prompt });
    
    console.log(`  [Bootstrap] 🚀 系統根任務啟動，已掛載首個推論分支。`);
    
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
1. **探索與釐清階段 (Discovery & Clarify)**: 調用偵查工具與 \`list_sandbox_files\` 獲取現況。
2. **決議與規劃階段 (Reasoning & Plan)**: 使用 \`plan\` 工具梳理多階段開發步驟。
3. **執行階段 (Implementation)**: 套用代碼變動。
4. **回報階段 (Reporting)**: 完成所有變動後，【必須】呼叫 \`send_message\` 提供彙報並結束連鎖。

${getToolDescriptionPrompt()}
`;

    const result = await model.generateContentStream({
        contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${currentPrompt}` }] }]
    });

    for await (const chunk of result.stream) {
        if (getIsAborted && getIsAborted()) {
            console.log("[Flow] 生成過程中偵測到中斷。");
            break;
        }
        const cand = chunk.candidates?.[0];
        if (!cand?.content?.parts) continue;
        for (const part of cand.content.parts) {
            if (part.functionCall) {
                const name = part.functionCall.name;
                const toolArgs = part.functionCall.args;
                
                // --- 深度限制保護 (避免 AI 陷入無窮推論循環) ---
                context.loopCount = (context.loopCount || 0) + 1;
                if (context.loopCount > 10) {
                    console.log(`  [AI] ⚠️ 連鎖推論深度達限，終止衍生。`);
                    continue;
                }

                // --- 建立分支任務 ---
                context.currentTask.addTask(name, toolArgs);
                console.log(`  [AI] 🧠 偵測到行動計畫: ${name}，已掛載至任務樹。`);
            } else if (part.text) {
                context.currentTask.addTask("send_message", { text: part.text });
            }
        }
    }

    return { success: true };
});

