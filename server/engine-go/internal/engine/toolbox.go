package engine

import (
	"fmt"

	"imagine/engine/internal/types"
)

// ToolHandler 定義了工具執行的具體邏輯函式型別
type ToolHandler func(arguments map[string]interface{}, contextInstance types.ToolUseContextInterface) (types.ToolOutput, error)

/**
 * Toolbox 負責管理 Go 版引擎的工具宣告與處理器
 */
type Toolbox struct {
	Declarations []types.ToolDeclaration
	Handlers     map[string]ToolHandler
}

/**
 * GlobalToolbox 全域單例
 */
var GlobalToolbox = &Toolbox{
	Handlers: make(map[string]ToolHandler),
}

/**
 * NewToolbox 根據配置初始化工具箱
 */
func NewToolbox(toolsConfig *ToolsConfig) *Toolbox {
	var declarationList []types.ToolDeclaration
	for name, data := range toolsConfig.Declarations {
		if declarationMap, isSuccessful := data.(map[string]interface{}); isSuccessful {
			declaration := types.ToolDeclaration{
				Name:        name,
				Description: fmt.Sprintf("%v", declarationMap["description"]),
				Type:        fmt.Sprintf("%v", declarationMap["type"]),
			}
			if parameters, isFound := declarationMap["parameters"].(map[string]interface{}); isFound {
				declaration.Parameters = parameters
			}
			declarationList = append(declarationList, declaration)
		}
	}

	GlobalToolbox.Declarations = declarationList
	return GlobalToolbox
}

/**
 * Register 註冊工具處理器
 */
func (toolbox *Toolbox) Register(name string, handler ToolHandler) {
	toolbox.Handlers[name] = handler
}

/**
 * RegisterWithDeclaration 同時註冊處理器與工具宣告
 */
func (toolbox *Toolbox) RegisterWithDeclaration(name string, handler ToolHandler, declaration types.ToolDeclaration) {
	if handler != nil {
		toolbox.Handlers[name] = handler
	}
	toolbox.Declarations = append(toolbox.Declarations, declaration)
}

/**
 * SpawnAgent 建立子代理人任務
 */
func (toolbox *Toolbox) SpawnAgent(role string) string {
	agentID := GenerateID("AGENT")
	GlobalAppStore.CreateTaskWithID(agentID, role, agentID)
	return agentID
}

/**
 * ExecuteTool 是工具執行的統一入口，回傳 ToolOutput（含 RenderToolResult）。
 */
func (toolbox *Toolbox) ExecuteTool(name string, arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ToolOutput, error) {
	fmt.Printf("\n[Toolbox] 🛠️ 執行工具: %s\n", name)

	handler, isFound := toolbox.Handlers[name]
	if !isFound {
		err := fmt.Errorf("找不到名為 %s 的工具處理器", name)
		return types.NewToolOutput(name, types.ActionResult{Success: false, Error: err.Error()}), err
	}

	output, errorValue := handler(arguments, agentContext)
	if errorValue != nil {
		fmt.Printf("[Toolbox] ❌ 執行出錯: %v\n", errorValue)
	}
	return output, errorValue
}

/**
 * RunAsyncTool 在背景執行工具並在完成後通知事件總線 (EventBus)
 */
func (toolbox *Toolbox) RunAsyncTool(agentContext types.ToolUseContextInterface, taskID string, toolName string, arguments map[string]interface{}) string {
	// 立即回傳說明文字給呼叫者
	description := fmt.Sprintf("已啟動非同步工具: %s，任務編號為 %s，請留意後續進度。", toolName, taskID)

	go func() {
		// 1. 實際執行工具邏輯
		output, errorValue := toolbox.ExecuteTool(toolName, arguments, agentContext)
		result := output.GetActionResult()

		// 2. 更新全域 Task 狀態與結果
		status := types.StatusCompleted
		if errorValue != nil {
			status = types.StatusError
		}
		GlobalAppStore.UpdateTaskState(taskID, "status", status)
		GlobalAppStore.UpdateTaskState(taskID, "result", result.Data)

		// 3. 廣播工具完成事件
		GlobalEventBus.Publish("task.finished", types.TaskFinishedEvent{
			TaskID:   taskID,
			ToolName: toolName,
			Result:   result,
		})

		if errorValue != nil {
			fmt.Printf("[Toolbox] ❌ 非同步工具 %s 執行失敗: %v\n", toolName, errorValue)
		}
	}()

	return description
}
