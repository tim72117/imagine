package tools

import (
	"fmt"
	"imagine/engine/internal/types"
)

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
