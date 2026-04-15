package tools

import (
	"fmt"
	"imagine/engine/internal/types"
)

var SpawnWorkersDeclaration = types.ToolDeclaration{
	Name:        "spawn_workers",
	Description: "由協調者調派一或多個專屬執行者來處理子任務。你必須根據任務性質選擇「偵查者 (explorer)」或「編修者 (editor)」，可同時調派多個執行者並行工作。",
	Type:        "async",
	Parameters: map[string]interface{}{
		"type": "OBJECT",
		"properties": map[string]interface{}{
			"workers": map[string]interface{}{
				"type": "ARRAY",
				"items": map[string]interface{}{
					"type": "OBJECT",
					"properties": map[string]interface{}{
						"task": map[string]interface{}{
							"type":        "STRING",
							"description": "指派給該執行者的具體工作目標。請使用繁體中文描述任務細節。",
						},
						"role": map[string]interface{}{
							"type":        "STRING",
							"description": "指派的執行者角色類型。",
							"enum":        []string{"explorer", "editor"},
						},
					},
					"required": []string{"task", "role"},
				},
				"description": "執行者列表。每項任務都會啟動一個獨立的執行器。",
			},
			"explanation": map[string]interface{}{
				"type":        "STRING",
				"description": "說明為何需要此時調派這些執行者，以及它們分工的邏輯。",
			},
		},
		"required": []string{"workers", "explanation"},
	},
}

// SpawnAgentFunc 定義了建立代理人的函式型別，避免工具直接依賴 GlobalToolbox
type SpawnAgentFunc func(role string) string

// RunAgentFunc 定義了運行代理人的函式型別
type RunAgentFunc func(agentID string, role string, goal string)

/**
 * SpawnWorkers 工具實作
 */
func SpawnWorkers(arguments map[string]interface{}, agentContext types.ToolUseContextInterface, spawnAgent SpawnAgentFunc, runAgent RunAgentFunc) (types.ActionResult, error) {
	workers, isSuccessful := arguments["workers"].([]interface{})
	if !isSuccessful {
		return types.ActionResult{Success: false, Error: "缺少 workers 參數"}, nil
	}

	explanation, _ := arguments["explanation"].(string)
	
	var spawnedTaskDescriptions []string
	for _, workerElement := range workers {
		workerMap, isSuccessful := workerElement.(map[string]interface{})
		if !isSuccessful {
			continue
		}

		role, _ := workerMap["role"].(string)
		taskDescription, _ := workerMap["task"].(string)

		// 建立子代理人並發起任務 (透過傳入的注入函式)
		newAgentID := spawnAgent(role)
		runAgent(newAgentID, role, taskDescription)

		spawnedTaskDescriptions = append(spawnedTaskDescriptions, fmt.Sprintf("%s (%s)", role, taskDescription))
	}

	return types.ActionResult{
		Success: true,
		Data: map[string]interface{}{
			"explanation": explanation,
			"spawned":     spawnedTaskDescriptions,
		},
	}, nil
}
