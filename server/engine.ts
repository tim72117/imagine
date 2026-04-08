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
        const { requestTask, resolve } = item;
        this.currentCount++;
        this.lastCallTime = now;

        try {
            const result = await requestTask();
            resolve(result);
        } catch (err) {
            this.release();
            throw err;
        }
    }

    release() {
        this.currentCount--;
        this.process();
    }
}

export const aiQueue = new AIRequestQueue(2, 1000);

export class AIEngine {
    private model: any;
    constructor(inferenceModel: any) { this.model = inferenceModel; }
    
    async *generateStream(inputPrompt: string, context: any = {}) {
        const { getIsAborted } = context;

        const streamResponse = await aiQueue.enqueue(async () => {
            return await this.model.generateContentStream({
                contents: [{ role: "user", parts: [{ text: inputPrompt }] }]
            });
        });

        try {
            let accumulatedText = "";

            for await (const chunk of streamResponse.stream) {
                if (getIsAborted?.()) break;
                const candidate = chunk.candidates?.[0];
                if (!candidate?.content?.parts) continue;

                for (const part of candidate.content.parts) {
                    if (part.text) {
                        accumulatedText += part.text;
                        yield { type: 'chunk', text: part.text };
                    }
                    if (part.functionCall) {
                        const action = { name: part.functionCall.name, args: part.functionCall.args };
                        yield { type: 'action', action };
                    }
                }
            }

            yield { type: 'final', text: accumulatedText };

        } finally {
            aiQueue.release();
        }
    }
}
