package engine

import (
	"context"
	"fmt"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

/**
 * Agent 代理人核心結構，對應 TS 中的 Agent 類別
 */
type Agent struct {
	RoleName     string
	RoleType     string
	Provider     provider.AIProvider
	SystemPrompt string
	ToolPrompt   string
	AllowedTools []string
	Toolbox      *Toolbox
}

/**
 * GlobalAgentLoader 全域載入器，預設指向 server/.agent
 */
var GlobalAgentLoader = NewAgentLoader("../.agent")

/**
 * NewAgent 建立一個新的代理人實體
 */
func NewAgent(roleType string, toolsConfig *ToolsConfig, aiProvider provider.AIProvider) *Agent {
	// 嚴格從 .agent 檔案載入定義
	agentDefinition, errorValue := GlobalAgentLoader.GetAgent(roleType)
	
	systemPrompt := ""
	allowedTools := []string{}

	if errorValue == nil {
		fmt.Printf("  [Agent] 📂 已載入定義檔: %s.agent\n", roleType)
		systemPrompt = agentDefinition.Thought
		allowedTools = agentDefinition.Tools
	} else {
		fmt.Printf("  [Agent] ⚠️ 找不到定義檔 %s.agent，Prompt 將維持為空。\n", roleType)
	}

	return &Agent{
		RoleName:     roleType,
		RoleType:     roleType,
		Provider:     aiProvider,
		SystemPrompt: systemPrompt,
		ToolPrompt:   "請務必在執行工具前，先用文字簡短說明你的行動意圖與原因。",
		AllowedTools: allowedTools,
		Toolbox:      GlobalToolbox,
	}
}

/**
 * Run 執行任務推論循環，對應 TS 中的 run 方法
 * 它會自動處理多輪對話 (Max Rounds) 並透過通道傳回所有事件
 */
func (agent *Agent) Run(agentContext *AgentContext, allDeclarations map[string]interface{}) (<-chan types.AIEvent, error) {
	resultEvents := make(chan types.AIEvent, 500)
	maxRounds := 10
	
	go func() {
		defer close(resultEvents)

		messages := agentContext.GetMessages()
		initialGoal := "未定義任務"
		if len(messages[0]) > 0 {
			initialGoal = messages[0][0].Text
		}

		fmt.Printf("  [%s] (%s) 🧠 開始任務：%s...\n", agent.RoleName, agentContext.AgentID, func() string {
			if len(initialGoal) > 50 {
				return initialGoal[:50]
			}
			return initialGoal
		}())

		// 同步狀態為 Active
		agentContext.SetState("status", types.StatusActive)
		agentContext.SetState("progress", 0)

		// --- 推論循環 ---
		for agentContext.Round < maxRounds {
			// 同步當前狀態到 Store
			agentContext.SyncState()
			
			// 核心檢查：如果尚有子任務未完成，應暫停推論循環，進入等待狀態
			if len(agentContext.Tasks) > 0 && !agentContext.IsAllTasksCompleted() {
				fmt.Printf("  [%s] ⏳ 尚有子任務未完成，暫停推論，進入等待狀態 (Total Tasks: %d)\n", agent.RoleName, len(agentContext.Tasks))
				agentContext.SetState("status", types.StatusWaiting)
				agentContext.SyncState()
				break
			}

			currentRound := agentContext.Round + 1
			fmt.Printf("  [%s] 🔄 第 %d 輪循環啟動\n", agent.RoleName, currentRound)

			agentContext.SetState("status", types.StatusThinking)
			agentContext.SetState("progress", 10+(currentRound*10))
			agentContext.Round = currentRound

			history := agentContext.GetMessages()
			userMessages := history[0]
			assistantMessages := history[1]

			// 1. 準備工具與配置
			toolDeclarations := GetTools(agent.AllowedTools, allDeclarations)
			options := map[string]interface{}{
				"tools": toolDeclarations,
			}

			// 2. 準備環境資訊
			environmentInfo := fmt.Sprintf("【目前工作目錄】：%s", func() string {
				if agentContext.WorkDir == "" {
					return "未定義"
				}
				return agentContext.WorkDir
			}())

			// 3. 組裝指令 (Prompt Only)
			instruction, errorValue := BuildInferenceParameters(
				agent.SystemPrompt,
				agent.ToolPrompt,
				environmentInfo,
				userMessages,
				assistantMessages,
			)

			if errorValue != nil {
				resultEvents <- types.AIEvent{Type: "error", Text: errorValue.Error()}
				break
			}

			// 3. 在 Agent 中執行推論啟動
			rawEventStream, errorValue := agent.Provider.GenerateStream(context.Background(), instruction, options)
			if errorValue != nil {
				resultEvents <- types.AIEvent{Type: "error", Text: errorValue.Error()}
				break
			}

			// 3. 本輪推論與工具執行
			toolCalledThisRound := false
			currentAssistantMessage := PrepareNextRoundMessage()

			for streamEvent := range rawEventStream {
				if streamEvent.Type == "action" && streamEvent.Action != nil {
					toolCalledThisRound = true
					
					// 紀錄 Function Call
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, types.Part{
						FunctionCall: &types.FunctionCall{
							Name: streamEvent.Action.Name,
							Args: streamEvent.Action.Args,
						},
					})

					// 發送 Action 事件 (先讓觀察者知道意圖)
					resultEvents <- streamEvent

					// 調派執行：由 Toolbox 決定同步或非同步
					arguments, _ := streamEvent.Action.Args.(map[string]interface{})
					agent.Toolbox.Dispatch(streamEvent.Action.Name, arguments, agentContext, allDeclarations, resultEvents)

				} else if streamEvent.Type == "chunk" {
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, types.Part{Text: streamEvent.Text})
					resultEvents <- streamEvent
				}
			}

			// 3. 歸檔本輪助手回應
			agentContext.AddMessage("assistant", currentAssistantMessage)
			agentContext.SetState("status", types.StatusThinkingCompleted)
			agentContext.SetState("progress", 10+(currentRound*10))

			// 檢查是否結束
			if !toolCalledThisRound {
				fmt.Printf("  [%s] ✨ 本階段任務完成。\n", agent.RoleName)
				
				// 1. 標記當前任務為完成
				agentContext.SetState("status", types.StatusCompleted)
				agentContext.SetState("progress", 100)

				// 如果此時所有子任務也已完結，則標記 AgentContext 為徹底完成
				if agentContext.IsAllTasksCompleted() {
					agentContext.IsFinished = true
				}

				agentContext.SyncState()
				break
			}
		}
	}()

	return resultEvents, nil
}
