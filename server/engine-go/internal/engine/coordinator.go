package engine

import (
	"fmt"
	"os"
	"time"

	"imagine/engine/internal/types"
)

/**
 * Coordinator 負責監聽全域事件 (如任務完成) 並調度對應的代理人執行續推。
 * 它不再持有 AI 資源，而是透過全域引擎進行調度。
 */
var GlobalCommandQueue = make(chan types.Message, 100)

type Coordinator struct {
	isRunning bool
}

func NewCoordinator() *Coordinator {
	return &Coordinator{}
}

/**
 * Start 啟動協調者的背景監聽任務。
 */
func (coordinator *Coordinator) Start() {
	if coordinator.isRunning {
		return
	}
	coordinator.isRunning = true

	fmt.Println("[Coordinator] 🛰️ 事件監聽器已啟動...")

	// 1. 核心職責：訂閱任務完成通知並觸發「續推」
	GlobalEventBus.Subscribe("task.finished", func(payload interface{}) {
		eventData, isSuccessful := payload.(types.TaskFinishedEvent)
		if !isSuccessful {
			return
		}

		taskID := eventData.TaskID
		toolName := eventData.ToolName

		// A. 找出該任務屬於哪個代理人
		agentID, exists := GlobalAppStore.GetAgentIDByTaskID(taskID)
		if !exists {
			fmt.Printf("[Coordinator] ⚠️ 收到任務完成通知但找不到對應代理人: %s\n", taskID)
			return
		}

		// B. 取得代理人角色 (以便重入 RunAgent)
		role := "coordinator" // 預設角色
		
		//【語意變更】：應從 Session/持久化層恢復 Context，而不僅是記憶體
		if context, err := LoadToolUseContext(agentID); err == nil {
			role = context.Role
		}

		fmt.Printf("[Coordinator] 🔗 任務完成，啟動續推: Agent=%s, Tool=%s\n", agentID, toolName)

		// 僅發送喚醒訊息到隊列
		GlobalCommandQueue <- types.Message{
			Role:    "system",
			Text:    fmt.Sprintf("工具 %s 已執行完畢，請根據結果繼續推論。", toolName),
			Time:    time.Now().UnixMilli(),
			AgentID: agentID,
		}
	})

	// 2. 核心監聽隊列：集中處理存儲與調派
	go func() {
		for message := range GlobalCommandQueue {
			agentID := message.AgentID
			fmt.Printf("[Coordinator] ⚡️ 事件喚醒: Agent=%s, Role=%s\n", agentID, message.Role)

			// A. 從 AppStore 獲取當前活躍的單例 (即時對話支流)
			toolUseContext, found := GetToolUseContextFromStore()
			if !found {
				fmt.Printf("[Coordinator] ⚠️ 找不到活躍代理人，忽略訊息 (AgentID: %s)\n", agentID)
				continue
			}

			// B. 將訊息寫入該單例並持久化
			if message.Text != "" {
				toolUseContext.AddMessage(message.Role, message)
				_ = toolUseContext.Save()
			}
				
			// C. 執行調派
			coordinator.dispatch(toolUseContext)
		}
	}()
}

/**
 * dispatch 執行核心推論
 */
func (coordinator *Coordinator) dispatch(toolUseContext *ToolUseContext) {
	// 直接從已備妥的上下文啟動
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

	// 初始建立 (為了讓 AgentID 存在於系統中)
	CreateToolUseContext(agentID, "explorer", userPrompt, workingDirectory)

	// 僅發送任務訊息到隊列，由隊列處理後續 AddMessage 與 Save
	GlobalCommandQueue <- types.Message{
		Role:    "user",
		Text:    userPrompt,
		Time:    time.Now().UnixMilli(),
		AgentID: agentID,
	}
}
