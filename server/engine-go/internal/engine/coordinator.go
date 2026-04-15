package engine

import (
	"fmt"
	"os"
	"time"

	"imagine/engine/internal/types"
)

/**
 * Coordinator 負責協調整個 AI 引擎的事件流與任務分派。
 */
type Coordinator struct{}

func NewCoordinator() *Coordinator {
	return &Coordinator{}
}

/**
 * Start 啟動協調者的背景監聽任務。
 */
func (coordinator *Coordinator) Start() {
	fmt.Println("[Coordinator] 🛰️ 事件監聽器已啟動...")

	// 1. 監聽任務完成事件 (用於非同步喚醒)
	GlobalEventBus.Subscribe("task.finished", func(data interface{}) {
		event, ok := data.(types.TaskFinishedEvent)
		if !ok {
			return
		}

		taskID := event.TaskID
		toolName := event.ToolName

		// A. 驗證任務並獲取關聯 AgentID
		task, exists := GlobalAppStore.GetTask(taskID)
		if !exists {
			fmt.Printf("[Coordinator] ⚠️ 收到未知任務完成事件: %s\n", taskID)
			return
		}

		agentID := task.AgentID

		fmt.Printf("[Coordinator] 🔗 任務完成，啟動續推: Agent=%s, Tool=%s\n", agentID, toolName)

		// 僅發送喚醒訊息到隊列，後續由隊列負責 AddMessage
		GlobalCommandQueue <- types.Message{
			Role:    "system",
			Text:    fmt.Sprintf("工具 %s 已執行完畢，請根據結果繼續推論。", toolName),
			Time:    time.Now().UnixMilli(),
			AgentID: agentID,
		}
	})

	// 2. 核心監聽隊列：集中處理併入與調派
	go func() {
		for message := range GlobalCommandQueue {
			agentID := message.AgentID
			fmt.Printf("[Coordinator] ⚡️ 事件喚醒: Agent=%s, Role=%s\n", agentID, message.Role)

			// A. 獲取單例 (配合您的要求，若無則建立，並直接加入訊息)
			toolUseContext, found := GetToolUseContextFromStore()
			if !found {
				fmt.Printf("[Coordinator] 🆕 建立新執行環境 (AgentID: %s)\n", agentID)
				workingDirectory, _ := os.Getwd()
				toolUseContext = CreateToolUseContext(agentID, "explorer", message.Text, workingDirectory)
			}

			// B. 直接加入訊息 (不再透過參數傳遞給 Agent)
			if message.Text != "" {
				toolUseContext.AddMessage(message.Role, message)
			}
				
			// C. 執行調派
			coordinator.dispatch(toolUseContext)
		}
	}()
}

/**
 * dispatch 執行核心派發
 */
func (coordinator *Coordinator) dispatch(toolUseContext *ToolUseContext) {
	// 直接啟動
	eventStream := RunAgent(toolUseContext)
	if eventStream != nil {
		go func() {
			for event := range eventStream {
				GlobalEventBus.Publish("agent.inference", map[string]interface{}{
					"agentId": toolUseContext.AgentID,
					"role":    toolUseContext.Role,
					"event":   event,
				})
			}
			
			// 發送推論結束信號
			GlobalEventBus.Publish("agent.inference.done", toolUseContext.AgentID)
		}()
	}
}

/**
 * Submit 提供一個外部手動提交初始任務的入口
 */
func (coordinator *Coordinator) Submit(userPrompt string) {
	agentID := GenerateID("AGENT")
	workingDirectory, _ := os.Getwd()

	// 初始建立
	CreateToolUseContext(agentID, "explorer", userPrompt, workingDirectory)

	// 發送任務訊息到隊列
	GlobalCommandQueue <- types.Message{
		Role:    "user",
		Text:    userPrompt,
		Time:    time.Now().UnixMilli(),
		AgentID: agentID,
	}
}
