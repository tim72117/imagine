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

func CreateTask(role string, agentID string) string {
	taskID := GenerateID("TASK")
	GlobalAppStore.CreateTaskWithID(taskID, role, agentID)
	return taskID
}

func (store *AppStore) CreateTaskWithID(taskID string, role string, agentID string) {
	task := &types.Task{
		ID:            taskID,
		AgentID:       agentID,
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

/**
 * GetTaskByAgentID 查找指定 Agent 正在執行的任務
 */
func (store *AppStore) GetTaskByAgentID(agentID string) (*types.Task, bool) {
	store.RLock()
	defer store.RUnlock()
	
	taskMap := store.state["tasks"].(map[string]*types.Task)
	task, exists := taskMap[agentID]
	return task, exists
}

/**
 * GetAgentIDByTaskID 透過 TaskID 從 Store 中反向查找關聯的 AgentID
 */
func (store *AppStore) GetAgentIDByTaskID(taskID string) (string, bool) {
	store.RLock()
	defer store.RUnlock()

	taskMap, isSuccessful := store.state["tasks"].(map[string]*types.Task)
	if !isSuccessful {
		return "", false
	}

	if task, exists := taskMap[taskID]; exists {
		return task.AgentID, true
	}
	
	return "", false
}

/**
 * GetTask 透過 TaskID 取得任務資訊
 */
func (store *AppStore) GetTask(taskID string) (*types.Task, bool) {
	store.RLock()
	defer store.RUnlock()

	taskMap, isFound := store.state["tasks"].(map[string]*types.Task)
	if !isFound {
		return nil, false
	}

	task, exists := taskMap[taskID]
	return task, exists
}

/**
 * UpdateTaskState 更新特定任務的狀態空間
 */
func (store *AppStore) UpdateTaskState(taskID string, key string, value interface{}) {
	store.Lock()
	defer store.Unlock()

	taskMap, isFound := store.state["tasks"].(map[string]*types.Task)
	if !isFound {
		return
	}

	if task, exists := taskMap[taskID]; exists {
		if task.State == nil {
			task.State = make(map[string]interface{})
		}
		task.State[key] = value
		task.UpdatedAt = time.Now()
	}
}

