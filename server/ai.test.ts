import { describe, it, expect, vi } from 'vitest';
import { Coordinator } from './ai.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 模擬狀態規約 ---
let mockResponses: any[] = [];
let callCount = 0;
let capturedPrompts: string[] = []; // 用於收集 AI 接收到的 Prompts

vi.mock('@google/generative-ai', () => {
    const MockGoogleGenerativeAI = vi.fn(function () {
        return {
            getGenerativeModel: vi.fn().mockReturnValue({
                generateContentStream: vi.fn().mockImplementation(async (args: any) => {
                    const p = args.contents[0].parts[0].text;
                    capturedPrompts.push(p);

                    console.log(`[MockAI] 推論啟動...`);
                    const parts = mockResponses[callCount] || [];
                    callCount++;
                    return {
                        stream: (async function* () {
                            for (const part of parts) {
                                await new Promise(resolve => setTimeout(resolve, 1000));
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

describe('平坦化執行流程綜合測試', () => {
    it('自動連鎖工作流：偵查 -> 分析 -> 彙報 (Discovery -> Analysis -> Done)', async () => {
        mockResponses = [
            [ 
                { text: "你好！我正在準備分析你的專案。" }, 
                { functionCall: { name: "list_files", args: { path: "./", explanation: "理解架構", next_step: "分析內容" } } } 
            ], 
            [ { text: "看到檔案了，分析完畢。" } ]
        ];
        callCount = 0;
        capturedPrompts = [];

        const coordinator = new Coordinator();
        const itStream = coordinator.coordinate("分析專案", {
            workDir: path.join(__dirname, '../src/sandbox')
        });

        // 消耗產生器
        let yieldCount = 0;
        let isDone = false;
        
        const consume = async () => {
            while (!isDone) {
                const result = await Promise.race([
                    itStream.next(),
                    new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 10000))
                ]);

                if ((result as any).timeout || (result as any).done) {
                    isDone = true;
                    break;
                }

                const value = (result as any).value;
                if (value) {
                    console.log(`[Test:Yield]`, JSON.stringify(value));
                    yieldCount++;
                    if (value.role === 'assistant' && callCount >= mockResponses.length) {
                        isDone = true;
                    }
                }
            }
        };

        await consume();

        // 1. 斷言數據流與 Prompt
        // 檢查是否包含系統提示詞或任務目標
        expect(capturedPrompts[0]).toContain("分析專案");
        expect(yieldCount).toBeGreaterThan(0);
        
        console.log(`[Test] 混合工具調用流程測試通過！`);
    }, 45000);
});
