package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"imagine/engine/internal/types"
)

/**
 * ToolHandler 定義工具執行的函式原型
 */
type ToolHandler func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error)

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
func (toolbox *Toolbox) ExecuteTool(name string, arguments map[string]interface{}, agentContext *AgentContext) types.ActionResult {
	handler, exists := toolbox.handlers[name]
	if !exists {
		return types.ActionResult{Success: false, Error: fmt.Sprintf("Tool %s not found", name)}
	}

	// 更新任務狀態
	agentContext.SetState("status", types.StatusExecutingTool)
	agentContext.SetState("progress", 0)

	// 執行工具邏輯
	result, errorValue := handler(arguments, agentContext)
	if errorValue != nil {
		result = types.ActionResult{Success: false, Error: errorValue.Error()}
	}

	// 轉化結果為字串紀錄
	resultJSON, _ := json.Marshal(result)
	messageText := fmt.Sprintf("[%s] 執行完成: %s", name, string(resultJSON))
	if !result.Success {
		messageText = fmt.Sprintf("[%s] 執行失敗: %s", name, result.Error)
	}

	// 將結果存入歷史紀錄
	agentContext.AddMessage("tool", types.Message{
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
func (toolbox *Toolbox) Dispatch(name string, arguments map[string]interface{}, agentContext *AgentContext, allDeclarations map[string]interface{}, eventChan chan<- types.AIEvent) {
	// 1. 判定工具類型
	isAsync := false
	if declaration, exists := allDeclarations[name].(map[string]interface{}); exists {
		if toolType, isOk := declaration["type"].(string); isOk && toolType == "async" {
			isAsync = true
		}
	}

	if isAsync {
		// --- 非同步模式 ---
		// A. 立即發送「已派發」事件
		eventChan <- types.AIEvent{
			Type: "tool_result",
			Text: fmt.Sprintf("[%s] 任務已成功派發，正在背景執行中...", name),
			Action: &types.ActionData{
				Name: name,
				Args: map[string]interface{}{"status": "dispatched"},
			},
		}

		// B. 在背景執行實際邏輯
		go func() {
			eventChan <- RunAsyncTool(agentContext, name, arguments)
		}()
	} else {
		// --- 同步模式 ---
		eventChan <- RunAsyncTool(agentContext, name, arguments)
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
	listFilesHandler := func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArg, _ := arguments["path"].(string)
		finalPath := resolvePath(agentContext.WorkDir, pathArg)

		directoryEntries, errorValue := os.ReadDir(finalPath)
		if errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		var fileNames []string
		for _, file := range directoryEntries {
			fileNames = append(fileNames, file.Name())
		}

		data := map[string]interface{}{
			"files":       fileNames,
			"path":        pathArg,
			"explanation": arguments["explanation"],
		}
		return types.ActionResult{Success: true, Data: data}, nil
	}

	GlobalToolbox.Register("list_files", listFilesHandler)
	GlobalToolbox.Register("list_files_async", listFilesHandler)

	// read_file_content: 讀取檔案內容
	GlobalToolbox.Register("read_file_content", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArg, _ := arguments["path"].(string)
		finalPath := resolvePath(agentContext.WorkDir, pathArg)

		content, errorValue := os.ReadFile(finalPath)
		if errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		data := map[string]interface{}{
			"content":     string(content),
			"path":        pathArg,
			"explanation": arguments["explanation"],
		}
		return types.ActionResult{Success: true, Data: data}, nil
	})

	// update_file: 更新或建立檔案
	GlobalToolbox.Register("update_file", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArg, _ := arguments["path"].(string)
		codeArg, _ := arguments["code"].(string)
		finalPath := resolvePath(agentContext.WorkDir, pathArg)

		// 確保目錄存在
		directory := filepath.Dir(finalPath)
		if errorValue := os.MkdirAll(directory, 0755); errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		// 寫入檔案
		if errorValue := os.WriteFile(finalPath, []byte(codeArg), 0644); errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		data := map[string]interface{}{
			"path":        finalPath,
			"explanation": arguments["explanation"],
		}
		return types.ActionResult{Success: true, Data: data}, nil
	})

	// plan: 任務規劃
	GlobalToolbox.Register("plan", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"analysis":   arguments["analysis"],
				"next_steps": arguments["next_steps_plan"],
			},
		}, nil
	})

	// spawn_workers: 派發工作
	GlobalToolbox.Register("spawn_workers", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		workers, isOk := arguments["workers"].([]interface{})
		if !isOk {
			return types.ActionResult{Success: false, Error: "缺少 workers 參數"}, nil
		}

		explanation, _ := arguments["explanation"].(string)
		
		var spawnedTaskDescriptions []string
		for _, workerItem := range workers {
			worker, isOk := workerItem.(map[string]interface{})
			if !isOk {
				continue
			}

			role, _ := worker["role"].(string)
			taskDesc, _ := worker["task"].(string)

			// 1. 為此子任務產生具體的 TaskID 並綁入父 Context
			taskID := GenerateID("TASK")
			agentContext.Tasks = append(agentContext.Tasks, taskID)
			
			// 建立子任務實體
			CreateTaskWithID(taskID, role)

			// 2. 產生此 Worker 的專屬 AgentID
			workerAgentID := GenerateID("AGENT")

			// 3. 提交到全域隊列
			GlobalCommandQueue <- types.Message{
				Role:      "system",
				AgentRole: role,
				Text:      fmt.Sprintf("SPAWN:TASK=%s", taskDesc),
				Time:      time.Now().UnixMilli(),
				AgentID:   workerAgentID,
				TaskID:    taskID,
			}

			spawnedTaskDescriptions = append(spawnedTaskDescriptions, fmt.Sprintf("%s (%s) [ID: %s]", role, taskDesc, taskID))
		}

		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"explanation": explanation,
				"spawned":     spawnedTaskDescriptions,
			},
		}, nil
	})
}

/**
 * RunAsyncTool 模擬 TS 版的 runAsyncTool，執行工具並處理狀態同步與事件發送
 */
func RunAsyncTool(agentContext *AgentContext, toolName string, arguments map[string]interface{}) types.AIEvent {
	// 1. 同步狀態 (可選：模擬進入執行狀態)
	agentContext.SetState("status", types.StatusActive)
	agentContext.SetState("progress", 50)

	// 2. 透過 Toolbox 執行工具
	result := GlobalToolbox.ExecuteTool(toolName, arguments, agentContext)

	// 3. 封裝成 AIEvent 回傳
	resultDescription := fmt.Sprintf("[%s] 執行完成", toolName)
	if !result.Success {
		resultDescription = fmt.Sprintf("[%s] 執行失敗: %s", toolName, result.Error)
	}

	event := types.AIEvent{
		Type: "tool_result",
		Text: resultDescription,
		Action: &types.ActionData{
			Name: toolName,
			Args: result.Data,
		},
	}

	// 4. (核心改動) 工具完成後僅廣播事件，不再直接干涉調度隊列
	fmt.Printf("[%s] (Debug) 期待 5 秒後廣播完成事件...\n", toolName)
	go func() {
		time.Sleep(5 * time.Second)

		// 廣播工具完成事件到全域總線
		GlobalEventBus.Publish("asynchronousTool.finished", map[string]interface{}{
			"agentId":  agentContext.AgentID,
			"taskId":   agentContext.TaskID,
			"toolName": toolName,
			"result":   result,
		})
	}()

	return event
}
