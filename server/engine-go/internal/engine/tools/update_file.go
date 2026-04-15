package tools

import (
	"os"
	"path/filepath"

	"imagine/engine/internal/types"
)

var UpdateFileDeclaration = types.ToolDeclaration{
	Name:        "update_file",
	Description: "修改檔案內容 or 產出全新的組件代碼。支援使用檔案代碼（例：[F1]）定位目標。",
	Type:        "sync",
	Parameters: map[string]interface{}{
		"type": "OBJECT",
		"properties": map[string]interface{}{
			"path": map[string]interface{}{
				"type":        "STRING",
				"description": "目標檔案路徑 or 代碼（例：[F1]）。",
			},
			"code": map[string]interface{}{
				"type":        "STRING",
				"description": "完整的 React 組件代碼。規範：\n1. 絕對禁止 import。\n2. 僅限一個名為 App 的組件。\n3. 無須 export。\n4. 僅限 React 18 語法與 Tailwind CSS。\n5. 不支援第三方圖示，請用 Emoji 或 Tailwind 組件圖形。",
			},
			"explanation": map[string]interface{}{
				"type":        "STRING",
				"description": "【極簡】說明本次代碼變更的核心邏輯與修改點。",
			},
			"next_step": map[string]interface{}{
				"type":        "STRING",
				"description": "檔案更新完成後，預計的後續開發動作。",
			},
		},
		"required": []string{"path", "code", "explanation", "next_step"},
	},
}

/**
 * UpdateFile 工具實作
 */
func UpdateFile(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ToolOutput, error) {
	pathArgument, _ := arguments["path"].(string)
	codeArgument, _ := arguments["code"].(string)
	finalPath := resolvePath(agentContext.GetWorkingDirectory(), pathArgument)

	directoryPath := filepath.Dir(finalPath)
	if errorValue := os.MkdirAll(directoryPath, 0755); errorValue != nil {
		return types.NewToolOutput("update_file", types.ActionResult{Success: false, Error: errorValue.Error()}), nil
	}

	if errorValue := os.WriteFile(finalPath, []byte(codeArgument), 0644); errorValue != nil {
		return types.NewToolOutput("update_file", types.ActionResult{Success: false, Error: errorValue.Error()}), nil
	}

	return types.NewToolOutput("update_file", types.ActionResult{
		Success: true,
		Data: map[string]interface{}{
			"path":        finalPath,
			"explanation": arguments["explanation"],
		},
	}), nil
}
