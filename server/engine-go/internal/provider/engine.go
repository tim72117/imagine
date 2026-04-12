package provider

import (
	"context"
	"time"

	"imagine/engine/internal/types"
)

/**
 * AIProvider 是推論引擎的統一介面。
 * 目前維持使用單一字串 prompt 作為輸入，待命名規範化完成後再行升級。
 */
type AIProvider interface {
	GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error)
}

/**
 * RequestQueue 負責限流與併發控制。
 */
type RequestQueue struct {
	tokens chan struct{}
	ticker *time.Ticker
}

func NewRequestQueue(maxConcurrent int, minInterval time.Duration) *RequestQueue {
	queueInstance := &RequestQueue{
		tokens: make(chan struct{}, maxConcurrent),
		ticker: time.NewTicker(minInterval),
	}
	for i := 0; i < maxConcurrent; i++ {
		queueInstance.tokens <- struct{}{}
	}
	return queueInstance
}

/**
 * Execute 確保在限制範圍內執行任務。
 */
func (queueInstance *RequestQueue) Execute(task func() error) error {
	token := <-queueInstance.tokens
	defer func() { queueInstance.tokens <- token }()

	<-queueInstance.ticker.C

	return task()
}
