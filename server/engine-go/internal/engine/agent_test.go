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
 * MockProvider 實作 AIProvider 介面，支援多輪測試與不同訊息返回
 */
type MockProvider struct {
	Rounds       [][]types.AIEvent
	currentRound int
	mu           sync.Mutex
	CallCount    int
}

func (m *MockProvider) GenerateStream(ctx context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.CallCount++
	events := make(chan types.AIEvent, 10)
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

/**
 * TestAsyncToolWorkflow 完整測試「非同步工具」的執行、等待、喚醒與讀取流程。
 *
 * 測試流程 (Workflow):
 * 1. 環境初始化: 清理舊的 session 檔案，重置全域 Store、EventBus 與 Toolbox。
 * 2. 工具註冊: 註冊一個類型為 "async" 的工具 `read_file_async`。
 * 3. 任務提交: 透過 GlobalCommandQueue 注入初始任務訊息。
 * 4. 第一階段驗證 (推理循環與等待):
 *    - 驗證 Agent 執行完成第一波推理循環。
 *    - 確認 CallCount 為 2 (Round 1: 呼叫工具; Round 2: AI 回應說明正在處理並結束循環)。
 *    - 此時 Agent 應停止動作，進入等待狀態。
 * 5. 非同步事件觸發:
 *    - 模擬工具背景處理完成，透過 GlobalEventBus 發送 `task.finished` 事件。
 * 6. 第二階段驗證 (喚醒與續推):
 *    - 驗證 Coordinator 接收事件並將訊息塞回隊列，觸發 Agent 續推。
 *    - 確認 CallCount 增加至 3 (Round 3: 讀取工具結果並總結)。
 *    - 驗證 Agent 的歷史紀錄中確實包含系統注入的「工具執行完畢」回報訊息。
 * 7. 最終輸出驗證:
 *    - 檢查助手訊息 (Assistant Messages) 的內容，確保包含非同步工具處理後的關鍵資訊。
 */
func TestAsyncToolWorkflow(t *testing.T) {
	// --- 1. 準備模擬資料 ---
	// Round 1: AI 呼叫非同步工具
	// Round 2: AI 在工具交由背景處理後，回應說明正在讀取
	// Round 3: 被喚醒後，AI 根據最終結果進行總結
	mockEvents := [][]types.AIEvent{
		{
			{
				Type: "action",
				Action: &types.ActionData{
					Name: "read_file_async",
					Args: map[string]interface{}{"path": "test.txt"},
				},
			},
		},
		{
			{Type: "chunk", Text: "我已經啟動了檔案讀取程序，請稍候。"},
		},
		{
			{Type: "chunk", Text: "檔案讀取完畢，內容確認為：系統更新成功。"},
		},
	}
	mockProvider := &MockProvider{Rounds: mockEvents}

	// --- 2. 初始化核心資源 (環境隔離) ---
	_ = os.RemoveAll("sessions") // 徹底清理舊狀態檔案
	GlobalAppStore = NewAppStore()
	GlobalEventBus = NewEventBus()
	GlobalToolbox = &Toolbox{
		Handlers: make(map[string]ToolHandler),
		Declarations: []types.ToolDeclaration{
			{Name: "read_file_async", Type: "async"},
		},
	}
	
	// 使用隨機 AgentID 避免檔案殘留干擾
	testAgentID := GenerateID("TEST-ASYNC")

	// 註冊非同步模擬工具
	GlobalToolbox.Register("read_file_async", func(args map[string]interface{}, ctx *AgentContext) (types.ActionResult, error) {
		fmt.Printf("    [Check 1] 🔧 執行工具: read_file_async, 參數: %v\n", args)
		
		// 模擬耗時行為 (現在 RunAsyncTool 會在背景呼叫此 Handler)
		time.Sleep(1 * time.Second) 
		fmt.Println("    [Check 3] 模擬工具運算完成...")
		
		return types.ActionResult{
			Success: true,
			Data:    map[string]interface{}{"content": "系統更新成功"},
		}, nil
	})

	// 設定全域引擎單例
	GlobalEngine = &AIBuilderEngine{
		Provider: mockProvider,
		Tools:    &ToolsConfig{}, 
	}

	// --- 3. 啟動編排者 (Coordinator) ---
	coordinator := NewCoordinator()
	coordinator.Start()

	// --- 4. 初始化根代理人上下文 (模擬對話 Session 啟動) ---
	wd, _ := os.Getwd()
	agentCtx := CreateAgentContextWithID(testAgentID, "explorer", "請讀取檔案", wd)
	
	initMsg := types.Message{
		Role:      "user",
		Text:      "請讀取檔案",
		AgentID:   testAgentID,
		AgentRole: "explorer",
	}
	agentCtx.AddMessage("user", initMsg)
	
	fmt.Printf("[Test] 🚀 啟動非同步測試流程 (AgentID: %s)...\n", testAgentID)

	// --- 5. 執行第一波推理循環 (透過串流同步等待) ---
	// 直接呼叫 RunAgent 並消耗串流，這會阻塞直到第 1 輪 (Tool Call) 與 第 2 輪 (Ack) 結束
	stream1 := RunAgent(agentCtx)
	fmt.Println("[Test] 📥 正在讀取推論串流...")
	for range stream1 {
		// 分散消耗串流即可，這保證了推論循環完全跑完
	}

	// --- 5.1 關鍵步驟：模擬 Agent 休眠並被清出記憶體 ---
	fmt.Println("[Test] 💤 模擬 Agent 進入休眠，清空記憶體狀態...")
	GlobalAppStore.Lock()
	agentMap := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	delete(agentMap, testAgentID)
	GlobalAppStore.Unlock()
	
	// 優化：確保變數指標不再被誤用
	agentCtx = nil 

	// 驗證第一波推理循環完成 (Check 2)
	// 注意：這裡必須重新 Load 才能檢查狀態
	agentCtx, _ = GetAgentContext(testAgentID)
	if agentCtx == nil {
		// 如果 GetAgentContext 不會自動從磁碟補回，我們手動 Load (模擬 Coordinator 行為)
		agentCtx, _ = LoadAgentContext(testAgentID)
	}

	fmt.Printf("[Check 2] 第一波循環結束斷言, 當前 Round: %d, CallCount: %d\n", agentCtx.Round, mockProvider.CallCount)
	
	if mockProvider.CallCount != 2 {
		t.Errorf("期望第一波循環包含 2 次推論, 得到 %d", mockProvider.CallCount)
	}

	// 檢查每一輪的輸出 (Check 2.1)
	assistantMsgs := agentCtx.Messages[1]
	if len(assistantMsgs) < 2 {
		t.Errorf("期望第一波產生至少 2 條助手訊息, 得到 %d", len(assistantMsgs))
	} else {
		// [Check 2.1] 第 1 輪輸出檢查
		hasToolCall := false
		for _, part := range assistantMsgs[0].Parts {
			if part.FunctionCall != nil && part.FunctionCall.Name == "read_file_async" {
				hasToolCall = true
			}
		}
		if !hasToolCall {
			t.Error("第 1 輪輸出應包含工具調用，但未找到")
		} else {
			fmt.Println("    [Check 2.1] ✅ 第 1 輪輸出檢查: 成功偵測到工具調用")
		}

		// [Check 2.1] 第 2 輪輸出檢查
		expectedText := "啟動了檔案讀取程序"
		if !contains(assistantMsgs[1].Text, expectedText) {
			t.Errorf("第 2 輪輸出應包含文字 %q, 得到: %q", expectedText, assistantMsgs[1].Text)
		} else {
			fmt.Printf("    [Check 2.1] ✅ 第 2 輪輸出檢查: %s\n", assistantMsgs[1].Text)
		}
	}

	// --- 6. 驗證喚醒與續推 (Check 4) ---
	// 注意：喚醒是由非同步工具的 Publish 事件觸發 Coordinator，這部分仍然在背景發生
	fmt.Println("[Check 3] 等待非同步工具完成事件...")
	time.Sleep(2 * time.Second) // 等待工具耗死 (1s) 並讓 Coordinator 接手
	
	// 刷新指標
	agentCtx, _ = GetAgentContext(testAgentID)
	
	fmt.Printf("[Check 4] 喚醒續推後斷言, 當前 Round: %d, CallCount: %d\n", agentCtx.Round, mockProvider.CallCount)

	if mockProvider.CallCount < 3 {
		t.Error("期望 Agent 被喚醒後發起第三次推論 (Round 3)，但未偵測到第 3 次 call")
	}

	// 檢查歷史紀錄中是否正確讀取到了 System 續推訊息
	messages := append(agentCtx.Messages[0], agentCtx.Messages[1]...)
	foundWakeUpMessage := false
	for _, m := range messages {
		if m.Role == "system" && m.Text != "" {
			fmt.Printf("    [Check 4] ✅ 在歷史紀錄中找到喚醒異動: %s\n", m.Text)
			foundWakeUpMessage = true
		}
	}

	if !foundWakeUpMessage {
		t.Error("Agent 續推後，歷史紀錄中找不到系統注入的工具執行報告 (喚醒訊息)")
	}

	// --- 7. 驗證最終輸出給使用者的訊息 (Check 5) ---
	// Assistant 訊息存放在 Messages[1]
	assistantMessages := agentCtx.Messages[1]
	if len(assistantMessages) == 0 {
		t.Error("期待 AI 產生回覆訊息，但助手訊息紀錄為空")
	} else {
		finalResponse := assistantMessages[len(assistantMessages)-1].Text
		fmt.Printf("    [Check 5] ✅ 最終輸出訊息: %s\n", finalResponse)
		
		expectedKeywords := "系統更新成功"
		if !contains(finalResponse, expectedKeywords) {
			t.Errorf("最終回覆未包含預期關鍵字 %q, 得到: %q", expectedKeywords, finalResponse)
		}
	}

	fmt.Println("[Test] ✅ 非同步測試案例全部達成")
}

// 輔助函式：檢查字串包含
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
