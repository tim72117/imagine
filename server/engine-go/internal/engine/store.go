package engine

import (
	"fmt"
	"math/rand"
	"sync"
	"time"

	"imagine/engine/internal/types"
)

/**
 * AppStore 負責管理全域狀態，實作線程安全的狀態存取
 */
type AppStore struct {
	sync.RWMutex
	state map[string]interface{}
}

func NewAppStore() *AppStore {
	store := &AppStore{
		state: make(map[string]interface{}),
	}
	// 初始化任務儲存區
	store.state["tasks"] = make(map[string]*types.Task)
	return store
}

// GlobalAppStore 全域唯一的狀態中心
var GlobalAppStore = NewAppStore()

/**
 * SetState 更新全域狀態中的特定欄位
 */
func (store *AppStore) SetState(key string, value interface{}) {
	store.Lock()
	defer store.Unlock()
	store.state[key] = value
}

/**
 * GetState 獲取全域狀態中的特定欄位
 */
func (store *AppStore) GetState(key string) (interface{}, bool) {
	store.RLock()
	defer store.RUnlock()
	val, exists := store.state[key]
	return val, exists
}

/**
 * CreateTask 建立任務 (Task) 的核心函式，對應 TS 中的 createTask
 */
func CreateTask(role string, agentID string) string {
	// 產生隨機 ID，格式範例: TASK-1712680000-ADF
	randomPart := fmt.Sprintf("%X", rand.Intn(0xFFF))
	taskID := fmt.Sprintf("TASK-%d-%s", time.Now().UnixMilli(), randomPart)
	
	task := &types.Task{
		ID:        taskID,
		AgentID:   agentID,
		Role:      role,
		Status:    types.StatusPending,
		Progress:  0,
		Messages:  [][]types.Message{{}, {}},
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}

	GlobalAppStore.Lock()
	tasks := GlobalAppStore.state["tasks"].(map[string]*types.Task)
	tasks[taskID] = task
	GlobalAppStore.Unlock()

	return taskID
}

/**
 * AgentContext 具備狀態同步能力的執行上下文，對應 TS 中的 AgentContext
 */
type AgentContext struct {
	TaskID  string
	AgentID string
	Round   int
	WorkDir string
	Store   *AppStore
}

/**
 * GetCurrentTask 獲取當前上下文關聯的任務實體
 */
func (ctx *AgentContext) GetCurrentTask() *types.Task {
	ctx.Store.RLock()
	defer ctx.Store.RUnlock()
	tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
	return tasks[ctx.TaskID]
}

/**
 * UpdateTaskState 更新當前任務的狀態
 */
func (ctx *AgentContext) UpdateTaskState(status types.TaskStatus, progress int) {
	ctx.Store.Lock()
	defer ctx.Store.Unlock()
	tasks := ctx.Store.state["tasks"].(map[string]*types.Task)
	if task, exists := tasks[ctx.TaskID]; exists {
		task.Status = status
		task.Progress = progress
		task.UpdatedAt = time.Now()
	}
}

/**
 * AddMessage 為任務添加訊息紀錄
 */
func (ctx *AgentContext) AddMessage(role string, message types.Message) {
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
	}
}
