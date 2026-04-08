import { Signaler, createAgentContext, Agent, appStore, createTask } from './agent.js';
import { toolbox, ROLES } from './tools.js';

// --- 集中定義工作空間與日誌目錄 ---
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');
export const HISTORY_DIR = path.join(__dirname, 'history');

// --- 系統狀態追蹤 (平直化) ---

export const onLogEvent = (callback) => { appStore.on('update', callback); };
export const onStateUpdate = (callback) => { appStore.on('state_update', callback); };

// --- 主要入口 (EntryPoint) ---
export class Coordinator {
    constructor() {
        this.toolbox = toolbox;
    }

    async *coordinate(userPrompt, executionContext = {}) {
        const context = {
            ...executionContext,
            signaler: executionContext.signaler || new Signaler(),
            agentId: executionContext.masterAgentId
        };

        const taskId = createTask({
            role: 'Coordinator',
            agentId: context.agentId
        });

        const promptMessage = {
            role: 'user',
            text: userPrompt,
            time: Date.now()
        };

        // 建立 Master Context
        const masterContext = createAgentContext({
            taskId,
            agentId: context.agentId,
            workDir: context.workDir,
            signaler: context.signaler,
            messages: [promptMessage]
        });

        // 啟動時同步狀態到 Store (改用 updateTaskState)
        masterContext.updateTaskState({ status: 'active', progress: 0 });

        const master = new Agent(ROLES.coordinator, this.toolbox);
        
        const it = master.run(masterContext);
        let result;
        while (true) {
            const { value, done } = await it.next();
            if (done) {
                result = value;
                break;
            }
            yield value;
        }

        const currentTask = masterContext.getCurrentTask();
        if (result.status === "complete" && currentTask && !currentTask.messages.some(m => m.data?.name === 'spawn_workers')) {
            console.log(`  [Master] ℹ️ 偵測到未自動分派，啟動手動補償 Explorer...`);
            const explorer = new Agent(ROLES.explorer, this.toolbox);
            const expIt = explorer.run(masterContext); 
            while (true) {
                const { value, done } = await expIt.next();
                if (done) break;
                yield value;
            }
        }

        return { success: true, taskId };
    }
}
