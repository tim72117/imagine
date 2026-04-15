package engine

import (
	"context"
	"encoding/json"
	"testing"

	"imagine/engine/internal/types"
)

/**
 * MessageSequenceMockProvider 用於捕捉並驗證每一輪傳入的訊息列表
 */
type MessageSequenceMockProvider struct {
	CapturedMessages [][]types.Message
	Rounds           [][]types.AIEvent
	currentRound     int
}

func (mock *MessageSequenceMockProvider) GenerateStream(ctx context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	copiedMessages := make([]types.Message, len(messages))
	copy(copiedMessages, messages)
	mock.CapturedMessages = append(mock.CapturedMessages, copiedMessages)

	events := make(chan types.AIEvent, 10)
	roundIdx := mock.currentRound
	mock.currentRound++

	go func() {
		defer close(events)
		if roundIdx < len(mock.Rounds) {
			for _, event := range mock.Rounds[roundIdx] {
				events <- event
			}
		}
	}()
	return events, nil
}

/**
 * TestMessageSequenceIncrementalCheck 使用「主序列片段比對」法檢查每輪對話
 */
func TestMessageSequenceIncrementalCheck(t *testing.T) {
	// --- 1. 定義預期的最終完整訊息序列 (Master Sequence) ---
	expectedMasterSequence := []types.Message{
		{Role: "system", Text: "System Prompt"},    // 0: System 指令 (動態組裝，我們比對 Role 即可)
		{Role: "user", Text: "請列出檔案"},         // 1: User 提問
		{Role: "assistant", Text: "正在列出檔案"},   // 2: 第 1 輪產出的助理思考 (含 Action)
		{Role: "system", Text: "已開始執行同步工具: list_files"}, // 3: 工具執行後的描述 (Messages[2])
		{Role: "tool", Tool: "list_files", Text: "{\"files\":[\"a.txt\"]}"}, // 4: 工具原始結果 (Messages[2])
	}

	// --- 2. 準備模擬回覆 ---
	mockEvents := [][]types.AIEvent{
		{
			{Type: "chunk", Text: "正在列出檔案"},
			{
				Type: "action",
				Action: &types.ActionData{
					Name: "list_files",
					Args: map[string]interface{}{"path": "./"},
				},
			},
		},
		{
			{Type: "chunk", Text: "這就是結果。"},
		},
	}
	mockProvider := &MessageSequenceMockProvider{Rounds: mockEvents}

	// --- 3. 初始化測試環境 ---
	Initialize(mockProvider, "../../test_tools.json")
	GlobalToolbox.Register("list_files", func(args map[string]interface{}, ctx types.ToolUseContextInterface) (types.ActionResult, error) {
		return types.ActionResult{Success: true, Data: map[string]interface{}{"files": []string{"a.txt"}}}, nil
	})

	testAgentID := "MSG-SEQ-TEST"
	agentContext := CreateToolUseContext(testAgentID, "explorer", "測試遞增訊息流", "./")
	agentContext.AddMessage("user", types.Message{Role: "user", Text: "請列出檔案", AgentID: testAgentID})

	// --- 4. 執行推論 ---
	agent := NewAgent("explorer", GlobalEngine.Tools, mockProvider)
	eventStream, _ := agent.Run(agentContext, GlobalToolbox.Declarations)
	for range eventStream { }

	// --- 5. 逐輪片段比對驗證 (Slice Comparison) ---
	t.Logf("推論結束，總共發起 %d 輪模型調用", len(mockProvider.CapturedMessages))

	// 每輪預期的訊息數量起點
	// Round 1: [System, User] (len=2)
	// Round 2: [System, User, Assistant, SystemDesc, ToolResult] (len=5)
	expectedStepLengths := []int{2, 5}

	for roundIdx, captured := range mockProvider.CapturedMessages {
		expectedLen := expectedStepLengths[roundIdx]
		
		t.Logf("---- [Round %d] 驗證 (預期長度: %d) ----", roundIdx+1, expectedLen)

		if len(captured) != expectedLen {
			t.Errorf("Round %d: 訊息數量不匹配。預期 %d, 實際 %d", roundIdx+1, expectedLen, len(captured))
		}

		// 逐一內容比對
		for msgIdx, msg := range captured {
			if msgIdx >= expectedLen { break }
			
			expected := expectedMasterSequence[msgIdx]
			
			// 1. 檢查角色
			if msg.Role != expected.Role {
				t.Errorf("Round %d, Msg %d: 角色不匹配。預期 %s, 實際 %s", roundIdx+1, msgIdx, expected.Role, msg.Role)
			}

			// 2. 檢查文字 (System 除外，因為它包含動態工作目錄)
			if expected.Role != "system" || msgIdx > 0 {
				if msg.Text != expected.Text {
					t.Errorf("Round %d, Msg %d: 內容不匹配。\n預期：%q\n實際：%q", roundIdx+1, msgIdx, expected.Text, msg.Text)
				}
			}

			// 3. 檢查工具名稱 (針對 tool 角色)
			if expected.Role == "tool" {
				if msg.Tool != expected.Tool {
					t.Errorf("Round %d, Msg %d: 工具名稱不匹配。預期 %s, 實際 %s", roundIdx+1, msgIdx, expected.Tool, msg.Tool)
				}
			}
		}
	}

	// 輸出最後一輪的完整 JSON 序列以便人工檢閱
	finalJson, _ := json.MarshalIndent(mockProvider.CapturedMessages[len(mockProvider.CapturedMessages)-1], "", "  ")
	t.Logf("最終發送給 LLM 的完整 JSON 序列：\n%s", string(finalJson))

	t.Log("✅ 遞增序列切片比對完成：訊息流完全符合預期金牌路徑。")
}
