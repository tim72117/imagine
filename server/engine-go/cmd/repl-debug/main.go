package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"imagine/engine/internal/config"
	"imagine/engine/internal/engine"
	enginetools "imagine/engine/internal/engine/tools"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
	"os"
	"strings"
	"time"
)

/**
 * CaptureProxyProvider 代理真實的 AI Provider 並攔截每輪輸入
 */
type CaptureProxyProvider struct {
	RealProvider provider.AIProvider
}

func (p *CaptureProxyProvider) GenerateStream(ctx context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	fmt.Printf("\n\x1b[35m%s\x1b[0m\n", strings.Repeat("─", 60))
	fmt.Printf("\x1b[35m[攔截器] 發送給 AI 的訊息 (共 %d 條):\x1b[0m\n", len(messages))
	jsonBytes, _ := json.MarshalIndent(messages, "", "  ")
	fmt.Printf("\x1b[90m%s\x1b[0m\n", string(jsonBytes))
	fmt.Printf("\x1b[35m%s\x1b[0m\n\n", strings.Repeat("─", 60))

	return p.RealProvider.GenerateStream(ctx, messages, options)
}

func main() {
	providerName := flag.String("provider", "vllm", "AI provider (claude, gemini, ollama or vllm)")
	modelName := flag.String("model", "", "Model name (留空從 settings.json 讀取)")
	flag.Parse()

	fmt.Println("\x1b[35m" + `
    =========================================
    🔍 AI Builder - Debug REPL (含攔截器)
    =========================================
    每輪推論前會印出發送給 AI 的完整訊息。
    輸入 'exit' 或 'quit' 退出。
    ` + "\x1b[0m")

	// 1. 建立真實 Provider
	var realProvider provider.AIProvider
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)

	switch *providerName {
	case "vllm":
		settings, _ := config.LoadSettings("configs/settings.json")
		model := *modelName
		if model == "" {
			model = settings.Model
		}
		realProvider = provider.NewVLLMProvider(settings.VLLMBaseURL, model, queue)
	case "ollama":
		settings, _ := config.LoadSettings("configs/settings.json")
		model := *modelName
		if model == "" {
			model = settings.Model
		}
		realProvider = provider.NewOllamaProvider(settings.OllamaURL, model, queue)
	case "gemini":
		realProvider = provider.NewGeminiProvider(*modelName, queue)
	case "claude":
		realProvider = provider.NewClaudeProvider(*modelName, queue)
	default:
		fmt.Printf("\x1b[31m[Fatal] 不支援的提供者: %s\x1b[0m\n", *providerName)
		os.Exit(1)
	}

	// 2. 包裝攔截器
	aiProvider := &CaptureProxyProvider{RealProvider: realProvider}

	// 3. 引擎初始化
	if err := engine.Initialize(aiProvider); err != nil {
		fmt.Printf("\x1b[31m[Fatal] %v\x1b[0m\n", err)
		os.Exit(1)
	}

	// 4. 協調者
	coordinator := engine.NewCoordinator()
	coordinator.Start()

	// 5. 訂閱推論事件
	engine.GlobalEventBus.Subscribe("agent.inference", func(payload interface{}) {
		data, _ := payload.(map[string]interface{})
		agentEvent, _ := data["event"].(types.AIEvent)
		role, _ := data["role"].(string)

		if agentEvent.Type == "chunk" {
			fmt.Print("\x1b[38;5;243m" + agentEvent.Text + "\x1b[0m")
		} else if agentEvent.Type == "action" {
			fmt.Printf("\n\x1b[33m[Tool] 🛠️  代理人 [%s] 調用工具: %s\x1b[0m\n", role, agentEvent.Action.Name)
		} else if agentEvent.Type == "tool_result" && agentEvent.Output != nil {
			fmt.Printf("\x1b[32m%s\x1b[0m\n", agentEvent.Output.RenderToolResult())
		}
	})

	engine.GlobalEventBus.Subscribe("agent.inference.done", func(payload interface{}) {
		agentID, _ := payload.(string)
		fmt.Printf("\n\x1b[96m[System] ✨ Agent (%s) 推論回合結束\x1b[0m\n", agentID)
	})

	// 6. 互動式輸入循環
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

		fmt.Printf("\x1b[90m[User] %s\x1b[0m\n", input)
		coordinator.Submit(input)
		time.Sleep(2 * time.Second)

		// 顯示暫存差異
		if ctx, ok := engine.GetToolUseContextFromStore(); ok {
			staged, _ := ctx.GetStagedChanges().(*enginetools.StagedChanges)
			if staged != nil && len(staged.Files) > 0 {
				fmt.Print("\n\x1b[33m[Staged Changes]\x1b[0m\n")
				enginetools.PrintStagedDiff(staged)
			}
		}

		fmt.Print("\n> ")
	}

	if err := scanner.Err(); err != nil {
		fmt.Printf("\x1b[31m[Error] %v\x1b[0m\n", err)
	}
}
