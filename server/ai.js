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
export const FRAMEWORK_FILE = path.join(__dirname, '../src/sandbox/Framework.md');
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
            name: "update_framework",
            description: "當專案方向變更、加入新技術架構或規範需更新時，修改 Framework.md。需明確說明下一步計畫。",
            parameters: {
                type: "OBJECT",
                properties: {
                    new_content: { type: "STRING", description: "更新後的 Framework.md 繁體中文內容。" },
                    next_step: { type: "STRING", description: "同步手冊後，預計要進行的具體開發任務或下一步目標。" }
                },
                required: ["new_content", "next_step"]
            }
        },
        {
            name: "plan",
            description: "當接收到的需求過於龐大、複雜、涉及多階段變動，或是需求本身描述過於空泛、抽象、不明確時呼叫。進行全局架構分析、需求澄清、步驟拆解並更新開發手冊以明確後續計畫。",
            parameters: {
                type: "OBJECT",
                properties: {
                    analysis: { type: "STRING", description: "針對大型任務的現狀分析，或針對空泛需求的澄清、假設與困難點拆解邏輯。" },
                    updated_framework: { type: "STRING", description: "根據拆解後的計畫，重新編寫或增修 Framework.md 的內容。" },
                    next_steps_plan: {
                        type: "ARRAY",
                        items: { type: "STRING" },
                        description: "預計執行的後續具體計畫步驟，每個步驟將會轉化為一個獨立的推論任務 (ai_request)"
                    }
                },
                required: ["analysis", "updated_framework", "next_steps_plan"]
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
export async function recordGeminiResponse({ type = "CHAT", prompt, output, raw = null }) {
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
            output: typeof output === 'object' ? JSON.stringify(output, null, 2) : output,
            raw
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
            "update_framework": 10,
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

        // 1.5 在啟動 Handler 前先行日誌紀錄 (不帶 result)
        await recordGeminiResponse({
            type: "TASK_START",
            prompt: `【Task 啟動執行】：${task.name}`,
            output: `啟動參數：\n${JSON.stringify(task.args, null, 2)}`,
            raw: {
                taskId: task.id,
                parentTaskId: parentTask?.id,
                tool: task.name,
                args: task.args
            }
        });

        // 2. 執行核心工具邏輯 (Handler)
        // 將當前 task 本身注入 context，供 ai_request 等需要遞迴建立子任務的工具使用
        result = await handler(task.args, { ...context, currentTask: task });
        task.result = result;

        // 3. 統一任務衍生機制 (手動回傳版 - 供尚未完全切換至 addTask 模式的工具使用)
        const subTaskItems = result.derivedTasks || result.tasks;
        if (subTaskItems && Array.isArray(subTaskItems)) {
            for (const d of subTaskItems) {
                // 如果該任務已經在當前 tasks 裡（可能是工具內已呼叫過 addTask），則跳過
                if (task.tasks.some(t => t.name === d.name && JSON.stringify(t.args) === JSON.stringify(d.args))) {
                    continue;
                }
                
                if (d.name === "ai_request") {
                    context.loopCount = (context.loopCount || 0) + 1;
                    if (context.loopCount > 5) {
                        console.log(`  [Task] ⚠️ 已達連鎖推論深度上限 (MAX=5)，跳過 ai_request。`);
                        continue;
                    }
                }
                task.addTask(d.name, d.args);
            }
        }

        // 5. 執行 After Hook 並標記完成
        await this.runHooks(task.name, 'after', { toolName: task.name, args: task.args, result, context, parentTask, task });
        task.status = 'completed';

        return result;
    }

    // 新增方法：深度優先探訪並執行 (支援動態擴展)
    async traverseAndExecute(task, context = {}) {
        const parentTask = context.currentParent || null;

        // 1. 執行目前節點 (使用既有的核心執行邏輯)
        const result = await this.executeTask(parentTask, task, context);

        // 2. 檢查執行完後是否產生了新的分岔 (子任務)
        // 注意：在我們的任務結構中，子任務會掛載在 task.tasks 陣列裡
        if (task.tasks && task.tasks.length > 0) {
            console.log(`  [Walker] 🌳 節點 ${task.id} 執行完畢，發現 ${task.tasks.length} 個分岔，準備深入探訪...`);

            for (const subTask of task.tasks) {
                // 3. 遞迴探訪各個分岔
                // 在探訪分岔時，將目前節點設為下一層的 parent
                await this.traverseAndExecute(subTask, { ...context, currentParent: task });
            }
        }

        // 4. 當所有分岔執行完畢，返回上一層 (完成此節點的生命週期)
        return result;
    }
}

export const registry = new TaskManager();

// 註冊：目錄清單讀取 (通用版)
registry.register("list_files", async (args) => {
    try {
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(__dirname, '../', args.path);
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
registry.register("read_file_content", async (args) => {
    try {
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(__dirname, '../', args.path);
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

// 註冊：更新架構
registry.register("update_framework", async (args, { currentPrompt }) => {
    return {
        success: true,
        derivedTasks: [
            { name: "ai_request", args: { prompt: `${currentPrompt}\n---\n已更新 Framework.md。下一步計畫是：${args.next_step}。` } }
        ]
    };
});

// 註冊：任務拆解與規劃 (內部執行器版)
registry.register("plan", async (args, context) => {
    const { currentPrompt } = context;

    // 1. 建立一個局部的、獨立的任務執行器
    const subRegistry = new TaskManager();
    // 繼承全域的工具處理器與優先級設定
    subRegistry.handlers = registry.handlers;
    subRegistry.priorities = registry.priorities;

    console.log(`  [Plan] 🛠️ 開始執行局部任務鏈 (${args.next_steps_plan.length} 個步驟)`);

    // 2. 依序在局部執行器中啟動任務
    let lastStepFactualResults = ""; // 儲存前一次任務回傳的真實執行結果

    for (const [index, step] of args.next_steps_plan.entries()) {
        const subTaskArgs = {
            prompt: `${currentPrompt}\n---\n【前置階段執行結果回報】：\n${lastStepFactualResults || "（這是第一階段，無前置結果）"}\n---\n【當前階段任務目標】：${step}`
        };

        const subTask = subRegistry.createTask("ai_request", subTaskArgs);

        // 修改點：現在可以直接接收 executeTask 回傳的結果
        const taskResult = await subRegistry.executeTask(null, subTask, context);

        // 將結果轉為字串，帶入下一輪循環的 Prompt
        if (taskResult) {
            lastStepFactualResults = JSON.stringify(taskResult, null, 2);
        } else {
            lastStepFactualResults = "（執行完成，未產生額外回傳數據）";
        }
    }

    // 任務鏈已執行完畢
    return {
        success: true
    };
});

// 註冊：更新 UI
registry.register("update_ui", async (args) => {
    return { success: true, explanation: args.explanation, next_step: args.next_step };
});

// 註冊：通用子任務執行器 (Batch Executor)
registry.register("run_subtasks", async (args, context) => {
    const { tasks } = args; // tasks 格式範例: [{ name: "ai_request", args: { ... } }]

    if (!tasks || !Array.isArray(tasks)) {
        return { success: false, error: "無效的子任務清單格式" };
    }

    let lastResult = { success: true, note: "無子任務執行" };
    const parent = context.currentTask;

    console.log(`  [Batch Runner] ⚡ 啟動批次任務執行 (共 ${tasks.length} 步)`);

    for (const item of tasks) {
        // 1. 建立並執行子任務 (掛載在 run_subtasks 節點下)
        const subTask = registry.createTask(item.name, item.args);
        lastResult = await registry.executeTask(parent, subTask, context);

        // 2. 如果任務參數中有 next_step，則基於「真實執行結果」立刻進行下一步推論
        if (item.args && item.args.next_step) {
            console.log(`  [Batch Runner] 🔗 偵測到 next_step，為工具 ${item.name} 啟動連線推論...`);
            const followUpArgs = {
                prompt: `【工具執行完成回報】\n原始行動計畫：${item.args.next_step}\n實際執行產出數據：\n${JSON.stringify(lastResult, null, 2)}\n\n請根據以上真實情況，繼續進行開發或判斷下一步。`
            };
            const followUpTask = registry.createTask("ai_request", followUpArgs);
            lastResult = await registry.executeTask(parent, followUpTask, context);
        }
    }

    return lastResult; // 回傳清單中最後一筆（含連鎖推論）的產出結果
});

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

    const frameworkDocs = await fs.readFile(FRAMEWORK_FILE, 'utf8').catch(() => "// 尚無框架");

    const systemInstruction = `你是一個具備「思考與執行合一」能力的高級前端工程師 Agent。
注意：【禁止憑空推論】。如果你的上下文不足以支撐對現有專案實作的精確理解，【必須】立刻呼叫工具進行主動偵查。

【專案執行原則】：
1. **分析先行**: 接收到需求後，若未掌握具體檔案結構或編碼細節，或是需求本身過於空泛抽象，請優先使用偵查類工具或 \`plan\` 工具。
2. **規格一致性**: 所有的產出必須符合下方列出的 Framework.md 規範。
3. **透明度**: 所有說明與分析流程請一律使用【繁體中文】。

【執行流程 (SOP)】：
1. **探索與釐清階段 (Discovery & Clarify)**: 調用偵查工具與 \`list_sandbox_files\` 獲取現況。
2. **決議與規劃階段 (Reasoning & Plan)**: 使用 \`plan\` 工具梳理多階段開發步驟。
3. **執行階段 (Implementation)**: 套用代碼變動或更新手冊內容。
4. **回報階段 (Reporting)**: 完成所有變動後，【必須】呼叫 \`send_message\` 提供彙報並結束連鎖。

${getToolDescriptionPrompt()}

【開發規範文件 (Framework.md)】：
---
${frameworkDocs}
---`;

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
                
                // --- 直接使用 Task 分支機制 ---
                // 此處會建立實體 Task 物件、建立父子關聯、並自動註冊至全域 taskTreeMap
                context.currentTask.addTask(name, toolArgs);
                
                console.log(`  [AI] 🧠 偵測到行動計畫: ${name}，已即時掛載至任務樹。`);
            } else if (part.text) {
                // 將文字訊息也建立為一個正式的發送任務，以便被走訪器處理
                context.currentTask.addTask("send_message", { text: part.text });
            }
        }
    }

    // 回傳成功，走訪器在執行完本推論任務後，會自動檢查 currentTask.tasks 中新增的分岔
    return { success: true };
});

