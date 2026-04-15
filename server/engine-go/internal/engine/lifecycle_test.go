package engine

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"imagine/engine/internal/types"
)

/**
 * MockLifecycleProvider 專門用於測試具有內建迴圈的非同步喚醒流程
 */
type MockLifecycleProvider struct {
	RoundCount int
	WaitGroup  *sync.WaitGroup
	IsAwakened bool
}

func (mock *MockLifecycleProvider) GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent, 10)
	mock.RoundCount++

	currentRound := mock.RoundCount

	go func() {
		defer close(events)

		fmt.Printf("    [Mock] ✨ Provider 第 %d 次調用 (IsAwakened: %v)\n", currentRound, mock.IsAwakened)

		// A. 第一次調用：啟動工具
		if currentRound == 1 {
			events <- types.AIEvent{
				Type: "action",
				Action: &types.ActionData{
					Name: "list_files",
					Args: map[string]interface{}{"path": "./"},
				},
			}
			return
		}

		// B. 內部循環調用 (尚未喚醒)：回傳空以暫停執行
		if !mock.IsAwakened {
			fmt.Println("    [Mock] 💤 收到內建迴圈請求，回傳空內容以模擬掛起...")
			return
		}

		// C. 喚醒後調用：回傳完成
		fmt.Println("    [Mock] 🚀 收到喚醒後請求，發送最終內容。")
		events <- types.AIEvent{Type: "chunk", Text: "這是喚醒後的最終回饋。"}
		mock.WaitGroup.Done()
	}()

	return events, nil
}

/**
 * TestAgentAsyncWakeupLifecycle 測試 Agent 的休眠與喚醒整合流程
 */
func TestAgentAsyncWakeupLifecycle(t *testing.T) {
	testWaitGroup := &sync.WaitGroup{}
	testWaitGroup.Add(1)

	mockProvider := &MockLifecycleProvider{WaitGroup: testWaitGroup, IsAwakened: false}

	coordinator := NewCoordinator()
	coordinator.Start()

	// 1. 初始化引擎並檢查錯誤 (確保 test_tools.json 在正確路徑)
	errorValue := Initialize(mockProvider, "../../test_tools.json")
	if errorValue != nil {
		// 嘗試不同路徑
		errorValue = Initialize(mockProvider, "test_tools.json")
	}

	if errorValue != nil {
		t.Fatalf("❌ 引擎初始化失敗: %v", errorValue)
	}

	// 2. 啟動 Agent
	agentID := GenerateID("LIFECYCLE-AGENT")
	workingDirectory := "./"
	agentContext := CreateToolUseContext(agentID, "coordinator", "模擬指令", workingDirectory)

	fmt.Println("[Test] 🏗️  發起初始執行序列...")
	RunAgent(agentContext)

	// 等待內部迴圈走完
	time.Sleep(1 * time.Second)

	if len(agentContext.Messages[1]) == 0 {
		t.Fatal("❌ 錯誤：第一輪推論未儲存 Assistant 訊息，Agent 可能未正確啟動")
	}
	fmt.Println("[Test] ✅ Agent 成功暫停。")

	// 3. 模擬喚醒事件
	mockProvider.IsAwakened = true
	taskID := "TASK-ASYNC-123"

	// 注入任務狀態到 AppStore 以供 Coordinator 查詢
	GlobalAppStore.CreateTaskWithID(taskID, "coordinator", agentID)

	fmt.Println("[Test] 🔔 模擬發出 task.finished 事件...")
	GlobalEventBus.Publish("task.finished", types.TaskFinishedEvent{
		TaskID:   taskID,
		ToolName: "list_files",
		Result:   types.ActionResult{Success: true},
	})

	// 4. 等待完成
	doneChannel := make(chan struct{})
	go func() {
		testWaitGroup.Wait()
		close(doneChannel)
	}()

	select {
	case <-doneChannel:
		fmt.Println("[Test] 🎉 整合測試成功。")
	case <-time.After(5 * time.Second):
		t.Fatal("❌ 測試逾時：喚醒機制未能成功觸發。")
	}
}
