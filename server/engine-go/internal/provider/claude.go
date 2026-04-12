package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"

	"imagine/engine/internal/types"
)

type ClaudeProvider struct {
	APIKey    string
	ModelName string
	Queue     *RequestQueue
}

func NewClaudeProvider(modelName string, queue *RequestQueue) *ClaudeProvider {
	return &ClaudeProvider{
		APIKey:    os.Getenv("ANTHROPIC_API_KEY"),
		ModelName: modelName,
		Queue:     queue,
	}
}

func (providerInstance *ClaudeProvider) GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		errorValue := providerInstance.Queue.Execute(func() error {
			url := "https://api.anthropic.com/v1/messages"

			// 轉換對話紀錄為 Claude 格式
			var claudeMessages []interface{}
			var systemPrompt string

			for _, message := range messages {
				if message.Role == "system" {
					systemPrompt = message.Text
					continue
				}
				claudeMessages = append(claudeMessages, map[string]interface{}{
					"role":    message.Role,
					"content": message.Text,
				})
			}

			requestBody := map[string]interface{}{
				"model":      providerInstance.ModelName,
				"max_tokens": 4096,
				"messages":   claudeMessages,
				"stream":     true,
			}

			if systemPrompt != "" {
				requestBody["system"] = systemPrompt
			}

			if toolDeclarations, isSuccessful := options["tools"].([]types.ToolDeclaration); isSuccessful && len(toolDeclarations) > 0 {
				convertedTools := []interface{}{}
				for _, declaration := range toolDeclarations {
					convertedTools = append(convertedTools, map[string]interface{}{
						"name":         declaration.Name,
						"description":  declaration.Description,
						"input_schema": declaration.Parameters,
					})
				}
				requestBody["tools"] = convertedTools
			}

			jsonBody, _ := json.Marshal(requestBody)
			request, errorValue := http.NewRequestWithContext(contextInstance, "POST", url, bytes.NewBuffer(jsonBody))
			if errorValue != nil {
				return errorValue
			}

			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("x-api-key", providerInstance.APIKey)
			request.Header.Set("anthropic-version", "2023-06-01")

			response, errorValue := http.DefaultClient.Do(request)
			if errorValue != nil {
				return errorValue
			}
			defer response.Body.Close()

			if response.StatusCode != http.StatusOK {
				var errorResponse map[string]interface{}
				_ = json.NewDecoder(response.Body).Decode(&errorResponse)
				return fmt.Errorf("Claude API 錯誤 (HTTP %d): %v", response.StatusCode, errorResponse)
			}

			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				line := scanner.Text()
				if !strings.HasPrefix(line, "data: ") {
					continue
				}

				data := strings.TrimPrefix(line, "data: ")
				if data == "[DONE]" {
					break
				}

				var rawEvent map[string]interface{}
				if errorValue := json.Unmarshal([]byte(data), &rawEvent); errorValue != nil {
					continue
				}

				eventType, _ := rawEvent["type"].(string)
				switch eventType {
				case "content_block_delta":
					delta, _ := rawEvent["delta"].(map[string]interface{})
					if deltaType, _ := delta["type"].(string); deltaType == "text_delta" {
						if text, ok := delta["text"].(string); ok {
							events <- types.AIEvent{Type: "chunk", Text: text}
						}
					}
				case "content_block_start":
					contentBlock, _ := rawEvent["content_block"].(map[string]interface{})
					if blockType, _ := contentBlock["type"].(string); blockType == "tool_use" {
						events <- types.AIEvent{
							Type: "action",
							Action: &types.ActionData{
								Name: contentBlock["name"].(string),
								Args: contentBlock["input"],
							},
						}
					}
				}
			}
			return scanner.Err()
		})

		if errorValue != nil {
			fmt.Printf("[Claude] 發生錯誤: %v\n", errorValue)
		}
	}()

	return events, nil
}
