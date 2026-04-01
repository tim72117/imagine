import { describe, it, expect, vi } from 'vitest';
import { registry } from './ai';

// --- 模擬資料序列 (依據 log_2026-03-31_02.json) ---
const mockResponses = [
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

vi.mock('@google/generative-ai', () => {
    const MockGoogleGenerativeAI = vi.fn(function() {
        return {
            getGenerativeModel: vi.fn().mockReturnValue({
                generateContentStream: vi.fn().mockImplementation(async () => {
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
    it('應該能依序執行: bootstrap -> ai_request(plan) -> ai_request(update_framework) -> ai_request(send_message)', async () => {
        callCount = 0; // 重置計數器
        const capturedMessages = [];

        // --- 模擬 server.js 的 Hook 廣播行為 ---
        let isNewCallCount = 0;
        registry.on('send_message', 'after', async ({ args, context }) => {
            // 複製 server.js 的核心邏輯進行驗證
            if (!context.isAlreadySpoken) {
                isNewCallCount++; // 統計新泡泡開啟次數
                context.isAlreadySpoken = true;
                console.log(`[Mock Broadcast] 🟢 開啟新泡泡 (isNew: true)`);
            }
            console.log(`[Mock Broadcast] 串接訊息: ${args.text}`);
            capturedMessages.push(args.text);
        });

        const rootTask = registry.createTask("bootstrap_request", { user_prompt: "加入按鈕" });
        const context = { loopCount: 0 };

        // 執行整個演進過程
        await registry.executeTask(null, rootTask, context);

        // 驗證流程演進
        // 1. 檢查根任務是否完成了
        expect(rootTask.status).toBe('completed');

        // 2. 檢查 ai_request 鏈條深度 (這會產生連鎖)
        const allAiRequests = [];
        const collectAiRequests = (t) => {
            if (t.name === 'ai_request') allAiRequests.push(t);
            t.tasks.forEach(collectAiRequests);
        };
        collectAiRequests(rootTask);
        
        // 期望深度分析：
        // 1. bootstrap 衍生 1 個 -> ai_request (1)
        // 2. ai_request (1) 衍生 1 個 -> plan (1)
        // 3. plan (1) 根據 [3 步] 衍生 3 個 -> ai_request (2, 3, 4)
        // 4. ai_request (2) 執行 update_framework 後衍生 1 個 -> ai_request (5)
        // 總計應有 5 個 ai_request
        expect(allAiRequests.length).toBe(5);

        // 3. 驗證最後產出的訊息內容 (由其中一個 ai_request 觸發)
        const messages = [];
        const collectMessages = (t) => {
            if (t.name === 'send_message') messages.push(t);
            t.tasks.forEach(collectMessages);
        };
        collectMessages(rootTask);
        
        expect(messages.length).toBeGreaterThan(0);
        expect(isNewCallCount).toBe(1);
        
        console.log(`[Test] 成功重現放射狀對話鏈，共執行 ${allAiRequests.length} 次推論，總計發送 isNew: true ${isNewCallCount} 次。`);
    });
});
