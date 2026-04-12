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

type GeminiProvider struct {
	APIKey    string
	ModelName string
	Queue     *RequestQueue
}

func NewGeminiProvider(modelName string, queue *RequestQueue) *GeminiProvider {
	return &GeminiProvider{
		APIKey:    os.Getenv("GOOGLE_API_KEY"),
		ModelName: modelName,
		Queue:     queue,
	}
}

func (providerInstance *GeminiProvider) GenerateStream(contextInstance context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		errorValue := providerInstance.Queue.Execute(func() error {
			url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?key=%s", providerInstance.ModelName, providerInstance.APIKey)

			// 轉換對話歷史為 Gemini 格式 (Contents)
			var geminiContents []interface{}
			var systemInstruction interface{}

			for _, message := range messages {
				if message.Role == "system" {
					systemInstruction = map[string]interface{}{
						"parts": []interface{}{
							map[string]string{"text": message.Text},
						},
					}
					continue
				}

				role := "user"
				if message.Role == "assistant" {
					role = "model"
				}

				geminiContents = append(geminiContents, map[string]interface{}{
					"role": role,
					"parts": []interface{}{
						map[string]string{"text": message.Text},
					},
				})
			}

			requestBody := map[string]interface{}{
				"contents": geminiContents,
			}

			if systemInstruction != nil {
				requestBody["systemInstruction"] = systemInstruction
			}

			// 轉換工具格式
			if toolDeclarations, isSuccessful := options["tools"].([]types.ToolDeclaration); isSuccessful && len(toolDeclarations) > 0 {
				convertedTools := []interface{}{}
				for _, declaration := range toolDeclarations {
					convertedTools = append(convertedTools, map[string]interface{}{
						"name":        declaration.Name,
						"description": declaration.Description,
						"parameters":  declaration.Parameters,
					})
				}
				requestBody["tools"] = []interface{}{
					map[string]interface{}{
						"functionDeclarations": convertedTools,
					},
				}
			}

			jsonBody, _ := json.Marshal(requestBody)
			request, errorValue := http.NewRequestWithContext(contextInstance, "POST", url, bytes.NewBuffer(jsonBody))
			if errorValue != nil {
				return errorValue
			}

			response, errorValue := http.DefaultClient.Do(request)
			if errorValue != nil {
				return errorValue
			}
			defer response.Body.Close()

			scanner := bufio.NewScanner(response.Body)
			for scanner.Scan() {
				line := scanner.Text()
				line = strings.TrimLeft(line, " ,")
				if line == "[" || line == "]" || line == "" {
					continue
				}

				var chunks []map[string]interface{}
				if errorValue := json.Unmarshal([]byte("["+strings.TrimSuffix(line, ",")+"]"), &chunks); errorValue != nil {
					continue
				}

				for _, chunk := range chunks {
					candidates, isSuccessful := chunk["candidates"].([]interface{})
					if !isSuccessful || len(candidates) == 0 {
						continue
					}

					candidate := candidates[0].(map[string]interface{})
					content, isSuccessful := candidate["content"].(map[string]interface{})
					if !isSuccessful {
						continue
					}

					parts, isSuccessful := content["parts"].([]interface{})
					if !isSuccessful {
						continue
					}

					for _, partElement := range parts {
						partMap := partElement.(map[string]interface{})
						if text, isText := partMap["text"].(string); isText {
							events <- types.AIEvent{Type: "chunk", Text: text}
						}
						if functionCall, isAction := partMap["functionCall"].(map[string]interface{}); isAction {
							events <- types.AIEvent{
								Type: "action",
								Action: &types.ActionData{
									Name: functionCall["name"].(string),
									Args: functionCall["args"],
								},
							}
						}
					}
				}
			}
			return scanner.Err()
		})

		if errorValue != nil {
			fmt.Printf("[Gemini] 發生錯誤: %v\n", errorValue)
		}
	}()

	return events, nil
}
