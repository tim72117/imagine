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
      name: "list_sandbox_files",
      description: "列出 src/sandbox/ 目錄下的所有檔案與資料夾。需說明讀取原因與接下來的計畫。",
      parameters: {
        type: "OBJECT",
        properties: {
          explanation: { type: "STRING", description: "【極簡】說明為何此時需要獲取目錄清單。" },
          next_step: { type: "STRING", description: "獲取清單後預計執行的下一步分析動作。" }
        },
        required: ["explanation", "next_step"]
      }
    },
    {
      name: "read_file_content",
      description: "讀取專案內特定檔案內容進行深度分析。需說明讀取原因與接下來的計畫。",
      parameters: {
        type: "OBJECT",
        properties: {
          path: { type: "STRING", description: "檔案路徑 (例如: src/sandbox/Target.tsx)" },
          explanation: { type: "STRING", description: "【極簡】說明為何此時需要調閱此檔案內容。" },
          next_step: { type: "STRING", description: "讀取並分析內容後，預計要執行的下一步動作。" }
        },
        required: ["path", "explanation", "next_step"]
      }
    },
    {
      name: "update_ui",
      description: "修改現有代碼或產出全新的組件。遵循極簡沙盒規範。",
      parameters: {
        type: "OBJECT",
        properties: {
          code: {
            type: "STRING",
            description: "完整的 React 組件代碼。規範：\n1. 絕對禁止 import。\n2. 僅限一個名為 App 的組件。\n3. 無須 export。\n4. 僅限 React 18 語法與 Tailwind CSS。\n5. 不支援第三方圖示，請用 Emoji 或 Tailwind 組件圖形。"
          },
          explanation: { type: "STRING", description: "【極簡】說明本次 UI 變更的核心邏輯與設計重點。" },
          next_step: { type: "STRING", description: "UI 產出/修復後，預計的後續開發動作。" }
        },
        required: ["code", "explanation", "next_step"]
      }
    },
    {
      name: "update_framework",
      description: "當專案方向變更、加入新技術架構或規範需更新時，修改 Framework.md。需明確說明下一步計畫。",
      parameters: {
        type: "OBJECT",
        properties: {
          new_content: { type: "STRING", description: "更新後的 Framework.md 繁體中文內容。" },
          next_step: { type: "STRING", description: "同步手冊後，預計要進行的具體開發任務或下一步目標。" }
        },
        required: ["new_content", "next_step"]
      }
    },
    {
      name: "plan",
      description: "當接收到的需求過於龐大、複雜或涉及多階段變動時呼叫。進行全局架構分析、步驟拆解並更新開發手冊以明確後續計畫。",
      parameters: {
        type: "OBJECT",
        properties: {
          analysis: { type: "STRING", description: "針對大型任務的現狀分析、困難點與拆解邏輯。" },
          updated_framework: { type: "STRING", description: "根據拆解後的計畫，重新編寫或增修 Framework.md 的內容。" },
          next_steps_plan: { type: "STRING", description: "列出具體的執行隊列，明確分階段實作的第一步目標。" }
        },
        required: ["analysis", "updated_framework", "next_steps_plan"]
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
      "list_sandbox_files": 4,  // 列出清單最優先
      "read_file_content": 5,   // 分析特定檔案
      "update_framework": 10,  // 規範優先
      "plan": 20,              // 任務規劃優先度居中
      "update_ui": 30          // 實作最後
    };
  }

  register(toolName, handler) {
    this.handlers.set(toolName, handler);
  }

  async execute(toolCalls, context = {}) {
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
        const result = await handler(call.args, context);
        results.push({ name: call.name, ...result });
        if (result.triggerNext) {
          chainStatus.triggerNext = true;
          chainStatus.nextPrompt = result.nextPrompt;
        }
      }
    }
    return { results, chainStatus };
  }
}

const registry = new ToolRegistry();

// 註冊：清單讀取
registry.register("list_sandbox_files", async (args, { onChunk, currentPrompt }) => {
  try {
    const sandboxDir = path.join(__dirname, '../src/sandbox/');
    const files = await fs.readdir(sandboxDir);
    onChunk({ type: 'status', message: `📡 正在讀取目錄：${args.explanation}` });

    const fullPaths = files.map(file => path.join('src/sandbox', file).replace(/\\/g, '/'));
    const fileList = fullPaths.join(', ');

    onChunk({ isNew: true });
    onChunk({ chunk: `✅ **清單獲取：** [${fileList}]\n⏭️ **計畫：** ${args.next_step}` });

    return {
      success: true,
      triggerNext: true,
      nextPrompt: `${currentPrompt}\n---\n【目錄清單】：[${fileList}]\n目前分析理由：${args.explanation}\n下一步計畫：${args.next_step}`
    };
  } catch (err) {
    return {
      success: false,
      triggerNext: true,
      nextPrompt: `${currentPrompt}\n---\n【系統錯誤】目錄清單獲取失敗：${err.message}\n請嘗試其他方式或檢查目錄是否存在。`
    };
  }
});

// 註冊：讀取檔案內容並針對性分析
registry.register("read_file_content", async (args, { onChunk, currentPrompt }) => {
  try {
    const absPath = path.isAbsolute(args.path) ? args.path : path.join(__dirname, '../', args.path);
    const content = await fs.readFile(absPath, 'utf8');
    onChunk({ type: 'status', message: `🔍 正在分析：${args.path} (${args.explanation})` });
    onChunk({ isNew: true });
    onChunk({ chunk: `✅ **分析完成：** \`${args.path}\`\n⏭️ **計畫：** ${args.next_step}` });
    return {
      success: true,
      triggerNext: true,
      nextPrompt: `${currentPrompt}\n---\n【檔案內容：${args.path}】\n${content}\n---\n原因：${args.explanation}\n計畫：${args.next_step}`
    };
  } catch (err) {
    onChunk({ isNew: true });
    onChunk({ chunk: `❌ **讀取失敗：** \`${args.path}\` - ${err.message}\n\n` });
    return {
      success: false,
      triggerNext: true,
      nextPrompt: `${currentPrompt}\n---\n【系統錯誤】讀取檔案「${args.path}」失敗：${err.message}\n請檢查路徑是否正確，或嘗試 \`list_sandbox_files\` 確認檔案存在。`
    };
  }
});

// 註冊：更新架構
registry.register("update_framework", async (args, { onChunk, allCalls }) => {
  if (args.new_content) await fs.writeFile(FRAMEWORK_FILE, args.new_content, 'utf8');
  onChunk({ type: 'status', message: `📖 已同步手冊：${args.next_step}` });
  onChunk({ isNew: true });
  onChunk({ chunk: `✅ **手冊已更新**\n⏭️ **計畫：** ${args.next_step}` });

  const hasUiCall = allCalls.some(c => c.name === "update_ui");
  return {
    success: true,
    triggerNext: !hasUiCall,
    nextPrompt: `已更新 Framework.md。下一步計畫是：${args.next_step}。請根據此目標執行下一步動作。`
  };
});

// 註冊：任務拆解與規劃
registry.register("plan", async (args, { onChunk, allCalls }) => {
  if (args.updated_framework) {
    await fs.writeFile(FRAMEWORK_FILE, args.updated_framework, 'utf8');
  }
  onChunk({ type: 'status', message: `🧩 正在進行全局規劃：${args.analysis}` });
  onChunk({ isNew: true });
  onChunk({ chunk: `🎯 **規劃完成**\n⏭️ **當前目標：** ${args.next_steps_plan}` });
  onChunk({ chunk: "\n[SIGNAL:PLAN_GENERATED]\n" });

  const hasUiCall = allCalls.some(c => c.name === "update_ui");
  return {
    success: true,
    triggerNext: !hasUiCall,
    nextPrompt: `規劃已生效。分析：${args.analysis}。第一步預計執行計畫：${args.next_steps_plan}。請立即按照該計畫啟動第一階段任務。`
  };
});

// 註冊：更新 UI
registry.register("update_ui", async (args, { onChunk }) => {
  if (args.code) {
    onChunk({ type: 'status', message: `🚀 正在套用 UI 變更：${args.explanation}` });
    await fs.writeFile(TARGET_FILE, args.code, 'utf8');
    onChunk({ isNew: true });
    onChunk({ chunk: `✨ **UI 已更新：** ${args.explanation}\n⏭️ **計畫：** ${args.next_step}` });
  }
  return { success: true, explanation: args.explanation, next_step: args.next_step };
});

// 基礎專案環境檢查 (不再自動觸發 AI 分析，改由 AI 呼叫工具)
export async function checkAndInitializeFramework() {
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

// 核心串流處理解析器 (支援連鎖請求與中斷)
export async function streamGeminiSDK(userPrompt, onChunk, onComplete, getIsAborted) {
  if (isProcessBusy) { onChunk({ chunk: '\n[系統提示]：伺服器忙碌中...\n' }); onComplete(); return; }
  isProcessBusy = true;
  let loopCount = 0;
  const MAX_LOOPS = 3;
  let currentPrompt = userPrompt;

  // 初始發送一個新泡泡信號
  onChunk({ isNew: true });

  try {
    while (loopCount < MAX_LOOPS) {
      if (getIsAborted && getIsAborted()) {
        console.log("[Flow] 後端偵測到中斷，終止執行。");
        break;
      }
      loopCount++;
      const frameworkDocs = await fs.readFile(FRAMEWORK_FILE, 'utf8').catch(() => "// 尚無框架");

      const systemInstruction = `你是一個具備「思考與執行合一」能力的高級前端工程師 Agent。
注意：【禁止憑空推論】。如果你的上下文不足以支撐對現有專案實作的精確理解，【必須】立刻呼叫工具進行主動偵查。

【專案執行原則】：
1. **分析先行**: 接收到需求後，若未掌握具體檔案結構或代碼，首動動作一定是 \`list_sandbox_files\` 並選擇性讀取關鍵檔案。
2. **規格一致性**: 所有的代碼產出必須符合下方列出的 Framework.md 規範。
3. **透明度**: 所有說明與分析流程請一律使用【繁體中文】。

【執行 SOP 流程】：
1. **主動偵查 (Discovery Step)**: 當不知道專案內容或代碼細節時，主動使用 \`list_sandbox_files\` 與 \`read_file_content\`。
2. **精確執行 (Implementation Step)**: 使用 \`update_ui\` 實作代碼。
3. **下一步執行計畫 (Planning Step)**: 每次回應必須包含後續動作的規劃。

你可以選擇多個工具【依序執行】。目前已停用單純文字對話，請務必透過工具執行來推進任務。

【開發規範文件 (Framework.md)】：
---
${frameworkDocs}
---`;

      console.log(`[Flow] 執行階段 (Loop ${loopCount}): ${currentPrompt.slice(0, 50)}...`);

      const result = await model.generateContentStream({
        contents: [{ role: "user", parts: [{ text: `${systemInstruction}\nUser Request: ${currentPrompt}` }] }]
      });

      let toolCalls = [];
      let fullOutput = "";
      let lastExplanationLength = 0; // 用於追蹤 explanation 的串流進度
      let hasSentToolHint = false;

      for await (const chunk of result.stream) {
        if (getIsAborted && getIsAborted()) {
          console.log("[Flow] 生成過程中偵測到中斷。");
          break;
        }
        const cand = chunk.candidates?.[0];
        if (!cand?.content?.parts) continue;
        for (const part of cand.content.parts) {
          if (part.functionCall) {
            toolCalls.push({ name: part.functionCall.name, args: part.functionCall.args });

            // 處理 explanation 的即時回顯
            const args = part.functionCall.args;
            if (args.explanation) {
              onChunk({ type: 'status', message: `🚀 正在準備：${args.explanation}` });
              lastExplanationLength = args.explanation.length;
            }
          } else if (part.text) {
            onChunk({ chunk: part.text });
            fullOutput += part.text;
          }
        }
      }

      // --- 若本輪沒有任何 Tool Call，直接回傳文字並跳出迴圈 ---
      if (toolCalls.length === 0) {
        await recordGeminiResponse(currentPrompt, fullOutput, "TEXT", { text: fullOutput });
        break;
      }

      // --- 進入工具處理系統，傳入 currentPrompt 以供連鎖決定 ---
      const { results, chainStatus } = await registry.execute(toolCalls, {
        onChunk,
        onComplete,
        allCalls: toolCalls,
        currentPrompt
      });

      const uiRes = results.find(r => r.name === "update_ui");
      const frameworkRes = results.find(r => r.name === "update_framework" || r.name === "plan");

      const finalDisplay = fullOutput ||
        (uiRes ? `✅ UI 更新完成。下一步：${uiRes.next_step}` :
          (frameworkRes ? `✅ 規格已同步。下一步：${frameworkRes.next_step}` :
            `第 ${loopCount} 步執行完畢。`));

      await recordGeminiResponse(currentPrompt, finalDisplay, "TOOL_STEP", { calls: toolCalls, results });

      if (chainStatus.triggerNext && loopCount < MAX_LOOPS) {
        console.log(`[Flow] 自行連鎖觸發: ${chainStatus.nextPrompt}`);
        currentPrompt = chainStatus.nextPrompt;
        continue;
      } else { break; }
    }
  } catch (error) {
    console.error(`[Error]: ${error.message}`);
    onChunk({ isNew: true });
    onChunk({ chunk: `\n[Server Error]: ${error.message}\n` });
  } finally {
    setTimeout(() => { isProcessBusy = false; onComplete(); }, COOLDOWN_MS);
  }
}
