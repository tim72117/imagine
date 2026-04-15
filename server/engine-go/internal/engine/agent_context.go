package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
)

/**
 * ToolUseContext 定義了代理人執行的狀態容器。
 * 遵循原則：不自帶鎖 (No Lock)，併發安全由 Agent 執行序確保。
 */
type ToolUseContext struct {
	AgentID          string            `json:"agentId"`
	Role             string            `json:"role"`
	Goal             string            `json:"goal"`
	Tasks            []string          `json:"tasks"`
	Round            int               `json:"round"`
	WorkingDirectory string            `json:"workingDirectory"`
	Messages         [][]types.Message `json:"messages"` // [0: 歷史, 1: 思考中, 2: 暫存結果]
	IsRunning        bool              `json:"isRunning"`
	IsFinished       bool              `json:"isFinished"`
	Status           types.TaskStatus  `json:"status"`
	Store            *AppStore         `json:"-"`

	GetStateFunc func(key string) (interface{}, bool) `json:"-"`
	SetStateFunc func(key string, value interface{})  `json:"-"`

	// 執行期狀態
	readFileState *tools.ReadFileState `json:"-"`
	stagedChanges *tools.StagedChanges `json:"-"`
}

func (contextInstance *ToolUseContext) GetReadFileState() any {
	return contextInstance.readFileState
}

func (contextInstance *ToolUseContext) GetStagedChanges() any {
	return contextInstance.stagedChanges
}

func (contextInstance *ToolUseContext) GetWorkingDirectory() string {
	return contextInstance.WorkingDirectory
}

func (contextInstance *ToolUseContext) GetState(key string) interface{} {
	if contextInstance.GetStateFunc == nil {
		return nil
	}
	value, _ := contextInstance.GetStateFunc(key)
	return value
}

func (contextInstance *ToolUseContext) SetState(key string, value interface{}) {
	if contextInstance.SetStateFunc != nil {
		contextInstance.SetStateFunc(key, value)
	}
}

/**
 * GetToolUseContextFromStore 從 AppStore 獲取當前活躍的單例。
 */
func GetToolUseContextFromStore() (*ToolUseContext, bool) {
	GlobalAppStore.RLock()
	defer GlobalAppStore.RUnlock()

	contextInstance, _ := GlobalAppStore.state["agent"].(*ToolUseContext)
	if contextInstance == nil {
		return nil, false
	}

	return contextInstance, true
}

/**
 * CreateToolUseContext 初始化並註冊單例。
 */
func CreateToolUseContext(agentID string, role string, goal string, workingDirectory string) *ToolUseContext {
	if agentID == "" {
		agentID = GenerateID("AGENT")
	}

	contextInstance := &ToolUseContext{
		AgentID:          agentID,
		Role:             role,
		Goal:             goal,
		Tasks:            []string{},
		Round:            0,
		WorkingDirectory: workingDirectory,
		Messages:         [][]types.Message{{}, {}, {}},
		IsRunning:        false,
		IsFinished:       false,
		Status:           types.StatusPending,
		readFileState:    tools.NewReadFileState(),
		stagedChanges:    tools.NewStagedChanges(),
	}

	// 繼承歷史 (AppStore 的鎖仍需保留以保護全域狀態)
	GlobalAppStore.Lock()
	if existing, exists := GlobalAppStore.state["agent"].(*ToolUseContext); exists && existing != nil {
		for i := 0; i < 3; i++ {
			contextInstance.Messages[i] = append([]types.Message{}, existing.Messages[i]...)
		}
	}
	GlobalAppStore.state["agent"] = contextInstance
	GlobalAppStore.Unlock()

	contextInstance.bindStateFunctions()
	return contextInstance
}

/**
 * LoadToolUseContext 從持久化層恢復 (預留介面)。
 */
func LoadToolUseContext(agentID string) (*ToolUseContext, error) {
	if existing, found := GetToolUseContextFromStore(); found {
		return existing, nil
	}
	return nil, fmt.Errorf("LoadToolUseContext has not been implemented yet")
}

/**
 * bindStateFunctions 繫結狀態存取函式。
 */
func (contextInstance *ToolUseContext) bindStateFunctions() {
	task, isFound := GlobalAppStore.GetTask(contextInstance.AgentID)

	if !isFound {
		contextInstance.GetStateFunc = GlobalAppStore.GetState
		contextInstance.SetStateFunc = GlobalAppStore.SetState
		return
	}

	taskID := task.ID
	contextInstance.GetStateFunc = func(key string) (interface{}, bool) {
		currentTask, isSuccessful := GlobalAppStore.GetTask(taskID)
		if !isSuccessful {
			return nil, false
		}

		switch key {
		case "status":
			return currentTask.Status, true
		default:
			return GlobalAppStore.GetState(key)
		}
	}

	contextInstance.SetStateFunc = func(key string, value interface{}) {
		switch key {
		case "status":
			if status, isSuccessful := value.(types.TaskStatus); isSuccessful {
				GlobalAppStore.UpdateTaskStatus(taskID, status)
			}
		default:
			GlobalAppStore.SetState(key, value)
		}
	}
}

/**
 * AddMessage 將訊息存入指定分區。
 * 注意：不帶鎖，調用者須自負執行序安全。
 */
func (contextInstance *ToolUseContext) AddMessage(role string, message types.Message) {
	switch role {
	case "assistant":
		contextInstance.Messages[1] = append(contextInstance.Messages[1], message)
	case "tool", "system":
		contextInstance.Messages[2] = append(contextInstance.Messages[2], message)
	default:
		contextInstance.Messages[0] = append(contextInstance.Messages[0], message)
	}
}

/**
 * CommitRound 將本輪結果併入歷史。
 */
func (contextInstance *ToolUseContext) CommitRound() {
	contextInstance.Messages[0] = append(contextInstance.Messages[0], contextInstance.Messages[1]...)
	contextInstance.Messages[0] = append(contextInstance.Messages[0], contextInstance.Messages[2]...)

	contextInstance.Messages[1] = []types.Message{}
	contextInstance.Messages[2] = []types.Message{}
}

/**
 * Save 執行增量持久化。
 */
func (contextInstance *ToolUseContext) Save() error {
	sessionDirectory := "sessions"
	_ = os.MkdirAll(sessionDirectory, 0755)

	// 過濾僅屬於本 AgentID 的訊息以符合增量設計
	incrementalContext := *contextInstance
	incrementalContext.Messages = [][]types.Message{{}, {}, {}}

	for i := 0; i < 3; i++ {
		for _, msg := range contextInstance.Messages[i] {
			if msg.AgentID == contextInstance.AgentID {
				incrementalContext.Messages[i] = append(incrementalContext.Messages[i], msg)
			}
		}
	}

	fileName := filepath.Join(sessionDirectory, fmt.Sprintf("%s.json", contextInstance.AgentID))
	data, errorValue := json.MarshalIndent(incrementalContext, "", "  ")
	if errorValue != nil {
		return errorValue
	}

	return os.WriteFile(fileName, data, 0644)
}
