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
func (t *Toolbox) Register(name string, handler ToolHandler) {
	t.handlers[name] = handler
}

/**
 * ExecuteTool 執行指定的工具，並自動處理狀態更新與紀錄
 */
func (t *Toolbox) ExecuteTool(name string, args map[string]interface{}, ctx *AgentContext) ActionResult {
	handler, exists := t.handlers[name]
	if !exists {
		return ActionResult{Success: false, Error: fmt.Sprintf("Tool %s not found", name)}
	}

	// 更新任務狀態
	ctx.UpdateTaskState(StatusExecutingTool, 0)

	// 執行工具邏輯
	result, err := handler(args, ctx)
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
	ctx.AddMessage("tool", Message{
		Role: "tool",
		Text: messageText,
		Time: time.Now().UnixMilli(),
		Data: result,
		Tool: name,
	})

	return result
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
	GlobalToolbox.Register("list_files", func(args map[string]interface{}, ctx *AgentContext) (ActionResult, error) {
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
	})

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
