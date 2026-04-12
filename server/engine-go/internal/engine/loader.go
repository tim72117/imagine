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
	AgentDirectory string
	cache          map[string]*AgentDefinition
}

/**
 * NewAgentLoader 初始化載入器，預設指向 server/.agent
 */
func NewAgentLoader(directoryPath string) *AgentLoader {
	return &AgentLoader{
		AgentDirectory: directoryPath,
		cache:          make(map[string]*AgentDefinition),
	}
}

/**
 * GetAgent 獲取指定角色的定義，若未載入則從檔案讀取 (Lazy Load)
 */
func (loader *AgentLoader) GetAgent(role string) (*AgentDefinition, error) {
	// 1. 檢查快取
	if definition, isSuccessful := loader.cache[role]; isSuccessful {
		return definition, nil
	}

	// 2. 構建路徑並讀取
	path := filepath.Join(loader.AgentDirectory, fmt.Sprintf("%s.agent", role))
	content, errorValue := os.ReadFile(path)
	if errorValue != nil {
		return nil, fmt.Errorf("無法開啟 Agent 檔案 [%s]: %v", path, errorValue)
	}

	// 3. 解析內容
	definition, errorValue := loader.parseAgentFile(string(content))
	if errorValue != nil {
		return nil, fmt.Errorf("解析 Agent 檔案失敗 [%s]: %v", role, errorValue)
	}

	// 4. 存入快取並傳回
	loader.cache[role] = definition
	return definition, nil
}

/**
 * parseAgentFile 解析 .agent 檔案格式
 */
func (loader *AgentLoader) parseAgentFile(content string) (*AgentDefinition, error) {
	// 統一換行符號並處理分段
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	sections := strings.Split(normalized, "\n---\n")

	if len(sections) < 2 {
		return nil, fmt.Errorf("檔案格式錯誤，至少需要 Metadata 與一個內容區段")
	}

	definition := &AgentDefinition{
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
			value := strings.TrimSpace(parts[1])
			
			switch key {
			case "role":
				definition.Role = value
			case "model":
				definition.Model = value
			case "tools":
				continue 
			default:
				if strings.HasPrefix(line, "-") {
					toolName := strings.TrimSpace(strings.TrimPrefix(line, "-"))
					definition.Tools = append(definition.Tools, toolName)
				}
			}
		} else if strings.HasPrefix(line, "-") {
			toolName := strings.TrimSpace(strings.TrimPrefix(line, "-"))
			definition.Tools = append(definition.Tools, toolName)
		}
	}

	// 解析其餘區段
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
			definition.Thought = body
		case "TOOLS":
			definition.DetailedTools = body
		}
	}

	return definition, nil
}
