import readline from 'readline';
import { AIEngine, activeProvider, setGlobalEngine } from './server/engine.js';
import { ROLES } from './server/tools.js';
import { Message } from './server/types.js';
import { TARGET_DIR } from './server/ai.js';
import { createTask } from './server/agent.js';

/**
 * 終端機互動式 AI 協調者 (REPL)
 */
async function startREPL() {
    const args = process.argv.slice(2);
    
    // 處理引擎切換參數
    if (args.includes('--ollama')) {
        setGlobalEngine('ollama', ROLES);
    } else if (args.includes('--gemini')) {
        setGlobalEngine('gemini', ROLES);
    }

    console.log(`\x1b[36m%s\x1b[0m`, `
    =========================================
    🚀 AI Builder - Terminal Orchestrator
    =========================================
    輸入指令來啟動任務，或輸入 'exit' 退出。
    `);

    const userMessages: Message[] = [];
    const assistantMessages: Message[] = [];

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> '
    });

    rl.prompt();

    // 處理 Ctrl+C
    rl.on('SIGINT', () => {
        console.log(`\n\x1b[33m[System] 收到中斷訊號，正在關閉 REPL...\x1b[0m`);
        rl.close();
        process.exit(0);
    });

    rl.on('line', async (line) => {
        const input = line.trim();
        if (input.toLowerCase() === 'exit') {
            console.log('再見！');
            rl.close();
            process.exit(0);
        }

        if (input) {
            console.log(`\x1b[90m[User] 提交指令: ${input}\x1b[0m`);
            
            const taskId = createTask({ role: 'Coordinator', agentId: 'MASTER' });
            const engine = new AIEngine(activeProvider);
            
            // 加入當前指令
            const currentMessage: Message = { role: 'user', text: input, time: Date.now() };
            userMessages.push(currentMessage);

            // 啟動 Go 引擎
            const iterator = engine.generateStream("", {
                taskId,
                role: 'coordinator',
                workDir: TARGET_DIR,
                userMessages,
                assistantMessages
            });

            let fullAssistantResponse = "";

            process.stdout.write('\n\x1b[36m[AI Thinking]...\x1b[0m\n');

            for await (const chunk of iterator) {
                if (chunk.type === 'chunk' && chunk.text) {
                    process.stdout.write(chunk.text);
                    fullAssistantResponse += chunk.text;
                } else if (chunk.type === 'action' && chunk.action) {
                    console.log(`\n\x1b[32m[Action] 呼叫工具: ${chunk.action.name}\x1b[0m`);
                } else if (chunk.type === 'tool_result') {
                    const toolName = chunk.action ? chunk.action.name : '未知工具';
                    console.log(`\n\x1b[33m[Result] 工具執行完成: ${toolName}\x1b[0m`);
                }
            }

            // 保存本輪助手的回應至歷史
            assistantMessages.push({
                role: 'assistant',
                text: fullAssistantResponse,
                time: Date.now()
            });

            console.log('\n\n\x1b[32m[System] 階段性任務處理完成。\x1b[0m');
            rl.prompt();
        } else {
            rl.prompt();
        }
    });

    rl.on('close', () => {
        console.log('\n再見！');
        process.exit(0);
    });
}

startREPL().catch(err => {
    console.error('REPL 啟動失敗:', err);
});
