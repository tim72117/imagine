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
            name: "list_sandbox_files",
            description: "列出 src/sandbox/ 目錄下的所有檔案與資料夾。需說明讀取原因與接下來的計畫。",
            parameters: {
                type: "OBJECT",
                properties: {
                    explanation: { type: "STRING", description: "【極簡】說明為何此時需要獲取目錄清單。" },
                    next_step: { type: "STRING", description: "獲取清單後預計執行的下一步分析動作。" }
                },
                required: ["explanation", "next_step"]
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
                    next_steps_plan: { type: "STRING", description: "列出具體的執行隊列，明確分階段實作的第一步目標或是預計要釐清的項目。" }
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

        // 1. 若該任務有對應的 handler (基本工具)，則準備執行
        if (handler) {
            task.status = 'running';
            console.log(`  [Task] 派發任務: ${task.name} (Task ID: ${task.id})`);

            await this.runHooks(task.name, 'before', { toolName: task.name, args: task.args, context, parentTask, task });

            const result = await handler(task.args, context);
            task.result = result;
            task.status = 'completed';

            await recordGeminiResponse(
                `【Task 執行】：${task.name}`,
                JSON.stringify({ parentTaskId: parentTask?.id, taskId: task.id, args: task.args, result }, null, 2),
                "TASK_RESULT",
                { parentTaskId: parentTask?.id, taskId: task.id, tool: task.name, args: task.args }
            );

            await this.runHooks(task.name, 'after', { toolName: task.name, args: task.args, result, context, parentTask, task });

            // --- 統一任務衍生機制 ---
            
            // 1. 處理顯式衍生 (由 handler 解析出的多個子任務)
            if (result.derivedTasks && Array.isArray(result.derivedTasks)) {
                for (const d of result.derivedTasks) {
                    task.addTask(d.name, d.args);
                }
                console.log(`  [Task] 🧬 從任務 ${task.id} 衍生出 ${result.derivedTasks.length} 個子任務`);
            }

            // 2. 處理連鎖衍生 (由 handler 宣告的後續推論需求)
            if (result.triggerNext) {
                context.loopCount = (context.loopCount || 0) + 1;
                if (context.loopCount <= 3) {
                    const targetHostTask = parentTask ? parentTask : task;
                    targetHostTask.addTask("ai_request", { prompt: result.nextPrompt });
                    console.log(`  [Task] 🔗 捕獲連鎖推論，於節點 ${targetHostTask.id} 後方掛載新的 ai_request (連鎖深度: ${context.loopCount})`);
                } else {
                    console.log(`  [Task] ⚠️ 已達連鎖推論深度上限 (MAX_LOOPS=3)，停止衍生。`);
                }
            }
        } else {
            // 如果沒有 handler，它只是一個複合群組任務 (Composite Task)
            task.status = 'running';
        }

        // 2. 動態追蹤並消化它底下的所有遞迴子任務
        while (true) {
            const pendingTasks = task.tasks.filter(t => t.status === 'pending');
            if (pendingTasks.length === 0) break;

            pendingTasks.sort((a,b) => {
                const pA = this.priorities[a.name] || 99;
                const pB = this.priorities[b.name] || 99;
                return pA - pB;
            });

            const currentSubTask = pendingTasks[0];
            await this.executeTask(task, currentSubTask, context);
        }

        if (!handler) task.status = 'completed';
    }
}

export const registry = new TaskManager();

// 註冊：清單讀取
registry.register("list_sandbox_files", async (args, { currentPrompt }) => {
    try {
        const sandboxDir = path.join(__dirname, '../src/sandbox/');
        const files = await fs.readdir(sandboxDir);

        // 將檔案清單轉為完整相對路徑
        const fullPaths = files.map(file => path.join('src/sandbox', file).replace(/\\/g, '/'));
        const fileList = fullPaths.join(', ');

        return {
            success: true,
            fileList,
            triggerNext: true,
            nextPrompt: `${currentPrompt}\n---\n【目錄清單】：[${fileList}]\n分析原因：${args.explanation}\n下一步：${args.next_step}`
        };
    } catch (err) {
        return {
            success: false,
            triggerNext: true,
            nextPrompt: `【系統錯誤】目錄清單獲取失敗：${err.message}`
        };
    }
});

// 註冊：讀取檔案內容並針對性分析
registry.register("read_file_content", async (args, { currentPrompt }) => {
    try {
        const absPath = path.isAbsolute(args.path) ? args.path : path.join(__dirname, '../', args.path);
        const content = await fs.readFile(absPath, 'utf8');
        return {
            success: true,
            content,
            triggerNext: true,
            nextPrompt: `${currentPrompt}\n---\n【檔案內容：${args.path}】\n${content}\n---\n原因：${args.explanation}\n計畫：${args.next_step}`
        };
    } catch (err) {
        return {
            success: false,
            triggerNext: true,
            nextPrompt: `${currentPrompt}\n---\n【系統錯誤】讀取檔案「${args.path}」失敗：${err.message}\n請檢查路徑是否正確。`
        };
    }
});

// 註冊：更新架構
registry.register("update_framework", async (args, { currentPrompt }) => {
    return {
        success: true,
        triggerNext: true,
        nextPrompt: `${currentPrompt}\n---\n已更新 Framework.md。下一步計畫是：${args.next_step}。`
    };
});

// 註冊：任務拆解與規劃
registry.register("plan", async (args, { currentPrompt }) => {
    return {
        success: true,
        triggerNext: true,
        nextPrompt: `${currentPrompt}\n---\n規劃已生效。分析：${args.analysis}。第一步預計執行計畫：${args.next_steps_plan}。`
    };
});

// 註冊：更新 UI
registry.register("update_ui", async (args) => {
    return { success: true, explanation: args.explanation, next_step: args.next_step };
});

// 註冊：對話發送工具 (切斷 chain)
registry.register("send_message", async (args) => {
    return { success: true, triggerNext: false, text: args.text };
});

// 註冊：初始轉送 (No-Op UI)
registry.register("bootstrap_request", async (args) => {
    return {
        success: true,
        triggerNext: true,
        nextPrompt: args.user_prompt
    };
});

// 註冊：執行 AI 推論請求 (將 AI 請求本身包裝為任務)
registry.register("ai_request", async (args, context) => {
    const { getIsAborted } = context;
    const currentPrompt = args.prompt;
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
    
    return { success: true, derivedTasks };
});

