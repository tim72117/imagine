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
 * AgenticEngine Proxy: 透過外部 Go CLI 執行推論
 */
export class AgenticEngine {
    constructor() {}

    async *GenerateStream(prompt: string, agentContext: any = {}) {
        const { getIsAborted, role, userMessages, workDir } = agentContext;

        const commandArgs = ["-json"];
        
        // 只傳遞當前 User 訊息作為 prompt
        const currentPrompt = prompt || (userMessages && userMessages[userMessages.length - 1]?.text) || "";
        if (currentPrompt) commandArgs.push("-prompt", currentPrompt);
        if (role) commandArgs.push("-role", role);

        // 如果有工作目錄則透過 context 帶入，但不帶歷史訊息
        if (workDir) {
            commandArgs.push("-context", JSON.stringify({ workDir }));
        }

        const engineProcess = spawn(CLI_PATH, commandArgs, { env: process.env });
        let streamBuffer = "";

        for await (const chunk of engineProcess.stdout) {
            if (getIsAborted?.()) {
                engineProcess.kill();
                break;
            }

            streamBuffer += chunk.toString();
            const streamLines = streamBuffer.split("\n");
            streamBuffer = streamLines.pop() || "";

            for (const line of streamLines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                try {
                    yield JSON.parse(trimmedLine) as AIEvent;
                } catch { /* 忽略非 JSON 輸出 */ }
            }
        }
    }
}
