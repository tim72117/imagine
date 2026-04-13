package engine

import (
	"context"
	"fmt"
	"imagine/engine/internal/provider"
	"imagine/engine/internal/types"
)

/**
 * Agent 代理人核心結構
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

var GlobalAgentLoader = NewAgentLoader("../.agent")

func NewAgent(roleType string, toolsConfig *ToolsConfig, aiProvider provider.AIProvider) *Agent {
	agentDefinition, errorValue := GlobalAgentLoader.GetAgent(roleType)
	
	systemPrompt := ""
	allowedTools := []string{}

	if errorValue == nil {
		fmt.Printf("  [Agent] 📂 已載入定義檔: %s.agent\n", roleType)
		systemPrompt = agentDefinition.Thought
		allowedTools = agentDefinition.Tools
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

func (agent *Agent) Run(agentContext *AgentContext, allDeclarations []types.ToolDeclaration) (<-chan types.AIEvent, error) {
	resultEvents := make(chan types.AIEvent, 500)
	maxRounds := 10
	
	go func() {
		defer close(resultEvents)

		fmt.Printf("  [%s] (%s) 🧠 開始推論推論循環...\n", agent.RoleName, agentContext.AgentID)

		agentContext.SetState("status", types.StatusActive)

		for agentContext.Round < maxRounds {
			currentRound := agentContext.Round + 1
			fmt.Printf("  [%s] 🔄 第 %d 輪循環啟動\n", agent.RoleName, currentRound)

			agentContext.SetState("status", types.StatusThinking)
			agentContext.Round = currentRound

			// 1. 組裝結構化訊息列表 (取代之前的單一 Prompt 字串)
			var messages []types.Message
			
			// A. 系統指令與環境資訊
			environmentInformation := fmt.Sprintf("【目前工作目錄】：%s", agentContext.WorkingDirectory)
			finalSystemPrompt := fmt.Sprintf("%s\n\n%s\n\n%s", agent.SystemPrompt, agent.ToolPrompt, environmentInformation)
			
			messages = append(messages, types.Message{
				Role: "system",
				Text: finalSystemPrompt,
			})

			// B. 注入對話歷史
			messages = append(messages, agentContext.Messages[0]...) // User/Tool Messages
			messages = append(messages, agentContext.Messages[1]...) // Assistant Messages

			// 2. 準備工具
			toolDeclarations := GetTools(agent.AllowedTools, allDeclarations)
			options := map[string]interface{}{
				"tools": toolDeclarations,
			}

			// 3. 發起推論
			// 注意：現在傳送的是 []types.Message
			rawEventStream, errorValue := agent.Provider.GenerateStream(context.Background(), messages, options)
			if errorValue != nil {
				resultEvents <- types.AIEvent{Type: "error", Text: errorValue.Error()}
				break
			}

			toolCalledThisRound := false
			currentAssistantMessage := PrepareNextRoundMessage()

			for streamEvent := range rawEventStream {
				if streamEvent.Type == "action" && streamEvent.Action != nil {
					toolCalledThisRound = true
					
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, types.Part{
						FunctionCall: &types.FunctionCall{
							Name: streamEvent.Action.Name,
							Args: streamEvent.Action.Args,
						},
					})

					resultEvents <- streamEvent
					arguments, _ := streamEvent.Action.Args.(map[string]interface{})

					// 1. 判斷工具是否為非同步
					isAsync := false
					for _, declaration := range allDeclarations {
						if declaration.Name == streamEvent.Action.Name && declaration.Type == "async" {
							isAsync = true
							break
						}
					}

					if isAsync {
						// 2. 新增非同步任務 Task
						taskID := CreateTask(agent.RoleName, agentContext.AgentID)
						agentContext.Tasks = append(agentContext.Tasks, taskID)
						fmt.Printf("  [%s] 📨 啟動非同步工具: %s (TaskID: %s)\n", agent.RoleName, streamEvent.Action.Name, taskID)
						
						// 3. 執行非同步動作 (透過 Toolbox) 並立即拿回說明文字
						description := agent.Toolbox.RunAsyncTool(agentContext, taskID, streamEvent.Action.Name, arguments)
						
						// 4. 將說明寫入對話紀錄
						agentContext.AddMessage("system", types.Message{
							Role: "system",
							Text: description,
						})
					} else {
						// 同步執行
						result, description, _ := agent.Toolbox.ExecuteTool(streamEvent.Action.Name, arguments, agentContext)
						
						// 1. 將執行說明寫入對話紀錄
						agentContext.AddMessage("system", types.Message{
							Role: "system",
							Text: description,
						})

						// 2. 將回傳結果寫入對話紀錄 (原本在 Toolbox 內部做，現在移到這裡)
						resultData, _ := json.Marshal(result.Data)
						agentContext.AddMessage("tool", types.Message{
							Role: "tool",
							Text: string(resultData),
							Tool: streamEvent.Action.Name,
						})
					}

				} else if streamEvent.Type == "chunk" {
					currentAssistantMessage.Text += streamEvent.Text
					currentAssistantMessage.Parts = append(currentAssistantMessage.Parts, types.Part{Text: streamEvent.Text})
					resultEvents <- streamEvent
				}
			}

			// 4. 存檔與檢查
			agentContext.AddMessage("assistant", currentAssistantMessage)
			
			if !toolCalledThisRound {
				fmt.Printf("  [%s] ✨ 推論結束。\n", agent.RoleName)
				agentContext.SetState("status", types.StatusCompleted)
				agentContext.IsFinished = true
				break
			}
		}
		agentContext.Save()
	}()

	return resultEvents, nil
}
