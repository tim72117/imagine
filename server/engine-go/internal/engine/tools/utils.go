package tools

import (
	"os"
	"path/filepath"
	"bufio"
)

/**
 * resolvePath 根據 WorkingDirectory 處理路徑邏輯
 */
func resolvePath(workingDirectory, inputPath string) string {
	if filepath.IsAbs(inputPath) {
		return filepath.Clean(inputPath)
	}
	return filepath.Clean(filepath.Join(workingDirectory, inputPath))
}

/**
 * getFileMetadata 獲取檔案行數與修改時間
 */
func getFileMetadata(filePath string) (int, int64, error) {
	file, errorValue := os.Open(filePath)
	if errorValue != nil {
		return 0, 0, errorValue
	}
	defer file.Close()

	stat, _ := file.Stat()
	mtime := stat.ModTime().UnixMilli()

	scanner := bufio.NewScanner(file)
	lineCount := 0
	for scanner.Scan() {
		lineCount++
	}
	return lineCount, mtime, nil
}
