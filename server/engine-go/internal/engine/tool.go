package engine

import (
	"encoding/json"
	"os"
)

// --- 工具配置助手 ---

// ToolsConfig 代表 tools.json 的結構
type ToolsConfig struct {
	Declarations map[string]interface{} `json:"declarations"`
	RoleTools    map[string][]string    `json:"role_tools"`
	Prompts      map[string]string      `json:"prompts"`
}

/**
 * LoadToolsConfig 從 tools.json 載入所有宣告與角色設定
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
 * GetRolePrompt 獲取特定角色的系統提示詞 (System Prompt)
 */
func (config *ToolsConfig) GetRolePrompt(role string) string {
	if prompt, exists := config.Prompts[role]; exists {
		return prompt
	}
	return "你是一個專業的 AI 開發助手。"
}

/**
 * GetRoleTools 獲獲取特定角色可用的工具名稱列表
 */
func (config *ToolsConfig) GetRoleTools(role string) []string {
	if tools, exists := config.RoleTools[role]; exists {
		return tools
	}
	return []string{}
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
