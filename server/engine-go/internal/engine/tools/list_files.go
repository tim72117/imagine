package tools

import (
	"os"

	"imagine/engine/internal/types"
)

/**
 * ListFiles 工具實作
 */
func ListFiles(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
	pathArgument, _ := arguments["path"].(string)
	finalPath := resolvePath(agentContext.GetWorkingDirectory(), pathArgument)

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
}
