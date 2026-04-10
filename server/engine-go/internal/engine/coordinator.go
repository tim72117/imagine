package engine

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

/**
 * Coordinator 負責協調整個 AI 系統的運作
 */
var GlobalCommandQueue = make(chan types.Message, 100)

type Coordinator struct {
	mutex     sync.RWMutex
	messages  []types.Message
	isRunning bool
}

func NewCoordinator() *Coordinator {
	return &Coordinator{
		messages: []types.Message{},
	}
}

func (coordinator *Coordinator) Start(aiProvider provider.AIProvider, toolsConfig *ToolsConfig) {
	coordinator.mutex.Lock()
	if coordinator.isRunning {
		coordinator.mutex.Unlock()
		return
	}
	coordinator.isRunning = true
	coordinator.mutex.Unlock()

	fmt.Println("[Coordinator] 🛰️ Go 版背景監聽器已啟動...")

	// 1. 訂閱非同步工具完成事件
	GlobalEventBus.Subscribe("asynchronousTool.finished", func(payload interface{}) {
		eventData, isSuccessful := payload.(map[string]interface{})
		if !isSuccessful {
			return
		}
		
		agentID, _ := eventData["agentId"].(string)
		taskID, _ := eventData["taskId"].(string)
		toolName, _ := eventData["toolName"].(string)
		
		var agentRole string
		GlobalAppStore.RLock()
		if agentMap, ok := GlobalAppStore.state["agents"].(map[string]*AgentContext); ok {
			if ctx, exists := agentMap[agentID]; exists {
				agentRole = ctx.Role
			}
		}
		GlobalAppStore.RUnlock()

		GlobalCommandQueue <- types.Message{
			Role:      "system",
			AgentRole: agentRole,
			Text:      fmt.Sprintf("工具 %s 已執行完畢，請根據結果繼續推論。", toolName),
			Time:      time.Now().UnixMilli(),
			AgentID:   agentID,
			TaskID:    taskID,
		}
	})

	// 2. 訂閱 Agent 結束事件 (維持發送 TASK_COMPLETED 協議不變)
	GlobalEventBus.Subscribe("agent.finished", func(payload interface{}) {
		eventData, isSuccessful := payload.(map[string]interface{})
		if !isSuccessful {
			return
		}
		
		agentID, _ := eventData["agentId"].(string)
		taskID, _ := eventData["taskId"].(string)
		isFinished, _ := eventData["isFinished"].(bool)
		
		if taskID != "" && isFinished {
			GlobalCommandQueue <- types.Message{
				Role:    "system",
				Text:    fmt.Sprintf("TASK_COMPLETED:ID=%s", taskID),
				Time:    time.Now().UnixMilli(),
				AgentID: agentID,
				TaskID:  taskID,
			}
		}
	})

	go func() {
		for message := range GlobalCommandQueue {
			coordinator.mutex.Lock()
			coordinator.messages = append(coordinator.messages, message)
			coordinator.mutex.Unlock()

			fmt.Printf("[Coordinator] ⚡️ 偵測到指令: %s\n", message.Text)
			
			// 統一入口：所有訊息 (含結案協議) 都直接進入 ProcessNextBatch
			coordinator.dispatch(aiProvider, toolsConfig, message)
		}
	}()
}

/**
 * dispatch 處理根代理人與任何訊息的進入點
 */
func (coordinator *Coordinator) dispatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, message types.Message) {
	agentRole := message.AgentRole
	if agentRole == "" {
		if message.TaskID != "" {
			agentRole = "worker"
		} else {
			agentRole = "coordinator"
		}
	}
	coordinator.ProcessNextBatch(aiProvider, toolsConfig, agentRole, message.AgentID, message.TaskID, message)
}

func (coordinator *Coordinator) Submit(userPrompt string) {
	agentID := GenerateID("AGENT")
	GlobalCommandQueue <- types.Message{
		Role:      "user",
		AgentRole: "coordinator",
		Text:      userPrompt,
		Time:      time.Now().UnixMilli(),
		AgentID:   agentID,
	}
}

/**
 * ProcessNextBatch 現在負責執行推論與「結案審核」
 */
func (coordinator *Coordinator) ProcessNextBatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, role string, agentID string, taskID string, originalMessage types.Message) {
	
	// [結案處理] 如果訊息是結案通知，執行層級檢查判斷是否喚醒父代
	if strings.HasPrefix(originalMessage.Text, "TASK_COMPLETED:") {
		parentContext, exists := GlobalAppStore.GetParentContext(taskID)
		if exists && parentContext.IsAllTasksCompleted() {
			fmt.Printf("[Coordinator] 🔔 雇主 (%s) 的所有子任務全數完成，發送喚醒通知。\n", parentContext.AgentID)
			GlobalCommandQueue <- types.Message{
				Role:      "system",
				AgentRole: parentContext.Role,
				Text:      "所有子任務已完成，請匯總進度。",
				Time:      time.Now().UnixMilli(),
				AgentID:   parentContext.AgentID,
				TaskID:    parentContext.TaskID,
			}
		}
		// 結案訊息處理完畢，不進入後續推論
		return
	}

	if agentID == "" {
		agentID = GenerateID("AGENT")
	}

	if !GlobalAppStore.TryLockAgent(agentID) {
		go func() {
			time.Sleep(2 * time.Second)
			GlobalCommandQueue <- originalMessage
		}()
		return
	}

	coordinator.mutex.RLock()
	history := make([]types.Message, len(coordinator.messages))
	copy(history, coordinator.messages)
	coordinator.mutex.RUnlock()

	agent := NewAgent(role, toolsConfig, aiProvider)
	workingDirectory, _ := os.Getwd()
	agentContext := GetOrCreateAgentContext(agentID, taskID, role, workingDirectory)

	if agentContext.Round == 0 {
		for _, message := range history {
			if message.AgentID == agentID || message.AgentID == "" {
				agentContext.AddMessage("user", message)
			}
		}
	}

	fmt.Printf("[Coordinator] 🚀 啟動 Agent (%s) 推論循環...\n", agentID)
	eventStream, errorValue := agent.Run(agentContext, toolsConfig.Declarations)
	if errorValue != nil {
		GlobalAppStore.UnlockAgent(agentID)
		return
	}

	go func() {
		for event := range eventStream {
			if event.Type == "chunk" {
				fmt.Print(event.Text)
			}
		}
		GlobalAppStore.UnlockAgent(agentID)

		GlobalEventBus.Publish("agent.finished", map[string]interface{}{
			"agentId":    agentID,
			"role":       role,
			"taskId":     taskID,
			"isFinished": agentContext.IsFinished,
		})
	}()
}
