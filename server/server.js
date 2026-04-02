import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import {
  toolbox,
  TARGET_FILE,
  coordinatorModel,
  agentModel,
  Coordinator
} from './ai.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- WebSocket 全域追蹤與發送工具 ---
const activeClients = new Set();

const broadcast = (data) => {
  const message = JSON.stringify(data);
  activeClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(message);
  });
};

// --- 註冊 工具鉤子 (Hooks) ---
// 註解：現在我們直接使用 broadcast，不再依賴 context.onChunk

toolbox.on('update_file', 'before', async ({ args }) => {
  if (args.code) {
    broadcast({ type: 'rendering', isLoading: true });

    console.log(`[Test] 偵測到代碼變更，進入 3 秒測試延遲...`);
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`[Hook:before] 正在寫入檔案代碼至 ${TARGET_FILE}...`);
    await fs.writeFile(TARGET_FILE, args.code, 'utf8');
  }
});

toolbox.on('list_files', 'before', async ({ args }) => {
  broadcast({ statusMessage: `🔍 正在偵查目錄: ${args.path}...` });
});

toolbox.on('read_file_content', 'before', async ({ args }) => {
  broadcast({ statusMessage: `📖 正在分析檔案內容: ${args.path}...` });
});

toolbox.on('plan', 'before', async ({ args }) => {
  broadcast({ statusMessage: `📋 正在進行多階段開發規劃...` });
});

toolbox.on('list_files', 'after', async ({ args, result }) => {
  broadcast({ statusMessage: `✅ 目錄掃描完成: ${args.path}` });
});

toolbox.on('read_file_content', 'after', async ({ args }) => {
  broadcast({ statusMessage: `✅ 分析檔案成功: ${args.path}` });
});

toolbox.on('plan', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `🎯 **任務規劃已更新**\n⏭️ **執行計畫：** ${args.next_steps_plan}` });
});

toolbox.on('update_file', 'after', async ({ args }) => {
  broadcast({ type: 'rendering', isLoading: false });
  broadcast({ type: 'refresh' }); // 觸發前端刷新 Sandbox
  broadcast({ statusMessage: `✨ 代碼實作完成: ${args.explanation}` });
});


toolbox.on('send_message', 'after', async ({ args, context }) => {
  // 如果是當前任務流程中的第一次發言，才開新泡泡
  // 使用 context.session 確保跨遞迴、跨分岔共用狀態
  if (!context.session || !context.session.isAlreadySpoken) {
    broadcast({ isNew: true });
    if (!context.session) context.session = {};
    context.session.isAlreadySpoken = true;
  }
  broadcast({ chunk: args.text }); // 接續傳送內容
});

toolbox.on('ask_user', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `❓ **AI 正在詢問：**\n\n${args.question}` });
});

app.use(cors({ origin: '*' }));
app.use(express.json());


app.get('/api/get-ui-code', async (req, res) => {
  const code = await fs.readFile(TARGET_FILE, 'utf8');
  res.json({ success: true, code });
});

const PORT = 3002;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Builder Server running on port ${PORT} (WS Enabled)`);
});

const wss = new WebSocketServer({ server });

let isProcessBusy = false;

wss.on('connection', (ws) => {
  activeClients.add(ws);
  console.log(`[WS] 連結建立 (目前活躍客戶端: ${activeClients.size})`);
  let isAborted = false;

  ws.on('message', async (message) => {
    try {
      const { prompt } = JSON.parse(message.toString());

      ws.send(JSON.stringify({ isNew: true, chunk: `【WS 即時接收確認】：${prompt}` }));

      if (isProcessBusy) {
        broadcast({ isNew: true, chunk: '\n[系統提示]：伺服器忙碌中...\n' });
        return;
      }
      isProcessBusy = true;

      try {
        // 1. 使用獨立的協調者元件分析需求並指派任務
        const coordinator = new Coordinator(coordinatorModel, agentModel, toolbox);
        await coordinator.coordinate(prompt, {
          getIsAborted: () => isAborted,
          loopCount: 0,
          workDir: path.join(__dirname, '../src/sandbox') // 強制沙盒區域
        });
      } finally {
        isProcessBusy = false;
        if (!isAborted && ws.readyState === 1) ws.send(JSON.stringify({ done: true }));
      }

    } catch (err) { console.error('[WS Error]', err); }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    isAborted = true;
    console.log(`[WS] 客戶端斷開 (剩餘連線: ${activeClients.size})`);
  });
});
