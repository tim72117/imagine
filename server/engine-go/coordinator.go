package engine

import (
	"fmt"
	"os"
	"sync"
	"time"
)

/**
 * Coordinator 負責協調整個 AI 系統的運作，對應 TS 中的 Coordinator
 * 它監聽命令隊列，並負責啟動代理人任務
 */
type Coordinator struct {
	mutex        sync.RWMutex
	messages     []Message
	commandQueue chan Message
	isRunning    bool
}

func NewCoordinator() *Coordinator {
	return &Coordinator{
		commandQueue: make(chan Message, 100),
		messages:     []Message{},
	}
}

/**
 * Start 啟動背景監聽器，持續處理進入隊列的命令
 */
func (coordinator *Coordinator) Start(provider AIProvider, toolsConfig *ToolsConfig) {
	coordinator.mutex.Lock()
	if coordinator.isRunning {
		coordinator.mutex.Unlock()
		return
	}
	coordinator.isRunning = true
	coordinator.mutex.Unlock()

	fmt.Println("[Coordinator] 🛰️ Go 版背景監聽器已啟動...")

	go func() {
		for message := range coordinator.commandQueue {
			coordinator.mutex.Lock()
			// 將新命令加入歷史紀錄
			coordinator.messages = append(coordinator.messages, message)
			coordinator.mutex.Unlock()

			fmt.Printf("[Coordinator] ⚡️ 偵測到指令: %s\n", message.Text)
			
			// 執行批次處理
			coordinator.ProcessNextBatch(provider, toolsConfig, "explorer") // 預設使用協調者角色
		}
	}()
}

/**
 * Submit 發送新指令到隊列中
 */
func (coordinator *Coordinator) Submit(userPrompt string) {
	coordinator.commandQueue <- Message{
		Role: "user",
		Text: userPrompt,
		Time: time.Now().UnixMilli(),
	}
}

/**
 * ProcessNextBatch 啟動代理人執行任務
 */
func (coordinator *Coordinator) ProcessNextBatch(provider AIProvider, toolsConfig *ToolsConfig, role string) {
	coordinator.mutex.RLock()
	// 擷取目前的歷史紀錄
	history := make([]Message, len(coordinator.messages))
	copy(history, coordinator.messages)
	coordinator.mutex.RUnlock()

	// 確保角色有效
	if role == "" {
		role = "explorer"
	}

	// 1. 建立 Agent 實體
	agent := NewAgent(role, toolsConfig, provider)

	// 2. 建立任務與上下文
	wd, _ := os.Getwd()
	taskID := CreateTask(role, "MASTER-GO")
	agentContext := &AgentContext{
		TaskID:  taskID,
		AgentID: "MASTER-AGENT",
		WorkDir: wd, // 使用當前命令執行目錄
		Store:   GlobalAppStore,
	}

	// 3. 注入歷史紀錄到 Store
	for _, message := range history {
		agentContext.AddMessage("user", message)
	}

	// 4. 執行任務循環
	fmt.Println("[Coordinator] 🚀 啟動 Go 版 Agent 推論循環...")
	eventStream, errorVal := agent.Run(agentContext, toolsConfig.Declarations)
	if errorVal != nil {
		fmt.Printf("[Coordinator] ❌ 執行錯誤: %v\n", errorVal)
		return
	}

	// 5. 消耗串流 (在 Go 內部暫時只做列印，未來可對接 SSE 或 WebSocket)
	go func() {
		for event := range eventStream {
			if event.Type == "chunk" {
				fmt.Print(event.Text)
			} else if event.Type == "action" {
				fmt.Printf("\n[Coordinator] 🔧 Agent 正在執行工具: %s\n", event.Action.Name)
			} else if event.Type == "tool_result" {
				fmt.Printf("\n[Coordinator] ✅ 工具執行結果: %s\n", event.Text)
			}
		}
		fmt.Println("\n[Coordinator] ✨ 任務階段性處理完成。")
	}()
}
