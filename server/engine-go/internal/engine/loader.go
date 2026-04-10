package engine

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

/**
 * AgentDefinition 代表從 .agent 檔案中讀取的原始定義
 */
type AgentDefinition struct {
	Role         string
	Model        string
	Tools        []string
	Thought      string
	DetailedTools string
	RawMetadata  map[string]string
}

/**
 * AgentLoader 負責延遲載入 Agent 配置
 */
type AgentLoader struct {
	AgentDir string
	cache    map[string]*AgentDefinition
}

/**
 * NewAgentLoader 初始化載入器，預設指向 server/.agent
 */
func NewAgentLoader(dir string) *AgentLoader {
	return &AgentLoader{
		AgentDir: dir,
		cache:    make(map[string]*AgentDefinition),
	}
}

/**
 * GetAgent 獲取指定角色的定義，若未載入則從檔案讀取 (Lazy Load)
 */
func (l *AgentLoader) GetAgent(role string) (*AgentDefinition, error) {
	// 1. 檢查快取
	if def, ok := l.cache[role]; ok {
		return def, nil
	}

	// 2. 構建路徑並讀取
	path := filepath.Join(l.AgentDir, fmt.Sprintf("%s.agent", role))
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("無法開啟 Agent 檔案 [%s]: %v", path, err)
	}

	// 3. 解析內容 (使用 --- 分段)
	def, err := l.parseAgentFile(string(content))
	if err != nil {
		return nil, fmt.Errorf("解析 Agent 檔案失敗 [%s]: %v", role, err)
	}

	// 4. 存入快取並傳回
	l.cache[role] = def
	return def, nil
}

/**
 * parseAgentFile 解析 .agent 檔案格式
 */
func (l *AgentLoader) parseAgentFile(content string) (*AgentDefinition, error) {
	// 統一換行符號並處理分段
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	sections := strings.Split(normalized, "\n---\n")

	if len(sections) < 2 {
		return nil, fmt.Errorf("檔案格式錯誤，至少需要 Metadata 與一個內容區段")
	}

	def := &AgentDefinition{
		RawMetadata: make(map[string]string),
	}

	// 解析 Metadata (索引 0)
	metaLines := strings.Split(sections[0], "\n")
	for _, line := range metaLines {
		line = strings.TrimSpace(line)
		if line == "---" || line == "" {
			continue
		}
		if strings.Contains(line, ":") {
			parts := strings.SplitN(line, ":", 2)
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			
			switch key {
			case "role":
				def.Role = val
			case "model":
				def.Model = val
			case "tools":
				// 簡單處理列表，後續區段若有 '-' 則由下一行處理
				continue 
			default:
				if strings.HasPrefix(line, "-") {
					toolName := strings.TrimSpace(strings.TrimPrefix(line, "-"))
					def.Tools = append(def.Tools, toolName)
				}
			}
		} else if strings.HasPrefix(line, "-") {
			// 處理 YAML 列表風格
			toolName := strings.TrimSpace(strings.TrimPrefix(line, "-"))
			def.Tools = append(def.Tools, toolName)
		}
	}

	// 解析其餘區段 (根據標頭識別)
	for i := 1; i < len(sections); i++ {
		block := strings.TrimSpace(sections[i])
		if block == "" || block == "---" {
			continue
		}

		lines := strings.SplitN(block, "\n", 2)
		header := strings.TrimSpace(lines[0])
		body := ""
		if len(lines) > 1 {
			body = strings.TrimSpace(lines[1])
		}

		switch header {
		case "THOUGHT":
			def.Thought = body
		case "TOOLS":
			def.DetailedTools = body
		}
	}

	return def, nil
}
