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

func NewOllamaProvider(baseURL, model string, queue *RequestQueue) *OllamaProvider {
	// 移除結尾的斜線以確保路徑拼接正確
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

func (p *OllamaProvider) GenerateStream(ctx context.Context, prompt string, options map[string]interface{}) (<-chan types.AIEvent, error) {
	events := make(chan types.AIEvent)

	go func() {
		defer close(events)

		err := p.Queue.Execute(func() error {
			// 轉換 Gemini 格式的工具宣告為 Ollama 格式
			var ollamaTools []interface{}
			if tools, ok := options["tools"].([]map[string]interface{}); ok && len(tools) > 0 {
				if decls, ok := tools[0]["functionDeclarations"].([]interface{}); ok {
					for _, d := range decls {
						ollamaTools = append(ollamaTools, map[string]interface{}{
							"type":     "function",
							"function": d,
						})
					}
				}
			}

			reqBody := ollamaRequest{
				Model:    p.ModelName,
				Messages: []interface{}{map[string]string{"role": "user", "content": prompt}},
				Stream:   true,
				Tools:    ollamaTools,
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
								events <- types.AIEvent{Type: "chunk", Text: content}
							}
						}
						// 處理工具調用
						if toolCalls, ok := message["tool_calls"].([]interface{}); ok {
							for _, tc := range toolCalls {
								call, ok := tc.(map[string]interface{})
								if !ok {
									continue
								}
								fn, ok := call["function"].(map[string]interface{})
								if !ok {
									continue
								}

								// 嘗試解析參數 (可能可能是 map 或是 JSON 字串)
								args := fn["arguments"]
								var parsedArgs map[string]interface{}

								switch v := args.(type) {
								case map[string]interface{}:
									parsedArgs = v
								case string:
									if err := json.Unmarshal([]byte(v), &parsedArgs); err != nil {
										fmt.Printf("[Ollama] 無法解析工具參數字串: %v\n", err)
									}
								}

								events <- types.AIEvent{
									Type: "action",
									Action: &types.ActionData{
										Name: fn["name"].(string),
										Args: parsedArgs,
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
