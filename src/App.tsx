import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { Send, MessageSquare, Terminal, Layout, Layers, RefreshCw, Smartphone, Monitor, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';

// Lazy loading the sandbox component to handle re-renders better
const PreviewTarget = lazy(() => import('./sandbox/Target'));

// Simple Error Boundary for the Sandbox
class SandboxErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(error: any, info: any) { console.error("Sandbox Error:", error, info); }
  render() {
    if (this.state.hasError) return (
      <div className="flex flex-col items-center justify-center min-h-[500px] border-4 border-dashed border-red-500/20 bg-red-500/5 rounded-3xl text-red-400 p-8">
        <Terminal className="mb-4 w-12 h-12" />
        <h3 className="text-xl font-bold mb-2">語法錯誤或渲染失敗</h3>
        <p className="opacity-70">請檢查 AI 產生的代碼，或嘗試重新整理。</p>
        <button onClick={() => window.location.reload()} className="mt-6 px-6 py-2 bg-red-500 hover:bg-red-400 text-white rounded-full transition-colors flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> 重新整理
        </button>
      </div>
    );
    return this.props.children;
  }
}

interface Message {
  role: 'user' | 'ai';
  content: string;
  timestamp: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'ai', content: '您好！我是您的 UI 開發小助手。請問您想對左側的介面做什麼樣的調整呢？', timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [previewKey, setPreviewKey] = useState(0); // 用來強制刷新預覽畫面
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // 網頁開啟時，立即讀取並初始化專案框架文件檔
    const initFramework = async () => {
      try {
        await fetch('http://localhost:3002/api/init-framework');
        console.log('[System] 專案框架文件已載入完成。');
      } catch (err) {
        console.error('[Error] 框架初始化失敗:', err);
      }
    };
    initFramework();

    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    
    // 初始化一條空的 AI 訊息來接收串流
    const aiPlaceholder: Message = { role: 'ai', content: '', timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, aiPlaceholder]);
    
    const currentInput = input;
    setInput('');
    setIsProcessing(true);

    try {
      const response = await fetch(`http://localhost:3002/api/update-ui-stream?prompt=${encodeURIComponent(currentInput)}`);
      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulatedContent = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          setPreviewKey(prev => prev + 1);
          break;
        }

        const chunkText = decoder.decode(value, { stream: true });
        // 解析可能包含多個 data: 或不完整 data: 的封包
        const lines = chunkText.split('\n');
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          if (line.startsWith('data: ')) {
            try {
              const cleanedLine = line.replace('data: ', '').trim();
              if (!cleanedLine) continue;
              
              const data = JSON.parse(cleanedLine);
              if (data.done) {
                setPreviewKey(prev => prev + 1);
                break;
              }

              if (data.chunk) {
                accumulatedContent += data.chunk;
                // 強制觸發 React 更新最後一條訊息，確保流感
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (updated[lastIdx].role === 'ai') {
                    updated[lastIdx].content = accumulatedContent;
                  }
                  return updated;
                });
              }
            } catch (e) {
              // 如果 JSON 解析失敗，代表可能是被切割的封包，保留至下次處理或忽略
              // 在流式傳輸中，這種情況偶爾發生，這裡我們先略過異常
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
      setMessages(prev => [...prev, { role: 'ai', content: '串流發生錯誤，請重試。', timestamp: new Date().toLocaleTimeString() }]);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex w-full h-screen font-sans bg-background overflow-hidden relative">
      {/* Background Glow */}
      <div className="glow-bg" />

      {/* Main Container */}
      <div className="flex flex-1 overflow-hidden">
        
        {/* Left: Preview Area (70%) */}
        <section className="flex-1 flex flex-col p-6 bg-transparent relative z-10">
          <header className="flex items-center justify-between mb-4 border-b border-white/5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Layout className="w-5 h-5 text-blue-500" />
              </div>
              <h2 className="text-xl font-bold tracking-tight">即時預覽 / Sandbox</h2>
            </div>
            
            <div className="flex bg-zinc-900 border border-white/10 p-1 rounded-xl shadow-inner shadow-black/40">
              <button 
                onClick={() => setPreviewMode('desktop')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm transition-all ${previewMode === 'desktop' ? 'bg-white/10 text-white shadow-md' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <Monitor className="w-4 h-4" /> Desktop
              </button>
              <button 
                onClick={() => setPreviewMode('mobile')}
                className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm transition-all ${previewMode === 'mobile' ? 'bg-white/10 text-white shadow-md' : 'text-zinc-500 hover:text-zinc-300'}`}
              >
                <Smartphone className="w-4 h-4" /> Mobile
              </button>
            </div>
          </header>

          <main className="flex-1 overflow-y-auto overflow-x-hidden flex items-start justify-center pt-8">
            <motion.div 
              layout
              className={`${previewMode === 'mobile' ? 'w-[375px]' : 'w-full max-w-5xl'} transition-all duration-500`}
            >
              <SandboxErrorBoundary>
                <Suspense fallback={<div className="flex items-center justify-center p-20 animate-pulse text-zinc-500">正在準備環境...</div>}>
                  <PreviewTarget key={previewKey} />
                </Suspense>
              </SandboxErrorBoundary>
            </motion.div>
          </main>
        </section>

        {/* Right: Chat Sidebar (30%) - Fixed and No Shrink */}
        <aside className="w-[450px] flex-shrink-0 border-l border-white/10 bg-sidebar flex flex-col relative shadow-2xl z-20">
          <header className="p-6 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-purple-500/20">
                <MessageSquare className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold">AI Agent</h2>
                <span className="text-xs text-green-500 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span> 線上狀態
                </span>
              </div>
            </div>
            <button className="p-2 text-zinc-500 hover:text-white transition-colors">
              <Layers className="w-5 h-5" />
            </button>
          </header>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 flex flex-col custom-scrollbar">
            {messages.map((msg, i) => (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                key={i} 
                className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div className={`p-4 rounded-2xl max-w-[85%] text-sm leading-relaxed shadow-lg markdown-content ${
                  msg.role === 'user' 
                  ? 'bg-blue-600 text-white rounded-tr-none' 
                  : 'bg-white/5 text-zinc-200 border border-white/5 rounded-tl-none'
                }`}>
                  {msg.role === 'ai' && msg.content.includes('🚀') && (
                    <div className="flex items-center gap-2 mb-2 text-indigo-400 font-medium animate-pulse">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>AI 正在構思代碼變更...</span>
                    </div>
                  )}
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
                <span className="text-[10px] text-zinc-600 mt-1 px-1">{msg.timestamp}</span>
              </motion.div>
            ))}
            {isProcessing && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-zinc-500 text-xs">
                <RefreshCw className="w-3 h-3 animate-spin" />正在修改界面代碼並即時重新渲染...
              </motion.div>
            )}
          </div>

          {/* Input Area */}
          <div className="p-6 border-t border-white/5 bg-zinc-900/40 backdrop-blur-md pb-10">
            <div className="relative group">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="如何修改介面？ (例如：改為深紅主題、加入多個卡片...)"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 pr-14 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all resize-none group-hover:border-white/20 h-24"
              />
              <button 
                onClick={handleSend}
                disabled={!input.trim() || isProcessing}
                className="absolute right-3 bottom-3 p-3 bg-blue-600 hover:bg-blue-500 text-white rounded-xl shadow-lg transition-all disabled:bg-zinc-700 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </aside>

      </div>
    </div>
  );
}
