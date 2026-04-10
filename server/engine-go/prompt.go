package engine

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)



/**
 * BuildInferenceParameters 將 Agent 的配置與歷史紀錄組裝為推論參數 (Prompt + Options)
 */
func BuildInferenceParameters(
	systemPrompt string,
	toolPrompt string,
	envInfo string,
	userMessages []Message,
	assistantMessages []Message,
) (string, error) {

	// 組合並排序對話歷史
	var flattenedHistory []Message
	flattenedHistory = append(flattenedHistory, userMessages...)
	flattenedHistory = append(flattenedHistory, assistantMessages...)

	sort.Slice(flattenedHistory, func(index1, index2 int) bool {
		return flattenedHistory[index1].Time < flattenedHistory[index2].Time
	})

	var historyLines []string
	for _, message := range flattenedHistory {
		roleLabel := "【User】"
		if message.Role == "assistant" {
			roleLabel = "【Assistant】"
		} else if message.Role == "tool" {
			roleLabel = "【Tool Result】"
		}

		content := message.Text
		if len(message.Parts) > 0 {
			var partsText []string
			for _, part := range message.Parts {
				if part.Text != "" {
					partsText = append(partsText, part.Text)
				} else if part.FunctionCall != nil {
					partsText = append(partsText, fmt.Sprintf("[呼叫工具: %s]", part.FunctionCall.Name))
				}
			}
			if combined := strings.Join(partsText, ""); combined != "" {
				content = combined
			}
		}

		historyLines = append(historyLines, fmt.Sprintf("%s\n%s", roleLabel, content))
	}

	historyText := strings.Join(historyLines, "\n\n")
	statusHistory := fmt.Sprintf("【對話與執行歷史】：\n%s", historyText)

	// 組合最終指令 (Prompt)
	completeInstruction := fmt.Sprintf("%s\n%s\n%s\n%s\n\n請根據以上資訊更新開發進展或執行工具。",
		systemPrompt,
		toolPrompt,
		envInfo,
		statusHistory,
	)

	return completeInstruction, nil
}

/**
 * PrepareNextRoundMessage 初始化一個新的助理訊息，對應 TS 中的 assistantMessage 初始化
 */
func PrepareNextRoundMessage() Message {
	return Message{
		Role:  "assistant",
		Text:  "",
		Parts: []Part{},
		Time:  time.Now().UnixMilli(),
	}
}

/**
 * ConsumeAndPrintStream 消耗串流並輸出至終端機，對應 CLI 中的推論結果渲染邏輯
 */
func ConsumeAndPrintStream(events <-chan AIEvent, isJson bool) {
	for event := range events {
		if isJson {
			data, _ := json.Marshal(event)
			fmt.Println(string(data))
		} else {
			if event.Type == "chunk" {
				fmt.Print(event.Text)
			} else if event.Type == "action" {
				fmt.Printf("\n[🔧 Tool Call] %s: %v\n", event.Action.Name, event.Action.Args)
			}
		}
	}
}
