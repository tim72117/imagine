package main

import (
	"bufio"
	"flag"
	"fmt"
	"imagine/engine/internal/config"
	"imagine/engine/internal/engine"
	"imagine/engine/internal/provider"
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
	providerName := flag.String("provider", "ollama", "AI provider (claude, gemini or ollama)")
	modelName := flag.String("model", "gemma4:e2b", "Model name")
	toolsPath := flag.String("tools", "configs/tools.json", "Path to tools.json configuration")
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
	if errorValue := engine.Initialize(aiProvider, *toolsPath); errorValue != nil {
		fmt.Printf("\x1b[31m[Fatal] %v\x1b[0m\n", errorValue)
		os.Exit(1)
	}

	// 4. 建立協調者實例 並 啟動背景監聽
	coordinator := engine.NewCoordinator()
	coordinator.Start()

	// 5. 啟動互動式輸入循環
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
