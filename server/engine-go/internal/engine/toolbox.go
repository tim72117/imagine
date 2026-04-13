package engine

import (
	"encoding/json"
	"fmt"

	"imagine/engine/internal/types"
)

// ToolHandler 定義了工具執行的具體邏輯函式型別
type ToolHandler func(arguments map[string]interface{}, contextInstance *AgentContext) (types.ActionResult, error)

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
 * SpawnAgent 建立子代理人任務
 */
func (toolbox *Toolbox) SpawnAgent(role string) string {
	agentID := GenerateID("AGENT")
	GlobalAppStore.CreateTaskWithID(agentID, role, agentID)
	return agentID
}

/**
 * ExecuteTool 是工具執行的統一入口。
 */
func (toolbox *Toolbox) ExecuteTool(name string, arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, string, error) {
	fmt.Printf("\n[Toolbox] 🛠️ 執行工具: %s\n", name)

	description := fmt.Sprintf("已開始執行同步工具: %s", name)

	handler, isFound := toolbox.Handlers[name]
	if !isFound {
		errorValue := fmt.Errorf("找不到名為 %s 的工具處理器", name)
		fmt.Printf("[Toolbox] ❌ %v\n", errorValue)
		return types.ActionResult{Success: false, Error: errorValue.Error()}, description, errorValue
	}

	result, errorValue := handler(arguments, agentContext)
	if errorValue != nil {
		fmt.Printf("[Toolbox] ❌ 執行出錯: %v\n", errorValue)
		return result, description, errorValue
	}

	return result, description, nil
}

/**
 * RunAsyncTool 在背景執行工具並在完成後通知事件總線 (EventBus)
 */
func (toolbox *Toolbox) RunAsyncTool(agentContext *AgentContext, taskID string, toolName string, arguments map[string]interface{}) string {
	// 立即回傳說明文字給呼叫者
	description := fmt.Sprintf("已啟動非同步工具: %s，任務編號為 %s，請留意後續進度。", toolName, taskID)

	go func() {
		// 1. 實際執行工具邏輯
		result, _, errorValue := toolbox.ExecuteTool(toolName, arguments, agentContext)

		// 2. 廣播工具完成事件 (Coordinator 會監聽此事件並喚醒 Agent)
		GlobalEventBus.Publish("task.finished", types.TaskFinishedEvent{
			TaskID:   taskID,
			ToolName: toolName,
			Result:   result,
		})

		// 3. 背景任務結束後必須主動 Save
		_ = agentContext.Save()

		if errorValue != nil {
			fmt.Printf("[Toolbox] ❌ 非同步工具 %s 執行失敗: %v\n", toolName, errorValue)
		}
	}()

	return description
}
