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

	// 3. 載入工具與提示詞配置
	toolsConfig, errorVal := engine.LoadToolsConfig(*toolsPath)
	if errorVal != nil {
		fmt.Printf("Fatal: Could not load tools config from %s: %v\n", *toolsPath, errorVal)
		os.Exit(1)
	}

	// 4. 準備推論背景 (Prompt Context)
	userMessages := []types.Message{}

	if *contextJson != "" {
		var ctxData struct {
			UserMessages      []types.Message `json:"userMessages"`
		}
		if errorVal := json.Unmarshal([]byte(*contextJson), &ctxData); errorVal == nil {
			userMessages = ctxData.UserMessages
		}
	}

	// 如果沒有傳入 context 歷史，則使用單一 prompt 作為起始
	if len(userMessages) == 0 && *prompt != "" {
		userMessages = []types.Message{{Role: "user", Text: *prompt, Time: time.Now().UnixMilli()}}
	}

	if !*jsonOutput {
		fmt.Printf("[CLI] 🚀 Initializing Coordinator: %s (Provider: %s)\n", *roleFlag, *providerName)
		fmt.Println("-----------------------------------------")
	}

	// 5. 建立並啟動 Coordinator
	coordinator := engine.NewCoordinator()
	coordinator.Start(aiProvider, toolsConfig)

	// 6. 提交任務 (使用指定角色)
	if len(userMessages) > 0 {
		for _, message := range userMessages {
			// 在 CLI 模式下，我們直接調用 ProcessNextBatch 並傳入指定角色
			coordinator.Submit(message.Text)
			// 注意：coordinator.Start 內部目前是寫死 coordinator，
			// 在手動 CLI 模式下，我們可以手動觸發 Process 以套用 roleFlag
			coordinator.ProcessNextBatch(aiProvider, toolsConfig, *roleFlag)
		}
	}

	// 由於 CLI 是單次執行的，我們需要等待任務處理完成
	// 在實際應用中，這裡會對接事件監聽，目前暫時用簡單的等待或阻塞
	if !*jsonOutput {
		fmt.Println("[CLI] ⏳ Waiting for Agent to complete tasks...")
	}
	
	// 這裡為了演示，讓進程停留一下，正常應該監聽 Coordinator 的結束訊號
	time.Sleep(15 * time.Second)

	if !*jsonOutput {
		fmt.Println("\n-----------------------------------------")
		fmt.Println("[CLI] ✅ Session finished")
	}
}
