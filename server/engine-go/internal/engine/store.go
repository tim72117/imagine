package engine

import (
	"fmt"
	"math/rand"
	"sync"
	"time"

	"imagine/engine/internal/types"
)

/**
 * AppStore 負責管理全域狀態
 */
type AppStore struct {
	sync.RWMutex
	state map[string]interface{}
}

func NewAppStore() *AppStore {
	store := &AppStore{
		state: make(map[string]interface{}),
	}
	store.state["tasks"] = make(map[string]*types.Task)
	store.state["agents"] = make(map[string]*AgentContext)
	return store
}

var GlobalAppStore = NewAppStore()

func (store *AppStore) SetState(key string, value interface{}) {
	store.Lock()
	defer store.Unlock()
	store.state[key] = value
}

func (store *AppStore) GetState(key string) (interface{}, bool) {
	store.RLock()
	defer store.RUnlock()
	value, exists := store.state[key]
	return value, exists
}

/**
 * TryLockAgent 嘗試鎖定 Agent
 */
func (store *AppStore) TryLockAgent(agentID string) bool {
	store.Lock()
	defer store.Unlock()
	
	agentMap := store.state["agents"].(map[string]*AgentContext)
	agentContext, exists := agentMap[agentID]
	if !exists {
		return true
	}
	
	if agentContext.IsRunning {
		return false
	}
	
	agentContext.IsRunning = true
	return true
}

/**
 * UnlockAgent 解除 Agent 鎖定
 */
func (store *AppStore) UnlockAgent(agentID string) {
	store.Lock()
	defer store.Unlock()
	
	agentMap := store.state["agents"].(map[string]*AgentContext)
	if agentContext, exists := agentMap[agentID]; exists {
		agentContext.IsRunning = false
	}
}

func GenerateID(prefix string) string {
	randomPart := fmt.Sprintf("%X", rand.Intn(0xFFF))
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), randomPart)
}

func CreateTask(role string) string {
	taskID := GenerateID("TASK")
	CreateTaskWithID(taskID, role)
	return taskID
}

func CreateTaskWithID(taskID string, role string) {
	task := &types.Task{
		ID:            taskID,
		Role:          role,
		Status:        types.StatusPending,
		Progress:      0,
		Messages:      [][]types.Message{{}, {}},
		CreatedAt:     time.Now(),
		UpdatedAt:     time.Now(),
		State:         make(map[string]interface{}),
	}

	GlobalAppStore.Lock()
	taskMap := GlobalAppStore.state["tasks"].(map[string]*types.Task)
	taskMap[taskID] = task
	GlobalAppStore.Unlock()
}

/**
 * GetParentContext 透過搜尋所有 Agent 的 Tasks 列表來反查父代理人實體
 */
func (store *AppStore) GetParentContext(taskID string) (*AgentContext, bool) {
	store.RLock()
	defer store.RUnlock()
	
	agentMap := store.state["agents"].(map[string]*AgentContext)
	for _, agentContext := range agentMap {
		for _, ownedTaskID := range agentContext.Tasks {
			if ownedTaskID == taskID {
				return agentContext, true
			}
		}
	}
	return nil, false
}

type AgentContext struct {
	AgentID    string       `json:"agentId"`
	Role       string       `json:"role"`
	TaskID     string       `json:"taskId,omitempty"`
	Tasks      []string     `json:"tasks"`
	Round      int          `json:"round"`
	WorkDir    string       `json:"workDir"`
	Messages   [][]types.Message `json:"messages"`
	IsRunning  bool         `json:"isRunning"`  // 是否正在推論中
	IsFinished bool         `json:"isFinished"` // 是否已徹底完成所有任務與循環
	Store      *AppStore    `json:"-"`
	GetState func(key string) (interface{}, bool) `json:"-"`
	SetState func(key string, value interface{}) `json:"-"`
}

func GetOrCreateAgentContext(agentID string, taskID string, role string, workDir string) *AgentContext {
	GlobalAppStore.Lock()
	agentMap := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	
	var agentContext *AgentContext
	if existingContext, exists := agentMap[agentID]; exists {
		if taskID != "" {
			existingContext.TaskID = taskID
		}
		if role != "" {
			existingContext.Role = role
		}
		agentContext = existingContext
	} else {
		agentContext = &AgentContext{
			AgentID:    agentID,
			Role:       role,
			TaskID:     taskID,
			Tasks:      []string{},
			Round:      0,
			WorkDir:    workDir,
			Messages:   [][]types.Message{{}, {}},
			IsRunning:  false,
			IsFinished: false,
			Store:      GlobalAppStore,
		}
		agentMap[agentID] = agentContext
	}
	GlobalAppStore.Unlock()
	
	agentContext.bindStateFunctions()
	return agentContext
}

func (agentContext *AgentContext) bindStateFunctions() {
	if agentContext.TaskID == "" {
		agentContext.GetState = agentContext.Store.GetState
		agentContext.SetState = agentContext.Store.SetState
	} else {
		agentContext.GetState = func(key string) (interface{}, bool) {
			agentContext.Store.RLock()
			defer agentContext.Store.RUnlock()
			taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
			task, exists := taskMap[agentContext.TaskID]
			if !exists { return nil, false }
			
			switch key {
			case "status": return task.Status, true
			case "progress": return task.Progress, true
			default:
				if task.State == nil { return nil, false }
				value, isSuccessful := task.State[key]
				return value, isSuccessful
			}
		}
		
		agentContext.SetState = func(key string, value interface{}) {
			agentContext.Store.Lock()
			defer agentContext.Store.Unlock()
			taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
			task, exists := taskMap[agentContext.TaskID]
			if !exists { return }
			
			switch key {
			case "status": 
				if status, isOk := value.(types.TaskStatus); isOk { task.Status = status }
			case "progress":
				if progress, isOk := value.(int); isOk { task.Progress = progress }
			default:
				if task.State == nil { task.State = make(map[string]interface{}) }
				task.State[key] = value
			}
			task.UpdatedAt = time.Now()
		}
	}
}

func (agentContext *AgentContext) SyncState() {
	if agentContext.TaskID != "" {
		if parentCtx, exists := agentContext.Store.GetParentContext(agentContext.TaskID); exists {
			parentCtx.UpdateTaskStateWithContext(agentContext.TaskID, agentContext)
		}
	}
	agentContext.Store.Lock()
	defer agentContext.Store.Unlock()
	agentMap := agentContext.Store.state["agents"].(map[string]*AgentContext)
	agentMap[agentContext.AgentID] = agentContext
}

func (agentContext *AgentContext) GetMessages() [][]types.Message {
	if agentContext.TaskID != "" {
		agentContext.Store.RLock()
		defer agentContext.Store.RUnlock()
		taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
		if task, exists := taskMap[agentContext.TaskID]; exists {
			return task.Messages
		}
	}
	return agentContext.Messages
}

func (agentContext *AgentContext) UpdateTaskState(status types.TaskStatus, progress int) {
	agentContext.SetState("status", status)
	agentContext.SetState("progress", progress)
}

func (agentContext *AgentContext) IsAllTasksCompleted() bool {
	agentContext.Store.RLock()
	defer agentContext.Store.RUnlock()
	taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
	
	for _, taskID := range agentContext.Tasks {
		if task, exists := taskMap[taskID]; exists {
			if task.Status != types.StatusCompleted && task.Status != types.StatusError {
				return false
			}
		}
	}
	return true
}

func (agentContext *AgentContext) UpdateTaskStateWithContext(taskID string, subContext *AgentContext) {
	agentContext.Store.Lock()
	defer agentContext.Store.Unlock()
	taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
	if task, exists := taskMap[taskID]; exists {
		task.UpdatedAt = time.Now()
		task.Data = subContext
	}
}

func (agentContext *AgentContext) AddMessage(role string, message types.Message) {
	if agentContext.TaskID != "" {
		agentContext.Store.Lock()
		defer agentContext.Store.Unlock()
		taskMap := agentContext.Store.state["tasks"].(map[string]*types.Task)
		if task, exists := taskMap[agentContext.TaskID]; exists {
			if role == "user" || role == "tool" {
				task.Messages[0] = append(task.Messages[0], message)
			} else {
				task.Messages[1] = append(task.Messages[1], message)
			}
			task.UpdatedAt = time.Now()
			return
		}
	}
	
	if role == "user" || role == "tool" {
		agentContext.Messages[0] = append(agentContext.Messages[0], message)
	} else {
		agentContext.Messages[1] = append(agentContext.Messages[1], message)
	}
}
