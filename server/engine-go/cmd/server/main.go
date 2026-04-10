package main

import (
	"context"
	"encoding/json"
	"fmt"
	"imagine/engine/internal/provider"
	"net/http"
	"os"
	"time"
)

var (
	queue *provider.RequestQueue
)

func init() {
	// 初始化併發控制: 2 個併發, 500ms 間隔
	queue = provider.NewRequestQueue(2, 500*time.Millisecond)
}

type CommandRequest struct {
	Provider string                 `json:"provider"` // "gemini" 或 "ollama"
	Model    string                 `json:"model"`
	Prompt   string                 `json:"prompt"`
	Options  map[string]interface{} `json:"options"`
}

func handleGenerate(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "Only POST allowed", http.StatusMethodNotAllowed)
		return
	}

	var req CommandRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fmt.Printf("[Go Engine] ❌ Decode error: %v\n", err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	fmt.Printf("[Go Engine] 📨 Received request (Provider: %s, Model: %s)\n", req.Provider, req.Model)

	var aiProvider provider.AIProvider
	if req.Provider == "ollama" {
		aiProvider = provider.NewOllamaProvider("http://localhost:11434", req.Model, queue)
	} else {
		aiProvider = provider.NewGeminiProvider(req.Model, queue)
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	events, err := aiProvider.GenerateStream(ctx, req.Prompt, req.Options)
	if err != nil {
		fmt.Printf("[Go Engine] ❌ GenerateStream error: %v\n", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// 設定 SSE (Server-Sent Events) 格式
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	count := 0
	for event := range events {
		count++
		data, _ := json.Marshal(event)
		fmt.Fprintf(w, "data: %s\n\n", data)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	fmt.Printf("[Go Engine] ✅ Completed streaming %d events\n", count)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/generate", handleGenerate)
	fmt.Printf("[Go Engine] 🚀 Server starting on :%s\n", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Printf("Fatal: %v\n", err)
	}
}
