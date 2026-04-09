import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import { AgentConfig } from './types.js';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

// --- 介面定義 (Interfaces) ---

export interface AIChunk {
    type: 'chunk';
    text: string;
}

export interface AIAction {
    type: 'action';
    action: {
        name: string;
        args: any;
    };
}

export type AIEvent = AIChunk | AIAction;

export interface AIProvider {
    generateStream(inputPrompt: string, context: any): AsyncGenerator<AIEvent>;
}

// --- 請求隊列管理 (Queue Management) ---

class AIRequestQueue {
    private maxConcurrent: number;
    private minIntervalMs: number;
    private currentCount: number;
    private queue: { requestTask: () => Promise<any>, resolve: (val: any) => void, reject: (err: any) => void }[];
    private lastCallTime: number;

    constructor(maxConcurrent = 2, minIntervalMs = 1000) {
        this.maxConcurrent = maxConcurrent;
        this.minIntervalMs = minIntervalMs;
        this.currentCount = 0;
        this.queue = [];
        this.lastCallTime = 0;
    }

    async enqueue(requestTask: () => Promise<any>): Promise<any> {
        return new Promise((resolve, reject) => {
            this.queue.push({ requestTask, resolve, reject });
            this.process();
        });
    }

    async process() {
        if (this.currentCount >= this.maxConcurrent || this.queue.length === 0) return;

        const now = Date.now();
        const timeSinceLast = now - this.lastCallTime;
        if (timeSinceLast < this.minIntervalMs) {
            setTimeout(() => this.process(), this.minIntervalMs - timeSinceLast);
            return;
        }

        const item = this.queue.shift();
        if (!item) return;
        const { requestTask, resolve, reject } = item;
        this.currentCount++;
        this.lastCallTime = now;

        try {
            const result = await requestTask();
            resolve(result);
        } catch (err) {
            this.currentCount--; // 發生錯誤時釋放配額
            reject(err);
            this.process();
        }
    }

    release() {
        this.currentCount--;
        this.process();
    }
}

export const aiQueue = new AIRequestQueue(2, 500);

// --- Google Gemini Provider ---

export class GeminiProvider implements AIProvider {
    private model: any;
    constructor(modelInstance: any) {
        this.model = modelInstance;
    }

    async *generateStream(inputPrompt: string, context: any): AsyncGenerator<AIEvent> {
        const streamResponse = await aiQueue.enqueue(async () => {
            return await this.model.generateContentStream({
                contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
            });
        });

        try {
            for await (const chunk of streamResponse.stream) {
                if (context.getIsAborted?.()) break;
                const candidate = chunk.candidates?.[0];
                if (!candidate?.content?.parts) continue;

                for (const part of candidate.content.parts) {
                    if (part.text) {
                        yield { type: 'chunk', text: part.text };
                    }
                    if (part.functionCall) {
                        yield { type: 'action', action: { name: part.functionCall.name, args: part.functionCall.args } };
                    }
                }
            }
        } finally {
            aiQueue.release();
        }
    }
}

// --- Ollama Provider ---

export class OllamaProvider implements AIProvider {
    private baseURL: string;
    private modelName: string;

    constructor(config: { baseURL: string, model: string }) {
        this.baseURL = config.baseURL;
        this.modelName = config.model;
    }

    async *generateStream(inputPrompt: string, context: any): AsyncGenerator<AIEvent> {
        // 將通用的工具定義轉換為 Ollama (OpenAI) 格式
        const ollamaTools = context.tools?.[0]?.functionDeclarations?.map((decl: any) => ({
            type: 'function',
            function: {
                name: decl.name,
                description: decl.description,
                parameters: decl.parameters
            }
        }));

        const responseData = await aiQueue.enqueue(async () => {
            try {
                console.log(`[Ollama] 🛠️  準備發送工具定義:`);
                console.log(JSON.stringify(ollamaTools, null, 2));
                console.log(`[Ollama] 📡 正在對 ${this.baseURL} 發起請求 (模型: ${this.modelName})...`);
                const res = await axios.post(`${this.baseURL}/api/chat`, {
                    model: this.modelName,
                    messages: [{ role: 'user', content: inputPrompt }],
                    stream: true,
                    think: false,
                    tools: ollamaTools
                }, {
                    responseType: 'stream',
                    timeout: 300000 // 增加至 5 分鐘，給予大型模型（如 26B）充足的預處理時間
                });
                console.log(`[Ollama] ✅ 已建立串流連線 (Status: ${res.status})`);
                return res.data;
            } catch (err: any) {
                console.error(`[Ollama] ❌ 請求失敗: ${err.message}`);
                if (err.response) {
                    console.error(`[Ollama] 錯誤詳情:`, err.response.data);
                }
                throw err;
            }
        });

        let buffer = '';
        try {
            for await (const chunk of responseData) {
                if (context.getIsAborted?.()) break;

                buffer += chunk.toString();
                const lines = buffer.split('\n');

                // 最後一行可能不完整，保留到下一次處理
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);

                        // 處理思考內容 (Thinking)
                        if (json.message?.thinking) {
                            yield { type: 'chunk', text: `\x1b[2m${json.message.thinking}\x1b[0m` };
                        }

                        // 處理正式文字內容
                        if (json.message?.content) {
                            yield { type: 'chunk', text: json.message.content };
                        }

                        // 處理工具調用
                        if (json.message?.tool_calls) {
                            for (const tc of json.message.tool_calls) {
                                yield {
                                    type: 'action',
                                    action: {
                                        name: tc.function.name,
                                        args: tc.function.arguments
                                    }
                                };
                            }
                        }
                    } catch (e) {
                        // 解析失敗則跳過
                    }
                }
            }
        } finally {
            aiQueue.release();
        }
    }
}

// --- Providers 實例化與管理 ---

export const geminiProviders = {
    coordinator: new GeminiProvider(genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" })),
    explorer: new GeminiProvider(genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" })),
    editor: new GeminiProvider(genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" }))
};

export const ollamaProviders = {
    coordinator: new OllamaProvider({ baseURL: 'https://ollama.e-gps.tw', model: 'gemma4:e4b' }),
    explorer: new OllamaProvider({ baseURL: 'https://ollama.e-gps.tw', model: 'gemma4:e4b' }),
    editor: new OllamaProvider({ baseURL: 'https://ollama.e-gps.tw', model: 'gemma4:e4b' })
};

/**
 * 全域切換引擎
 */
export function setGlobalEngine(type: 'gemini' | 'ollama', ROLES: Record<string, AgentConfig>) {
    const target = type === 'ollama' ? ollamaProviders : geminiProviders;
    console.log(`[System] 🔄 全域引擎已切換至: ${type.toUpperCase()}`);
    ROLES.coordinator.model = target.coordinator;
    ROLES.explorer.model = target.explorer;
    ROLES.editor.model = target.editor;
}

// --- AIEngine (入口) ---

export class AIEngine {
    private provider: AIProvider;

    constructor(provider: AIProvider) {
        this.provider = provider;
    }

    async *generateStream(inputPrompt: string, context: any = {}) {
        yield* this.provider.generateStream(inputPrompt, context);
    }
}
