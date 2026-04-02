import { describe, it, expect, vi } from 'vitest';
import { toolbox, Coordinator } from './ai';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- 模擬狀態規約 ---
let mockResponses = [];
let callCount = 0;
let capturedPrompts = []; // 用於收集 AI 接收到的 Prompts

vi.mock('@google/generative-ai', () => {
    const MockGoogleGenerativeAI = vi.fn(function () {
        return {
            getGenerativeModel: vi.fn().mockReturnValue({
                generateContentStream: vi.fn().mockImplementation(async (args) => {
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

describe('平坦化執行流程綜合測試', () => {
    it('自動連鎖工作流：偵查 -> 分析 -> 彙報 (Discovery -> Analysis -> Done)', async () => {
        mockResponses = [
            [ { text: "分析專案結構。" } ], // 1. Coordinator 解析目標
            [ { functionCall: { name: "list_files", args: { path: "./", explanation: "找檔案", next_step: "分析" } } } ], // 2. AI 偵查
            [ { functionCall: { name: "read_file_content", args: { path: "Target.tsx", explanation: "讀檔", next_step: "彙報" } } } ], // 3. AI 讀取
            [ { text: "分析完畢。", functionCall: { name: "send_message", args: { text: "分析完畢。" } } } ] // 4. AI 彙報
        ];
        callCount = 0;
        capturedPrompts = [];

        const coordinator = new Coordinator();
        const { sessionId } = await coordinator.coordinate("執行代碼分析", {
            workDir: path.join(__dirname, '../src/sandbox')
        });

        // 1. 斷言數據流
        expect(capturedPrompts[0]).toContain("你是一個強大的【任務協調者");
        expect(capturedPrompts[1]).toContain("你是一個具備「思考與執行合一」能力的高級前端工程師 Worker");
        
        // 2. 斷言 Session
        expect(sessionId).toBeDefined();
        expect(sessionId).toContain("SESSION-");

        // 3. 驗證最終結果 (最後一輪輸入應包含前一輪的工具執行結果)
        const lastPrompt = capturedPrompts[capturedPrompts.length - 1];
        expect(lastPrompt).toContain("Target.tsx");
        
        console.log(`[Test] 平坦化流程測試通過！`);
    });
});
