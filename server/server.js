import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs-extra';
import { 
  streamGeminiSDK, 
  registry, 
  TARGET_FILE, 
  FRAMEWORK_FILE 
} from './ai.js';

dotenv.config();

const app = express();

// --- 註冊 工具鉤子 (Hooks) ---

// 1. 全局進度狀態 (Status) - 執行前觸發
registry.on('*', 'before', async ({ toolName, args, context }) => {
  const { onChunk } = context;
  const toolIcons = {
    update_ui: '🚀'
  };
  const icon = toolIcons[toolName] || '🛠️';
  const message = args.explanation || args.analysis || args.reason || '正在執行工作...';
  onChunk({ type: 'status', message: `${icon} ${message}` });
});

// 2. 檔案寫入副作用 (Side Effects) - 執行前觸發
registry.on('update_ui', 'before', async ({ args, context }) => {
  if (args.code) {
    const { onChunk } = context;
    // 直接通知前端：即將開始渲染流程，強制開啟遮罩
    onChunk({ type: 'rendering', isLoading: true });
    
    // 應使用者要求：增加 3 秒測試延遲
    console.log(`[Test] 偵測到 UI 變更，進入 3 秒測試延遲...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log(`[Hook:before] 正在寫入 UI 代碼至 ${TARGET_FILE}...`);
    await fs.writeFile(TARGET_FILE, args.code, 'utf8');
  }
});

registry.on('plan', 'before', async ({ args }) => {
  if (args.updated_framework) {
    console.log(`[Hook:before] 正在更新發展手冊 (Plan)...`);
    await fs.writeFile(FRAMEWORK_FILE, args.updated_framework, 'utf8');
  }
});

registry.on('update_framework', 'before', async ({ args }) => {
  if (args.new_content) {
    console.log(`[Hook:before] 正在同步發展手冊...`);
    await fs.writeFile(FRAMEWORK_FILE, args.new_content, 'utf8');
  }
});

// 3. 訊息泡泡回傳 (Bubble Updates) - 執行後觸發
registry.on('list_sandbox_files', 'after', async ({ args, result, context }) => {
  const { onChunk } = context;
  onChunk({ isNew: true });
  onChunk({ chunk: `✅ **清單獲取：** [${result.fileList}]\n⏭️ **計畫：** ${args.next_step}` });
});

registry.on('read_file_content', 'after', async ({ args, context }) => {
  const { onChunk } = context;
  onChunk({ isNew: true });
  onChunk({ chunk: `✅ **分析完成：** \`${args.path}\`\n⏭️ **計畫：** ${args.next_step}` });
});

registry.on('plan', 'after', async ({ args, context }) => {
  const { onChunk } = context;
  onChunk({ isNew: true });
  onChunk({ chunk: `🎯 **規劃完成**\n⏭️ **當前目標：** ${args.next_steps_plan}\n\n[SIGNAL:PLAN_GENERATED]` });
});

registry.on('update_framework', 'after', async ({ args, context }) => {
  const { onChunk } = context;
  onChunk({ isNew: true });
  onChunk({ chunk: `✅ **手冊已更新**\n⏭️ **計畫：** ${args.next_step}` });
});

registry.on('update_ui', 'after', async ({ args, context }) => {
  const { onChunk } = context;
  
  // 通知前端：套用完成，移除遮罩，並觸發代碼重刷
  onChunk({ type: 'rendering', isLoading: false });
  onChunk({ type: 'refresh' });

  onChunk({ isNew: true });
  onChunk({ chunk: `✨ **UI 已更新：** ${args.explanation}\n⏭️ **計畫：** ${args.next_step}` });
});

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

  // 啟動定時心跳，防止長時生成逾時 (15秒一次)
  const heartbeat = setInterval(() => {
    if (isAborted) return clearInterval(heartbeat);
    res.write(': heartbeat\n\n');
  }, 15000);

  streamGeminiSDK(
    prompt,
    (data) => {
      if (isAborted) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    },
    () => {
      clearInterval(heartbeat);
      if (!isAborted) {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
      }
    },
    () => isAborted
  );
});

// 路由 2: 初始化專案框架 (由前端開啟時呼叫)
async function checkAndInitializeFramework() {
  try {
    const exists = await fs.pathExists(FRAMEWORK_FILE);
    if (!exists) {
      await fs.writeFile(FRAMEWORK_FILE, "# Framework.md\n請等待 AI 進行全局掃描後建立規範。", 'utf8');
    }
    console.log("[System] 專案環境檢查完成。分析主導權已移交給 AI Agent。");
    return "Ready";
  } catch (error) {
    console.error("[Error] 環境初始化失敗:", error);
    throw error;
  }
}

app.get('/api/init-framework', async (req, res) => {
  try {
    const status = await checkAndInitializeFramework();
    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
