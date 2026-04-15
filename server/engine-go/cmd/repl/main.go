package main

import (
	"bufio"
	"flag"
	"fmt"
	"imagine/engine/internal/config"
	"imagine/engine/internal/engine"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
	"os"
	"strings"
	"time"
)

/**
 * Go 版互動式 REPL 工具
 * 這是一個完全由 Go 核心驅動的終端機介面，支援多種 AI 提供者。
 */
func main() {
	// 1. 定義 CLI 參數
	providerName := flag.String("provider", "vllm", "AI provider (claude, gemini, ollama or vllm)")
	modelName := flag.String("model", "gemma4:e2b", "Model name")
	flag.Parse()

	fmt.Println("\x1b[36m" + `
    =========================================
    🚀 AI Builder - Go Native REPL
    =========================================
    輸入指令來啟動任務，輸入 'exit' 或 'quit' 退出。
    ` + "\x1b[0m")

	// 2. 準備依賴項 (根據 CLI 參數選擇不同的 Provider 實作)
	var aiProvider provider.AIProvider
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)

	switch *providerName {
	case "vllm":
		settings, _ := config.LoadSettings("configs/settings.json")
		model := *modelName
		if settings.Model != "" {
			model = settings.Model
		}
		aiProvider = provider.NewVLLMProvider(settings.VLLMBaseURL, model, queue)
	case "ollama":
		settings, _ := config.LoadSettings("configs/settings.json")
		aiProvider = provider.NewOllamaProvider(settings.OllamaURL, *modelName, queue)
	case "gemini":
		aiProvider = provider.NewGeminiProvider(*modelName, queue)
	case "claude":
		aiProvider = provider.NewClaudeProvider(*modelName, queue)
	default:
		fmt.Printf("\x1b[31m[Fatal] 不支援的提供者: %s\x1b[0m\n", *providerName)
		os.Exit(1)
	}

	// 3. 執行引擎初始化 (這會注入 Provider 並啟動背景監聽)
	if errorValue := engine.Initialize(aiProvider); errorValue != nil {
		fmt.Printf("\x1b[31m[Fatal] %v\x1b[0m\n", errorValue)
		os.Exit(1)
	}

	// 4. 建立協調者實例 並 啟動背景監聽
	coordinator := engine.NewCoordinator()
	coordinator.Start()

	// 5. 訂閱 Agent 推論事件並進行 UI 呈現
	engine.GlobalEventBus.Subscribe("agent.inference", func(payload interface{}) {
		data, _ := payload.(map[string]interface{})
		agentEvent, _ := data["event"].(types.AIEvent)
		role, _ := data["role"].(string)
		
		if agentEvent.Type == "chunk" {
			// 即時列印灰色推論文字
			fmt.Print("\x1b[38;5;243m" + agentEvent.Text + "\x1b[0m")
		} else if agentEvent.Type == "action" {
			// 列印黃色工具調用標籤
			fmt.Printf("\n\x1b[33m[Tool] 🛠️  代理人 [%s] 調用工具: %s\x1b[0m\n", role, agentEvent.Action.Name)
		}
	})

	engine.GlobalEventBus.Subscribe("agent.inference.done", func(payload interface{}) {
		agentID, _ := payload.(string)
		fmt.Printf("\n\x1b[96m[System] ✨ Agent (%s) 推論回合結束\x1b[0m\n", agentID)
	})

	// 6. 啟動互動式輸入循環
	scanner := bufio.NewScanner(os.Stdin)
	fmt.Print("> ")

	for scanner.Scan() {
		input := strings.TrimSpace(scanner.Text())

		if input == "" {
			fmt.Print("> ")
			continue
		}

		if strings.ToLower(input) == "exit" || strings.ToLower(input) == "quit" {
			fmt.Println("再見！")
			break
		}

		fmt.Printf("\x1b[90m[User] 提交指令: %s\x1b[0m\n", input)
		
		// 透過協調者提交任務
		coordinator.Submit(input)

		// 這裡使用簡單的等待，讓推論串流能完整顯示
		time.Sleep(2 * time.Second)
		fmt.Print("\n> ")
	}

	if errorValue := scanner.Err(); errorValue != nil {
		fmt.Printf("\x1b[31m[Error] 讀取輸入時發生錯誤: %v\x1b[0m\n", errorValue)
	}
}
