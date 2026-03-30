import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 路徑定義
export const TARGET_FILE = path.join(__dirname, '../src/sandbox/Target.tsx');
export const FRAMEWORK_FILE = path.join(__dirname, '../src/sandbox/Framework.md');
export const HISTORY_DIR = path.join(__dirname, 'history');

// --- Function Calling 定義 ---
const tools = [{
  functionDeclarations: [
    {
      name: "update_ui",
      description: "當使用者要求修改、優化、美化或生成全新的 React 組件介面時呼叫。需提供完整 React 代碼與簡短的變更說明。",
      parameters: {
        type: "OBJECT",
        properties: {
          code: { type: "STRING", description: "完整的 React 組件代碼 (使用 Tailwind CSS)" },
          explanation: { type: "STRING", description: "【極簡、一句話】說明這次改動的核心內容（繁體中文）。" }
        },
        required: ["code", "explanation"]
      }
    },
    {
      name: "update_framework",
      description: "當專案方向改變、加入新技術架構或規範需更新時，呼叫此功能修改 Framework.md 分析內容。",
      parameters: {
        type: "OBJECT",
        properties: {
          new_content: { type: "STRING", description: "更新後的 Framework.md 繁體中文分析內容。" }
        },
        required: ["new_content"]
      }
    },
    {
      name: "reset_project",
      description: "當專案方向與之前完全不符時呼叫。此功能會同步更新開發手冊並發送重置信號。",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "重置與重新規劃的原因說明。" },
          new_framework_content: { type: "STRING", description: "針對新需求重新編寫的 Framework.md 繁體中文內容。" }
        },
        required: ["reason", "new_framework_content"]
      }
    },
    {
      name: "send_message",
      description: "單純詢問問題、聊天、規劃或進度回報時呼叫代碼時呼叫。",
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: "回傳給使用者的文字內容" }
        },
        required: ["text"]
      }
    }
  ]
}];

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash", tools: tools });

let isProcessBusy = false;
let isAnalyzingFramework = false;
const COOLDOWN_MS = 1000;

// 紀錄回應資訊的函式 (堆疊式，每小時一個檔案)
export async function recordGeminiResponse(prompt, output, type = "CHAT", rawData = null) {
  try {
    await fs.ensureDir(HISTORY_DIR);
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const hourStr = now.getHours().toString().padStart(2, '0');
    const fileName = `log_${dateStr}_${hourStr}.json`;
    const historyPath = path.join(HISTORY_DIR, fileName);

    let logs = [];
    if (await fs.pathExists(historyPath)) {
      try { logs = await fs.readJson(historyPath); } catch (e) { logs = []; }
    }

    logs.push({
      timestamp: now.toLocaleString(),
      type,
      prompt,
      output,
      raw: rawData // 全量原始資訊
    });
    await fs.writeJson(historyPath, logs, { spaces: 2 });
    console.log(`[System] [${type}] 回應已堆疊紀錄至: ${fileName} (含 Raw Data)`);
  } catch (error) {
    console.error('[Error] 紀錄失敗:', error);
  }
}

// --- Tool Handler 封裝 ---
class ToolRegistry {
  constructor() {
    this.handlers = new Map();
    this.priorities = {
      "update_framework": 10,
      "reset_project": 20,
      "update_ui": 30,
      "send_message": 40
    };
  }

  register(toolName, handler) {
    this.handlers.set(toolName, handler);
  }

  async execute(toolCalls, context = {}) {
    // 依優先順序排序
    const sorted = [...toolCalls].sort((a, b) => {
      const pA = this.priorities[a.name] || 99;
      const pB = this.priorities[b.name] || 99;
      return pA - pB;
    });

    let chainStatus = { triggerNext: false, nextPrompt: "" };
    const results = [];
    for (const call of sorted) {
      const handler = this.handlers.get(call.name);
      if (handler) {
        console.log(`[Tool] 正在執行: ${call.name} (優先級: ${this.priorities[call.name] || 99})`);
        const result = await handler(call.args, context);
        results.push({ name: call.name, ...result });
        
        // 檢查是否由 Handler 觸發連鎖請求
        if (result.triggerNext) {
          chainStatus.triggerNext = true;
          chainStatus.nextPrompt = result.nextPrompt;
        }
      } else {
        console.warn(`[Tool] 找不到處理常式: ${call.name}`);
      }
    }
    return { results, chainStatus };
  }
}

const registry = new ToolRegistry();

// 註冊：更新架構
registry.register("update_framework", async (args, context) => {
  if (args.new_content) await fs.writeFile(FRAMEWORK_FILE, args.new_content, 'utf8');
  
  // 如果這一輪沒有同時呼叫 update_ui，則觸發自動跟進
  const hasUiCall = context.allCalls.some(c => c.name === "update_ui");
  return { 
    success: true, 
    triggerNext: !hasUiCall, 
    nextPrompt: "已更新開發手冊 (Framework.md)，請立即根據最新的開發規範產出對應的 App.tsx 實作代碼。" 
  };
});

// 註冊：重置專案
registry.register("reset_project", async (args, context) => {
  if (args.new_framework_content) {
    await fs.writeFile(FRAMEWORK_FILE, args.new_framework_content, 'utf8');
  }
  const { onChunk } = context;
  onChunk(`⚠️ **重置提案：** ${args.reason}\n\n`);
  onChunk("\n[SIGNAL:RESET_PROPOSAL]\n⚠️ **專案大方向已重置，正在重新生成代碼...**\n\n");
  
  const hasUiCall = context.allCalls.some(c => c.name === "update_ui");
  return { 
    success: true, 
    triggerNext: !hasUiCall, 
    nextPrompt: `專案大方向已重置為「${args.reason}」，已更新 Framework.md，請立即根據新規劃產出對應的代碼實作。` 
  };
});

// 註冊：更新 UI
registry.register("update_ui", async (args, { onChunk }) => {
  if (args.code) {
    if (args.explanation) {
      onChunk(`🚀 **更新 UI：** ${args.explanation}\n\n`);
    }
    await fs.writeFile(TARGET_FILE, args.code, 'utf8');
  }
  return { success: true, explanation: args.explanation };
});

// 註冊：發送訊息
registry.register("send_message", async (args) => {
  return { success: true, text: args.text };
});

// 自動分析專案內容並初始化框架定義文件 (Framework.md)
export async function checkAndInitializeFramework() {
  if (isAnalyzingFramework) {
    console.log("[System] 目前已有正在進行中的分析，跳過重複觸發...");
    return await fs.readFile(FRAMEWORK_FILE, 'utf8');
  }

  try {
    const exists = await fs.pathExists(FRAMEWORK_FILE);
    let content = "";
    if (exists) content = await fs.readFile(FRAMEWORK_FILE, 'utf8');

    if (!content.trim()) {
      isAnalyzingFramework = true;
      console.log("[System] Framework.md 為空，正在【深度掃描 Sandbox 檔案】並分析專案功能...");
      
      const sandboxDir = path.join(__dirname, '../src/sandbox/');
      const files = await fs.readdir(sandboxDir);
      let sandboxOverview = "";
      
      for (const file of files) {
        if (file.endsWith('.tsx') || file.endsWith('.ts') || file.endsWith('.js') || file.endsWith('.css')) {
          const filePath = path.join(sandboxDir, file);
          const fContent = await fs.readFile(filePath, 'utf8');
          sandboxOverview += `\n--- File: ${file} ---\n${fContent}\n`;
        }
      }
      
      const analysisPrompt = `
      Please analyze the following sandbox code and create a CONCISE Framework.md doc.
      [Sandbox Implementation Files]
      ${sandboxOverview}
      [Instruction]
      1. 使用「極簡、條列式」撰寫 Framework.md 元數據。
      2. 分析目前 Sandbox 的【核心功能】與【介面邏輯】。
      3. 定義未來修改時應遵循的 UI 與程式碼範式。
      4. Language: 繁體中文 (Traditional Chinese).
      OUTPUT ONLY THE MARKDOWN CONTENT.
      `;
      
      const result = await model.generateContent(analysisPrompt);
      const frameworkText = result.response.text();
      await fs.writeFile(FRAMEWORK_FILE, frameworkText, 'utf8');
      await recordGeminiResponse(analysisPrompt, frameworkText, "FRAMEWORK_INIT", { frameworkText });
      console.log("[System] Framework.md 已完成深度掃描分析。");
      return frameworkText;
    }
    return content;
  } catch (error) {
    console.error("[Error] 無法初始化 Framework.md:", error);
    throw error;
  } finally {
    isAnalyzingFramework = false;
  }
}

// 核心串流處理解析器 (支援連鎖請求)
export async function streamGeminiSDK(userPrompt, onChunk, onComplete) {
  if (isProcessBusy) { onChunk('\n[系統提示]：伺服器忙碌中...\n'); onComplete(); return; }
  isProcessBusy = true;
  let loopCount = 0;
  const MAX_LOOPS = 3;
  let currentPrompt = userPrompt;

  try {
    while (loopCount < MAX_LOOPS) {
      loopCount++;
      const currentCode = await fs.readFile(TARGET_FILE, 'utf8').catch(() => "// 尚無代碼");
      const frameworkDocs = await fs.readFile(FRAMEWORK_FILE, 'utf8').catch(() => "// 尚無框架");

      const systemInstruction = `你是一個專業的前端 UI 專家。
目前專案環境為「極簡化動態 Sandbox」，請嚴格遵守以下代碼架構規範：
1. **技術棧**: 僅限使用 React 18 (Functional Component) 與 Tailwind CSS。
2. **圖示限制**: 目前【不支援】Lucide 或任何第三方圖示庫，請改用 Emoji 或 Tailwind 的精美排版與形狀替代圖示需求。
3. **單一組件**: 所有代碼必須包含在一個名為 \`App\` 的組件內 (例如: const App = () => { ... })。
4. **無須引進 (No Imports)**: 環境已預載 React 與 Tailwind，請直接撰寫組件邏輯，不要加入 import 語句。
5. **UI 風格**: 追求高端、精緻且具備現代感的介面設計。

以下是專案的【開發規範文件 (Framework.md)】：
---
${frameworkDocs}
---

使用者目前的【程式碼】如下：
---
${currentCode}
---

根據需求，你可以選擇：
1. 使用 update_ui 修改現有代碼或生成新動態組件。
2. 使用 update_framework 更新開發規範文檔。
3. 使用 send_message 回答問題、規劃進度。
4. 【重要提案】若大改方向，請呼叫 reset_project 回傳重置提案與規畫。
【連動指令】：如果你進行了架構調整，請在同一次回應中接著呼叫 update_ui 產出對應的代碼。`;

      console.log(`[Flow] 執行階段 (Loop ${loopCount}): ${currentPrompt.slice(0, 50)}...`);
      
      const result = await model.generateContentStream({
        contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${currentPrompt}` }] }]
      });

      let toolCalls = [];
      let lastSentLength = 0;
      let fullOutput = "";

      for await (const chunk of result.stream) {
        const cand = chunk.candidates?.[0];
        if (!cand?.content?.parts) continue;
        for (const part of cand.content.parts) {
          if (part.functionCall) {
            toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args });
            if (part.functionCall.args.text) {
              const delta = part.functionCall.args.text.slice(lastSentLength);
              if (delta) { onChunk(delta); fullOutput += delta; lastSentLength = part.functionCall.args.text.length; }
            }
          } else if (part.text) {
            onChunk(part.text);
            fullOutput += part.text;
          }
        }
      }

      const { results, chainStatus } = await registry.execute(toolCalls, { onChunk, onComplete, allCalls: toolCalls });
      
      const uiRes = results.find(r => r.name === "update_ui");
      const msgRes = results.find(r => r.name === "send_message");
      const finalDisplay = msgRes?.text || fullOutput || (uiRes ? (uiRes.explanation || "UI 更新完畢。") : `Step ${loopCount} 完成。`);
      
      await recordGeminiResponse(currentPrompt, finalDisplay, "TOOL_STEP", { calls: toolCalls, results });

      if (chainStatus.triggerNext && loopCount < MAX_LOOPS) {
        console.log(`[Flow] 自行連鎖觸發: ${chainStatus.nextPrompt}`);
        currentPrompt = chainStatus.nextPrompt;
        continue;
      } else { break; }
    }
  } catch (error) {
    console.error(`[Error]: ${error.message}`);
    onChunk(`\n[Server Error]: ${error.message}\n`);
  } finally {
    setTimeout(() => { isProcessBusy = false; onComplete(); }, COOLDOWN_MS);
  }
}
