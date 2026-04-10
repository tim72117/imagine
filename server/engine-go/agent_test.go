package engine

import (
	"context"
	"testing"
)

/**
 * MockProvider 實作 AIProvider 介面，供測試使用
 */
type MockProvider struct {
	Events []AIEvent
}

func (m *MockProvider) GenerateStream(ctx context.Context, prompt string, options map[string]interface{}) (<-chan AIEvent, error) {
	events := make(chan AIEvent)
	go func() {
		defer close(events)
		for _, e := range m.Events {
			events <- e
		}
	}()
	return events, nil
}

/**
 * TestAgentSimpleRun 測試 Agent 的基本推論循環 (無工具呼叫)
 */
func TestAgentSimpleRun(t *testing.T) {
	// 1. 準備模擬資料
	mockEvents := []AIEvent{
		{Type: "chunk", Text: "你好！"},
		{Type: "chunk", Text: "我是 AI 助理。"},
	}
	provider := &MockProvider{Events: mockEvents}

	toolsConfig := &ToolsConfig{
		Prompts:   map[string]string{"explorer": "你是一個觀察者"},
		RoleTools: map[string][]string{"explorer": {}},
	}

	// 2. 初始化 Agent 與 Context
	agent := NewAgent("explorer", toolsConfig, provider)
	taskID := CreateTask("explorer", "TEST-AGENT")
	agentContext := &AgentContext{
		TaskID:  taskID,
		AgentID: "TEST-AGENT",
		WorkDir: "/tmp/test",
		Store:   GlobalAppStore,
	}

	// 3. 執行 Agent
	allDeclarations := make(map[string]interface{})
	eventStream, err := agent.Run(agentContext, allDeclarations)
	if err != nil {
		t.Fatalf("Agent.Run failed: %v", err)
	}

	// 4. 驗證產出的事件
	var receivedText string
	for event := range eventStream {
		if event.Type == "chunk" {
			receivedText += event.Text
		}
	}

	expected := "你好！我是 AI 助理。"
	if receivedText != expected {
		t.Errorf("Expected text %q, got %q", expected, receivedText)
	}

	// 驗證狀態
	task := agentContext.GetCurrentTask()
	if task.Status != StatusThinkingCompleted {
		t.Errorf("Expected status %s, got %s", StatusThinkingCompleted, task.Status)
	}
}

/**
 * TestAgentToolExecution 測試 Agent 的工具執行循環
 */
func TestAgentToolExecution(t *testing.T) {
	// 1. 準備模擬資料：第一輪呼叫工具，第二輪結束回答
	mockEvents := []AIEvent{
		{
			Type: "action",
			Action: &ActionData{
				Name: "plan",
				Args: map[string]interface{}{
					"analysis": "測試計畫",
				},
			},
		},
	}
	provider := &MockProvider{Events: mockEvents}

	toolsConfig := &ToolsConfig{
		Prompts:   map[string]string{"explorer": "你是一個觀察者"},
		RoleTools: map[string][]string{"explorer": {"plan"}},
	}

	agent := NewAgent("explorer", toolsConfig, provider)
	taskID := CreateTask("explorer", "TEST-TOOL-AGENT")
	agentContext := &AgentContext{
		TaskID:  taskID,
		AgentID: "TEST-TOOL-AGENT",
		WorkDir: "/tmp/test",
		Store:   GlobalAppStore,
	}

	// 3. 執行
	allDeclarations := make(map[string]interface{})
	eventStream, _ := agent.Run(agentContext, allDeclarations)

	// 4. 檢查是否有產生 tool_result 事件
	toolResultFound := false
	for event := range eventStream {
		if event.Type == "tool_result" && event.Action.Name == "plan" {
			toolResultFound = true
		}
	}

	if !toolResultFound {
		t.Error("Expected tool_result event for 'plan' tool callback, but not found")
	}
}
