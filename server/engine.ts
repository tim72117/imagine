import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, 'engine-go/engine-cli');

// --- Types ---

export interface AIEvent {
    type: 'chunk' | 'action' | 'tool_result';
    text?: string;
    action?: {
        name: string;
        args: any;
    };
    tool?: string;
}

export interface AIProvider {
    id: 'gemini' | 'ollama';
}

// --- Provider Instances ---

const sharedGemini: AIProvider = { id: 'gemini' };
const sharedOllama: AIProvider = { id: 'ollama' };

export const geminiProviders = {
    coordinator: sharedGemini,
    explorer: sharedGemini,
    editor: sharedGemini
};

export const ollamaProviders = {
    coordinator: sharedOllama,
    explorer: sharedOllama,
    editor: sharedOllama
};

// 全域當前使用的 Provider 指標
export let activeProvider: AIProvider = geminiProviders.coordinator;

/**
 * 全域引擎切換工具
 */
export function setGlobalEngine(type: 'gemini' | 'ollama') {
    activeProvider = type === 'ollama' ? ollamaProviders.coordinator : geminiProviders.coordinator;
    console.log(`[System] 🔄 Global Engine switched to: ${type.toUpperCase()}`);
}

// --- AIEngine Proxy ---

export class AIEngine {
    private providerId: string;

    constructor(provider: AIProvider) {
        this.providerId = provider.id;
    }

    async *generateStream(instructionPrompt: string, contextObj: any = {}) {
        const { getIsAborted, model, role, toolsPath, ...remainingContext } = contextObj;

        const commandArguments = [
            "-json",
            "-provider", this.providerId,
            "-model", model?.model || (this.providerId === "ollama" ? "gemma4:e4b" : "gemini-2.5-flash-lite"),
        ];

        // 如果傳入了完整的歷史訊息，則優先使用 -context 模式將 JSON 傳遞給 Go
        if (remainingContext.userMessages || remainingContext.assistantMessages) {
            commandArguments.push("-context", JSON.stringify({
                systemPrompt: remainingContext.systemPrompt,
                toolPrompt: remainingContext.toolPrompt,
                workDir: remainingContext.workDir,
                userMessages: remainingContext.userMessages || [],
                assistantMessages: remainingContext.assistantMessages || []
            }));
        } else {
            commandArguments.push("-prompt", instructionPrompt);
        }

        if (role) {
            commandArguments.push("-role", role);
        }

        const childProcess = spawn(CLI_PATH, commandArguments, { env: process.env });
        let outputBuffer = "";

        for await (const chunk of childProcess.stdout) {
            if (getIsAborted && getIsAborted()) {
                childProcess.kill();
                break;
            }

            outputBuffer += chunk.toString();
            const lines = outputBuffer.split("\n");
            outputBuffer = lines.pop() || "";

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine === "") {
                    continue;
                }
                try {
                    yield JSON.parse(trimmedLine) as AIEvent;
                } catch (errorVal) {
                    // 忽略非 JSON 輸出（如偵錯日誌）
                }
            }
        }
    }
}
