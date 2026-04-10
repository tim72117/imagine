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

func NewGeminiProvider(model string, queue *RequestQueue) *GeminiProvider {
	return &GeminiProvider{
		APIKey:    os.Getenv("GOOGLE_API_KEY"),
		ModelName: model,
		Queue:     queue,
	}
}

func (p *GeminiProvider) GenerateStream(ctx context.Context, prompt string, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		err := p.Queue.Execute(func() error {
			url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?key=%s", p.ModelName, p.APIKey)

			reqBody := map[string]interface{}{
				"contents": []interface{}{
					map[string]interface{}{
						"role": "user",
						"parts": []interface{}{
							map[string]string{"text": prompt},
						},
					},
				},
			}

			if tools, ok := options["tools"]; ok {
				reqBody["tools"] = tools
			}

			jsonBody, _ := json.Marshal(reqBody)
			req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonBody))
			if err != nil {
				return err
			}

			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()

			scanner := bufio.NewScanner(resp.Body)
			for scanner.Scan() {
				line := scanner.Text()
				line = strings.TrimLeft(line, " ,")
				if line == "[" || line == "]" || line == "" {
					continue
				}

				var chunks []map[string]interface{}
				// Gemini stream API returns a JSON array over time, or multiple objects
				if err := json.Unmarshal([]byte("["+strings.TrimSuffix(line, ",")+"]"), &chunks); err != nil {
					continue
				}

				for _, chunk := range chunks {
					candidates, ok := chunk["candidates"].([]interface{})
					if !ok || len(candidates) == 0 {
						continue
					}

					candidate := candidates[0].(map[string]interface{})
					content, ok := candidate["content"].(map[string]interface{})
					if !ok {
						continue
					}

					parts, ok := content["parts"].([]interface{})
					if !ok {
						continue
					}

					for _, part := range parts {
						pMap := part.(map[string]interface{})
						if text, ok := pMap["text"].(string); ok {
							events <- types.AIEvent{Type: "chunk", Text: text}
						}
						if fn, ok := pMap["functionCall"].(map[string]interface{}); ok {
							events <- types.AIEvent{
								Type: "action",
								Action: &types.ActionData{
									Name: fn["name"].(string),
									Args: fn["args"],
								},
							}
						}
					}
				}
			}
			return scanner.Err()
		})

		if err != nil {
			fmt.Printf("[Gemini] Error: %v\n", err)
		}
	}()

	return events, nil
}
