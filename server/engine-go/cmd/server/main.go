package main

import (
	"context"
	"encoding/json"
	"fmt"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
	"net/http"
	"os"
	"time"
)

var (
	requestQueue *provider.RequestQueue
)

func init() {
	// 初始化併發控制: 2 個併發, 500ms 間隔
	requestQueue = provider.NewRequestQueue(2, 500*time.Millisecond)
}

type CommandRequest struct {
	Provider string                 `json:"provider"` // "gemini", "ollama" 或 "claude"
	Model    string                 `json:"model"`
	Prompt   string                 `json:"prompt"`
	Options  map[string]interface{} `json:"options"`
}

func handleGenerate(responseWriter http.ResponseWriter, httpRequest *http.Request) {
	if httpRequest.Method != "POST" {
		http.Error(responseWriter, "僅允許 POST 請求", http.StatusMethodNotAllowed)
		return
	}

	var requestData CommandRequest
	if errorValue := json.NewDecoder(httpRequest.Body).Decode(&requestData); errorValue != nil {
		fmt.Printf("[Go Engine] ❌ 解析錯誤: %v\n", errorValue)
		http.Error(responseWriter, errorValue.Error(), http.StatusBadRequest)
		return
	}

	fmt.Printf("[Go Engine] 📨 收到請求 (提供者: %s, 模型: %s)\n", requestData.Provider, requestData.Model)

	var aiProvider provider.AIProvider
	if requestData.Provider == "ollama" {
		aiProvider = provider.NewOllamaProvider("http://localhost:11434", requestData.Model, requestQueue)
	} else if requestData.Provider == "gemini" {
		aiProvider = provider.NewGeminiProvider(requestData.Model, requestQueue)
	} else {
		aiProvider = provider.NewClaudeProvider(requestData.Model, requestQueue)
	}

	contextInstance, cancelFunction := context.WithCancel(httpRequest.Context())
	defer cancelFunction()

	// 2. 包裝字串 Prompt 為訊息格式
	messages := []types.Message{
		{
			Role: "user",
			Text: requestData.Prompt,
			Time: time.Now().UnixMilli(),
		},
	}

	eventStream, errorValue := aiProvider.GenerateStream(contextInstance, messages, requestData.Options)
	if errorValue != nil {
		fmt.Printf("[Go Engine] ❌ 串流生成錯誤: %v\n", errorValue)
		http.Error(responseWriter, errorValue.Error(), http.StatusInternalServerError)
		return
	}

	// 1. 設定 SSE (Server-Sent Events) 格式
	responseWriter.Header().Set("Content-Type", "text/event-stream")
	responseWriter.Header().Set("Cache-Control", "no-cache")
	responseWriter.Header().Set("Connection", "keep-alive")

	eventCount := 0
	for event := range eventStream {
		eventCount++
		jsonData, _ := json.Marshal(event)
		fmt.Fprintf(responseWriter, "data: %s\n\n", jsonData)
		
		// 2. 立即推送緩衝區
		if flusher, isSuccessful := responseWriter.(http.Flusher); isSuccessful {
			flusher.Flush()
		}
	}
	fmt.Printf("[Go Engine] ✅ 已完成 %d 個事件的串流傳輸\n", eventCount)
}

func main() {
	portNumber := os.Getenv("PORT")
	if portNumber == "" {
		portNumber = "8080"
	}

	http.HandleFunc("/generate", handleGenerate)
	fmt.Printf("[Go Engine] 🚀 伺服器啟動於 :%s\n", portNumber)
	
	if errorValue := http.ListenAndServe(":"+portNumber, nil); errorValue != nil {
		fmt.Printf("致命錯誤: %v\n", errorValue)
	}
}
