import { describe, it, expect, vi } from 'vitest';
import { registry } from './ai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 模擬資料序列 ---
let mockResponses = [
    // 1. 第一次 ai_request: 輸出 plan
    [
        {
            functionCall: {
                name: "plan",
                args: {
                    analysis: "使用者僅提出「加入按鈕」需求，需釐清細節。",
                    updated_framework: "更新了手冊...",
                    next_steps_plan: ["1. 詢問需求", "2. 規劃", "3. 實作"]
                }
            }
        }
    ],
    // 2. 第二次 ai_request (由 plan 觸發): 輸出 update_framework
    [
        {
            functionCall: {
                name: "update_framework",
                args: {
                    next_step: "已根據規劃更新開發手冊。",
                    new_content: "手冊內容..."
                }
            }
        }
    ],
    // 3. 第三次 ai_request (由 update_framework 觸發): 輸出多段 send_message
    [
        { text: "好的，我已經更新了專案開發手冊 (Framework.md)，" },
        { text: "並在「待釐清需求」中明確列出了確認細節。\\n\\n1. 按鈕功能" },
        { text: "：觸發行為？\\n2. 位置？\\n3. 視覺？\\n\\n期待您的回覆，以便我能繼續進行開發。" }
    ]
];

let callCount = 0;

let capturedPrompts = []; // 用於收集 AI 接收到的 Prompts

vi.mock('@google/generative-ai', () => {
    const MockGoogleGenerativeAI = vi.fn(function () {
        return {
            getGenerativeModel: vi.fn().mockReturnValue({
                generateContentStream: vi.fn().mockImplementation(async (args) => {
                    // 收集傳入的 Prompt 內容
                    const p = args.contents[0].parts[0].text;
                    capturedPrompts.push(p);

                    const parts = mockResponses[callCount] || [];
                    callCount++;
                    return {
                        stream: (async function* () {
                            for (const part of parts) {
                                yield { candidates: [{ content: { parts: [part] } }] };
                            }
                        })()
                    };
                })
            })
        };
    });
    return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

describe('TaskManager 流程重現測試 (依據歷史 Log)', () => {
    // --- 測試案例 ---

    it('自動連鎖工作流綜合測試：偵查 -> 分析 -> 彙報 (Discovery -> Analysis -> Done)', async () => {
        // 模擬三階段推論連鎖
        mockResponses = [
            [   // 1. AI 決定先看目錄
                {
                    functionCall: {
                        name: "list_files",
                        args: { path: "./", explanation: "尋找主入口檔案", next_step: "我需要讀取 Target.tsx 以進行分析" }
                    }
                }
            ],
            [   // 2. AI 看到路徑後，決定讀取 Target.tsx 的內容
                {
                    functionCall: {
                        name: "read_file_content",
                        args: { path: "Target.tsx", explanation: "分析組件結構", next_step: "準備給予用戶總結" }
                    }
                }
            ],
            [   // 3. 讀完內容後的最終對話 (修正：模擬調用 send_message)
                { 
                    text: "分析完畢，這是一個純淨的 React 組件。",
                    functionCall: { 
                        name: "send_message", 
                        args: { text: "分析完畢，這是一個純淨的 React 組件。" } 
                    }
                }
            ]
        ];
        callCount = 0;
        capturedPrompts = [];

        const rootTask = registry.createTask("bootstrap_request", { user_prompt: "執行自動化代碼分析" });
        await registry.traverseAndExecute(rootTask, {
            workDir: path.join(__dirname, '../src/sandbox')
        });

        // --- 1. 斷言驗證：數據流 (Captured Prompts) ---
        expect(capturedPrompts[1]).toContain("【實時工具執行回傳】");
        expect(capturedPrompts[1]).toContain("Target.tsx");
        expect(capturedPrompts[2]).toContain("【實時工具執行回傳】");
        expect(capturedPrompts[2]).toContain("const App =");

        // --- 2. 斷言驗證：任務樹結構 (Task Hierarchy) ---
        // 新架構下：bootstrap 為父，ai_request 與 tools 為其扁平子任務
        expect(rootTask.status).toBe('completed');
        
        const aiSubTask1 = rootTask.tasks[0]; 
        expect(aiSubTask1.name).toBe('ai_request');
        
        const toolTask1 = rootTask.tasks[1]; // list_files (由 bootstrap 主導)
        expect(toolTask1.name).toBe('list_files');
        
        const aiSubTask2 = rootTask.tasks[2]; // 次世代推論 (由 bootstrap 輪詢)
        expect(aiSubTask2.name).toBe('ai_request');

        const toolTask2 = rootTask.tasks[3]; // read_file_content
        expect(toolTask2.name).toBe('read_file_content');

        const aiSubTask3 = rootTask.tasks[4]; // 最後一輪思考
        expect(aiSubTask3.name).toBe('ai_request');
        
        // 最終產出的 send_message 是由 bootstrap 執行的動作之一
        const lastTool = rootTask.tasks[rootTask.tasks.length - 1];
        expect(lastTool.name).toBe('send_message');

        // --- 3. 斷言驗證：最終訊息 ---
        const messages = [];
        rootTask.tasks.forEach(t => {
            if (t.name === 'send_message' && t.args?.text) {
                messages.push(t.args.text);
            }
        });
        expect(messages.join('')).toContain("分析完畢");

        console.log(`[Test] 自動連鎖工作流綜合測試 (數據流 + 結構) 完美通過！`);
    });
});
