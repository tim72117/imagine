package engine

import (
	"encoding/json"
	"fmt"
	"time"

	"imagine/engine/internal/types"
)

/**
 * PrepareNextRoundMessage 初始化一個新的助理訊息。
 */
func PrepareNextRoundMessage() types.Message {
	return types.Message{
		Role:  "assistant",
		Text:  "",
		Parts: []types.Part{},
		Time:  time.Now().UnixMilli(),
	}
}

/**
 * ConsumeAndPrintStream 消耗串流並輸出至終端機。
 */
func ConsumeAndPrintStream(events <-chan types.AIEvent, isJson bool) {
	for event := range events {
		if isJson {
			data, _ := json.Marshal(event)
			fmt.Println(string(data))
		} else {
			if event.Type == "chunk" {
				fmt.Print(event.Text)
			} else if event.Type == "action" {
				fmt.Printf("\n[🔧 工具調用] %s: %v\n", event.Action.Name, event.Action.Args)
			} else if event.Type == "error" {
				fmt.Printf("\n[❌ 錯誤] %s\n", event.Text)
			}
		}
	}
}
