import { appStore, createTask } from './agent.js';
import { AIEngine, activeProvider } from './engine.js';
import { commandQueue, queueChanged } from './bus.js';
import { AgentContext } from './context.js';
import { toolbox, ROLES } from './tools.js';

// --- 集中定義工作空間與日誌目錄 ---
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');

// --- 系統狀態追蹤 (平直化) ---

export const onLogEvent = (callback: (data: any) => void) => { appStore.on('update', callback); };
export const onStateUpdate = (callback: (data: any) => void) => { appStore.on('state_update', callback); };

// --- 主要入口 (EntryPoint) ---
import { EventEmitter } from 'events';

export class Coordinator extends EventEmitter {
    private toolbox: any;
    private messages: any[] = [];
    private isRunning: boolean = false;

    constructor() {
        super();
        this.toolbox = toolbox;
    }

    /**
     * 啟動背景監聽器，永不停止。
     */
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log(`[Coordinator] 🛰️ 背景監聽器已啟動...`);

        // 監聽異動訊號
        queueChanged.on('changed', async () => {
            if (this.messages.length === 0) this.messages = [[], []];

            const queue = commandQueue.splice(0);
            if (queue.length === 0) return;



            console.log(`[Coordinator] ⚡️ 偵測到異動，啟動並行推理 (處理 ${queue.length} 項指令)`);
            this.messages[0].push(...queue);

            // 由於是事件驅動，我們直接在此執行 Agent 邏輯並透過事件送出結果
            await this.processNextBatch();
        });
    }

    private async processNextBatch() {
        // 初始化二維訊息歷史：[userSide, assistantSide]
        if (this.messages.length === 0) {
            this.messages = [[], []];
        }

        const taskId = createTask({ role: 'Coordinator', agentId: 'MASTER' });
        const engine = new AIEngine(activeProvider);

        // 直接調用 Go 引擎，由 Go 的 Agent.Run 處理所有的推論循環與工具執行
        const iterator = engine.generateStream("", {
            taskId,
            role: 'explorer',
            workDir: TARGET_DIR,
            userMessages: this.messages[0],
            assistantMessages: this.messages[1]
        });

        // 消耗產生器並透過事件發布
        for await (const chunk of iterator) {
            this.emit('data', chunk);
        }

        this.emit('completed');
    }

    // 相容性方法：發送新指令到隊列觸發執行
    submit(userPrompt: string) {
        if (!this.isRunning) this.start();
        commandQueue.push({ role: 'user', text: userPrompt, time: Date.now() });
        queueChanged.emit('changed');
    }
}
