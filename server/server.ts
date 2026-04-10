import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { WebSocket, WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { AgenticEngine } from './agent.js';
import { onStateUpdate } from './store.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TARGET_DIR = path.join(__dirname, '../src/sandbox');

const app = express();

// --- WebSocket 全域追蹤與發送工具 ---
const activeClients = new Set<WebSocket>();


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
  
  ws.on('message', async (rawMessage) => {
    console.log(`[WS:In] 接收數據: ${rawMessage.toString().substring(0, 100)}...`);
    try {
      const data = JSON.parse(rawMessage.toString());
      const { prompt } = data;
      
      console.log(`[WS:Go] 🚀 直接啟動 Go 引擎處理指令: ${prompt}`);
      ws.send(JSON.stringify({ isNew: true, chunk: `【指令已接收】：${prompt}` }));

      const engine = new AgenticEngine();
      const stream = engine.GenerateStream("", {
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
    console.log(`[WS] 客戶端斷開 (剩餘連線: ${activeClients.size})`);
  });
});
