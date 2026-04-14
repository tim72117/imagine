package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
)

type ToolUseContext struct {
	sync.RWMutex
	AgentID          string                             `json:"agentId"`
	Role             string                             `json:"role"`
	Goal             string                             `json:"goal"`
	Tasks            []string                           `json:"tasks"`
	Round            int                                `json:"round"`
	WorkingDirectory string                             `json:"workingDirectory"`
	Messages         [][]types.Message                  `json:"messages"` // 所有訊息紀錄 [0: 歷史, 1: 思考中, 2: 工具結果]
	IsRunning        bool                               `json:"isRunning"`
	IsFinished       bool                               `json:"isFinished"`
	Status           types.TaskStatus                   `json:"status"`
	Store            *AppStore                          `json:"-"`
	
	GetStateFunc func(key string) (interface{}, bool) `json:"-"`
	SetStateFunc func(key string, value interface{})  `json:"-"`

	// 執行期狀態
	readFileState *tools.ReadFileState `json:"-"`
}

func (contextInstance *ToolUseContext) GetReadFileState() any {
	return contextInstance.readFileState
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
 * GetToolUseContextFromStore 從 AppStore 獲取當前活躍的工具執行內容 (單例模式)
 * TODO: GetToolUseContextFromStore 可以呼叫 CreateToolUseContext
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
 * CreateToolUseContext 初始化並註冊為唯一工具執行內容 (全量繼承至 Messages)。
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
		Store:            GlobalAppStore,
		readFileState:    tools.NewReadFileState(),
	}

	// 繼承全量歷史
	GlobalAppStore.Lock()
	if existing, exists := GlobalAppStore.state["agent"].(*ToolUseContext); exists && existing != nil {
		for i := 0; i < 3; i++ {
			contextInstance.Messages[i] = append([]types.Message{}, existing.Messages[i]...)
		}
		fmt.Printf("  [Context] 🧠 已繼承全量紀錄 (%d 條訊息)\n", 
			len(contextInstance.Messages[0]) + len(contextInstance.Messages[1]) + len(contextInstance.Messages[2]))
	}
	GlobalAppStore.state["agent"] = contextInstance
	GlobalAppStore.Unlock()

	contextInstance.bindStateFunctions()
	return contextInstance
}

/**
 * LoadToolUseContext (暫不實作) 預留給未來從持久化層恢復 Agent 狀態使用
 */
func LoadToolUseContext(agentID string) (*ToolUseContext, error) {
	// 1. 優先從 AppStore 獲取現有的單例
	if existing, found := GetToolUseContextFromStore(); found {
		return existing, nil
	}

	// TODO: 載入agent 休眠時的運作訊息 (整合多個增量檔案以重建完整 Context)
	fmt.Printf("[Context] 🚧 LoadToolUseContext 尚未實作 (AgentID: %s)\n", agentID)
	
	return nil, fmt.Errorf("LoadToolUseContext has not been implemented yet")
}

/**
 * bindStateFunctions 正規化狀態存取介面
 */
func (contextInstance *ToolUseContext) bindStateFunctions() {
	task, isFound := contextInstance.Store.GetTask(contextInstance.AgentID)
	
	if !isFound {
		contextInstance.GetStateFunc = contextInstance.Store.GetState
		contextInstance.SetStateFunc = contextInstance.Store.SetState
		return
	}

	taskID := task.ID
	contextInstance.GetStateFunc = func(key string) (interface{}, bool) {
		currentTask, isSuccessful := contextInstance.Store.GetTask(taskID)
		if !isSuccessful {
			return nil, false
		}

		switch key {
		case "status":
			return currentTask.Status, true
		case "progress":
			return currentTask.Progress, true
		default:
			if currentTask.State == nil {
				return nil, false
			}
			value, isSuccessful := currentTask.State[key]
			return value, isSuccessful
		}
	}

	contextInstance.SetStateFunc = func(key string, value interface{}) {
		switch key {
		case "status":
			if status, isSuccessful := value.(types.TaskStatus); isSuccessful {
				contextInstance.Store.UpdateTaskState(taskID, "status", status)
				contextInstance.Status = status
			}
		case "progress":
			if progress, isSuccessful := value.(int); isSuccessful {
				contextInstance.Store.UpdateTaskState(taskID, "progress", progress)
			}
		default:
			contextInstance.Store.UpdateTaskState(taskID, key, value)
		}
	}
}

func (contextInstance *ToolUseContext) AddMessage(role string, message types.Message) {
	contextInstance.Lock()
	defer contextInstance.Unlock()

	switch role {
	case "assistant":
		contextInstance.Messages[1] = append(contextInstance.Messages[1], message)
	case "tool", "system":
		contextInstance.Messages[2] = append(contextInstance.Messages[2], message)
	default:
		contextInstance.Messages[0] = append(contextInstance.Messages[0], message)
	}
}

func (contextInstance *ToolUseContext) CommitRound() {
	contextInstance.Lock()
	defer contextInstance.Unlock()

	contextInstance.Messages[0] = append(contextInstance.Messages[0], contextInstance.Messages[1]...)
	contextInstance.Messages[0] = append(contextInstance.Messages[0], contextInstance.Messages[2]...)
	
	contextInstance.Messages[1] = []types.Message{}
	contextInstance.Messages[2] = []types.Message{}
}

func (contextInstance *ToolUseContext) Save() error {
	sessionDirectory := "sessions"
	_ = os.MkdirAll(sessionDirectory, 0755)

	// 【關鍵】：過濾僅屬於本 AgentID 的增量訊息
	incrementalContext := *contextInstance
	incrementalContext.Messages = [][]types.Message{{}, {}, {}}
	
	contextInstance.RLock()
	for i := 0; i < 3; i++ {
		for _, msg := range contextInstance.Messages[i] {
			if msg.AgentID == contextInstance.AgentID {
				incrementalContext.Messages[i] = append(incrementalContext.Messages[i], msg)
			}
		}
	}
	contextInstance.RUnlock()

	fileName := filepath.Join(sessionDirectory, fmt.Sprintf("%s.json", contextInstance.AgentID))
	data, errorValue := json.MarshalIndent(incrementalContext, "", "  ")
	if errorValue != nil {
		return errorValue
	}

	return os.WriteFile(fileName, data, 0644)
}
