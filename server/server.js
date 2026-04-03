import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import {
  toolbox,
  Coordinator
} from './ai.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- 集中定義工作空間 (由 server.js 主導) ---
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');

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

toolbox.on('update_file', 'before', async ({ args, context }) => {
  broadcast({ statusMessage: `📝 正在更新檔案: ${args.path}...` });

  // UI 專屬邏輯：若目標為特定檔案，則啟動渲染載入與延遲
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
  broadcast({ statusMessage: `✅ 檔案更新完成: ${args.path}` });

  // UI 專屬邏輯：結束渲染狀態並重新整理
  if (args.path && args.path.includes('Target.tsx')) {
    broadcast({ type: 'rendering', isLoading: false });
    broadcast({ type: 'refresh' });
    broadcast({ statusMessage: `✨ UI 渲染完成` });
  }
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
  const target = req.query.path || 'Target.tsx';
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
        const coordinator = new Coordinator();
        await coordinator.coordinate(prompt, {
          getIsAborted: () => isAborted,
          loopCount: 0,
          workDir: TARGET_DIR // 強制工作區域
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
