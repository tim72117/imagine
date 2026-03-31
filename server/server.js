import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { streamGeminiSDK, checkAndInitializeFramework } from './ai.js';

dotenv.config();

const app = express();

// 強化 CORS 設定
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 路由 1: 核心 UI 串流生成
app.get('/api/update-ui-stream', (req, res) => {
  const { prompt } = req.query;

  // 設定 SSE Header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no'); // 告訴代理伺服器不要緩衝

  console.log('#'.repeat(50));
  console.log(`[REQUEST] 前端發送需求: ${prompt}`);
  console.log(`${new Date().toLocaleString()}`);
  console.log('#'.repeat(50));

  let isAborted = false;
  req.on('close', () => {
    isAborted = true;
    console.log(`[SSE] 用戶已離線 (Aborted: ${prompt.slice(0, 20)}...)`);
  });

  // 立即發送心跳，確保連線建立
  res.write(': heartbeat\n\n');

  streamGeminiSDK(
    prompt,
    (data) => {
      if (isAborted) return;
      // data 可以是 { chunk: "..." } 或 { isNew: true }
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    () => {
      if (!isAborted) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    },
    () => isAborted
  );
});

// 路由 2: 初始化專案框架 (由前端開啟時呼叫)
app.get('/api/init-framework', async (req, res) => {
  try {
    const frameworkText = await checkAndInitializeFramework();
    res.json({ success: true, framework: frameworkText });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 路由 3: 取得目前 Sandbox 代碼
app.get('/api/get-ui-code', async (req, res) => {
  try {
    const { TARGET_FILE } = await import('./ai.js');
    const { default: fs } = await import('fs-extra');
    const code = await fs.readFile(TARGET_FILE, 'utf8');
    res.json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Agent Server is listening on http://0.0.0.0:${PORT}`);
});
