package engine

import (
	"encoding/json"
	"fmt"
	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
	"time"
)

/**
 * SyncTaskResults 從 AppStore 同步已完成的非同步任務結果至 Agent 歷史紀錄
 */
func (agent *Agent) SyncTaskResults(agentContext *ToolUseContext) {
	var activeTasks []string
	
	for _, taskID := range agentContext.Tasks {
		task, exists := GlobalAppStore.GetTask(taskID)
		
		// 檢查任務是否已完成或出錯
		if exists && (task.Status == types.StatusCompleted || task.Status == types.StatusError) {
			fmt.Printf("  [%s] 📥 同步已完成的任務結果: %s\n", agent.RoleName, taskID)
			
			// 1. 從 State 中提取結果 (優先自 "result" key 獲取)
			targetData := task.Data
			if task.State != nil && task.State["result"] != nil {
				targetData = task.State["result"]
			}
			resultData, _ := json.Marshal(targetData)
			
			// 2. 獲取工具名稱 (優先從 State 獲取，否則使用 Task.Role)
			toolName, _ := task.State["tool"].(string)
			if toolName == "" {
				toolName = task.Role
			}

			// 3. 注入工具結果訊息到歷史紀錄
			agentContext.AddMessage("tool", types.Message{
				Role: "tool",
				Text: string(resultData),
				Tool: toolName,
				Time: time.Now().UnixMilli(),
			})
			
			// 任務已處理，不加入 activeTasks (即從待辦清單移除)
			continue
		}
		
		// 尚未完成的任務保留在追蹤清單中
		activeTasks = append(activeTasks, taskID)
	}

	// 更新 Context 中的任務清單
	agentContext.Tasks = activeTasks
}

/**
 * GetAttachmentMessages 從工具快取中獲取需要附加在推論中的訊息 (Contextual Memory)
 */
func (agent *Agent) GetAttachmentMessages(agentContext *ToolUseContext) []types.Message {
	var messages []types.Message
	
	// 1. 從 ReadFileState 獲取檔案內容附件
	cache, _ := agentContext.GetReadFileState().(*tools.ReadFileState)
	if cache != nil {
		for filePath, state := range cache.States {
			// 將檔案內容封裝為系統資訊供 LLM 參考
			content := fmt.Sprintf("【目前已載入的檔案快取】: %s\n---\n%s\n---", filePath, state.Content)
			messages = append(messages, types.Message{
				Role: "system",
				Text: content,
				Time: time.Now().UnixMilli(),
			})
		}
	}

	return messages
}
