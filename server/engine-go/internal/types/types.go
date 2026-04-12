package types

import (
	"time"
)

// Message 代表對話中的單條訊息
type Message struct {
	Role      string `json:"role"`      // Actor Role: user, system, assistant, tool
	AgentRole string `json:"agentRole,omitempty"` // 代理人承擔的角色名稱 (如 explorer, coder)
	Text      string `json:"text"`
	Parts     []Part `json:"parts,omitempty"`
	Time      int64  `json:"time"`
	Data      any    `json:"data,omitempty"`
	Tool      string `json:"tool,omitempty"`
	AgentID   string `json:"agentId,omitempty"`
}

// Part 代表訊息中的組件 (文字或工具調用)
type Part struct {
	Text         string        `json:"text,omitempty"`
	FunctionCall *FunctionCall `json:"functionCall,omitempty"`
}

// FunctionCall 代表一個具體的工具調用請求
type FunctionCall struct {
	Name string      `json:"name"`
	Args interface{} `json:"args"`
}

// TaskStatus 定義任務的各種狀態
type TaskStatus string

const (
	StatusPending           TaskStatus = "pending"
	StatusActive            TaskStatus = "active"
	StatusThinking          TaskStatus = "thinking"
	StatusThinkingCompleted TaskStatus = "thinking_completed"
	StatusExecutingTool     TaskStatus = "executing_tool"
	StatusWaiting           TaskStatus = "waiting"
	StatusCompleted         TaskStatus = "completed"
	StatusError             TaskStatus = "error"
	StatusToolCompleted     TaskStatus = "tool_completed"
	StatusToolFailed        TaskStatus = "tool_failed"
)

// Task 代表一個具體的代理人任務執行實體
type Task struct {
	ID        string     `json:"id"`
	AgentID   string     `json:"agentId"` // 執行此任務的 AgentID
	Role          string     `json:"role"`
	Goal          string     `json:"goal,omitempty"`
	Status        TaskStatus `json:"status"`
	Progress      int        `json:"progress"`
	Round         int        `json:"round"`
	Messages      [][]Message `json:"messages"` // [UserMessages, AssistantMessages]
	CreatedAt     time.Time              `json:"createdAt"`
	UpdatedAt     time.Time              `json:"updatedAt,omitempty"`
	State         map[string]interface{} `json:"state,omitempty"` // 任務專屬狀態空間
	Data          any                    `json:"data,omitempty"`
}

// ActionResult 工具執行的結果
type ActionResult struct {
	Success bool                   `json:"success"`
	Status  string                 `json:"status,omitempty"`
	Error   string                 `json:"error,omitempty"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

type ToolDeclaration struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
	Type        string                 `json:"type"` // "sync" or "async"
}

// AIEvent 代表從引擎送出的事件 (文字塊或工具調用)
type AIEvent struct {
	Type   string      `json:"type"` // "chunk" 或 "action"
	Text   string      `json:"text,omitempty"`
	Action *ActionData `json:"action,omitempty"`
}

// ActionData 代表工具調用的具體名稱與參數
type ActionData struct {
	Name string      `json:"name"`
	Args interface{} `json:"args"`
}

// TaskFinishedEvent 代表工具執行完畢後的事件 Payload
type TaskFinishedEvent struct {
	TaskID   string       `json:"taskId"`
	ToolName string       `json:"toolName"`
	Result   ActionResult `json:"result"`
}
