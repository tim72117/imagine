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
 * Coordinator 負責協調整個 AI 系統的運作，對應 TS 中的 Coordinator
 * 它監聽命令隊列，並負責啟動代理人任務
 */
// GlobalCommandQueue 全域核心命令隊列，所有組件皆可透過此隊列提交指令
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

/**
 * Start 啟動背景監聽器，持續處理進入隊列的命令
 */
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
			// 將新命令加入歷史紀錄
			coordinator.messages = append(coordinator.messages, message)
			coordinator.mutex.Unlock()

			fmt.Printf("[Coordinator] ⚡️ 偵測到指令: %s\n", message.Text)
			
			// 分派任務
			coordinator.dispatch(aiProvider, toolsConfig, message)
		}
	}()

}

/**
 * dispatch 處理指令的分發，決定由哪個角色來執行
 */
func (coordinator *Coordinator) dispatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, message types.Message) {
	role := coordinator.determineRole(message)
	if role != "coordinator" {
		fmt.Printf("[Coordinator] 🚀 正在調派 Worker 角色: %s\n", role)
	}

	// 執行批次處理
	coordinator.ProcessNextBatch(aiProvider, toolsConfig, role)
}

/**
 * determineRole 解析訊息內容，判定應該使用的角色
 */
func (coordinator *Coordinator) determineRole(message types.Message) string {
	if strings.HasPrefix(message.Text, "SPAWN:") {
		parts := strings.Split(message.Text, ":")
		for _, part := range parts {
			if strings.HasPrefix(part, "ROLE=") {
				return strings.TrimPrefix(part, "ROLE=")
			}
		}
	}
	return "coordinator" // 預設為協調者
}

/**
 * Submit 發送新指令到隊列中
 */
func (coordinator *Coordinator) Submit(userPrompt string) {
	GlobalCommandQueue <- types.Message{
		Role: "user",
		Text: userPrompt,
		Time: time.Now().UnixMilli(),
	}
}

/**
 * ProcessNextBatch 啟動代理人執行任務
 */
func (coordinator *Coordinator) ProcessNextBatch(aiProvider provider.AIProvider, toolsConfig *ToolsConfig, role string) {
	coordinator.mutex.RLock()
	// 擷取目前的歷史紀錄
	history := make([]types.Message, len(coordinator.messages))
	copy(history, coordinator.messages)
	coordinator.mutex.RUnlock()

	// 確保角色有效
	if role == "" {
		role = "explorer"
	}

	// 1. 建立 Agent 實體
	agent := NewAgent(role, toolsConfig, aiProvider)

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

	// 5. 消耗串流
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
	}()
}
