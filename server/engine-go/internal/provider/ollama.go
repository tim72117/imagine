package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"imagine/engine/internal/types"
)

type OllamaProvider struct {
	BaseURL   string
	ModelName string
	Queue     *RequestQueue
}

func NewOllamaProvider(baseURL string, model string, queue *RequestQueue) *OllamaProvider {
	if len(baseURL) > 0 && baseURL[len(baseURL)-1] == '/' {
		baseURL = baseURL[:len(baseURL)-1]
	}
	return &OllamaProvider{
		BaseURL:   baseURL,
		ModelName: model,
		Queue:     queue,
	}
}

type ollamaRequest struct {
	Model    string        `json:"model"`
	Messages []interface{} `json:"messages"`
	Stream   bool          `json:"stream"`
	Tools    interface{}   `json:"tools,omitempty"`
}

func (providerInstance *OllamaProvider) GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		errorValue := providerInstance.Queue.Execute(func() error {
			// 1. 轉換工具宣告
			var ollamaTools []interface{}
			if tools, isSuccessful := options["tools"].([]types.ToolDeclaration); isSuccessful && len(tools) > 0 {
				for _, declaration := range tools {
					ollamaTools = append(ollamaTools, map[string]interface{}{
						"type": "function",
						"function": map[string]interface{}{
							"name":        declaration.Name,
							"description": declaration.Description,
							"parameters":  declaration.Parameters,
						},
					})
				}
			}

			// 2. 轉換結構化訊息列表
			var ollamaMessages []interface{}
			for _, message := range messages {
				ollamaMessages = append(ollamaMessages, map[string]interface{}{
					"role":    message.Role,
					"content": message.Text,
				})
			}

			requestBody := ollamaRequest{
				Model:    providerInstance.ModelName,
				Messages: ollamaMessages,
				Stream:   true,
				Tools:    ollamaTools,
			}

			fmt.Printf("[Ollama] 🏗️  發起結構化請求 (模型: %s, 訊息數: %d)\n", providerInstance.ModelName, len(ollamaMessages))
			jsonBody, _ := json.Marshal(requestBody)
			request, errorValue := http.NewRequestWithContext(contextInstance, "POST", providerInstance.BaseURL+"/api/chat", bytes.NewBuffer(jsonBody))
			if errorValue != nil {
				return errorValue
			}

			response, errorValue := http.DefaultClient.Do(request)
			if errorValue != nil {
				return errorValue
			}
			defer response.Body.Close()

			if response.StatusCode != http.StatusOK {
				return fmt.Errorf("ollama 伺服器錯誤: 狀態碼 %d", response.StatusCode)
			}

			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				select {
				case <-contextInstance.Done():
					return contextInstance.Err()
				default:
					line := scanner.Text()
					if line == "" {
						continue
					}

					var rawResponse map[string]interface{}
					if errorValue := json.Unmarshal([]byte(line), &rawResponse); errorValue != nil {
						continue
					}

					if message, isSuccessful := rawResponse["message"].(map[string]interface{}); isSuccessful {
						// 處理文字
						if content, isText := message["content"].(string); isText && content != "" {
							events <- types.AIEvent{Type: "chunk", Text: content}
						}

						// 處理原生工具調用 (Tool Calls)
						if toolCalls, isAction := message["tool_calls"].([]interface{}); isAction {
							for _, toolCallElement := range toolCalls {
								call, isSuccessful := toolCallElement.(map[string]interface{})
								if !isSuccessful {
									continue
								}
								functionData, isSuccessful := call["function"].(map[string]interface{})
								if !isSuccessful {
									continue
								}

								argumentsRaw := functionData["arguments"]
								var parsedArguments map[string]interface{}
								switch value := argumentsRaw.(type) {
								case map[string]interface{}:
									parsedArguments = value
								case string:
									_ = json.Unmarshal([]byte(value), &parsedArguments)
								}

								events <- types.AIEvent{
									Type: "action",
									Action: &types.ActionData{
										Name: functionData["name"].(string),
										Args: parsedArguments,
									},
								}
							}
						}
					}
				}
			}
			return scanner.Err()
		})

		if errorValue != nil {
			events <- types.AIEvent{Type: "error", Text: errorValue.Error()}
		}
	}()

	return events, nil
}
