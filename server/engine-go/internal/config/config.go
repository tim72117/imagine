package config

import (
	"encoding/json"
	"os"
)

/**
 * Settings 儲存全域推論引擎配置
 */
type Settings struct {
	OllamaURL    string `json:"ollama_url"`
	GeminiAPIKey string `json:"gemini_api_key"`
}

/**
 * LoadSettings 從指定路徑載入配置檔案
 */
func LoadSettings(path string) (*Settings, error) {
	// 預設配置
	defaultSettings := &Settings{
		OllamaURL: "http://localhost:11434",
	}

	file, errorValue := os.Open(path)
	if errorValue != nil {
		// 如果檔案不存在，則返回預設值
		return defaultSettings, nil
	}
	defer file.Close()

	var settings Settings
	if errorValue := json.NewDecoder(file).Decode(&settings); errorValue != nil {
		return defaultSettings, errorValue
	}

	// 確保必要欄位有值
	if settings.OllamaURL == "" {
		settings.OllamaURL = defaultSettings.OllamaURL
	}

	return &settings, nil
}
