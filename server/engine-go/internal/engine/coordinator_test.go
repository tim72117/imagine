package engine

import (
	"fmt"
	"testing"
	"time"
)

/**
 * TestCoordinator 測試協調者 (Coordinator) 的指令分發與任務啟動
 */
func TestCoordinator(t *testing.T) {
	// 1. 準備模擬資料
	mockEvents := []AIEvent{
		{Type: "chunk", Text: "Coordinator 測試啟動！"},
	}
	provider := &MockProvider{Events: mockEvents}
	
	toolsConfig := &ToolsConfig{
		Prompts:   map[string]string{"explorer": "你是一個指令協調員"},
		RoleTools: map[string][]string{"explorer": {}},
	}

	// 2. 初始化 Coordinator
	coordinator := NewCoordinator()
	coordinator.Start(provider, toolsConfig)

	fmt.Println("    [Test] 🚀 模擬提交用戶指令到 Coordinator...")
	
	// 3. 提交指令
	testPrompt := "啟動自動化測試任務"
	coordinator.Submit(testPrompt)

	// 4. 等待 Coordinator 的非同步處理 (由於是背景 goroutine)
	fmt.Println("    [Test] ⏳ 等待 Coordinator 處理中...")
	time.Sleep(2 * time.Second)

	// 5. 驗證全域狀態 Store 是否已建立 Task
	GlobalAppStore.RLock()
	tasks := GlobalAppStore.state["tasks"].(map[string]*Task)
	taskCount := len(tasks)
	GlobalAppStore.RUnlock()

	if taskCount == 0 {
		t.Error("❌ 錯誤：Coordinator 提交指令後未建立任何 Task")
	} else {
		fmt.Printf("    [Test] ✅ 成功驗證：Coordinator 已成功建立 %d 個任務\n", taskCount)
		
		// 驗證第一個任務的內容
		for id, task := range tasks {
			fmt.Printf("    [Test] 任務內容: ID=%s, Role=%s, Status=%s\n", id, task.Role, task.Status)
			if task.Role != "explorer" {
				t.Errorf("預期角色為 explorer, 但得到 %s", task.Role)
			}
			break
		}
	}
}
