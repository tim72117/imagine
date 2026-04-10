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

	go func() {
		for message := range GlobalCommandQueue {
			coordinator.mutex.Lock()
			coordinator.messages = append(coordinator.messages, message)
			coordinator.mutex.Unlock()

			fmt.Printf("[Coordinator] ⚡️ 偵測到指令: %s\n", message.Text)
			coordinator.dispatch(aiProvider, toolsConfig, message)
		}
	}()
}

func (coordinator *Coordinator) dispatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, message types.Message) {
	role := coordinator.determineRole(message)
	if role != "coordinator" {
		fmt.Printf("[Coordinator] 🚀 正在調派 Worker 角色: %s\n", role)
	}

	coordinator.ProcessNextBatch(aiProvider, toolsConfig, role, message.AgentID, message.TaskID, message.ParentAgentID, message)
}

func (coordinator *Coordinator) determineRole(message types.Message) string {
	if strings.HasPrefix(message.Text, "SPAWN:") {
		parts := strings.Split(message.Text, ":")
		for _, part := range parts {
			if strings.HasPrefix(part, "ROLE=") {
				return strings.TrimPrefix(part, "ROLE=")
			}
		}
	}
	return "coordinator"
}

func (coordinator *Coordinator) Submit(userPrompt string) {
	agentID := GenerateID("AGENT")
	
	GlobalCommandQueue <- types.Message{
		Role:    "user",
		Text:    userPrompt,
		Time:    time.Now().UnixMilli(),
		AgentID: agentID,
	}
}

/**
 * ProcessNextBatch 啟動代理人執行任務
 */
func (coordinator *Coordinator) ProcessNextBatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, role string, agentID string, taskID string, parentAgentID string, originalMsg types.Message) {
	
	// 1. 確保 AgentID 存在
	if agentID == "" {
		agentID = GenerateID("AGENT")
	}

	// 2. 併發防護：使用 Store 層級的原子鎖 (TryLockAgent)
	// 如果 Agent 已經在運行中，則將命令「延後」重新入隊
	if !GlobalAppStore.TryLockAgent(agentID) {
		fmt.Printf("[Coordinator] ⏳ Agent (%s) 忙碌中，將指令延後處理...\n", agentID)
		go func() {
			time.Sleep(2 * time.Second) // 延遲後重新入隊
			GlobalCommandQueue <- originalMsg
		}()
		return
	}

	coordinator.mutex.RLock()
	history := make([]types.Message, len(coordinator.messages))
	copy(history, coordinator.messages)
	coordinator.mutex.RUnlock()

	if role == "" {
		role = "explorer"
	}

	agent := NewAgent(role, toolsConfig, aiProvider)
	wd, _ := os.Getwd()
	agentContext := GetOrCreateAgentContext(agentID, taskID, wd)
	
	if parentAgentID != "" {
		GlobalAppStore.RLock()
		agents := GlobalAppStore.state["agents"].(map[string]*AgentContext)
		if parentCtx, exists := agents[parentAgentID]; exists {
			agentContext.ParentCtx = parentCtx
		}
		GlobalAppStore.RUnlock()
	}

	if agentContext.Round == 0 {
		for _, message := range history {
			if message.AgentID == agentID || message.AgentID == "" {
				agentContext.AddMessage("user", message)
			}
		}
	}

	fmt.Printf("[Coordinator] 🚀 啟動 Agent (%s) 推論循環...\n", agentID)
	eventStream, errorVal := agent.Run(agentContext, toolsConfig.Declarations)
	if errorVal != nil {
		fmt.Printf("[Coordinator] ❌ 執行錯誤: %v\n", errorVal)
		GlobalAppStore.UnlockAgent(agentID)
		return
	}

	go func() {
		for event := range eventStream {
			if event.Type == "chunk" {
				fmt.Print(event.Text)
			} else if event.Type == "action" {
				fmt.Printf("\n[%s] 🔧 正在執行工具: %s\n", role, event.Action.Name)
			} else if event.Type == "tool_result" {
				fmt.Printf("\n[%s] ✅ 工具執行結果: %s\n", role, event.Text)
			}
		}
		fmt.Printf("\n[%s] ✨ 任務階段性處理完成。\n", role)
		
		// 完畢後釋放鎖定
		GlobalAppStore.UnlockAgent(agentID)
	}()
}
