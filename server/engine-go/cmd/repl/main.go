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
 * 這是一個完全由 Go 核心驅動的終端機介面
 */
func main() {
	// 1. 定義 CLI 參數
	providerName := flag.String("provider", "ollama", "AI provider (gemini or ollama)")
	modelName := flag.String("model", "gemma4:e2b", "Model name")
	toolsPath := flag.String("tools", "configs/tools.json", "Path to tools.json configuration")
	flag.Parse()

	fmt.Println("\x1b[36m" + `
    =========================================
    🚀 AI Builder - Go Native REPL
    =========================================
    輸入指令來啟動任務，輸入 'exit' 或 'quit' 退出。
    ` + "\x1b[0m")

	// 2. 初始化核心組件與配置
	settings, _ := config.LoadSettings("configs/settings.json")
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)
	var aiProvider provider.AIProvider
	if *providerName == "ollama" {
		aiProvider = provider.NewOllamaProvider(settings.OllamaURL, *modelName, queue)
	} else {
		aiProvider = provider.NewGeminiProvider(*modelName, queue)
	}

	// 載入工具配置
	toolsConfig, errorVal := engine.LoadToolsConfig(*toolsPath)
	if errorVal != nil {
		fmt.Printf("\x1b[31m[Fatal] 無法載入工具配置 (%s): %v\x1b[0m\n", *toolsPath, errorVal)
		os.Exit(1)
	}

	// 3. 建立並啟動協調者
	coordinator := engine.NewCoordinator()
	coordinator.Start(aiProvider, toolsConfig)

	// 4. 啟動互動式輸入循環
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
		
		// 提交到協調者 (這會觸發 ProcessNextBatch)
		coordinator.Submit(input)

		// 這裡我們需要一個簡單的機制讓當前推論跑完後再顯示提示符
		// 暫時使用簡單的等待，未來可以透過 Channel 接收任務完成訊號
		time.Sleep(2 * time.Second)
		
		fmt.Print("\n> ")
	}

	if errorVal := scanner.Err(); errorVal != nil {
		fmt.Printf("\x1b[31m[Error] 讀取輸入時發生錯誤: %v\x1b[0m\n", errorVal)
	}
}
