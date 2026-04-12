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
		if context, isSuccessful := GetAgentContext(agentID); isSuccessful {
			role = context.Role
		}
		
		fmt.Printf("[Coordinator] 🔗 任務完成，啟動續推: Agent=%s, Tool=%s\n", agentID, toolName)

		GlobalCommandQueue <- types.Message{
			Role:      "system",
			Text:      fmt.Sprintf("工具 %s 已執行完畢，請根據結果繼續推論。", toolName),
			Time:      time.Now().UnixMilli(),
			AgentID:   agentID,
			AgentRole: role,
		}
	})

	// 2. 監聽隊列指令
	go func() {
		for message := range GlobalCommandQueue {
			fmt.Printf("[Coordinator] ⚡️ 事件喚醒: Agent=%s, Task=%s\n", message.AgentID, message.Text)
			coordinator.dispatch(message)
		}
	}()
}

/**
 * dispatch 處理訊息分發，並恢復代理人上下文
 */
func (coordinator *Coordinator) dispatch(message types.Message) {
	agentID := message.AgentID
	var agentContext *AgentContext

	// 1. 強制從 Session/Store 載入最準確的代理人上下文
	if agentID != "" {
		if context, errorValue := LoadAgentContext(agentID); errorValue == nil {
			agentContext = context
		}
	}

	// 2. 如果不存在，則建立基本上下文
	if agentContext == nil {
		workingDirectory, _ := os.Getwd()
		agentContext = CreateAgentContextWithID(agentID, message.AgentRole, message.Text, workingDirectory)
	}

	// 3. 併入本次訊息
	agentContext.AddMessage("user", message)

	// 4. 調用全域核心執行
	RunAgent(agentContext)
}

/**
 * Submit 提供一個外部手動提交初始任務的入口 (相容舊介面)
 */
func (coordinator *Coordinator) Submit(userPrompt string) {
	agentID := GenerateID("AGENT")
	
	GlobalCommandQueue <- types.Message{
		Role:       "user",
		AgentRole:  "coordinator",
		Text:       userPrompt,
		Time:       time.Now().UnixMilli(),
		AgentID:    agentID,
	}
}
