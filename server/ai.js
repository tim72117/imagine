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
export async function recordGeminiResponse(prompt, output, type = "CHAT", rawData = null) {
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
            raw: rawData // 全量原始資訊
        });
        await fs.writeJson(historyPath, logs, { spaces: 2 });
        console.log(`[System] [${type}] 回應已堆疊紀錄至: ${fileName} (含 Raw Data)`);
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
        this.tasks = []; // 子任務
        this.status = 'pending';
        this.result = null;
        this.createdAt = new Date().toISOString();
        this.parentTaskId = null; // 關聯父節點/前置節點
        this.nextTaskId = null;   // 連鎖的下個任務
    }

    addTask(name, args) {
        // 子任務 ID 直接繼承父任務
        const childId = `${this.id}-${this.tasks.length + 1}`;
        const task = new Task(childId, name, args);
        this.tasks.push(task);
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

        // 2. 執行核心工具邏輯 (Handler)
        result = await handler(task.args, context);
        task.result = result;

        await recordGeminiResponse(
            `【Task 執行】：${task.name}`,
            JSON.stringify({ parentTaskId: parentTask?.id, taskId: task.id, args: task.args, result }, null, 2),
            "TASK_RESULT",
            { parentTaskId: parentTask?.id, taskId: task.id, tool: task.name, args: task.args }
        );

        // 3. 統一任務衍生機制 (子任務掛載)
        if (result.derivedTasks && Array.isArray(result.derivedTasks)) {
            for (const d of result.derivedTasks) {
                // 如果是 ai_request，則檢查循環次數以防止死鎖
                if (d.name === "ai_request") {
                    context.loopCount = (context.loopCount || 0) + 1;
                    if (context.loopCount > 5) {
                        console.log(`  [Task] ⚠️ 已達連鎖推論深度上限 (MAX=5)，跳過 ai_request。`);
                        continue;
                    }
                }
                task.addTask(d.name, d.args);
            }
            console.log(`  [Task] 🧬 衍生出 ${result.derivedTasks.length} 個子任務並掛載。`);
        }

        // 4. 動態追蹤並消化它底下的所有遞迴子任務
        while (true) {
            const pendingTasks = task.tasks.filter(t => t.status === 'pending');
            if (pendingTasks.length === 0) break;

            pendingTasks.sort((a, b) => {
                const pA = this.priorities[a.name] || 99;
                const pB = this.priorities[b.name] || 99;
                return pA - pB;
            });

            const currentSubTask = pendingTasks[0];
            await this.executeTask(task, currentSubTask, context);
        }

        // 5. 只有當所有子任務都完成後，才執行 After Hook 並將標記主任務完成
        await this.runHooks(task.name, 'after', { toolName: task.name, args: task.args, result, context, parentTask, task });
        task.status = 'completed';

        return result; // 修改點：讓任務執行器會回傳最後的執行結果
    }
}

export const registry = new TaskManager();

// 註冊：目錄清單讀取 (通用版)
registry.register("list_files", async (args) => {
    try {
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(__dirname, '../', args.path);
        const files = await fs.readdir(absPath);
        
        // 分類檔案與目錄 (可選，但讓 AI 好判斷)
        const fileList = files.join(', ');

        return {
            success: true,
            path: args.path,
            fileList: fileList
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

    const subRegistry = new TaskManager();
    subRegistry.handlers = registry.handlers;
    subRegistry.priorities = registry.priorities;

    let lastResult = null;

    console.log(`  [Batch Runner] ⚡ 啟動批次任務執行 (共 ${tasks.length} 步)`);

    for (const item of tasks) {
        // 建立並執行子任務
        const subTask = subRegistry.createTask(item.name, item.args);
        lastResult = await subRegistry.executeTask(null, subTask, context);
    }

    return lastResult; // 回傳清單中最後一個任務的產出結果
});

// 註冊：對話發送工具 (切斷 chain)
registry.register("send_message", async (args) => {
    return { success: true, text: args.text };
});

// 註冊：初始轉送 (No-Op UI)
registry.register("bootstrap_request", async (args) => {
    return {
        success: true,
        derivedTasks: [
            { name: "ai_request", args: { prompt: args.user_prompt } }
        ]
    };
});

// 註冊：執行 AI 推論請求 (將 AI 請求本身包裝為任務)
registry.register("ai_request", async (args, context) => {
    const { getIsAborted } = context;
    const currentPrompt = args.prompt;

    // --- 關鍵修復：將推論上下文注入 context，供衍生任務參考 ---
    context.currentPrompt = currentPrompt;

    const derivedTasks = [];

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
                derivedTasks.push({ name: part.functionCall.name, args: part.functionCall.args });
            } else if (part.text) {
                derivedTasks.push({ name: "send_message", args: { text: part.text } });
            }
        }
    }

    // --- 修改亮點：將收集到的任務，立刻交給 run_subtasks 執行器進行同步處理 ---
    const subRegistry = new TaskManager();
    subRegistry.handlers = registry.handlers;
    subRegistry.priorities = registry.priorities;

    const dispatchTask = subRegistry.createTask("run_subtasks", { tasks: derivedTasks });
    
    // 執行同步子任務並回傳最終工具結果
    const finalResult = await subRegistry.executeTask(null, dispatchTask, context);

    return finalResult;
});

