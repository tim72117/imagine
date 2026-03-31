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
        },
        {
            name: "bootstrap_request",
            description: "內部工具。處理初始請求的標準化轉送。",
            parameters: {
                type: "OBJECT",
                properties: {
                    user_prompt: { type: "STRING", description: "使用者的原始需求。" }
                },
                required: ["user_prompt"]
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

let isProcessBusy = false;

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

// --- Tool Handler 封裝 ---
class ToolRegistry {
    constructor() {
        this.handlers = new Map();
        this.hooks = new Map(); // 用於儲存鉤子函式
        this.priorities = {
            "bootstrap_request": 1,
            "list_sandbox_files": 4,  // 列出清單
            "read_file_content": 5,   // 分析特定檔案
            "update_framework": 10,  // 規範優先
            "plan": 20,              // 任務規劃
            "update_ui": 30,         // 實作最後
            "finish_task": 99        // 任務總結與結案
        };
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

    async execute(toolCalls, context = {}) {
        const sorted = [...toolCalls].sort((a, b) => {
            const pA = this.priorities[a.name] || 99;
            const pB = this.priorities[b.name] || 99;
            return pA - pB;
        });

        let chainStatus = { triggerNext: false, nextPrompt: "" };
        const results = [];
        for (const call of sorted) {
            const handler = this.handlers.get(call.name);
            if (handler) {
                // --- 執行 Before 鉤子 ---
                await this.runHooks(call.name, 'before', { toolName: call.name, args: call.args, context });

                const result = await handler(call.args, context);
                results.push({ name: call.name, ...result });

                // --- 原子化錄製：每執行完一個工具就專屬記錄一次，不串接巨大歷史 ---
                await recordGeminiResponse(
                    `【工具執行】：${call.name}`,
                    JSON.stringify({ args: call.args, result }, null, 2),
                    "TOOL_RESULT",
                    { tool: call.name, args: call.args }
                );

                // --- 執行 After 鉤子 ---
                await this.runHooks(call.name, 'after', { toolName: call.name, args: call.args, result, context });

                if (result.triggerNext) {
                    chainStatus.triggerNext = true;
                    chainStatus.nextPrompt = result.nextPrompt;
                }
            }
        }
        return { results, chainStatus };
    }
}

export const registry = new ToolRegistry();

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

// 註冊：任務總結工具 (切斷 chain)
registry.register("finish_task", async (args) => {
    return {
        success: true,
        triggerNext: false,
        summary: args.summary,
        feedback: args.feedback,
        next_steps: args.next_steps
    };
});

// 註冊：初始轉送 (No-Op UI)
registry.register("bootstrap_request", async (args) => {
    return {
        success: true,
        triggerNext: true,
        nextPrompt: args.user_prompt
    };
});

// 核心串流處理解析器 (支援連鎖請求與中斷)
export async function streamGeminiSDK(userPrompt, onChunk, onComplete, getIsAborted, isRecursive = false) {
    if (!isRecursive) {
        if (isProcessBusy) { onChunk({ chunk: '\n[系統提示]：伺服器忙碌中...\n' }); onComplete(); return; }
        isProcessBusy = true;

        // 初始處理：手動推入第一次工具呼叫 (bootstrap)，建立純淨的轉送上下文
        const seed = [{
            name: "bootstrap_request",
            args: { user_prompt: userPrompt }
        }];
        const { chainStatus } = await registry.execute(seed, { onChunk, currentPrompt: userPrompt });
        if (chainStatus.triggerNext) userPrompt = chainStatus.nextPrompt; // 更新初始 Prompt
    }

    let loopCount = 0;
    const MAX_LOOPS = 3;
    let currentPrompt = userPrompt;

    try {
        while (loopCount < MAX_LOOPS) {
            if (getIsAborted && getIsAborted()) {
                console.log("[Flow] 後端偵測到中斷，終止執行。");
                break;
            }
            loopCount++;
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
4. **任務總結 (Conclusion)**: 完成所有變動後，【必須】呼叫 \`finish_task\` 提供彙報並結束連鎖。

${getToolDescriptionPrompt()}


【開發規範文件 (Framework.md)】：
---
${frameworkDocs}
---`;

            console.log(`[Flow] 執行階段 (Loop ${loopCount}): ${currentPrompt.slice(0, 50)}...`);

            const result = await model.generateContentStream({
                contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${currentPrompt}` }] }]
            });

            // 移除不必要的陣列與文字緩衝，僅保留連鎖狀態
            let chainStatus = { triggerNext: false, nextPrompt: "" };

            for await (const chunk of result.stream) {
                if (getIsAborted && getIsAborted()) {
                    console.log("[Flow] 生成過程中偵測到中斷。");
                    break;
                }
                const cand = chunk.candidates?.[0];
                if (!cand?.content?.parts) continue;
                for (const part of cand.content.parts) {
                    if (part.functionCall) {
                        // --- 即時消費工具指令 ---
                        console.log(`[Flow] 即時執行動作: ${part.functionCall.name}`);
                        const { chainStatus: cs } = await registry.execute([{ name: part.functionCall.name, args: part.functionCall.args }], { onChunk, currentPrompt });
                        if (cs.triggerNext) { chainStatus = cs; }
                    } else if (part.text) {
                        // --- 即時消費對話片段 (不多重串接) ---
                        // 文字片段即刻存入 JSON 紀錄檔，不使用 fullOutput 收集
                        await registry.execute([{ name: "finish_task", args: { summary: part.text } }], { onChunk, currentPrompt });
                    }
                }
            }

            if (chainStatus.triggerNext && loopCount < MAX_LOOPS) {
                console.log(`[Flow] 自行連鎖觸發: ${chainStatus.nextPrompt}`);
                await streamGeminiSDK(chainStatus.nextPrompt, onChunk, onComplete, getIsAborted, true);
                return;
            } else { break; }
        }
    } finally {
        if (!isRecursive) {
            isProcessBusy = false;
            onComplete();
        }
    }
}
