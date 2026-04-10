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
	val, exists := store.state[key]
	return val, exists
}

/**
 * TryLockAgent 嘗試鎖定 Agent (Atomic-like Check and Set)
 * 如果 Agent 已經在運行中，返回 false；否則設置為運行中並返回 true
 */
func (store *AppStore) TryLockAgent(agentID string) bool {
	store.Lock()
	defer store.Unlock()
	
	agents := store.state["agents"].(map[string]*AgentContext)
	ctx, exists := agents[agentID]
	if !exists {
		// 如果 AgentContext 還不存在，允許啟動 (後續會建立)
		return true
	}
	
	if ctx.IsRunning {
		return false
	}
	
	ctx.IsRunning = true
	return true
}

/**
 * UnlockAgent 解除 Agent 鎖定
 */
func (store *AppStore) UnlockAgent(agentID string) {
	store.Lock()
	defer store.Unlock()
	
	agents := store.state["agents"].(map[string]*AgentContext)
	if ctx, exists := agents[agentID]; exists {
		ctx.IsRunning = false
	}
}

func GenerateID(prefix string) string {
	randomPart := fmt.Sprintf("%X", rand.Intn(0xFFF))
	return fmt.Sprintf("%s-%d-%s", prefix, time.Now().UnixMilli(), randomPart)
}

func CreateTask(role string, agentID string) string {
	taskID := GenerateID("TASK")
	CreateTaskWithID(taskID, role, agentID)
	return taskID
}

func CreateTaskWithID(taskID string, role string, agentID string) {
	task := &types.Task{
		ID:        taskID,
		AgentID:   agentID,
		Role:      role,
		Status:    types.StatusPending,
		Progress:  0,
		Messages:  [][]types.Message{{}, {}},
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
		State:     make(map[string]interface{}),
	}

	GlobalAppStore.Lock()
	tasks := GlobalAppStore.state["tasks"].(map[string]*types.Task)
	tasks[taskID] = task
	GlobalAppStore.Unlock()
}

type AgentContext struct {
	AgentID   string       `json:"agentId"`
	TaskID    string       `json:"taskId,omitempty"`
	Tasks     []string     `json:"tasks"`
	Round     int          `json:"round"`
	WorkDir   string       `json:"workDir"`
	Messages  [][]types.Message `json:"messages"`
	IsRunning bool         `json:"isRunning"` // 新增運行狀態
	Store     *AppStore    `json:"-"`
	ParentCtx *AgentContext `json:"-"`
	
	GetState func(key string) (interface{}, bool) `json:"-"`
	SetState func(key string, value interface{}) `json:"-"`
}

func GetOrCreateAgentContext(agentID string, taskID string, workDir string) *AgentContext {
	GlobalAppStore.Lock()
	agents := GlobalAppStore.state["agents"].(map[string]*AgentContext)
	
	var ctx *AgentContext
	if existing, exists := agents[agentID]; exists {
		if taskID != "" {
			existing.TaskID = taskID
		}
		ctx = existing
	} else {
		ctx = &AgentContext{
			AgentID:   agentID,
			TaskID:    taskID,
			Tasks:     []string{},
			Round:     0,
			WorkDir:   workDir,
			Messages:  [][]types.Message{{}, {}},
			IsRunning: false,
			Store:     GlobalAppStore,
		}
		agents[agentID] = ctx
	}
	GlobalAppStore.Unlock()
	
	ctx.bindStateFunctions()
	return ctx
}

func (ctx *AgentContext) bindStateFunctions() {
	if ctx.TaskID == "" {
		ctx.GetState = ctx.Store.GetState
		ctx.SetState = ctx.Store.SetState
	} else {
		ctx.GetState = func(key string) (interface{}, bool) {
			ctx.Store.RLock()
			defer ctx.Store.RUnlock()
			tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
			task, exists := tasks[ctx.TaskID]
			if !exists { return nil, false }
			
			switch key {
			case "status": return task.Status, true
			case "progress": return task.Progress, true
			default:
				if task.State == nil { return nil, false }
				val, ok := task.State[key]
				return val, ok
			}
		}
		
		ctx.SetState = func(key string, value interface{}) {
			ctx.Store.Lock()
			defer ctx.Store.Unlock()
			tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
			task, exists := tasks[ctx.TaskID]
			if !exists { return }
			
			switch key {
			case "status": 
				if s, ok := value.(types.TaskStatus); ok { task.Status = s }
			case "progress":
				if p, ok := value.(int); ok { task.Progress = p }
			default:
				if task.State == nil { task.State = make(map[string]interface{}) }
				task.State[key] = value
			}
			task.UpdatedAt = time.Now()
		}
	}
}

func (ctx *AgentContext) SyncState() {
	if ctx.ParentCtx != nil {
		ctx.ParentCtx.UpdateTaskStateWithContext(ctx.TaskID, ctx)
	}
	ctx.Store.Lock()
	defer ctx.Store.Unlock()
	agents := ctx.Store.state["agents"].(map[string]*AgentContext)
	agents[ctx.AgentID] = ctx
}

func (ctx *AgentContext) GetMessages() [][]types.Message {
	if ctx.TaskID != "" {
		ctx.Store.RLock()
		defer ctx.Store.RUnlock()
		tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
		if task, exists := tasks[ctx.TaskID]; exists {
			return task.Messages
		}
	}
	return ctx.Messages
}

func (ctx *AgentContext) UpdateTaskState(status types.TaskStatus, progress int) {
	ctx.SetState("status", status)
	ctx.SetState("progress", progress)
}

func (ctx *AgentContext) IsAllTasksCompleted() bool {
	ctx.Store.RLock()
	defer ctx.Store.RUnlock()
	tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
	
	for _, taskID := range ctx.Tasks {
		if task, exists := tasks[taskID]; exists {
			if task.Status != types.StatusCompleted && task.Status != types.StatusError {
				return false
			}
		}
	}
	return true
}

func (ctx *AgentContext) UpdateTaskStateWithContext(taskID string, subCtx *AgentContext) {
	ctx.Store.Lock()
	defer ctx.Store.Unlock()
	tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
	if task, exists := tasks[taskID]; exists {
		task.UpdatedAt = time.Now()
		task.Data = subCtx
	}
}

func (ctx *AgentContext) AddMessage(role string, message types.Message) {
	if ctx.TaskID != "" {
		ctx.Store.Lock()
		defer ctx.Store.Unlock()
		tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
		if task, exists := tasks[ctx.TaskID]; exists {
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
		ctx.Messages[0] = append(ctx.Messages[0], message)
	} else {
		ctx.Messages[1] = append(ctx.Messages[1], message)
	}
}
