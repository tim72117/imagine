package tools

import (
	"bufio"
	"os"

	"imagine/engine/internal/types"
)

/**
 * FileState 儲存單個檔案的讀取狀態
 */
type FileState struct {
	Content   string
	Timestamp int64
	Offset    float64
	Limit     float64
}

/**
 * ReadFileState 檔案讀取的執行期快取實例 (不持久化)
 */
type ReadFileState struct {
	States map[string]*FileState
}

func NewReadFileState() *ReadFileState {
	return &ReadFileState{
		States: make(map[string]*FileState),
	}
}

func (s *ReadFileState) Get(path string) (*FileState, bool) {
	state, exists := s.States[path]
	return state, exists
}

func (s *ReadFileState) Set(path string, state *FileState) {
	s.States[path] = state
}

/**
 * ReadFile 工具實作
 */
func ReadFile(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
	pathArgument, _ := arguments["path"].(string)
	offset, _ := arguments["offset"].(float64)
	limit, _ := arguments["limit"].(float64)
	if limit == 0 {
		limit = 500
	}

	fullPath := resolvePath(agentContext.GetWorkingDirectory(), pathArgument)

	// 1. 執行快取排重 (Smart Deduplication)
	currentMtime := int64(0)
	if stat, err := os.Stat(fullPath); err == nil {
		currentMtime = stat.ModTime().UnixMilli()
	}

	// 取得執行期快取實例
	cache, _ := agentContext.GetReadFileState().(*ReadFileState)
	if cache != nil {
		if existing, exists := cache.Get(fullPath); exists {
			if currentMtime == existing.Timestamp && offset == existing.Offset && limit == existing.Limit {
				return types.ActionResult{
					Success: true,
					Data: map[string]interface{}{
						"type": "file_unchanged",
						"path": pathArgument,
					},
				}, nil
			}
		}
	}

	// 2. 執行磁碟分段讀取 (Targeted Disk I/O)
	file, err := os.Open(fullPath)
	if err != nil {
		return types.ActionResult{Success: false, Error: err.Error()}, nil
	}
	defer file.Close()

	totalLines, _, _ := getFileMetadata(fullPath)
	
	file.Seek(0, 0)
	scanner := bufio.NewScanner(file)
	lineOffset := int(offset)
	if lineOffset > 0 {
		lineOffset--
	}

	currentLine := 0
	var contentBuffer []string
	for scanner.Scan() {
		if currentLine >= lineOffset {
			contentBuffer = append(contentBuffer, scanner.Text())
			if len(contentBuffer) >= int(limit) {
				break
			}
		}
		currentLine++
	}

	fullContent := ""
	for i, line := range contentBuffer {
		fullContent += line
		if i < len(contentBuffer)-1 {
			fullContent += "\n"
		}
	}

	// 3. 同步至執行期快取 (不持久化)
	if cache != nil {
		cache.Set(fullPath, &FileState{
			Content:   fullContent,
			Timestamp: currentMtime,
			Offset:    offset,
			Limit:     limit,
		})
	}

	// 模擬標記檔案追蹤 (這部分仍保留在持久化 state 中，因為它用於跨工具協作)
	triggers, _ := agentContext.GetState("nestedMemoryAttachmentTriggers").([]string)
	triggers = append(triggers, fullPath)
	agentContext.SetState("nestedMemoryAttachmentTriggers", triggers)

	return types.ActionResult{
		Success: true,
		Data: map[string]interface{}{
			"type":       "text",
			"path":       pathArgument,
			"content":    fullContent,
			"lineCount":  len(contentBuffer),
			"totalLines": totalLines,
			"mtimeMs":    currentMtime,
		},
	}, nil
}
