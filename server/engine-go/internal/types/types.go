package types

import (
	"fmt"
	"strings"
	"time"
)

// ToolUseContextInterface 定義了工具需要存取的工具執行內容介面
type ToolUseContextInterface interface {
	GetWorkingDirectory() string
	GetState(key string) interface{}
	SetState(key string, value interface{})
	AddMessage(category string, msg Message)
	GetReadFileState() any
	GetStagedChanges() any
}

// Message 代表對話中的單條訊息
type Message struct {
	Role      string `json:"role"`                // Actor Role: user, system, assistant, tool
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
	ID        string                 `json:"id"`
	AgentID   string                 `json:"agentId"` // 執行此任務的 AgentID
	Role      string                 `json:"role"`
	Goal      string                 `json:"goal,omitempty"`
	Status    TaskStatus             `json:"status"`
	Progress  int                    `json:"progress"`
	Round     int                    `json:"round"`
	Messages  [][]Message            `json:"messages"` // [UserMessages, AssistantMessages]
	CreatedAt time.Time              `json:"createdAt"`
	UpdatedAt time.Time              `json:"updatedAt,omitempty"`
	State     map[string]interface{} `json:"state,omitempty"` // 任務專屬狀態空間
	Data      any                    `json:"data,omitempty"`
}

// ActionResult 工具執行的結果
type ActionResult struct {
	Success bool                   `json:"success"`
	Status  string                 `json:"status,omitempty"`
	Error   string                 `json:"error,omitempty"`
	Data    map[string]interface{} `json:"data,omitempty"`
}

// ToolOutput 定義工具呼叫結束後的輸出介面
type ToolOutput interface {
	RenderToolResult() string
	GetActionResult() ActionResult
}

// BaseToolOutput 提供預設的 ToolOutput 實作
type BaseToolOutput struct {
	ToolName string
	Result   ActionResult
}

func NewToolOutput(toolName string, result ActionResult) *BaseToolOutput {
	return &BaseToolOutput{ToolName: toolName, Result: result}
}

func (o *BaseToolOutput) GetActionResult() ActionResult {
	return o.Result
}

func (o *BaseToolOutput) RenderToolResult() string {
	if !o.Result.Success {
		return fmt.Sprintf("[%s] ❌ %s", o.ToolName, o.Result.Error)
	}
	if len(o.Result.Data) == 0 {
		return fmt.Sprintf("[%s] ✅ 執行成功", o.ToolName)
	}
	// 預設：列出 Data 的頂層 key
	keys := make([]string, 0, len(o.Result.Data))
	for k := range o.Result.Data {
		keys = append(keys, k)
	}
	return fmt.Sprintf("[%s] ✅ 完成（欄位: %s）", o.ToolName, strings.Join(keys, ", "))
}

type ToolDeclaration struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
	Type        string                 `json:"type"` // "sync" or "async"
}

// AIEvent 代表從引擎送出的事件 (文字塊或工具調用)
type AIEvent struct {
	Type   string      `json:"type"` // "chunk" | "action" | "tool_result" | "error"
	Text   string      `json:"text,omitempty"`
	Action *ActionData `json:"action,omitempty"`
	Output ToolOutput  `json:"-"` // tool_result 時攜帶原始輸出，由外層呼叫 RenderToolResult()
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
