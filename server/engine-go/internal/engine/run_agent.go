package engine

import (
	"fmt"
	"os"
	"time"

	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

/**
 * AIBuilderEngine 是注入資源的容器
 */
type AIBuilderEngine struct {
	Provider provider.AIProvider
}

var GlobalEngine *AIBuilderEngine

/**
 * Initialize 執行全域單例注入。工具宣告由各工具檔的 Declaration 自動載入。
 */
func Initialize(aiProvider provider.AIProvider) error {
	GlobalEngine = &AIBuilderEngine{
		Provider: aiProvider,
	}

	fmt.Printf("[Engine] ✅ 全域引擎初始化完成 (Provider: %T, 工具數: %d)\n", aiProvider, len(GlobalToolbox.Declarations))
	return nil
}

/**
 * RunWithAgentID 是系統的高層進入端。
 */
func RunWithAgentID(agentID string, role string, task string) {
	if GlobalEngine == nil {
		fmt.Println("[Engine] ⚠️ 警告：引擎尚未初始化，請先呼叫 engine.Initialize()")
		return
	}

	// 1. 準備上下文
	workingDirectory, _ := os.Getwd()
	agentContext := CreateToolUseContext(agentID, role, task, workingDirectory)
	
	// 直接併入初始訊息 (不經過隊列，維持最簡潔的啟動路徑)
	agentContext.AddMessage("user", types.Message{
		Role:    "user",
		Text:    task,
		Time:    time.Now().UnixMilli(),
		AgentID: agentID,
	})

	// 2. 直接調用核心執行器
	RunAgent(agentContext)
}

/**
 * RunAgent 負責核心的「推論執行」流程。
 */
func RunAgent(toolUseContext *ToolUseContext) <-chan types.AIEvent {
	if GlobalEngine == nil {
		return nil
	}

	role := toolUseContext.Role
	agentID := toolUseContext.AgentID

	// 初始化核心推論 Agent
	agent := NewAgent(role, GlobalEngine.Provider)

	fmt.Printf("[Engine] ⚡️ 啟動 Agent [%s] (%s) 推論循環...\n", role, agentID)

	// 執行推論
	eventStream, errorValue := agent.Run(toolUseContext, GlobalToolbox.Declarations)
	if errorValue != nil {
		fmt.Printf("[Engine] ❌ 啟動失敗: %v\n", errorValue)
		return nil
	}

	return eventStream
}
