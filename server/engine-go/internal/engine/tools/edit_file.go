package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/sergi/go-diff/diffmatchpatch"
	"imagine/engine/internal/types"
)

// StagedFile 暫存單一檔案的待寫入內容
type StagedFile struct {
	OriginalContent string
	UpdatedContent  string
	Encoding        string
	LineEndings     LineEndingType
	Patch           []PatchHunk
}

// StagedChanges 暫存所有待寫入的檔案變更（key: 絕對路徑）
type StagedChanges struct {
	Files map[string]*StagedFile
}

func NewStagedChanges() *StagedChanges {
	return &StagedChanges{Files: make(map[string]*StagedFile)}
}

func (s *StagedChanges) Set(path string, file *StagedFile) {
	s.Files[path] = file
}

func (s *StagedChanges) Get(path string) (*StagedFile, bool) {
	f, ok := s.Files[path]
	return f, ok
}

// LineEndingType 代表換行符號類型
type LineEndingType string

const (
	LineEndingLF   LineEndingType = "LF"
	LineEndingCRLF LineEndingType = "CRLF"
)

// PatchHunk 代表一個差異區段（unified diff 字串格式）
type PatchHunk struct {
	Text string `json:"text"`
}

var EditFileDeclaration = types.ToolDeclaration{
	Name:        "edit_file",
	Description: "精確替換檔案中的字串片段。需先用 Read 工具確認目前內容。old_string 必須在檔案中唯一存在，new_string 為替換後的內容。",
	Type:        "sync",
	Parameters: map[string]interface{}{
		"type": "OBJECT",
		"properties": map[string]interface{}{
			"file_path": map[string]interface{}{
				"type":        "STRING",
				"description": "目標檔案路徑（絕對或相對）。",
			},
			"old_string": map[string]interface{}{
				"type":        "STRING",
				"description": "要被替換掉的原始字串，必須與檔案中的內容完全一致。",
			},
			"new_string": map[string]interface{}{
				"type":        "STRING",
				"description": "替換後的新字串。",
			},
			"replace_all": map[string]interface{}{
				"type":        "BOOLEAN",
				"description": "若為 true，替換檔案中所有符合的片段；預設為 false（只替換第一個）。",
			},
		},
		"required": []string{"file_path", "old_string", "new_string"},
	},
}

// fileReadResult 暫存讀檔結果
type fileReadResult struct {
	content     string
	fileExists  bool
	encoding    string // "utf8" | "utf16le"
	lineEndings LineEndingType
}

// readFileForEdit 讀取檔案並偵測編碼與換行符
func readFileForEdit(absolutePath string) fileReadResult {
	raw, err := os.ReadFile(absolutePath)
	if err != nil {
		return fileReadResult{fileExists: false, encoding: "utf8", lineEndings: LineEndingLF}
	}

	// 偵測 UTF-16 LE BOM (FF FE)
	encoding := "utf8"
	content := ""
	if len(raw) >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
		encoding = "utf16le"
		u16 := make([]uint16, (len(raw)-2)/2)
		for i := range u16 {
			u16[i] = uint16(raw[2+i*2]) | uint16(raw[3+i*2])<<8
		}
		runes := utf16.Decode(u16)
		content = string(runes)
	} else {
		if utf8.Valid(raw) {
			content = string(raw)
		} else {
			content = string(raw)
		}
	}

	// 偵測換行符
	lineEndings := LineEndingLF
	if strings.Contains(content, "\r\n") {
		lineEndings = LineEndingCRLF
	}

	return fileReadResult{
		content:     content,
		fileExists:  true,
		encoding:    encoding,
		lineEndings: lineEndings,
	}
}

// normalizeQuotes 將彎引號替換為直引號
func normalizeQuotes(s string) string {
	s = strings.ReplaceAll(s, "\u201C", "\"") // "
	s = strings.ReplaceAll(s, "\u201D", "\"") // "
	s = strings.ReplaceAll(s, "\u2018", "'")  // '
	s = strings.ReplaceAll(s, "\u2019", "'")  // '
	return s
}

// applyCurlyDoubleQuotes 將直雙引號替換為彎雙引號
func applyCurlyDoubleQuotes(s string) string {
	// 簡單處理：全部替換為左彎雙引號（語境較複雜時可擴充）
	return strings.ReplaceAll(s, "\"", "\u201C")
}

// applyCurlySingleQuotes 將直單引號替換為彎單引號
func applyCurlySingleQuotes(s string) string {
	return strings.ReplaceAll(s, "'", "\u2018")
}

// findActualString 先嘗試精確比對，失敗則正規化引號後再比對
func findActualString(fileContent, searchString string) (string, bool) {
	// Step 1: 精確比對
	if strings.Contains(fileContent, searchString) {
		return searchString, true
	}

	// Step 2: 正規化引號後比對
	normalizedContent := normalizeQuotes(fileContent)
	normalizedSearch := normalizeQuotes(searchString)

	idx := strings.Index(normalizedContent, normalizedSearch)
	if idx == -1 {
		return "", false
	}

	// 從原始檔案中提取對應片段（長度以 rune 計算）
	searchRunes := []rune(normalizedSearch)

	// 找到 rune 層級的 index
	runeIdx := 0
	byteIdx := 0
	for byteIdx < idx {
		_, size := utf8.DecodeRuneInString(normalizedContent[byteIdx:])
		byteIdx += size
		runeIdx++
	}

	originalRunes := []rune(fileContent)
	if runeIdx+len(searchRunes) > len(originalRunes) {
		return normalizedSearch, true
	}
	return string(originalRunes[runeIdx : runeIdx+len(searchRunes)]), true
}

// preserveQuoteStyle 若 old_string 與 actualOldString 不同，對 new_string 套用相同的引號風格
func preserveQuoteStyle(oldString, actualOldString, newString string) string {
	if oldString == actualOldString {
		return newString
	}
	// 偵測原始使用彎雙引號
	if strings.ContainsAny(actualOldString, "\u201C\u201D") {
		newString = applyCurlyDoubleQuotes(newString)
	}
	// 偵測原始使用彎單引號
	if strings.ContainsAny(actualOldString, "\u2018\u2019") {
		newString = applyCurlySingleQuotes(newString)
	}
	return newString
}

// applyEdit 執行字串替換並回傳更新後的內容
func applyEdit(content, oldString, newString string, replaceAll bool) (string, int) {
	if replaceAll {
		count := strings.Count(content, oldString)
		return strings.ReplaceAll(content, oldString, newString), count
	}
	idx := strings.Index(content, oldString)
	if idx == -1 {
		return content, 0
	}
	return content[:idx] + newString + content[idx+len(oldString):], 1
}

// generatePatch 使用 sergi/go-diff 產生 unified diff
func generatePatch(oldContent, newContent, filePath string) []PatchHunk {
	dmp := diffmatchpatch.New()
	diffs := dmp.DiffMain(oldContent, newContent, false)
	dmp.DiffCleanupSemantic(diffs)
	patches := dmp.PatchMake(oldContent, diffs)

	var hunks []PatchHunk
	for _, p := range patches {
		hunks = append(hunks, PatchHunk{Text: dmp.PatchToText([]diffmatchpatch.Patch{p})})
	}
	return hunks
}

// writeTextContent 依原始編碼與換行符寫出檔案
func writeTextContent(path, content string, encoding string, lineEndings LineEndingType) error {
	// 轉換換行符
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if lineEndings == LineEndingCRLF {
		normalized = strings.ReplaceAll(normalized, "\n", "\r\n")
	}

	var raw []byte
	if encoding == "utf16le" {
		runes := []rune(normalized)
		u16 := utf16.Encode(runes)
		raw = make([]byte, 2+len(u16)*2)
		raw[0], raw[1] = 0xFF, 0xFE // BOM
		for i, v := range u16 {
			raw[2+i*2] = byte(v)
			raw[3+i*2] = byte(v >> 8)
		}
	} else {
		raw = []byte(normalized)
	}

	return os.WriteFile(path, raw, 0644)
}

// EditFileOutput 實作 ToolOutput，以彩色 diff 呈現暫存變更
type EditFileOutput struct {
	Result  types.ActionResult
	Staged  *StagedChanges
	NewPath string // 本次編輯的檔案路徑
}

func (o *EditFileOutput) GetActionResult() types.ActionResult {
	return o.Result
}

func (o *EditFileOutput) RenderToolResult() string {
	if !o.Result.Success {
		return fmt.Sprintf("[edit_file] ❌ %s", o.Result.Error)
	}
	if o.Staged == nil || len(o.Staged.Files) == 0 {
		return "[edit_file] ✅ 已暫存（無差異）"
	}
	var sb strings.Builder
	sb.WriteString("[edit_file] ✅ 已暫存變更:\n")
	// 只顯示本次編輯的那個檔案
	if file, ok := o.Staged.Files[o.NewPath]; ok {
		for _, hunk := range file.Patch {
			sb.WriteString(RenderHunk(hunk.Text))
		}
	}
	return sb.String()
}

// EditFile 工具實作
func EditFile(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ToolOutput, error) {
	filePath, _ := arguments["file_path"].(string)
	oldString, _ := arguments["old_string"].(string)
	newString, _ := arguments["new_string"].(string)
	replaceAll, _ := arguments["replace_all"].(bool)

	errOut := func(msg string) (types.ToolOutput, error) {
		return types.NewToolOutput("edit_file", types.ActionResult{Success: false, Error: msg}), nil
	}

	if filePath == "" {
		return errOut("file_path 不能為空")
	}

	// Step 1 — 路徑解析
	absoluteFilePath := resolvePath(agentContext.GetWorkingDirectory(), filePath)

	// Step 2 — 確保父目錄存在
	if err := os.MkdirAll(filepath.Dir(absoluteFilePath), 0755); err != nil {
		return errOut(fmt.Sprintf("無法建立父目錄: %v", err))
	}

	// Step 3 — 讀檔 + 時間戳驗證
	result := readFileForEdit(absoluteFilePath)

	if result.fileExists {
		stat, err := os.Stat(absoluteFilePath)
		if err == nil {
			lastWriteTime := stat.ModTime().UnixMilli()
			cache, _ := agentContext.GetReadFileState().(*ReadFileState)
			if cache != nil {
				if lastRead, exists := cache.Get(absoluteFilePath); exists {
					isFullRead := lastRead.Offset == 0 && lastRead.Limit == 0
					if lastRead.Timestamp != lastWriteTime {
						// Windows 容錯：若內容相同則繼續
						if !(isFullRead && result.content == lastRead.Content) {
							return errOut(fmt.Sprintf("檔案在讀取後被外部修改，請重新 Read 後再編輯: %s", filePath))
						}
					}
				}
			}
		}
	}

	originalFileContents := result.content

	// Step 4 — 字串正規化
	actualOldString, found := findActualString(originalFileContents, oldString)
	if !found {
		actualOldString = oldString
	}
	actualNewString := preserveQuoteStyle(oldString, actualOldString, newString)

	// 驗證 old_string 存在
	if !strings.Contains(originalFileContents, actualOldString) {
		occurrences := strings.Count(originalFileContents, oldString)
		return errOut(fmt.Sprintf("old_string 在檔案中找不到（出現次數: %d）。請使用 Read 確認目前內容後重試。", occurrences))
	}

	// Step 5 — 計算新內容並存入 StagedChanges（不直接寫檔）
	updatedContent, replaceCount := applyEdit(originalFileContents, actualOldString, actualNewString, replaceAll)
	patch := generatePatch(originalFileContents, updatedContent, absoluteFilePath)

	staged, _ := agentContext.GetStagedChanges().(*StagedChanges)
	if staged == nil {
		return errOut("StagedChanges 未初始化")
	}
	staged.Set(absoluteFilePath, &StagedFile{
		OriginalContent: originalFileContents,
		UpdatedContent:  updatedContent,
		Encoding:        result.encoding,
		LineEndings:     result.lineEndings,
		Patch:           patch,
	})

	// Step 6 — 更新 readFileState（以新內容為準，時間戳沿用當前值）
	cache, _ := agentContext.GetReadFileState().(*ReadFileState)
	if cache != nil {
		existing, _ := cache.Get(absoluteFilePath)
		ts := int64(0)
		if existing != nil {
			ts = existing.Timestamp
		}
		cache.Set(absoluteFilePath, &FileState{
			Content:   updatedContent,
			Timestamp: ts,
		})
	}

	// Step 7 — 回傳結果（含彩色 diff 的 EditFileOutput）
	_ = replaceCount
	return &EditFileOutput{
		Result: types.ActionResult{
			Success: true,
			Data: map[string]interface{}{
				"filePath": filePath,
				"staged":   true,
			},
		},
		Staged:  staged,
		NewPath: absoluteFilePath,
	}, nil
}
