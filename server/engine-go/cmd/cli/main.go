package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"imagine/engine/internal/config"
	"imagine/engine/internal/engine"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

func main() {
	// 定義 CLI 參數
	providerName := flag.String("provider", "ollama", "AI provider (gemini or ollama)")
	modelName := flag.String("model", "gemma4:e2b", "Model name")
	prompt := flag.String("prompt", "", "The prompt to send to AI (fallback if -context is not used)")
	contextJson := flag.String("context", "", "JSON string containing full agent context (userMessages, assistantMessages, etc.)")
	roleFlag := flag.String("role", "coordinator", "Role name for tool filtering (optional)")
	toolsPath := flag.String("tools", "configs/tools.json", "Path to tools configuration")
	jsonOutput := flag.Bool("json", false, "Output results in JSON format for machines")
	flag.Parse()

	// 1. 初始化併發控制
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)

	// 2. 初始化 Provider 與配置
	settings, _ := config.LoadSettings("configs/settings.json")
	var aiProvider provider.AIProvider
	if *providerName == "ollama" {
		aiProvider = provider.NewOllamaProvider(settings.OllamaURL, *modelName, queue)
	} else {
		aiProvider = provider.NewGeminiProvider(*modelName, queue)
	}

	// 3. 執行引擎初始化
	if errorValue := engine.Initialize(aiProvider, *toolsPath); errorValue != nil {
		fmt.Printf("Fatal: %v\n", errorValue)
		os.Exit(1)
	}

	// 4. 準備推論背景 (Prompt Context)
	userMessages := []types.Message{}
	if *contextJson != "" {
		var ctxData struct {
			UserMessages []types.Message `json:"userMessages"`
		}
		if errorValue := json.Unmarshal([]byte(*contextJson), &ctxData); errorValue == nil {
			userMessages = ctxData.UserMessages
		}
	}

	if len(userMessages) == 0 && *prompt != "" {
		userMessages = []types.Message{{Role: "user", Text: *prompt, Time: time.Now().UnixMilli()}}
	}

	if !*jsonOutput {
		fmt.Printf("[CLI] 🚀 Initializing Coordinator: %s (Provider: %s)\n", *roleFlag, *providerName)
		fmt.Println("-----------------------------------------")
	}

	// 5. 建立並啟動 Coordinator
	coordinator := engine.NewCoordinator()
	coordinator.Start()

	// 6. 提交任務 (使用指定角色)
	if len(userMessages) > 0 {
		for _, message := range userMessages {
			// 直接發送到核心隊列，以便套用 CLI 指定的角色
			engine.GlobalCommandQueue <- types.Message{
				Role:      message.Role,
				Text:      message.Text,
				AgentID:   engine.GenerateID("CLI"),
				AgentRole: *roleFlag,
				Time:      time.Now().UnixMilli(),
			}
		}
	}

	// 由於 CLI 是單次執行的，我們需要等待任務處理完成
	if !*jsonOutput {
		fmt.Println("[CLI] ⏳ Waiting for Agent to complete tasks...")
	}
	
	// 在 CLI 模式下，簡單等待推論流結束
	time.Sleep(10 * time.Second)

	if !*jsonOutput {
		fmt.Println("\n-----------------------------------------")
		fmt.Println("[CLI] ✅ Session finished")
	}
}
