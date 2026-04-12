package engine

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"imagine/engine/internal/types"
)

type AgentContext struct {
	AgentID          string            `json:"agentId"`
	Role             string            `json:"role"`
	Tasks            []string          `json:"tasks"`
	Round            int               `json:"round"`
	WorkingDirectory string            `json:"workingDirectory"`
	Goal             string            `json:"goal"`
	Messages         [][]types.Message `json:"messages"`
	IsRunning        bool              `json:"isRunning"`
	IsFinished       bool              `json:"isFinished"`
	Status           types.TaskStatus  `json:"status"`
	Store            *AppStore         `json:"-"`
	
	GetState func(key string) (interface{}, bool) `json:"-"`
	SetState func(key string, value interface{})  `json:"-"`
}

/**
 * GetAgentContext 獲取現有的代理人上下文
 */
func GetAgentContext(agentID string) (*AgentContext, bool) {
	GlobalAppStore.RLock()
	defer GlobalAppStore.RUnlock()
	
	agentMap, isSuccessful := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	if !isSuccessful {
		return nil, false
	}
	
	contextInstance, isFound := agentMap[agentID]
	return contextInstance, isFound
}

/**
 * CreateAgentContextWithID 初始化並註冊一個代理人上下文。
 */
func CreateAgentContextWithID(agentID string, role string, goal string, workingDirectory string) *AgentContext {
	if agentID == "" {
		agentID = GenerateID("AGENT")
	}
	
	contextInstance := &AgentContext{
		AgentID:          agentID,
		Role:             role,
		Goal:             goal,
		Tasks:            []string{},
		Round:            0,
		WorkingDirectory: workingDirectory,
		Messages:         [][]types.Message{{}, {}},
		IsRunning:        false,
		IsFinished:       false,
		Status:           types.StatusPending,
		Store:            GlobalAppStore,
	}
	
	GlobalAppStore.Lock()
	agentMap := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	agentMap[agentID] = contextInstance
	GlobalAppStore.Unlock()
	
	contextInstance.bindStateFunctions()
	return contextInstance
}

/**
 * LoadAgentContext 從檔案系統載入先前儲存的代理人上下文
 */
func LoadAgentContext(agentID string) (*AgentContext, error) {
	sessionDirectory := "sessions"
	fileName := filepath.Join(sessionDirectory, fmt.Sprintf("%s.json", agentID))
	
	data, errorValue := os.ReadFile(fileName)
	if errorValue != nil {
		return nil, errorValue
	}

	var contextInstance AgentContext
	if errorValue := json.Unmarshal(data, &contextInstance); errorValue != nil {
		return nil, errorValue
	}

	contextInstance.Store = GlobalAppStore
	contextInstance.bindStateFunctions()

	GlobalAppStore.Lock()
	agentMap := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	agentMap[agentID] = &contextInstance
	GlobalAppStore.Unlock()

	return &contextInstance, nil
}

/**
 * bindStateFunctions 正規化狀態存取介面
 */
func (contextInstance *AgentContext) bindStateFunctions() {
	task, isFound := contextInstance.Store.GetTask(contextInstance.AgentID)
	
	if !isFound {
		contextInstance.GetState = contextInstance.Store.GetState
		contextInstance.SetState = contextInstance.Store.SetState
		return
	}

	taskID := task.ID
	contextInstance.GetState = func(key string) (interface{}, bool) {
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

	contextInstance.SetState = func(key string, value interface{}) {
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

func (contextInstance *AgentContext) AddMessage(role string, message types.Message) {
	if role == "user" || role == "tool" {
		contextInstance.Messages[0] = append(contextInstance.Messages[0], message)
	} else {
		contextInstance.Messages[1] = append(contextInstance.Messages[1], message)
	}
}

func (contextInstance *AgentContext) Save() error {
	sessionDirectory := "sessions"
	_ = os.MkdirAll(sessionDirectory, 0755)

	fileName := filepath.Join(sessionDirectory, fmt.Sprintf("%s.json", contextInstance.AgentID))
	data, errorValue := json.MarshalIndent(contextInstance, "", "  ")
	if errorValue != nil {
		return errorValue
	}

	return os.WriteFile(fileName, data, 0644)
}
