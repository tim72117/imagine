package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

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
 * TestRealInferenceInputCapture 執行此測試以查看「真實 Ollama 推論」中的每一輪輸入
 * 現在支援互動式輸入與真實工具調用
 */
func TestRealInferenceInputCapture(t *testing.T) {
	// 1. 初始化真實的 Ollama Provider
	queue := provider.NewRequestQueue(1, 100*time.Millisecond)
	realOllama := provider.NewOllamaProvider("http://localhost:11434", "gemma4:e2b", queue)
	
	proxyProvider := &CaptureProxyProvider{RealProvider: realOllama}

	// 2. 獲取使用者輸入
	var userInput string
	fmt.Print("\n👉 \x1b[32m請輸入測試指令:\x1b[0m ")
	
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err == nil {
		defer tty.Close()
		scanner := bufio.NewScanner(tty)
		if scanner.Scan() {
			userInput = scanner.Text()
		}
	} else {
		scanner := bufio.NewScanner(os.Stdin)
		if scanner.Scan() {
			userInput = scanner.Text()
		}
	}

	if userInput == "" {
		t.Fatal("未收到輸入或讀取內容為空")
	}

	// 3. 直接使用確認過後的絕對路徑載入 .agent 目錄
	GlobalAgentLoader = NewAgentLoader("/Users/caitingyu/Documents/imagine/server/.agent")
	t.Logf("✅ 使用固定 Agent 目錄: %s", "/Users/caitingyu/Documents/imagine/server/.agent")

	// 4. 使用真實的 Engine 初始化流程 (會載入真實工具與宣告)
	// 注意：tools.json 路徑相對於 Package 目錄
	Initialize(proxyProvider, "../../configs/tools.json")
	t.Logf("✅ 真實引擎與工具初始化完成")

	// 5. 設定任務與 Context
	testAgentID := "CAPTURE-REAL-TOOLS"
	agentContext := CreateToolUseContext(testAgentID, "explorer", userInput, "./")
	agentContext.AddMessage("user", types.Message{Role: "user", Text: userInput, AgentID: testAgentID})

	// 6. 載入 Agent 並發起推論
	agent := NewAgent("explorer", &ToolsConfig{}, proxyProvider)
	
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
