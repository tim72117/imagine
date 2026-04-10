import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocket, WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import {
  toolbox
} from './tools.js';
import { appStore, createTask } from './agent.js';
import { AIEngine, activeProvider } from './engine.js';
import { onStateUpdate } from './ai.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- 集中定義工作空間 (由 server.js 主導) ---
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');

// --- WebSocket 全域追蹤與發送工具 ---
const activeClients = new Set<WebSocket>();

// --- 集中日誌紀錄與持久化 (Log Persistence) ---
const HISTORY_DIR = path.join(__dirname, 'history');
fs.ensureDirSync(HISTORY_DIR);

const logQueue: any[] = [];
let isProcessingQueue = false;

async function processLogQueue() {
  if (isProcessingQueue || logQueue.length === 0) return;
  isProcessingQueue = true;
  try {
    while (logQueue.length > 0) {
      const logItem = logQueue.shift();
      const now = new Date();
      try {
        const fileName = `log_${now.toISOString().split('T')[0]}.json`;
        const historyPath = path.join(HISTORY_DIR, fileName);
        let logs = (await fs.pathExists(historyPath)) ? (await fs.readJson(historyPath)) : [];
        logs.push({ ...logItem, timestamp: now.toLocaleString() });
        await fs.writeJson(historyPath, logs, { spaces: 2 });
      } catch (err) { console.error('[Server:LogItemError]', err); }
    }
  } catch (err) {
    console.error('[Server:QueueCriticalError]', err);
  } finally {
    isProcessingQueue = false;
    if (logQueue.length > 0) processLogQueue();
  }
}

const broadcast = (data: any) => {
  const message = JSON.stringify(data);
  activeClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(message);
  });
};

onStateUpdate(({ key, value }: any) => {
    broadcast({
        type: 'workflow_state',
        key,
        value
    });
    // 同時也持久化到日誌 (可選)
    logQueue.push({ type: 'state_update', key, value });
    processLogQueue();
});

// --- 註冊 工具鉤子 (Hooks) ---

toolbox.on('update_file', 'before', async ({ args }: any) => {
  broadcast({ statusMessage: `📝 正在更新檔案: ${args.path}...` });

  if (args.code) {
    const fileName = path.basename(args.path || '');
    if (fileName === 'Target.tsx') {
      broadcast({ type: 'rendering', isLoading: true });
      broadcast({ statusMessage: `🎨 正在渲染新的 UI 畫面...` });
      console.log(`[Test] 偵測到 Target.tsx 變更，進入 3 秒測試延遲...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
});

toolbox.on('list_files', 'before', async ({ args }: any) => {
  broadcast({ statusMessage: `🔍 正在偵查目錄: ${args.path}...` });
});

toolbox.on('read_file_content', 'before', async ({ args }: any) => {
  broadcast({ statusMessage: `📖 正在分析檔案內容: ${args.path}...` });
});

toolbox.on('plan', 'before', async ({ args }: any) => {
  broadcast({ statusMessage: `📋 正在進行多階段開發規劃...` });
});

toolbox.on('list_files', 'after', async ({ args }: any) => {
  broadcast({ statusMessage: `✅ 目錄掃描完成: ${args.path}` });
});

toolbox.on('read_file_content', 'after', async ({ args }: any) => {
  broadcast({ statusMessage: `✅ 分析檔案成功: ${args.path}` });
});

toolbox.on('plan', 'after', async ({ args }: any) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `🎯 **任務規劃已更新**\n⏭️ **執行計畫：** ${args.next_steps_plan}` });
});

toolbox.on('update_file', 'after', async ({ args }: any) => {
  broadcast({ statusMessage: `✅ 檔案更新完成: ${args.path}` });

  if (args.path && args.path.includes('Target.tsx')) {
    broadcast({ type: 'rendering', isLoading: false });
    broadcast({ type: 'refresh' });
    broadcast({ statusMessage: `✨ UI 渲染完成` });
  }
});


toolbox.on('send_message', 'after', async ({ args, context }: any) => {
  if (!context.isAlreadySpoken) {
    broadcast({ isNew: true });
    context.isAlreadySpoken = true;
  }
  broadcast({ chunk: args.text });
});

toolbox.on('ask_user', 'after', async ({ args }: any) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `❓ **AI 正在詢問：**\n\n${args.question}` });
});

app.use(cors({ origin: '*' }));
app.use(express.json());


app.get('/api/get-ui-code', async (req: Request, res: Response) => {
  const target = (req.query.path as string) || 'Target.tsx';
  const filePath = path.join(TARGET_DIR, target);
  if (!(await fs.pathExists(filePath))) return res.status(404).json({ success: false });
  const code = await fs.readFile(filePath, 'utf8');
  res.json({ success: true, code });
});

const PORT = 3002;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Builder Server running on port ${PORT} (WS Enabled)`);
});


const wss = new WebSocketServer({ server });

wss.on('connection', (ws: WebSocket) => {
  activeClients.add(ws);
  const masterAgentId = `AGENT-MASTER-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
  console.log(`[WS] 連結建立 (Master ID: ${masterAgentId})`);
  let isAborted = false;

  ws.on('message', async (rawMessage) => {
    console.log(`[WS:In] 接收數據: ${rawMessage.toString().substring(0, 100)}...`);
    try {
      const data = JSON.parse(rawMessage.toString());
      const { prompt } = data;
      
      console.log(`[WS:Go] 🚀 直接啟動 Go 引擎處理指令: ${prompt}`);
      ws.send(JSON.stringify({ isNew: true, chunk: `【指令已接收】：${prompt}` }));

      const engine = new AIEngine(activeProvider);
      const stream = engine.generateStream("", {
          userMessages: [{ role: 'user', text: prompt, time: Date.now() }]
      });

      for await (const chunk of stream) {
          if (chunk.type === 'chunk' && chunk.text) {
              ws.send(JSON.stringify({ chunk: chunk.text }));
          } else if (chunk.type === 'action' && chunk.action) {
              ws.send(JSON.stringify({ type: 'action', action: chunk.action }));
          } else if (chunk.type === 'tool_result') {
              ws.send(JSON.stringify({ isNew: true, chunk: `\n✅ **工具執行完成**：${chunk.action?.name || '未知工具'}` }));
          }
      }
      ws.send(JSON.stringify({ isNew: true, chunk: '\n\n✨ **任務執行完成。**' }));

    } catch (err) { console.error('[WS Error]', err); }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    isAborted = true;
    console.log(`[WS] 客戶端斷開 (剩餘連線: ${activeClients.size})`);
  });
});
