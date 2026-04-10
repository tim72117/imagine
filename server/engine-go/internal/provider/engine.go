package provider

import (
	"context"
	"time"

	"imagine/engine/internal/types"
)

// AIProvider 是推論引擎的統一介面
type AIProvider interface {
	GenerateStream(ctx context.Context, prompt string, options map[string]interface{}) (<-chan types.AIEvent, error)
}

// RequestQueue 負責限流與併發控制
type RequestQueue struct {
	tokens chan struct{}
	ticker *time.Ticker
}

func NewRequestQueue(maxConcurrent int, minInterval time.Duration) *RequestQueue {
	q := &RequestQueue{
		tokens: make(chan struct{}, maxConcurrent),
		ticker: time.NewTicker(minInterval),
	}
	// 初始化令牌
	for i := 0; i < maxConcurrent; i++ {
		q.tokens <- struct{}{}
	}
	return q
}

// Execute 確保在限制範圍內執行任務
func (q *RequestQueue) Execute(task func() error) error {
	// 等待令牌 (控制最大併發)
	token := <-q.tokens
	defer func() { q.tokens <- token }()

	// 等待間隔 (控制請求頻率)
	<-q.ticker.C

	return task()
}
