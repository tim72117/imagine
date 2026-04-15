package tools

import (
	"fmt"
	"net/url"
	"strings"
)

// ANSI 顏色碼
const (
	colorReset  = "\x1b[0m"
	colorRed    = "\x1b[31m"
	colorGreen  = "\x1b[32m"
	colorCyan   = "\x1b[36m"
	colorYellow = "\x1b[33m"
	colorGray   = "\x1b[90m"
	bgRed       = "\x1b[41m"
	bgGreen     = "\x1b[42m"
)

// RenderHunk 將單一 hunk 輸出為帶行號的彩色字串（供 RenderToolResult 使用）
func RenderHunk(patchText string) string {
	var sb strings.Builder
	oldLine, newLine := 1, 1

	for _, entry := range strings.Split(patchText, "\n") {
		if entry == "" {
			continue
		}
		if strings.HasPrefix(entry, "@@") {
			oldLine, newLine = parseHunkHeader(entry)
			sb.WriteString(colorCyan + entry + colorReset + "\n")
			continue
		}
		if len(entry) < 1 {
			continue
		}
		prefix := entry[:1]
		decoded, err := url.PathUnescape(entry[1:])
		if err != nil {
			decoded = entry[1:]
		}
		subLines := strings.Split(decoded, "\n")
		for i, sub := range subLines {
			if sub == "" && i == len(subLines)-1 {
				continue
			}
			switch prefix {
			case " ":
				sb.WriteString(fmt.Sprintf("%s%4d %4d │ %s%s\n", colorGray, oldLine, newLine, sub, colorReset))
				oldLine++
				newLine++
			case "-":
				sb.WriteString(fmt.Sprintf("%s%4d      │ -%s%s\n", colorRed, oldLine, sub, colorReset))
				oldLine++
			case "+":
				sb.WriteString(fmt.Sprintf("%s     %4d │ +%s%s\n", colorGreen, newLine, sub, colorReset))
				newLine++
			}
		}
	}
	return sb.String()
}

// PrintStagedDiff 將 StagedChanges 以彩色 unified diff 格式輸出至終端機
func PrintStagedDiff(staged *StagedChanges) {
	if len(staged.Files) == 0 {
		fmt.Println(colorGray + "（無暫存變更）" + colorReset)
		return
	}

	for path, file := range staged.Files {
		printFileHeader(path)
		for _, hunk := range file.Patch {
			printHunk(hunk.Text)
		}
		fmt.Println()
	}
}

// printFileHeader 輸出檔案標頭
func printFileHeader(path string) {
	sep := strings.Repeat("─", 60)
	fmt.Printf("\n%s%s%s\n", colorYellow, sep, colorReset)
	fmt.Printf("%s📄 %s%s\n", colorYellow, path, colorReset)
	fmt.Printf("%s%s%s\n", colorYellow, sep, colorReset)
}

// parseHunkHeader 解析 @@ -oldStart,oldCount +newStart,newCount @@ 取得起始行號
func parseHunkHeader(header string) (oldStart, newStart int) {
	oldStart, newStart = 1, 1
	// 格式: @@ -a,b +c,d @@
	var o1, o2, n1, n2 int
	if _, err := fmt.Sscanf(header, "@@ -%d,%d +%d,%d @@", &o1, &o2, &n1, &n2); err == nil {
		return o1, n1
	}
	// 單行情況 @@ -a +c @@
	if _, err := fmt.Sscanf(header, "@@ -%d +%d @@", &o1, &n1); err == nil {
		return o1, n1
	}
	return
}

// printHunk 解析並彩色輸出單一 patch hunk 文字，左側顯示行號。
//
// 行號格式（寬度 4）：
//
//	oldLine newLine │ prefix content
//
// 刪除行只顯示 old 行號，新增行只顯示 new 行號，context 兩者都顯示。
func printHunk(patchText string) {
	oldLine, newLine := 1, 1
	firstHeader := true

	for _, entry := range strings.Split(patchText, "\n") {
		if entry == "" {
			continue
		}

		// @@ 標頭行：解析起始行號並輸出
		if strings.HasPrefix(entry, "@@") {
			oldLine, newLine = parseHunkHeader(entry)
			if firstHeader {
				firstHeader = false
			}
			fmt.Printf("%s%s%s\n", colorCyan, entry, colorReset)
			continue
		}

		if len(entry) < 1 {
			continue
		}

		prefix := entry[:1] // '+', '-', or ' '
		decoded, err := url.PathUnescape(entry[1:])
		if err != nil {
			decoded = entry[1:]
		}

		color := colorGray
		switch prefix {
		case "+":
			color = colorGreen
		case "-":
			color = colorRed
		}

		// 展開嵌入換行，逐行輸出（含行號）
		subLines := strings.Split(decoded, "\n")
		for i, sub := range subLines {
			if sub == "" && i == len(subLines)-1 {
				continue
			}
			switch prefix {
			case " ": // context
				fmt.Printf("%s%4d %4d │ %s%s%s\n", colorGray, oldLine, newLine, colorReset, sub, colorReset)
				oldLine++
				newLine++
			case "-": // 刪除
				fmt.Printf("%s%4d      │ -%s%s\n", colorRed, oldLine, sub, colorReset)
				oldLine++
			case "+": // 新增
				fmt.Printf("%s     %4d │ +%s%s\n", colorGreen, newLine, sub, colorReset)
				newLine++
			default:
				fmt.Printf("%s     %s%s\n", color, sub, colorReset)
			}
		}
	}
}
