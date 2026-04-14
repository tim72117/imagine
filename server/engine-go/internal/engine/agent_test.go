package engine

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"imagine/engine/internal/types"
)

/**
 * MockProvider 實作 AIProvider 介面。
 * 支援透過 Rounds 進行靜態回覆，或在 Rounds 為空時動態分析對話歷史。
 */
type MockProvider struct {
	mu           sync.Mutex
	CallCount    int
	Rounds       [][]types.AIEvent 
	currentRound int
	LastMessages []types.Message // 記錄最後一次收到的訊息以便驗證
}

func (m *MockProvider) GenerateStream(ctx context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	m.mu.Lock()
	m.LastMessages = messages // 擷取訊息內容
	m.mu.Unlock()

	m.CallCount++
	events := make(chan types.AIEvent, 10)

	if len(m.Rounds) > 0 {
		roundIdx := m.currentRound
		m.currentRound++
		go func() {
			defer close(events)
			if roundIdx < len(m.Rounds) {
				for _, e := range m.Rounds[roundIdx] {
					events <- e
				}
			}
		}()
		return events, nil
	}

	historyStr := ""
	for _, msg := range messages {
		historyStr += fmt.Sprintf("[%s]: %s\n", msg.Role, msg.Text)
	}

	go func() {
		defer close(events)

		// 動態判定邏輯：針對 bash 工具進行回覆
		if contains(historyStr, "工具 bash 已執行完畢") {
			if contains(historyStr, "Build Successful") {
				events <- types.AIEvent{Type: "chunk", Text: "專案建置完成，所有產出已就緒。"}
			} else {
				events <- types.AIEvent{Type: "chunk", Text: "異常：我看不到 bash 的執行成功輸出！"}
			}
		} else if m.CallCount == 1 {
			// 第一波：呼叫 bash 進行編譯
			events <- types.AIEvent{
				Type: "action",
				Action: &types.ActionData{
					Name: "bash",
					Args: map[string]interface{}{"command": "npm run build"},
				},
			}
		} else if m.CallCount == 2 {
			// 第二波：回覆處理中
			events <- types.AIEvent{Type: "chunk", Text: "好的，我現在開始執行專案建置指令，這需要一點時間。"}
		}
	}()

	return events, nil
}

/**
 * TestAsyncToolWorkflow 完整測試「非同步工具 (bash)」的執行、等待、喚醒與讀取流程。
 *
 * 測試流程 (Workflow):
 * 1. 環境初始化: 清理舊的 session 檔案，重置全域 Store。
 * 2. 工具註冊: 註冊非同步工具 `bash`。
 * 3. 任務提交: 模擬用戶要求「幫我編譯專案」。
 * 4. 第一階段驗證 (推理循環與等待):
 *    - 確認 CallCount 為 2 (Round 1: 呼叫 bash; Round 2: AI 回應說明啟動中)。
 * 5. 關鍵：休眠模擬 (持久化驗證)。
 * 6. 非同步事件觸發: 模擬 bash 執行結束。
 * 7. 最終輸出驗證 (Pull Model):
 *    - 驗證 Agent 喚醒後是否成功從 Task Store 拉取結果。
 */
func TestAsyncToolWorkflow(t *testing.T) {
	_ = os.RemoveAll("sessions") 
	GlobalAppStore = NewAppStore()
	GlobalEventBus = NewEventBus()
	GlobalToolbox = &Toolbox{
		Handlers: make(map[string]ToolHandler),
		Declarations: []types.ToolDeclaration{
			{Name: "bash", Type: "async"},
		},
	}
	
	testAgentID := GenerateID("TEST-BASH")
	mockProvider := &MockProvider{}

	// 註冊 bash 非同步模擬工具
	GlobalToolbox.Register("bash", func(args map[string]interface{}, ctx types.AgentContextInterface) (types.ActionResult, error) {
		fmt.Printf("    [Check 1] 🔧 執行指令: %v\n", args["command"])
		// 模擬長耗時工作
		time.Sleep(1 * time.Second) 
		fmt.Println("    [Check 3] 模擬背景指令執行完成...")
		
		return types.ActionResult{
			Success: true,
			Data:    map[string]interface{}{"output": "Build Successful", "exitCode": 0},
		}, nil
	})

	GlobalEngine = &AIBuilderEngine{
		Provider: mockProvider,
		Tools:    &ToolsConfig{}, 
	}

	coordinator := NewCoordinator()
	coordinator.Start()

	wd, _ := os.Getwd()
	agentCtx := CreateAgentContextWithID(testAgentID, "coder", "幫我編譯專案", wd)
	agentCtx.AddMessage("user", types.Message{Role: "user", Text: "幫我編譯專案", AgentID: testAgentID})
	
	fmt.Printf("[Test] 🚀 啟動非同步工具測試 (bash, ID: %s)...\n", testAgentID)

	// 執行第一波
	stream1 := RunAgent(agentCtx)
	for range stream1 { }

	// 模擬休眠
	fmt.Println("[Test] 💤 模擬 Agent 進入休眠...")
	GlobalAppStore.Lock()
	agentMap := GlobalAppStore.state["agents"].(map[string]*ToolUseContext)
	delete(agentMap, testAgentID)
	GlobalAppStore.Unlock()

	// 驗證持久化
	agentCtx, _ = LoadAgentContext(testAgentID)
	if mockProvider.CallCount != 2 {
		t.Errorf("期望 2 次推論, 得到 %d", mockProvider.CallCount)
	}

	// 模擬完成
	fmt.Println("[Check 3] 等待 bash 完成事件...")
	time.Sleep(2 * time.Second) 
	
	// 重新載入檢查喚醒
	agentCtx, _ = LoadAgentContext(testAgentID)
	fmt.Printf("[Check 4] 當前 Round: %d, CallCount: %d\n", agentCtx.Round, mockProvider.CallCount)

	if mockProvider.CallCount < 3 {
		t.Error("Agent 喚醒失敗")
	}

	// 驗證最終輸出
	assistantMessages := agentCtx.Messages[1]
	finalResponse := assistantMessages[len(assistantMessages)-1].Text
	fmt.Printf("    [Check 5] 最終回覆: %s\n", finalResponse)
	
	expectedKeywords := "產出已就緒"
	if !contains(finalResponse, expectedKeywords) {
		t.Errorf("最終回覆不符期望, 得到: %q", finalResponse)
	}

	fmt.Println("[Test] ✅ 非同步 bash 工具流程測試通過")
}

/**
 * TestReadFileAttachmentWorkflow 測試同步讀取檔案後，附件是否正確進入下一輪訊息清單。
 */
func TestReadFileAttachmentWorkflow(t *testing.T) {
	_ = os.RemoveAll("sessions")
	testFile := "test_attachment.txt"
	testContent := "來自測試檔案的內容：你好，AI！"
	_ = os.WriteFile(testFile, []byte(testContent), 0644)
	defer os.Remove(testFile)

	GlobalAppStore = NewAppStore()
	
	// 初始化 Mock 並定義行為
	mockProvider := &MockProvider{
		Rounds: [][]types.AIEvent{
			// 第一輪：AI 決定讀檔
			{
				{
					Type: "action",
					Action: &types.ActionData{
						Name: "read_file",
						Args: map[string]interface{}{"path": testFile},
					},
				},
			},
			// 第二輪：AI 看到附件後收工
			{
				{Type: "chunk", Text: "我已經讀到了檔案。"},
			},
		},
	}

	GlobalEngine = &AIBuilderEngine{
		Provider: mockProvider,
		Tools:    &ToolsConfig{},
	}

	wd, _ := os.Getwd()
	agentCtx := CreateAgentContextWithID("TEST-ATTACH", "coder", "讀檔測試", wd)
	
	// 執行測試
	stream := RunAgent(agentCtx)
	for range stream { }

	// 驗證
	if mockProvider.CallCount != 2 {
		t.Fatalf("期望 2 輪推論, 得到 %d", mockProvider.CallCount)
	}

	// 檢查第二輪收到的訊息 (LastMessages)
	hasAttachment := false
	for _, msg := range mockProvider.LastMessages {
		if contains(msg.Text, "目前已載入的檔案快取") && contains(msg.Text, testContent) {
			hasAttachment = true
			break
		}
	}

	if !hasAttachment {
		t.Error("第二輪推論中未發現預期的檔案內容附件")
	} else {
		fmt.Println("[Test] ✅ 檔案內容附件成功進入下一輪訊息清單")
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && func() bool {
		for i := 0; i <= len(s)-len(substr); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	}()
}
