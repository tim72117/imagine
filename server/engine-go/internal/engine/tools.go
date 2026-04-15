package engine

import (
	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
)

/**
 * 初始化工具處理器 (將實作從 tools 子套件註冊到 GlobalToolbox)
 */
func init() {
	// Glob: 搜尋檔案
	GlobalToolbox.Register("Glob", tools.ListFiles)

	// Read: 讀取檔案 (支援快取與分段)
	GlobalToolbox.Register("Read", tools.ReadFile)

	// update_file: 更新或建立檔案
	GlobalToolbox.Register("update_file", tools.UpdateFile)

	// spawn_workers: 派發工作
	GlobalToolbox.Register("spawn_workers", func(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
		return tools.SpawnWorkers(arguments, agentContext, GlobalToolbox.SpawnAgent, RunWithAgentID)
	})

	// Browser: 操控瀏覽器
	GlobalToolbox.Register("Browser", tools.Browser)
}
