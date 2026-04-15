package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"testing"
	"time"

	"imagine/engine/internal/config"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

var testInput = flag.String("input", "", "測試指令輸入")

/**
 * CaptureProxyProvider 代理真實的 AI Provider 並攔截輸入
 */
type CaptureProxyProvider struct {
	RealProvider provider.AIProvider
}

func (p *CaptureProxyProvider) GenerateStream(ctx context.Context, messages []types.Message, options map[string]interface{}) (<-chan types.AIEvent, error) {
	// --- 攔截並打印輸入 ---
	fmt.Printf("\n\n=========================================\n")
	fmt.Printf("🚀 [攔截器] 準備發送請求給 AI...\n")
	jsonBytes, _ := json.MarshalIndent(messages, "", "  ")
	fmt.Println(string(jsonBytes))
	fmt.Printf("=========================================\n\n")

	// --- 轉發給真實的 Provider ---
	return p.RealProvider.GenerateStream(ctx, messages, options)
}

/**
 * TestRealInferenceInputCapture 攔截預設 Provider 的每一輪輸入
 * Provider 設定從 configs/settings.json 載入
 */
func TestRealInferenceInputCapture(t *testing.T) {
	// 1. 從 settings.json 載入預設 Provider
	settings, _ := config.LoadSettings("../../configs/settings.json")
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)

	var realProvider provider.AIProvider
	switch {
	case settings.VLLMBaseURL != "":
		realProvider = provider.NewVLLMProvider(settings.VLLMBaseURL, settings.Model, queue)
		t.Logf("✅ 使用 vLLM Provider: %s, 模型: %s", settings.VLLMBaseURL, settings.Model)
	case settings.OllamaURL != "":
		realProvider = provider.NewOllamaProvider(settings.OllamaURL, settings.Model, queue)
		t.Logf("✅ 使用 Ollama Provider: %s, 模型: %s", settings.OllamaURL, settings.Model)
	default:
		t.Fatal("settings.json 未設定任何 Provider URL")
	}

	proxyProvider := &CaptureProxyProvider{RealProvider: realProvider}

	// 2. 獲取使用者輸入 (優先順序: -args -input > 環境變數 TEST_INPUT > stdin)
	userInput := *testInput
	if userInput == "" {
		userInput = os.Getenv("TEST_INPUT")
	}
	if userInput == "" {
		fmt.Print("\n👉 \x1b[32m請輸入測試指令:\x1b[0m ")
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			userInput = scanner.Text()
		}
	}

	if userInput == "" {
		t.Fatal("未收到輸入，請使用: go test -run TestRealInferenceInputCapture -args -input=\"指令\"")
	}

	// 3. 載入 .agent 目錄 (相對於模組根目錄)
	agentDir := "../../../.agent"
	GlobalAgentLoader = NewAgentLoader(agentDir)
	t.Logf("✅ 使用 Agent 目錄: %s", agentDir)

	// 4. 使用真實的 Engine 初始化流程 (會載入真實工具與宣告)
	// 注意：tools.json 路徑相對於 Package 目錄
	Initialize(proxyProvider)
	t.Logf("✅ 真實引擎與工具初始化完成")

	// 5. 設定任務與 Context
	testAgentID := "CAPTURE-REAL-TOOLS"
	agentContext := CreateToolUseContext(testAgentID, "explorer", userInput, "./")
	agentContext.AddMessage("user", types.Message{Role: "user", Text: userInput, AgentID: testAgentID})

	// 6. 載入 Agent 並發起推論
	agent := NewAgent("explorer", proxyProvider)
	
	fmt.Printf("\n[Test] 🎬 Agent [%s] 初始化完成，開始真實工具推論攔截...\n", agent.RoleName)
	eventStream, _ := agent.Run(agentContext, GlobalToolbox.Declarations)
	
	for event := range eventStream {
		if event.Type == "chunk" {
			fmt.Print(event.Text)
		} else if event.Type == "action" {
			fmt.Printf("\n\x1b[33m[Tool Call] 🛠️  代理人調用真實工具: %s\x1b[0m\n", event.Action.Name)
		}
	}
	fmt.Printf("\n[Test] ✅ 測試結束。\n")
}
