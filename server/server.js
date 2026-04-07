import express from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import {
  toolbox,
  Coordinator,
  onLogEvent,
  onStateUpdate,
  globalStore
} from './ai.js';
import { Signaler } from './agent.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// --- 集中定義工作空間 (由 server.js 主導) ---
export const TARGET_DIR = path.join(__dirname, '../src/sandbox');

// --- WebSocket 全域追蹤與發送工具 ---
const activeClients = new Set();
const sessionSignalers = new Map(); // 關鍵：追蹤每個 session 的 Signaler

// --- 集中日誌紀錄與持久化 (Log Persistence) ---
const HISTORY_DIR = path.join(__dirname, 'history');
fs.ensureDirSync(HISTORY_DIR);

const logQueue = [];
let isProcessingQueue = false;

async function processLogQueue() {
  if (isProcessingQueue || logQueue.length === 0) return;
  isProcessingQueue = true;
  try {
    while (logQueue.length > 0) {
      const logItem = logQueue.shift();
      const { data, now } = logItem;
      try {
        const fileName = data?.session_id ? `log_${data.session_id}.json` : `log_${now.toISOString().split('T')[0]}.json`;
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

const broadcast = (data) => {
  const message = JSON.stringify(data);
  activeClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(message);
  });
};

// --- 監聽 AI 推理日誌並廣播 ---
// 在伺服器端將日誌細項封裝在「logItem」欄位下
onLogEvent((logItem) => {
  // 1. WebSocket 廣播
  broadcast({
    type: 'reasoning_log',
    logItem: { ...logItem, timestamp: logItem.now?.toLocaleString() }
  });

  // 2. 磁碟持久化
  logQueue.push(logItem);
  processLogQueue();
});

onStateUpdate(({ sessionId, key, value }) => {
    broadcast({
        type: 'workflow_state',
        sessionId,
        key,
        value
    });
});

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
  const sessionId = `SESSION-${Date.now()}`;
  const masterAgentId = `AGENT-MASTER-${Math.random().toString(36).substring(2, 5).toUpperCase()}`;
  console.log(`[WS] 連結建立 (Session: ${sessionId}, ID: ${masterAgentId})`);
  let isAborted = false;

  ws.on('message', async (rawMessage) => {
    console.log(`[WS:In] 接收數據: ${rawMessage.toString().substring(0, 100)}...`);
    try {
      const data = JSON.parse(rawMessage.toString());
      console.log(`[WS:Route] 類型: ${data.type || 'DEFAULT'}, Session: ${data.sessionId || sessionId}`);
      const { prompt } = data;
      if (!prompt) return;

      console.log(`[WS:In] 廣播確認...`);
      ws.send(JSON.stringify({ isNew: true, chunk: `【WS 確認收到請求】：${prompt}` }));

      if (isProcessBusy) {
        console.warn(`[WS:Busy] 伺服器忙碌中，忽略請求: ${sessionId}`);
        ws.send(JSON.stringify({ isNew: true, chunk: '\n[系統提示]：伺服器忙碌中，請稍候再試或重啟對話。\n' }));
        return;
      }
      isProcessBusy = true;

      // 3. 手動發送一個初始化日誌，讓 UI 方塊立即出現 (預熱)
      await globalStore.log("AGENT_START", {
          prompt: 'System',
          data: { session_id: sessionId, role: 'Coordinator', round: 1, agent_id: masterAgentId }
      });
      globalStore.setState(sessionId, 'status', 'initializing');

      // 2. 初始化此 Session 的訊號器
      const currentSignaler = new Signaler();
      sessionSignalers.set(sessionId, currentSignaler);

      try {
        console.log(`[WS:Exec] 開始推理流程: ${sessionId}`);
        const coordinator = new Coordinator();
        const it = coordinator.coordinate(prompt, {
          getIsAborted: () => isAborted,
          loopCount: 0,
          sessionId,
          workDir: TARGET_DIR,
          signaler: currentSignaler, // 覆蓋預設訊號器
          masterAgentId
        });

        for await (const message of it) {
            console.log(`  [Stream] Yielded message: ${message.role} - ${(message.text || '').substring(0, 50)}...`);
            // 此處可根據需求將 message 直接透過 WebSocket 傳回前端
        }
      } catch (err) {
        console.error(`[WS:Error] 推理執行失敗:`, err);
        ws.send(JSON.stringify({ isNew: true, chunk: `\n❌ 執行錯誤: ${err.message}\n` }));
      } finally {
        isProcessBusy = false;
        sessionSignalers.delete(sessionId);
        if (!isAborted && ws.readyState === 1) ws.send(JSON.stringify({ done: true }));
        console.log(`[WS:Done] Session 結束: ${sessionId}`);
      }
    } catch (err) { console.error('[WS Error]', err); }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    isAborted = true;
    console.log(`[WS] 客戶端斷開 (剩餘連線: ${activeClients.size})`);
  });
});
