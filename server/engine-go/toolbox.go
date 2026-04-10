package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

/**
 * ToolHandler 定義工具執行的函式原型
 */
type ToolHandler func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error)

/**
 * Toolbox 負責管理工具的註冊與執行，對應 TS 中的 Toolbox
 */
type Toolbox struct {
	handlers map[string]ToolHandler
}

func NewToolbox() *Toolbox {
	return &Toolbox{
		handlers: make(map[string]ToolHandler),
	}
}

/**
 * Register 註冊新的工具處理器
 */
func (toolbox *Toolbox) Register(name string, handler ToolHandler) {
	toolbox.handlers[name] = handler
}

/**
 * ExecuteTool 執行指定的工具，並自動處理狀態更新與紀錄
 */
func (toolbox *Toolbox) ExecuteTool(name string, args map[string]interface{}, agentContext *AgentContext) ActionResult {
	handler, exists := toolbox.handlers[name]
	if !exists {
		return ActionResult{Success: false, Error: fmt.Sprintf("Tool %s not found", name)}
	}

	// 更新任務狀態
	agentContext.UpdateTaskState(StatusExecutingTool, 0)

	// 執行工具邏輯
	result, err := handler(args, agentContext)
	if err != nil {
		result = ActionResult{Success: false, Error: err.Error()}
	}

	// 轉化結果為字串紀錄
	resultJSON, _ := json.Marshal(result)
	messageText := fmt.Sprintf("[%s] 執行完成: %s", name, string(resultJSON))
	if !result.Success {
		messageText = fmt.Sprintf("[%s] 執行失敗: %s", name, result.Error)
	}

	// 將結果存入歷史紀錄
	agentContext.AddMessage("tool", Message{
		Role: "tool",
		Text: messageText,
		Time: time.Now().UnixMilli(),
		Data: result,
		Tool: name,
	})

	return result
}

/**
 * Dispatch 根據工具類型決定同步或非同步執行，並處理事件發送
 */
func (toolbox *Toolbox) Dispatch(name string, args map[string]interface{}, agentContext *AgentContext, allDeclarations map[string]interface{}, eventChan chan<- AIEvent) {
	// 1. 判定工具類型
	isAsync := false
	if declaration, exists := allDeclarations[name].(map[string]interface{}); exists {
		if toolType, ok := declaration["type"].(string); ok && toolType == "async" {
			isAsync = true
		}
	}

	if isAsync {
		// --- 非同步模式 ---
		// A. 立即發送「已派發」事件
		eventChan <- AIEvent{
			Type: "tool_result",
			Text: fmt.Sprintf("[%s] 任務已成功派發，正在背景執行中...", name),
			Action: &ActionData{
				Name: name,
				Args: map[string]interface{}{"status": "dispatched"},
			},
		}

		// B. 在背景執行實際邏輯
		go func() {
			eventChan <- RunAsyncTool(agentContext, name, args)
		}()
	} else {
		// --- 同步模式 ---
		eventChan <- RunAsyncTool(agentContext, name, args)
	}
}

// GlobalToolbox 全域工具箱實體
var GlobalToolbox = NewToolbox()

/**
 * resolvePath 根據 WorkDir 處理路徑邏輯：如果是絕對路徑則直接使用，否則與 WorkDir 拼湊，並進行 Clean
 */
func resolvePath(workDir, inputPath string) string {
	if filepath.IsAbs(inputPath) {
		return filepath.Clean(inputPath)
	}
	return filepath.Clean(filepath.Join(workDir, inputPath))
}

/**
 * 初始化同步工具 (Synchronous Tools Implementation)
 */
func init() {
	// list_files: 列出檔案
	listFilesHandler := func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
		pathArg, _ := args["path"].(string)
		finalPath := resolvePath(ctx.WorkDir, pathArg)

		entries, err := os.ReadDir(finalPath)
		if err != nil {
			return ActionResult{Success: false, Error: err.Error()}, nil
		}

		var fileNames []string
		for _, f := range entries {
			fileNames = append(fileNames, f.Name())
		}

		data := map[string]interface{}{
			"files":       fileNames,
			"path":        pathArg,
			"explanation": args["explanation"],
		}
		return ActionResult{Success: true, Data: data}, nil
	}

	GlobalToolbox.Register("list_files", listFilesHandler)
	GlobalToolbox.Register("list_files_async", listFilesHandler)

	// read_file_content: 讀取檔案內容
	GlobalToolbox.Register("read_file_content", func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
		pathArg, _ := args["path"].(string)
		finalPath := resolvePath(ctx.WorkDir, pathArg)

		content, err := os.ReadFile(finalPath)
		if err != nil {
			return ActionResult{Success: false, Error: err.Error()}, nil
		}

		data := map[string]interface{}{
			"content":     string(content),
			"path":        pathArg,
			"explanation": args["explanation"],
		}
		return ActionResult{Success: true, Data: data}, nil
	})

	// update_file: 更新或建立檔案
	GlobalToolbox.Register("update_file", func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
		pathArg, _ := args["path"].(string)
		codeArg, _ := args["code"].(string)
		finalPath := resolvePath(ctx.WorkDir, pathArg)

		// 確保目錄存在
		dir := filepath.Dir(finalPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return ActionResult{Success: false, Error: err.Error()}, nil
		}

		// 寫入檔案
		if err := os.WriteFile(finalPath, []byte(codeArg), 0644); err != nil {
			return ActionResult{Success: false, Error: err.Error()}, nil
		}

		data := map[string]interface{}{
			"path":        finalPath,
			"explanation": args["explanation"],
		}
		return ActionResult{Success: true, Data: data}, nil
	})

	// plan: 任務規劃
	GlobalToolbox.Register("plan", func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
		return ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"analysis":   args["analysis"],
				"next_steps": args["next_steps_plan"],
			},
		}, nil
	})

	// spawn_workers: 派發工作 (暫時模擬成功)
	GlobalToolbox.Register("spawn_workers", func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
		return ActionResult{
			Success: true, 
			Data: map[string]interface{}{
				"status": "success",
				"message": "已成功派發 Worker 工具處理任務",
			},
		}, nil
	})
}

/**
 * RunAsyncTool 模擬 TS 版的 runAsyncTool，執行工具並處理狀態同步與事件發送
 * 在 Go 中，我們透過回傳 AIEvent 串流或直接回傳結果來達成
 */
func RunAsyncTool(agentContext *AgentContext, toolName string, args map[string]interface{}) AIEvent {
	// 1. 同步狀態 (可選：模擬進入執行狀態)
	agentContext.UpdateTaskState(StatusActive, 50)

	// 2. 透過 Toolbox 執行工具
	result := GlobalToolbox.ExecuteTool(toolName, args, agentContext)

	// 3. 封裝成 AIEvent 回傳
	resultDescription := fmt.Sprintf("[%s] 執行完成", toolName)
	if !result.Success {
		resultDescription = fmt.Sprintf("[%s] 執行失敗: %s", toolName, result.Error)
	}

	return AIEvent{
		Type: "tool_result",
		Text: resultDescription,
		Action: &ActionData{
			Name: toolName,
			Args: result.Data,
		},
	}
}
