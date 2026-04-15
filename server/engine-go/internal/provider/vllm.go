package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"imagine/engine/internal/types"
)

type VLLMProvider struct {
	BaseURL   string
	ModelName string
	Queue     *RequestQueue
}

func NewVLLMProvider(baseURL string, model string, queue *RequestQueue) *VLLMProvider {
	if len(baseURL) > 0 && baseURL[len(baseURL)-1] == '/' {
		baseURL = baseURL[:len(baseURL)-1]
	}
	// vLLM 通常掛載在 /v1 子路徑
	if !strings.HasSuffix(baseURL, "/v1") {
		baseURL = baseURL + "/v1"
	}
	return &VLLMProvider{
		BaseURL:   baseURL,
		ModelName: model,
		Queue:     queue,
	}
}

type openAIRequest struct {
	Model    string        `json:"model"`
	Messages []interface{} `json:"messages"`
	Stream   bool          `json:"stream"`
	Tools    interface{}   `json:"tools,omitempty"`
}

func (providerInstance *VLLMProvider) GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		time.Sleep(500 * time.Millisecond)
		errorValue := providerInstance.Queue.Execute(func() error {
			// 1. 轉換工具宣告 (OpenAI 格式)
			var openAITools []interface{}
			if tools, isSuccessful := options["tools"].([]types.ToolDeclaration); isSuccessful && len(tools) > 0 {
				for _, declaration := range tools {
					openAITools = append(openAITools, map[string]interface{}{
						"type": "function",
						"function": map[string]interface{}{
							"name":        declaration.Name,
							"description": declaration.Description,
							"parameters":  declaration.Parameters,
						},
					})
				}
			}

			// 2. 轉換結構化訊息列表 (含工具調用格式)
			var openAIMessages []interface{}
			toolCallCounter := 0 // 用於產生配對的 tool_call_id
			toolCallIDQueue := []string{}

			for _, message := range messages {
				switch message.Role {
				case "assistant":
					// 收集 Parts 中的工具調用
					var toolCalls []interface{}
					for _, part := range message.Parts {
						if part.FunctionCall == nil {
							continue
						}
						callID := fmt.Sprintf("call_%d", toolCallCounter)
						toolCallCounter++
						toolCallIDQueue = append(toolCallIDQueue, callID)
						argsJSON, _ := json.Marshal(part.FunctionCall.Args)
						toolCalls = append(toolCalls, map[string]interface{}{
							"id":   callID,
							"type": "function",
							"function": map[string]interface{}{
								"name":      part.FunctionCall.Name,
								"arguments": string(argsJSON),
							},
						})
					}
					msg := map[string]interface{}{
						"role":    "assistant",
						"content": message.Text,
					}
					if len(toolCalls) > 0 {
						msg["tool_calls"] = toolCalls
					}
					openAIMessages = append(openAIMessages, msg)

				case "tool":
					callID := ""
					if len(toolCallIDQueue) > 0 {
						callID = toolCallIDQueue[0]
						toolCallIDQueue = toolCallIDQueue[1:]
					}
					openAIMessages = append(openAIMessages, map[string]interface{}{
						"role":         "tool",
						"content":      message.Text,
						"tool_call_id": callID,
					})

				default:
					openAIMessages = append(openAIMessages, map[string]interface{}{
						"role":    message.Role,
						"content": message.Text,
					})
				}
			}

			requestBody := openAIRequest{
				Model:    providerInstance.ModelName,
				Messages: openAIMessages,
				Stream:   true,
			}
			if len(openAITools) > 0 {
				requestBody.Tools = openAITools
			}

			fmt.Printf("[vLLM] 🏗️  發起請求 (模型: %s, 訊息數: %d)\n", providerInstance.ModelName, len(openAIMessages))
			jsonBody, _ := json.Marshal(requestBody)
			request, errorValue := http.NewRequestWithContext(contextInstance, "POST", providerInstance.BaseURL+"/chat/completions", bytes.NewBuffer(jsonBody))
			if errorValue != nil {
				return errorValue
			}

			request.Header.Set("Content-Type", "application/json")

			response, errorValue := http.DefaultClient.Do(request)
			if errorValue != nil {
				return errorValue
			}
			defer response.Body.Close()

			if response.StatusCode != http.StatusOK {
				var errorResponse map[string]interface{}
				_ = json.NewDecoder(response.Body).Decode(&errorResponse)
				return fmt.Errorf("vLLM 伺服器錯誤 (HTTP %d): %v", response.StatusCode, errorResponse)
			}

			// 累積工具調用片段: index -> {name, arguments}
			type toolCallAcc struct {
				Name      string
				Arguments strings.Builder
			}
			toolAccMap := map[int]*toolCallAcc{}

			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				select {
				case <-contextInstance.Done():
					return contextInstance.Err()
				default:
					line := scanner.Text()
					if !strings.HasPrefix(line, "data: ") {
						continue
					}

					data := strings.TrimPrefix(line, "data: ")
					if data == "[DONE]" {
						fmt.Printf("[vLLM] ✅ 串流結束，累積工具調用數: %d\n", len(toolAccMap))
						// 串流結束，emit 所有累積的工具調用
						for _, acc := range toolAccMap {
							if acc.Name == "" {
								continue
							}
							var parsedArguments map[string]interface{}
							_ = json.Unmarshal([]byte(acc.Arguments.String()), &parsedArguments)
							events <- types.AIEvent{
								Type: "action",
								Action: &types.ActionData{
									Name: acc.Name,
									Args: parsedArguments,
								},
							}
						}
						return nil
					}

					var rawResponse map[string]interface{}
					if errorValue := json.Unmarshal([]byte(data), &rawResponse); errorValue != nil {
						continue
					}

					choices, ok := rawResponse["choices"].([]interface{})
					if !ok || len(choices) == 0 {
						continue
					}

					choice := choices[0].(map[string]interface{})
					delta, ok := choice["delta"].(map[string]interface{})
					if !ok {
						continue
					}

					// 處理文字
					if content, isText := delta["content"].(string); isText && content != "" {
						events <- types.AIEvent{Type: "chunk", Text: content}
					}

					// 累積工具調用片段
					if toolCalls, isAction := delta["tool_calls"].([]interface{}); isAction {
						fmt.Printf("[vLLM] 🔧 收到 tool_calls chunk: %v\n", toolCalls)
						for _, toolCallElement := range toolCalls {
							call := toolCallElement.(map[string]interface{})
							idx := 0
							if idxFloat, hasIdx := call["index"].(float64); hasIdx {
								idx = int(idxFloat)
							}
							if toolAccMap[idx] == nil {
								toolAccMap[idx] = &toolCallAcc{}
							}
							acc := toolAccMap[idx]

							if functionData, isSuccessful := call["function"].(map[string]interface{}); isSuccessful {
								if name, hasName := functionData["name"].(string); hasName && name != "" {
									acc.Name = name
								}
								if args, hasArgs := functionData["arguments"].(string); hasArgs {
									acc.Arguments.WriteString(args)
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
