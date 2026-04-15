package engine

import (
	"fmt"
	"testing"
	"time"

	"imagine/engine/internal/types"
)

/**
 * TestCoordinator 測試協調者 (Coordinator) 的指令分發與任務啟動
 */
func TestCoordinator(t *testing.T) {
	// 1. 準備模擬資料
	mockEvents := [][]types.AIEvent{
		{
			{Type: "chunk", Text: "Coordinator 測試啟動！"},
		},
	}
	provider := &MockProvider{Rounds: mockEvents}

	// 關鍵：在重構後的架構中，Coordinator 依賴全域單例
	GlobalEngine = &AIBuilderEngine{
		Provider: provider,
	}
	GlobalAppStore = NewAppStore()
	GlobalEventBus = NewEventBus()
	GlobalToolbox = &Toolbox{Handlers: make(map[string]ToolHandler)}

	// 2. 初始化 Coordinator
	coordinator := NewCoordinator()
	coordinator.Start() // 新版不需再傳入參數

	fmt.Println("    [Test] 🚀 模擬提交用戶指令到 Coordinator...")

	// 3. 提交指令
	testPrompt := "啟動自動化測試任務"
	coordinator.Submit(testPrompt)

	// 4. 等待 Coordinator 的非同步處理 (由於是背景 goroutine)
	fmt.Println("    [Test] ⏳ 等待 Coordinator 處理中...")
	time.Sleep(1 * time.Second)

	// 5. 驗證全域狀態 Store 是否已建立 Task
	GlobalAppStore.RLock()
	tasks := GlobalAppStore.state["tasks"].(map[string]*types.Task)
	taskCount := len(tasks)
	GlobalAppStore.RUnlock()

	if taskCount == 0 {
		t.Error("❌ 錯誤：Coordinator 提交指令後未建立任何 Task")
	} else {
		fmt.Printf("    [Test] ✅ 成功驗證：Coordinator 已成功建立 %d 個任務\n", taskCount)

		// 驗證角色
		found := false
		for _, task := range tasks {
			if task.Role == "coordinator" {
				found = true
				break
			}
		}
		if !found {
			t.Error("預期角色為 coordinator, 找不到匹配的任務")
		}
	}
}
