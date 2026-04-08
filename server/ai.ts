import { createAgentContext, appStore, createTask, Agent, commandQueue, queueChanged } from './agent.js';
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
export class Coordinator {
    toolbox: any;
    constructor() {
        this.toolbox = toolbox;
    }

    async *coordinate(userPrompt: string, executionContext: any = {}) {
        // 維護持久化的訊息歷史，初始由隊列驅動
        const messages: any[] = [];

        if (userPrompt) {
            commandQueue.push({ role: 'user', text: userPrompt, time: Date.now() });
            queueChanged.emit('changed');
        }

        const runAgentInstance = async function* (history: any[]) {
            const taskId = createTask({ role: 'Coordinator', agentId: executionContext.masterAgentId });
            const ctx = createAgentContext({
                ...executionContext,
                taskId,
                workDir: executionContext.workDir,
                messages: history
            });

            if (executionContext._internal_context_ref) {
                Object.assign(executionContext._internal_context_ref, ctx);
            }

            const master = new Agent(ROLES.coordinator, toolbox);
            const it = master.run(ctx);
            while (true) {
                const { value, done } = await it.next();
                if (done) break;
                yield value;
            }
        };

        // --- 事件驅動調度循環 ---
        while (true) {
            // 1. 提取全域隊列
            const queue = commandQueue.splice(0);
            
            // 2. 若目前沒事做，則「等待異動事件」再啟動推理
            if (queue.length === 0) {
                console.log(`[Coordinator] 🛰️ 等待全域異動事件...`);
                await new Promise(resolve => queueChanged.once('changed', resolve));
                continue; 
            }
            
            // 3. 併入指令並啟動 Agent 實例
            console.log(`[Coordinator] ⚡️ 偵測到異動，啟動推理實例 (處理 ${queue.length} 項指令)`);
            messages.push(...queue);
            yield* runAgentInstance(messages);
        }
    }
}
