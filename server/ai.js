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

// 初始化 Gemini SDK
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  tools: tools
});

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

// 核心串流處理解析器
export async function streamGeminiSDK(userPrompt, onChunk, onComplete) {
  if (isProcessBusy) {
    onChunk('\n[系統提示]：伺服器忙碌中，請稍候...\n');
    onComplete();
    return;
  }

  let currentCode = "";
  let frameworkDocs = "";
  try {
    currentCode = await fs.readFile(TARGET_FILE, 'utf8');
    frameworkDocs = await fs.readFile(FRAMEWORK_FILE, 'utf8');
  } catch (err) {
    currentCode = "// 目前尚無現有代碼。";
    frameworkDocs = "// 目前尚無框架定義。";
  }

  isProcessBusy = true;

  try {
    const systemInstruction = `你是一個專業的 UI 工程師。
以下是專案的【開發框架與規範】：
---
${frameworkDocs}
---

使用者目前的【程式碼】如下：
---
${currentCode}
---

根據需求，你可以選擇：
1. 使用 update_ui 修改現有代碼或生成新代碼。
2. 使用 update_framework 更新你的開發規範文件。
3. 使用 send_message 回答問題、規劃進度。
4. 【重要提案】若大改方向，請呼叫 reset_project 回傳重置提案與規畫。
【關鍵連動指令】：如果你對新規規畫有信心，請在同一次回應中接著呼叫 update_ui 產出對應的第一版實作代碼（不需等待使用者確認，實現一氣呵成的重啟）。`;

    console.log(`[Executing Stream Tool Call] for: ${userPrompt}`);
    
    const result = await model.generateContentStream({
      contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${userPrompt}` }] }]
    });

    let fullOutput = "";
    let toolCalls = []; // 用於紀錄這一回合所有的工具調用
    let lastSentLength = 0;
    let hasSentUpdateHint = false;
    let hasLoggedRawChunk = false; 
    let chunksHistory = []; 

    for await (const chunk of result.stream) {
      chunksHistory.push(chunk); 
      
      const candidate = chunk.candidates?.[0];
      if (!candidate || !candidate.content || !candidate.content.parts) continue;

      // 遍歷所有 candidate 中的 parts，避免遺漏多重工具調用
      for (const part of candidate.content.parts) {
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args
          });
          
          const args = part.functionCall.args;
          if (args.code) {
            if (!hasSentUpdateHint && args.explanation) {
              onChunk(`🚀 **更新 UI：** ${args.explanation}\n\n`);
              hasSentUpdateHint = true;
            }
          } else if (args.new_framework_content || args.new_content) {
            onChunk("📖 **同步手冊：** 偵測到架構變更，正在自動對齊開發手冊...\n\n");
          } else if (args.reason) {
            onChunk(`⚠️ **重置提案：** ${args.reason}\n\n`);
          } else if (args.text) {
            const delta = args.text.slice(lastSentLength);
            if (delta) {
              onChunk(delta);
              lastSentLength = args.text.length;
            }
          }
        } else if (part.text) {
          onChunk(part.text);
          fullOutput += part.text;
        }
      }
    }

    // --- 最終處置：依照「手冊 -> 代碼 -> 對話」的固定流程處理 ---
    // 1. 先處理 Framework 全量更新 (順序優先)
    const frameworkCall = toolCalls.find(c => c.name === "update_framework" || (c.name === "reset_project" && c.args.new_framework_content));
    if (frameworkCall) {
      console.log(`[Flow] 執行階段 1: 更新 Framework 文件`);
      const newContent = frameworkCall.args.new_framework_content || frameworkCall.args.new_content;
      if (newContent) await fs.writeFile(FRAMEWORK_FILE, newContent, 'utf8');
    }

    // 2. 處理重置信號 (先處理信號，但不中斷流程)
    const resetCall = toolCalls.find(c => c.name === "reset_project");
    if (resetCall) {
      console.log(`[Flow] 執行階段 2: 處理重置規畫`);
      onChunk("\n[SIGNAL:RESET_PROPOSAL]\n⚠️ **專案大方向已重置，新規畫已同步至手冊。**\n\n");
    }

    // 3. 處理 UI 更新 (不論前面是否有重置)
    const uiCall = toolCalls.find(c => c.name === "update_ui");
    if (uiCall) {
      console.log(`[Flow] 執行階段 3: 更新 UI 組件代碼`);
      await fs.writeFile(TARGET_FILE, uiCall.args.code, 'utf8');
    }

    // 3. 彙整紀錄用的 Output
    const messageCall = toolCalls.find(c => c.name === "send_message");
    if (messageCall) fullOutput = messageCall.args.text;
    else if (uiCall) fullOutput = uiCall.args.explanation || "UI 更新完畢。";

    await recordGeminiResponse(userPrompt, fullOutput, toolCalls.length > 0 ? "TOOL" : "CHAT", {
      calls: toolCalls,
      chunks: chunksHistory,
      fullText: fullOutput
    });

  } catch (error) {
    console.error(`[Fatal Error]: ${error.message}`);
    onChunk(`\n[Server Error]: ${error.message}\n`);
  } finally {
    setTimeout(() => {
      isProcessBusy = false;
      onComplete();
    }, COOLDOWN_MS);
  }
}
