package engine

import (
	"encoding/json"
	"os"
)

// --- 工具配置助手 ---

// ToolsConfig 代表 tools.json 的結構，僅保留工具宣告
type ToolsConfig struct {
	Declarations map[string]interface{} `json:"declarations"`
}

/**
 * LoadToolsConfig 從 tools.json 載入所有宣告
 */
func LoadToolsConfig(path string) (*ToolsConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var config ToolsConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	return &config, nil
}

/**
 * GetTools 根據名稱列表從工具庫中篩選出對應的宣告，對應 TS 中的 getTools
 */
func GetTools(toolNames []string, allDeclarations map[string]interface{}) []map[string]interface{} {
	var declarations []interface{}
	for _, name := range toolNames {
		if declaration, exists := allDeclarations[name]; exists {
			declarations = append(declarations, declaration)
		}
	}

	return []map[string]interface{}{
		{
			"functionDeclarations": declarations,
		},
	}
}
