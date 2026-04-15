package engine

import (
	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
)

var planDeclaration = types.ToolDeclaration{
	Name:        "plan",
	Description: "當接收到的需求過於龐大，可能需要拆解進行多步驟處理時呼叫。進行架構分析與開發步驟的拆解。",
	Type:        "sync",
	Parameters: map[string]interface{}{
		"type": "OBJECT",
		"properties": map[string]interface{}{
			"analysis": map[string]interface{}{
				"type":        "STRING",
				"description": "針對大型任務的現狀分析，或針對空泛需求的澄清、假設與困難點拆解邏輯。",
			},
			"next_steps_plan": map[string]interface{}{
				"type":        "ARRAY",
				"items":       map[string]interface{}{"type": "STRING"},
				"description": "預計執行的後續具體計畫步驟",
			},
		},
		"required": []string{"analysis", "next_steps_plan"},
	},
}

/**
 * 初始化工具處理器與宣告 (從各工具檔取得 Declaration)
 */
func init() {
	GlobalToolbox.RegisterWithDeclaration("Glob", tools.ListFiles, tools.GlobDeclaration)
	GlobalToolbox.RegisterWithDeclaration("Read", tools.ReadFile, tools.ReadDeclaration)
	GlobalToolbox.RegisterWithDeclaration("edit_file", tools.EditFile, tools.EditFileDeclaration)
	GlobalToolbox.RegisterWithDeclaration("update_file", tools.UpdateFile, tools.UpdateFileDeclaration)
	GlobalToolbox.RegisterWithDeclaration("Browser", tools.Browser, tools.BrowserDeclaration)
	GlobalToolbox.RegisterWithDeclaration("spawn_workers", func(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ToolOutput, error) {
		return tools.SpawnWorkers(arguments, agentContext, GlobalToolbox.SpawnAgent, RunWithAgentID)
	}, tools.SpawnWorkersDeclaration)
	GlobalToolbox.RegisterWithDeclaration("plan", nil, planDeclaration)
}
