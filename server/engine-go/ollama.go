package engine

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type OllamaProvider struct {
	BaseURL   string
	ModelName string
	Queue     *RequestQueue
}

func NewOllamaProvider(baseURL, model string, queue *RequestQueue) *OllamaProvider {
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

func (p *OllamaProvider) GenerateStream(ctx context.Context, prompt string, options map[string]interface{}) (<-chan AIEvent, error) {
	events := make(chan AIEvent)

	go func() {
		defer close(events)

		err := p.Queue.Execute(func() error {
			reqBody := ollamaRequest{
				Model:    p.ModelName,
				Messages: []interface{}{map[string]string{"role": "user", "content": prompt}},
				Stream:   true,
				Tools:    options["tools"],
			}

			fmt.Printf("[Ollama] 🏗️  Calling %s (Model: %s)\n", p.BaseURL, p.ModelName)
			jsonBody, _ := json.Marshal(reqBody)
			req, err := http.NewRequestWithContext(ctx, "POST", p.BaseURL+"/api/chat", bytes.NewBuffer(jsonBody))
			if err != nil {
				return err
			}

			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				return err
			}
			defer resp.Body.Close()

			if resp.StatusCode != http.StatusOK {
				return fmt.Errorf("ollama error: status %d", resp.StatusCode)
			}
			fmt.Printf("[Ollama] 📡 Established stream connection (Status: %d)\n", resp.StatusCode)

			scanner := bufio.NewScanner(resp.Body)
			for scanner.Scan() {
				select {
				case <-ctx.Done():
					return ctx.Err()
				default:
					line := scanner.Text()
					if line == "" {
						continue
					}

					var raw map[string]interface{}
					if err := json.Unmarshal([]byte(line), &raw); err != nil {
						continue
					}

					// 處理訊息
					if message, ok := raw["message"].(map[string]interface{}); ok {
						// 處理文字
						if content, ok := message["content"].(string); ok {
							if content != "" {
								// fmt.Printf("[Ollama Debug] Chunk: %q\n", content)
								events <- AIEvent{Type: "chunk", Text: content}
							}
						}
						// 處理工具調用
						if toolCalls, ok := message["tool_calls"].([]interface{}); ok {
							for _, tc := range toolCalls {
								call := tc.(map[string]interface{})
								fn := call["function"].(map[string]interface{})
								events <- AIEvent{
									Type: "action",
									Action: &ActionData{
										Name: fn["name"].(string),
										Args: fn["arguments"],
									},
								}
							}
						}
					}
				}
			}
			return scanner.Err()
		})

		if err != nil {
			fmt.Printf("[Ollama] Error: %v\n", err)
		}
	}()

	return events, nil
}
