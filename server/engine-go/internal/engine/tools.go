package engine

import (
	"imagine/engine/internal/engine/tools"
	"imagine/engine/internal/types"
)

/**
 * 初始化工具處理器 (將實作從 tools 子套件註冊到 GlobalToolbox)
 */
func init() {
	// list_files: 列出檔案
	GlobalToolbox.Register("list_files", tools.ListFiles)

	// read_file: 讀取檔案 (支援快取與分段)
	GlobalToolbox.Register("read_file", tools.ReadFile)

	// update_file: 更新或建立檔案
	GlobalToolbox.Register("update_file", tools.UpdateFile)

	// spawn_workers: 派發工作 (透過閉包注入 engine 套件的方法)
	GlobalToolbox.Register("spawn_workers", func(arguments map[string]interface{}, agentContext types.AgentContextInterface) (types.ActionResult, error) {
		return tools.SpawnWorkers(arguments, agentContext, GlobalToolbox.SpawnAgent, RunWithAgentID)
	})
}
