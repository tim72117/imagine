package engine

import (
	"os"
	"strings"
	"testing"

	"imagine/engine/internal/types"
)

const testSourceCode = `package calculator

// Add 計算兩數之和
func Add(a, b int) int {
	return a + b
}

// Multiply 計算兩數之積
func Multiply(a, b int) int {
	return a * b
}

// Subtract 計算兩數之差
func Subtract(a, b int) int {
	return a - b
}
`

/**
 * TestEditFileTool 測試 AI 透過 edit_file 修改多行程式碼的完整流程
 *
 * 情境：使用者要求「將 Add 函式改為回傳 a + b + 1」
 * Mock Provider 回傳 edit_file 工具調用，驗證檔案內容正確更新。
 */
func TestEditFileTool(t *testing.T) {
	// --- 準備測試環境 ---
	testFile := "test_calculator.go"
	if err := os.WriteFile(testFile, []byte(testSourceCode), 0644); err != nil {
		t.Fatalf("無法建立測試檔案: %v", err)
	}
	defer os.Remove(testFile)

	GlobalAppStore = NewAppStore()
	GlobalAgentLoader = NewAgentLoader("../../../.agent")

	Initialize(
		&MockProvider{
			Rounds: [][]types.AIEvent{
				// 第一輪：AI 決定呼叫 edit_file 修改 Add 函式
				{
					{Type: "chunk", Text: "我將修改 Add 函式，使其回傳 a + b + 1。"},
					{
						Type: "action",
						Action: &types.ActionData{
							Name: "edit_file",
							Args: map[string]interface{}{
								"file_path":  testFile,
								"old_string": "func Add(a, b int) int {\n\treturn a + b\n}",
								"new_string": "func Add(a, b int) int {\n\treturn a + b + 1\n}",
							},
						},
					},
				},
				// 第二輪：AI 確認修改完成
				{
					{Type: "chunk", Text: "修改完成，Add 函式現在回傳 a + b + 1。"},
				},
			},
		},
	)

	wd, _ := os.Getwd()
	agentCtx := CreateToolUseContext("TEST-EDIT", "explorer", "將 Add 函式改為回傳 a + b + 1", wd)
	agentCtx.AddMessage("user", types.Message{
		Role:    "user",
		Text:    "將 Add 函式改為回傳 a + b + 1",
		AgentID: "TEST-EDIT",
	})

	// --- 執行推論 ---
	stream := RunAgent(agentCtx)
	for range stream {
	}

	// --- 驗證 ---

	// 1. 確認推論進行了 2 輪
	provider := GlobalEngine.Provider.(*MockProvider)
	if provider.CallCount != 2 {
		t.Errorf("預期 2 輪推論，實際 %d 輪", provider.CallCount)
	}

	// 2. 確認檔案內容已更新
	updatedBytes, err := os.ReadFile(testFile)
	if err != nil {
		t.Fatalf("無法讀取更新後的檔案: %v", err)
	}
	updatedContent := string(updatedBytes)

	if !strings.Contains(updatedContent, "return a + b + 1") {
		t.Errorf("檔案未正確更新，當前內容:\n%s", updatedContent)
	}

	// 3. 確認其他函式未被修改
	if !strings.Contains(updatedContent, "func Multiply(a, b int) int") {
		t.Error("Multiply 函式意外遺失")
	}
	if !strings.Contains(updatedContent, "func Subtract(a, b int) int") {
		t.Error("Subtract 函式意外遺失")
	}

	t.Logf("✅ 檔案更新成功，最終內容:\n%s", updatedContent)
}
