package engine

import (
	"fmt"
	"os"
	"path/filepath"

	"imagine/engine/internal/types"
)

/**
 * resolvePath 根據 WorkingDirectory 處理路徑邏輯
 */
func resolvePath(workingDirectory, inputPath string) string {
	if filepath.IsAbs(inputPath) {
		return filepath.Clean(inputPath)
	}
	return filepath.Clean(filepath.Join(workingDirectory, inputPath))
}

/**
 * 初始化工具處理器 (Synchronous Tools Implementation)
 */
func init() {
	// list_files: 列出檔案
	GlobalToolbox.Register("list_files", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArgument, _ := arguments["path"].(string)
		finalPath := resolvePath(agentContext.WorkingDirectory, pathArgument)

		directoryEntries, errorValue := os.ReadDir(finalPath)
		if errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		var fileNames []string
		for _, file := range directoryEntries {
			fileNames = append(fileNames, file.Name())
		}

		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"files":       fileNames,
				"path":        pathArgument,
				"explanation": arguments["explanation"],
			},
		}, nil
	})

	// read_file_content: 讀取檔案內容
	GlobalToolbox.Register("read_file_content", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArgument, _ := arguments["path"].(string)
		finalPath := resolvePath(agentContext.WorkingDirectory, pathArgument)

		content, errorValue := os.ReadFile(finalPath)
		if errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"content":     string(content),
				"path":        pathArgument,
				"explanation": arguments["explanation"],
			},
		}, nil
	})

	// update_file: 更新或建立檔案
	GlobalToolbox.Register("update_file", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
		pathArgument, _ := arguments["path"].(string)
		codeArgument, _ := arguments["code"].(string)
		finalPath := resolvePath(agentContext.WorkingDirectory, pathArgument)

		directoryPath := filepath.Dir(finalPath)
		if errorValue := os.MkdirAll(directoryPath, 0755); errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		if errorValue := os.WriteFile(finalPath, []byte(codeArgument), 0644); errorValue != nil {
			return types.ActionResult{Success: false, Error: errorValue.Error()}, nil
		}

		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"path":        finalPath,
				"explanation": arguments["explanation"],
			},
		}, nil
	})

	// spawn_workers: 派發工作
	GlobalToolbox.Register("spawn_workers", func(arguments map[string]interface{}, agentContext *AgentContext) (types.ActionResult, error) {
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

			// 建立子代理人並發起任務
			newAgentID := GlobalToolbox.SpawnAgent(role)
			RunWithAgentID(newAgentID, role, taskDescription)

			spawnedTaskDescriptions = append(spawnedTaskDescriptions, fmt.Sprintf("%s (%s)", role, taskDescription))
		}

		return types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"explanation": explanation,
				"spawned":     spawnedTaskDescriptions,
			},
		}, nil
	})
}
