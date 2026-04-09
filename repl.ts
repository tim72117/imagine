import readline from 'readline';
import { Coordinator } from './server/ai.js';
import { setGlobalEngine } from './server/engine.js';
import { ROLES, toolbox } from './server/tools.js';

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

    const coordinator = new Coordinator();

    // 監聽輸出事件
    coordinator.on('data', (chunk) => {
        if (chunk.type === 'chunk' && chunk.text) {
            process.stdout.write(chunk.text);
        } else if (chunk.role === 'tool') {
            const toolLabel = chunk.data?.deferred ? '⏳ 非同步工具' : '🔧 同步工具';
            console.log(`\n\x1b[33m[${toolLabel}] ${chunk.tool}: ${chunk.text}\x1b[0m`);
        } else if (chunk.type === 'action') {
            console.log(`\n\x1b[32m[Action] 呼叫工具: ${chunk.action.name}\x1b[0m`);
        }
    });

    coordinator.on('completed', () => {
        process.stdout.write('\n\n\x1b[32m[System] 階段性任務處理完成。\x1b[0m\n> ');
    });

    // 啟動監聽器
    coordinator.start();

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

    rl.on('line', (line) => {
        const input = line.trim();
        if (input.toLowerCase() === 'exit') {
            console.log('再見！');
            rl.close();
            process.exit(0);
        }

        if (input) {
            console.log(`\x1b[90m[User] 提交指令: ${input}\x1b[0m`);
            coordinator.submit(input);
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
