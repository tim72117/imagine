import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const CLI_PATH = path.join(__dirname, 'engine-go/engine-cli');

export interface AIEvent {
    type: 'chunk' | 'action' | 'tool_result';
    text?: string;
    action?: {
        name: string;
        args: any;
    };
    tool?: string;
}

/**
 * AIEngine Proxy: 透過外部 Go CLI 執行推論
 */
export class AIEngine {
    constructor() {}

    async *generateStream(instructionPrompt: string, contextObj: any = {}) {
        const { getIsAborted, role, userMessages, workDir } = contextObj;

        const args = ["-json"];
        
        // 只傳遞當前 User 訊息作為 prompt
        const currentPrompt = instructionPrompt || (userMessages && userMessages[userMessages.length - 1]?.text) || "";
        if (currentPrompt) args.push("-prompt", currentPrompt);
        if (role) args.push("-role", role);

        // 如果有工作目錄則透過 context 帶入，但不帶歷史訊息
        if (workDir) {
            args.push("-context", JSON.stringify({ workDir }));
        }

        const child = spawn(CLI_PATH, args, { env: process.env });
        let buffer = "";

        for await (const chunk of child.stdout) {
            if (getIsAborted?.()) {
                child.kill();
                break;
            }

            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    yield JSON.parse(trimmed) as AIEvent;
                } catch { /* 忽略非 JSON 輸出 */ }
            }
        }
    }
}
