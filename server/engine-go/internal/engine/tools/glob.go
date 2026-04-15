package tools

import (
	"os"
	"path/filepath"
	"strings"

	"imagine/engine/internal/types"
)

// ListFiles (現在作為 Glob 工具實作)
// 支援萬用字元模式, 例如: src/**/*.ts
func ListFiles(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
	pattern, _ := arguments["pattern"].(string)
	basePath, _ := arguments["path"].(string)
	
	if basePath == "" {
		basePath = "."
	}

	root := resolvePath(agentContext.GetWorkingDirectory(), basePath)
	var matches []string

	// 使用 WalkDir 進行遞迴搜尋
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		
		// 取得相對於起始路徑的相對路徑
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return nil
		}

		// 忽略隱藏資料夾（如 .git）
		if d.IsDir() && strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
			return filepath.SkipDir
		}

		// 進行模式比對
		if !d.IsDir() && matchPattern(pattern, rel) {
			matches = append(matches, rel)
		}
		
		return nil
	})

	if err != nil {
		return types.ActionResult{Success: false, Error: err.Error()}, nil
	}

	// 限制回傳數量，避免 Token 爆炸
	if len(matches) > 100 {
		matches = matches[:100]
	}

	data := map[string]interface{}{
		"files":   matches,
		"pattern": pattern,
		"root":    basePath,
	}

	if len(matches) == 0 {
		data["guidance"] = "未找到匹配檔案。指引: 請檢查模式是否正確，或嘗試使用更廣泛的模式(例如: **/*.go)；如果是在特定目錄下搜尋，請確保 path 正確。"
	}

	return types.ActionResult{
		Success: true,
		Data:    data,
	}, nil
}

// matchPattern 實作基本的 Glob 比對
func matchPattern(pattern, path string) bool {
	pattern = filepath.ToSlash(pattern)
	path = filepath.ToSlash(path)

	// 如果包含 **, 則處理遞迴邏輯
	if strings.Contains(pattern, "**") {
		parts := strings.Split(pattern, "/**/")
		if len(parts) == 2 {
			prefix := parts[0]
			suffix := parts[1]
			return strings.HasPrefix(path, prefix) && (strings.HasSuffix(path, suffix) || suffix == "*")
		}
		ext := filepath.Ext(pattern)
		if strings.HasPrefix(pattern, "**") && ext != "" {
			return filepath.Ext(path) == ext
		}
	}

	// 一般模式使用標準庫
	matched, _ := filepath.Match(pattern, path)
	return matched
}
