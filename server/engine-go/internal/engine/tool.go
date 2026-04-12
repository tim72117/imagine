package engine

import (
	"encoding/json"
	"os"

	"imagine/engine/internal/types"
)

/**
 * ToolsConfig 代表 tools.json 的結構，僅保留工具宣告
 */
type ToolsConfig struct {
	Declarations map[string]interface{} `json:"declarations"`
}

/**
 * LoadToolsConfig 從 tools.json 載入所有宣告
 */
func LoadToolsConfig(path string) (*ToolsConfig, error) {
	data, errorValue := os.ReadFile(path)
	if errorValue != nil {
		return nil, errorValue
	}
	var config ToolsConfig
	if errorValue := json.Unmarshal(data, &config); errorValue != nil {
		return nil, errorValue
	}
	return &config, nil
}

/**
 * GetTools 根據名稱列表從工具庫中篩選出對應的宣告
 */
func GetTools(toolNames []string, allDeclarations []types.ToolDeclaration) []types.ToolDeclaration {
	var filteredDeclarations []types.ToolDeclaration
	for _, name := range toolNames {
		for _, declaration := range allDeclarations {
			if declaration.Name == name {
				filteredDeclarations = append(filteredDeclarations, declaration)
			}
		}
	}
	return filteredDeclarations
}
