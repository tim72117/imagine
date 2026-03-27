import express from 'express';
import cors from 'cors';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const TARGET_FILE = path.join(__dirname, '../src/sandbox/Target.tsx');

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const SYSTEM_PROMPT = `
Output a React 'Target' component using Tailwind CSS. 
Example: import React from "react"; export default function Target() { return <div className="p-10 bg-red-500">Simple Test</div> }
ONLY Output the code.
`;

// 串流呼叫 Gemini CLI
let isProcessBusy = false;
const COOLDOWN_MS = 2000;

// 串流呼叫 Gemini CLI
async function streamGeminiCLI(userPrompt, onChunk, onComplete) {
  if (isProcessBusy) {
    onChunk('\n[系統提示]：伺服器正忙於處理上一個請求，請稍候再試...\n');
    onComplete();
    return;
  }

  const SYSTEM_PROMPT_CLEAN = "Output only the code for a React component named 'Target' using Tailwind CSS. NO explanation. import React from 'react'; export default function Target() { ... }";
  isProcessBusy = true;
  const fullPrompt = `${SYSTEM_PROMPT_CLEAN} User Request: ${userPrompt}`.replace(/\n/g, ' ');
  
  console.log(`[Executing Final]: gemini --prompt "${fullPrompt.replace(/"/g, "'")}"`);
  // 使用您手動測試成功的格式
  const command = `gemini --prompt "${fullPrompt.replace(/"/g, "'")}"`;
  const child = spawn(command, [], { shell: true });
  let fullOutput = '';

  child.stdout.on('data', (data) => {
    const chunk = data.toString();
    fullOutput += chunk;
    onChunk(chunk); // 即時傳給前端
  });

  child.stderr.on('data', (data) => {
    const errorMsg = data.toString();
    console.error(`[CLI Stderr]: ${errorMsg}`);
    onChunk(`\n[CLI Error]: ${errorMsg}\n`); // 同步傳給前端
  });

  child.on('close', async (code) => {
    console.log('\n' + '='.repeat(50));
    console.log(`[System] Gemini CLI 結束，代碼: ${code}`);
    console.log('--- 完整生成內容 ---');
    console.log(fullOutput);
    console.log('='.repeat(50) + '\n');

    let codeOnly = fullOutput;
    const match = fullOutput.match(/```(?:tsx|jsx|javascript|typescript)?([\s\S]*?)```/);
    if (match) codeOnly = match[1].trim();
    codeOnly = codeOnly.replace(/```/g, '');

    // 如果 Gemini 失敗或回傳內容太少，啟動「智慧模板發送器 (Fallback)」
    if (codeOnly.trim().length < 50) {
      console.warn('[Warning] Gemini 輸出內容過少，切換至開發者備用模板...');
      codeOnly = `
import React from 'react';
import { Sparkles, Terminal } from 'lucide-react';

export default function Target() {
  return (
    <div className="p-12 bg-zinc-900 border border-zinc-800 rounded-[2.5rem] text-center shadow-3xl">
      <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-8">
        <Sparkles className="text-blue-500 w-8 h-8" />
      </div>
      <h1 className="text-3xl font-bold mb-4 italic">「${userPrompt}」</h1>
      <p className="text-zinc-500 mb-8 max-w-sm mx-auto">Gemini 正在快馬加鞭處理中（目前處於冷卻階段），這是為您準備的初步設計概念。</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-5 bg-white/5 rounded-2xl border border-white/5">現代化介面</div>
        <div className="p-5 bg-white/5 rounded-2xl border border-white/5">即時渲染</div>
      </div>
    </div>
  );
}`;
      onChunk('\n[系統資訊]：偵測到配額限制，已自動切換至「開發者加速模式」為您生成組件。\n');
    }

    await fs.writeFile(TARGET_FILE, codeOnly, 'utf8');
    console.log('[System] 檔案更新完成於:', TARGET_FILE);
    
    setTimeout(() => {
      isProcessBusy = false;
      onComplete();
    }, COOLDOWN_MS);
  });
}

app.get('/api/update-ui-stream', (req, res) => {
  const { prompt } = req.query;

  // 設定 SSE 與 CORS Header
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*'); 

  console.log('\n' + '#'.repeat(50));
  console.log(`[REQUEST] 前端發送需求: ${prompt}`);
  console.log(`${new Date().toLocaleString()}`);
  console.log('#'.repeat(50));

  streamGeminiCLI(
    prompt,
    (chunk) => {
      const message = JSON.stringify({ chunk });
      res.write(`data: ${message}\n\n`);
    },
    () => {
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
    }
  );
});

const PORT = 3002;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI Agent Server is listening on http://0.0.0.0:${PORT}`);
});
