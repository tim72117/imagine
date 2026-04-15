package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"imagine/engine/internal/types"
)

var BrowserDeclaration = types.ToolDeclaration{
	Name:        "Browser",
	Description: "操控瀏覽器的全功能工具。每次呼叫只能執行一個 action。",
	Type:        "sync",
	Parameters: map[string]interface{}{
		"type": "OBJECT",
		"properties": map[string]interface{}{
			"action": map[string]interface{}{
				"type":        "STRING",
				"enum":        []string{"navigate", "click", "type", "scroll", "screenshot", "get_html"},
				"description": "要執行的動作類型",
			},
			"url": map[string]interface{}{
				"type":        "STRING",
				"description": "導航目標網址",
			},
			"coordinate": map[string]interface{}{
				"type":  "ARRAY",
				"items": map[string]interface{}{"type": "NUMBER"},
				"description": "[x, y] 座標",
			},
			"text": map[string]interface{}{
				"type":        "STRING",
				"description": "輸入文字",
			},
			"selector": map[string]interface{}{
				"type":        "STRING",
				"description": "CSS 選擇器",
			},
		},
		"required": []string{"action"},
	},
}

var (
	browser *rod.Browser
	page    *rod.Page
)

/**
 * getOrLaunchBrowser 確保瀏覽器已啟動並傳回當前分頁
 */
func getOrLaunchBrowser() (*rod.Page, error) {
	if browser == nil {
		// 使用 Launcher 關閉無頭模式 (Headless: false)
		u := launcher.New().Headless(false).MustLaunch()
		browser = rod.New().ControlURL(u).MustConnect()
	}
	if page == nil {
		page = browser.MustPage()
	}
	return page, nil
}

/**
 * Browser 工具實作 (集中式分發器)
 */
func Browser(arguments map[string]interface{}, agentContext types.ToolUseContextInterface) (types.ActionResult, error) {
	action, _ := arguments["action"].(string)
	
	p, err := getOrLaunchBrowser()
	if err != nil {
		return types.ActionResult{Success: false, Error: fmt.Sprintf("啟動瀏覽器失敗: %v", err)}, nil
	}

	switch action {
	case "navigate":
		url, _ := arguments["url"].(string)
		if url == "" {
			return types.ActionResult{Success: false, Error: "navigate 動作需要 url 參數"}, nil
		}
		p.MustNavigate(url).MustWaitStable()
		return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "success", "current_url": p.MustInfo().URL}}, nil

	case "click":
		// 優先支援座標
		if coord, ok := arguments["coordinate"].([]interface{}); ok && len(coord) == 2 {
			x := coord[0].(float64)
			y := coord[1].(float64)
			p.Mouse.MustMoveTo(x, y).MustClick(proto.InputMouseButtonLeft)
			return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "clicked", "at": []float64{x, y}}}, nil
		}
		// 其次支援選擇器
		if selector, ok := arguments["selector"].(string); ok && selector != "" {
			p.MustElement(selector).MustClick()
			return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "clicked", "selector": selector}}, nil
		}
		return types.ActionResult{Success: false, Error: "click 動作需要 coordinate 或 selector 參數"}, nil

	case "type":
		text, _ := arguments["text"].(string)
		if selector, ok := arguments["selector"].(string); ok && selector != "" {
			p.MustElement(selector).MustInput(text)
			return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "typed", "text": text}}, nil
		}
		// 若無選擇器，直接在目前焦點輸入字串
		p.MustInsertText(text)
		return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "typed", "text": text}}, nil

	case "scroll":
		// 修正: MustScroll 只需要 x, y 兩個參數
		p.Mouse.MustScroll(0, 500)
		return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "scrolled"}}, nil

	case "screenshot":
		timestamp := time.Now().Unix()
		fileName := fmt.Sprintf("screenshot_%d.png", timestamp)
		outputPath := filepath.Join(agentContext.GetWorkingDirectory(), "screenshots")
		_ = os.MkdirAll(outputPath, 0755)
		
		fullPath := filepath.Join(outputPath, fileName)
		p.MustScreenshot(fullPath)
		return types.ActionResult{Success: true, Data: map[string]interface{}{"status": "screenshot_taken", "path": fullPath}}, nil

	case "get_html":
		html := p.MustHTML()
		// 限制長度避免 Context 爆炸
		if len(html) > 5000 {
			html = html[:5000] + "...(truncated)"
		}
		return types.ActionResult{Success: true, Data: map[string]interface{}{"html": html}}, nil

	default:
		return types.ActionResult{Success: false, Error: fmt.Sprintf("不支援的瀏覽器動作: %s", action)}, nil
	}
}
