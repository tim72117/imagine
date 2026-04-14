package engine

import (
	"context"
	"encoding/json"
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

func (agent *Agent) Run(toolUseContext *ToolUseContext, allDeclarations []types.ToolDeclaration) (<-chan types.AIEvent, error) {
	resultEvents := make(chan types.AIEvent, 500)
	maxRounds := 10

	go func() {
		defer close(resultEvents)

		fmt.Printf("  [%s] (%s) 🧠 開始推論循環...\n", agent.RoleName, toolUseContext.AgentID)

		toolUseContext.SetState("status", types.StatusActive)

		// A. 同步已完成的非同步任務結果 (從 AppStore 拉取)
		agent.SyncTaskResults(toolUseContext)

		for toolUseContext.Round < maxRounds {
			currentRound := toolUseContext.Round + 1
			fmt.Printf("  [%s] 🔄 第 %d 輪循環啟動\n", agent.RoleName, currentRound)

			toolUseContext.SetState("status", types.StatusThinking)
			toolUseContext.Round = currentRound

			// 1. 組裝結構化訊息列表
			var messages []types.Message

			// A. 系統指令與環境資訊
			environmentInformation := fmt.Sprintf("【目前工作目錄】：%s", toolUseContext.WorkingDirectory)
			finalSystemPrompt := fmt.Sprintf("%s\n\n%s\n\n%s", agent.SystemPrompt, agent.ToolPrompt, environmentInformation)

			messages = append(messages, types.Message{
				Role: "system",
				Text: finalSystemPrompt,
			})

			// B. 注入對話歷史與當前暫存區 (歷史 -> 本輪思考 -> 本輪結果)
			toolUseContext.RLock()
			messages = append(messages, toolUseContext.Messages[0]...)
			messages = append(messages, toolUseContext.Messages[1]...)
			messages = append(messages, toolUseContext.Messages[2]...)
			toolUseContext.RUnlock()

			// C. 注入附件 (Contextual Memory)
			messages = append(messages, agent.GetAttachmentMessages(toolUseContext)...)

			// 2. 準備工具
			toolDeclarations := GetTools(agent.AllowedTools, allDeclarations)
			options := map[string]interface{}{
				"tools": toolDeclarations,
			}

			// 3. 發起推論
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
						taskID := CreateTask(agent.RoleName, toolUseContext.AgentID)
						toolUseContext.Tasks = append(toolUseContext.Tasks, taskID)
						fmt.Printf("  [%s] 📨 啟動非同步工具: %s (TaskID: %s)\n", agent.RoleName, streamEvent.Action.Name, taskID)

						// 3. 執行非同步動作 (透過 Toolbox) 並立即拿回說明文字
						description := agent.Toolbox.RunAsyncTool(toolUseContext, taskID, streamEvent.Action.Name, arguments)

						// 4. 將說明寫入對話紀錄
						toolUseContext.AddMessage("system", types.Message{
							Role: "system",
							Text: description,
						})
					} else {
						// 同步執行
						result, description, _ := agent.Toolbox.ExecuteTool(streamEvent.Action.Name, arguments, toolUseContext)

						// 1. 將執行說明寫入對話紀錄
						toolUseContext.AddMessage("system", types.Message{
							Role: "system",
							Text: description,
						})

						// 2. 將回傳結果寫入對話紀錄
						resultData, _ := json.Marshal(result.Data)
						toolUseContext.AddMessage("tool", types.Message{
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

			// 4. 固定當前輪產出並提交
			toolUseContext.AddMessage("assistant", currentAssistantMessage)
			toolUseContext.CommitRound()

			if !toolCalledThisRound {
				fmt.Printf("  [%s] ✨ 推論結束。\n", agent.RoleName)
				toolUseContext.SetState("status", types.StatusCompleted)
				toolUseContext.IsFinished = true
				break
			}
		}

		// 5. 確保持久化
		toolUseContext.Save()
	}()

	return resultEvents, nil
}
