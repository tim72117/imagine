package tools

import (
	"os"
	"path/filepath"

	"imagine/engine/internal/types"
)

/**
 * UpdateFile 工具實作
 */
func UpdateFile(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
	pathArgument, _ := arguments["path"].(string)
	codeArgument, _ := arguments["code"].(string)
	finalPath := resolvePath(agentContext.GetWorkingDirectory(), pathArgument)

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
}
