package engine

import (
	"fmt"
	"sync"
)

/**
 * EventCallback 定義訂閱者接收到事件時的回調函式原型
 */
type EventCallback func(payload interface{})

/**
 * EventBus 全域訂閱/發布中心，負責處理系統內的非同步事件
 */
type EventBus struct {
	mutex       sync.RWMutex
	subscribers map[string][]EventCallback
}

/**
 * GlobalEventBus 全域單例
 */
var GlobalEventBus = NewEventBus()

/**
 * NewEventBus 建立一個新的事件總線實例
 */
func NewEventBus() *EventBus {
	return &EventBus{
		subscribers: make(map[string][]EventCallback),
	}
}

/**
 * Subscribe 訂閱特定主題的事件
 * @param topic 訂閱的主題名稱 (例如 "task.finished")
 * @param callback 接收到事件時執行的函式
 */
func (eventBus *EventBus) Subscribe(topic string, callback EventCallback) {
	eventBus.mutex.Lock()
	defer eventBus.mutex.Unlock()

	eventBus.subscribers[topic] = append(eventBus.subscribers[topic], callback)
	fmt.Printf("[EventBus] 📥 新增訂閱者到主題: %s (目前總數: %d)\n", topic, len(eventBus.subscribers[topic]))
}

/**
 * Publish 發布訊息到指定主題，所有對該主題感興趣的訂閱者都會收到通知
 * @param topic 發布的主題名稱
 * @param payload 要傳遞的資料內容
 */
func (eventBus *EventBus) Publish(topic string, payload interface{}) {
	eventBus.mutex.RLock()
	handlers, exists := eventBus.subscribers[topic]
	eventBus.mutex.RUnlock()

	if !exists {
		return
	}

	// 非同步執行所有的回調函式，以免阻塞發布者
	for _, handler := range handlers {
		go func(currentHandler EventCallback) {
			defer func() {
				if recoveryValue := recover(); recoveryValue != nil {
					fmt.Printf("[EventBus] ❌ 執行主題 %s 的回調時發生驚恐 (Panic): %v\n", topic, recoveryValue)
				}
			}()
			currentHandler(payload)
		}(handler)
	}
}

/**
 * Clear 清空所有訂閱關係 (主要用於測試或系統重置)
 */
func (eventBus *EventBus) Clear() {
	eventBus.mutex.Lock()
	defer eventBus.mutex.Unlock()
	eventBus.subscribers = make(map[string][]EventCallback)
}
