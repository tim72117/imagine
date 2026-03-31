import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocketServer } from 'ws';
import {
  streamGeminiSDK,
  registry,
  TARGET_FILE,
  FRAMEWORK_FILE
} from './ai.js';

dotenv.config();

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

registry.on('update_ui', 'before', async ({ args }) => {
  if (args.code) {
    broadcast({ type: 'rendering', isLoading: true });
    
    console.log(`[Test] 偵測到 UI 變更，進入 3 秒測試延遲...`);
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`[Hook:before] 正在寫入 UI 代碼至 ${TARGET_FILE}...`);
    await fs.writeFile(TARGET_FILE, args.code, 'utf8');
  }
});

registry.on('plan', 'before', async ({ args }) => {
  if (args.updated_framework) {
    console.log(`[Hook:before] 正在同步計畫規範...`);
    await fs.writeFile(FRAMEWORK_FILE, args.updated_framework, 'utf8');
  }
});

registry.on('update_framework', 'before', async ({ args }) => {
  if (args.new_content) {
    console.log(`[Hook:before] 正在更新手冊內容...`);
    await fs.writeFile(FRAMEWORK_FILE, args.new_content, 'utf8');
  }
});

registry.on('list_sandbox_files', 'after', async ({ args, result }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `✅ **目錄掃描完成**\n[已發現檔案]：\n\`\`\`\n${result.fileList}\n\`\`\`\n⏭️ **計畫：** ${args.next_step}` });
});

registry.on('read_file_content', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `✅ **分析成功：** \`${args.path}\`\n⏭️ **目的：** ${args.explanation}` });
});

registry.on('plan', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `🎯 **任務規劃已更新**\n⏭️ **執行計畫：** ${args.next_steps_plan}` });
});

registry.on('update_framework', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: `✅ **規範同步完成**\n⏭️ **下一階段目標：** ${args.next_step}` });
});

registry.on('update_ui', 'after', async ({ args }) => {
  broadcast({ type: 'rendering', isLoading: false });
  broadcast({ type: 'refresh' }); // 觸發前端刷新 Sandbox
  broadcast({ isNew: true });
  broadcast({ chunk: `✨ **UI 實作完成：** ${args.explanation}\n⏭️ **計畫：** ${args.next_step}` });
});

registry.on('finish_task', 'after', async ({ args }) => {
  broadcast({ isNew: true });
  broadcast({ chunk: args.summary }); // 輸出 AI 最終結語
});

app.use(cors({ origin: '*' }));
app.use(express.json());

// 靜態路由 (心跳與代碼獲取)
app.get('/api/init-framework', async (req, res) => {
  const exists = await fs.pathExists(FRAMEWORK_FILE);
  if (!exists) await fs.writeFile(FRAMEWORK_FILE, "# Framework.md", 'utf8');
  res.json({ success: true });
});

app.get('/api/get-ui-code', async (req, res) => {
  const code = await fs.readFile(TARGET_FILE, 'utf8');
  res.json({ success: true, code });
});

const PORT = 3002;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Builder Server running on port ${PORT} (WS Enabled)`);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  activeClients.add(ws);
  console.log(`[WS] 連結建立 (目前活躍客戶端: ${activeClients.size})`);
  let isAborted = false;

  ws.on('message', async (message) => {
    try {
      const { prompt } = JSON.parse(message.toString());
      
      // 測試即時回顯
      ws.send(JSON.stringify({ isNew: true, chunk: `【WS 即時接收確認】：${prompt}` }));

      await streamGeminiSDK(
        prompt,
        (data) => { if (!isAborted && ws.readyState === 1) ws.send(JSON.stringify(data)); },
        () => { if (!isAborted && ws.readyState === 1) ws.send(JSON.stringify({ done: true })); },
        () => isAborted
      );
    } catch (err) { console.error('[WS Error]', err); }
  });

  ws.on('close', () => {
    activeClients.delete(ws);
    isAborted = true;
    console.log(`[WS] 客戶端斷開 (剩餘連線: ${activeClients.size})`);
  });
});
