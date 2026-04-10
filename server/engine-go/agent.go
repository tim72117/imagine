package engine

import (
	"context"
	"fmt"
)

/**
 * Agent 代理人核心結構，對應 TS 中的 Agent 類別
 */
type Agent struct {
	RoleName     string
	RoleType     string
	Provider     AIProvider
	SystemPrompt string
	ToolPrompt   string
	AllowedTools []string
	Toolbox      *Toolbox
}

/**
 * NewAgent 建立一個新的代理人實體
 */
func NewAgent(roleType string, toolsConfig *ToolsConfig, provider AIProvider) *Agent {
	return &Agent{
		RoleName:     roleType, // 簡化處理，實際可從 config 抓取更精確的名稱
		RoleType:     roleType,
		Provider:     provider,
		SystemPrompt: toolsConfig.GetRolePrompt(roleType),
		ToolPrompt:   "請務必在執行工具前，先用文字簡短說明你的行動意圖與原因。", 
		AllowedTools: toolsConfig.GetRoleTools(roleType),
		Toolbox:      GlobalToolbox,
	}
}

/**
 * Run 執行任務推論循環，對應 TS 中的 run 方法
 * 它會自動處理多輪對話 (Max Rounds) 並透過通道傳回所有事件
 */
func (agent *Agent) Run(agentContext *AgentContext, allDeclarations map[string]interface{}) (<-chan AIEvent, error) {
	resultEvents := make(chan AIEvent, 500)
	maxRounds := 10
	
	go func() {
		defer close(resultEvents)

		task := agentContext.GetCurrentTask()
		initialGoal := "未定義任務"
		if task != nil && len(task.Messages[0]) > 0 {
			initialGoal = task.Messages[0][0].Text
		}

		fmt.Printf("  [%s] (%s) 🧠 開始任務：%s...\n", agent.RoleName, agentContext.AgentID, func() string {
			if len(initialGoal) > 50 {
				return initialGoal[:50]
			}
			return initialGoal
		}())

		// 同步狀態為 Active
		agentContext.UpdateTaskState(StatusActive, 0)

		// --- 推論循環 ---
		for agentContext.Round < maxRounds {
			currentRound := agentContext.Round + 1
			fmt.Printf("  [%s] 🔄 第 %d 輪循環啟動\n", agent.RoleName, currentRound)

			agentContext.UpdateTaskState(StatusThinking, 10+(currentRound*10))
			agentContext.Round = currentRound

			task := agentContext.GetCurrentTask()
			userMessages := task.Messages[0]
			assistantMessages := task.Messages[1]

			// 1. 準備工具與配置
			toolDeclarations := GetTools(agent.AllowedTools, allDeclarations)
			options := map[string]interface{}{
				"tools": toolDeclarations,
			}

			// 2. 準備環境資訊
			envInfo := fmt.Sprintf("【目前工作目錄】：%s", func() string {
				if agentContext.WorkDir == "" {
					return "未定義"
				}
				return agentContext.WorkDir
			}())

			// 3. 組裝指令 (Prompt Only)
			instruction, err := BuildInferenceParameters(
				agent.SystemPrompt,
				agent.ToolPrompt,
				envInfo,
				userMessages,
				assistantMessages,
			)

			if err != nil {
				resultEvents <- AIEvent{Type: "error", Text: err.Error()}
				break
			}

			// 3. 在 Agent 中執行推論啟動
			rawEvents, err := agent.Provider.GenerateStream(context.Background(), instruction, options)
			if err != nil {
				resultEvents <- AIEvent{Type: "error", Text: err.Error()}
				break
			}

			// 3. 本輪推論與工具執行 (後續 logic 保持不變)
			toolCalledThisRound := false
			currentAssistantMessage := PrepareNextRoundMessage()

			for event := range rawEvents {
				if event.Type == "action" && event.Action != nil {
					toolCalledThisRound = true
					
					// 紀錄 Function Call
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, Part{
						FunctionCall: &FunctionCall{
							Name: event.Action.Name,
							Args: event.Action.Args,
						},
					})

					// 發送 Action 事件 (先讓觀察者知道意圖)
					resultEvents <- event

					// 執行工具 (使用 Agent 自己的 Toolbox)
					args, _ := event.Action.Args.(map[string]interface{})
					result := agent.Toolbox.ExecuteTool(event.Action.Name, args, agentContext)
					
					// 準備工具執行結果描述
					resultDescription := fmt.Sprintf("[%s] 執行完成", event.Action.Name)
					if !result.Success {
						resultDescription = fmt.Sprintf("[%s] 執行失敗: %s", event.Action.Name, result.Error)
					}

					// 發送工具結果事件
					resultEvents <- AIEvent{
						Type: "tool_result",
						Text: resultDescription,
						Action: &ActionData{
							Name: event.Action.Name,
							Args: result.Data,
						},
					}

				} else if event.Type == "chunk" {
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, Part{Text: event.Text})
					resultEvents <- event
				}
			}

			// 3. 歸檔本輪助手回應
			agentContext.AddMessage("assistant", currentAssistantMessage)
			agentContext.UpdateTaskState(StatusThinkingCompleted, 10+(currentRound*10))

			// 檢查是否結束
			if !toolCalledThisRound {
				fmt.Printf("  [%s] ✨ 本階段任務完成。\n", agent.RoleName)
				break
			}
		}
	}()

	return resultEvents, nil
}
