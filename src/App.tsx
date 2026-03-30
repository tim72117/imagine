import React, { useState, useEffect, useRef, Suspense } from 'react';
import { Send, MessageSquare, Layout, Layers, RefreshCw, Smartphone, Monitor, Loader2 } from 'lucide-react';
import { motion } from 'framer-motion';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';

// --- Dynamic Sandbox Iframe Component ---
function SandboxIframe({ code, isLoading }: { code: string, isLoading: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!iframeRef.current || isLoading) return;

    const iframeHtml = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
    <style>
      body { margin: 0; min-height: 100vh; font-family: sans-serif; background: transparent; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="text/babel" data-presets="react">
      try {
        ${code || 'const App = () => <div className="p-10 text-center text-zinc-400">尚無內容</div>'}
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(<App />);
      } catch (err) {
        console.error("Iframe Render Error:", err);
        document.getElementById('root').innerHTML = 
          '<div style="padding: 2rem; color: #ef4444; background: #fee2e2; border: 1px solid #fecaca; border-radius: 0.5rem; margin: 1rem;">' +
            '<h3 style="margin-top:0">渲染發生錯誤</h3>' +
            '<pre style="white-space: pre-wrap; font-size: 0.875rem;">' + (err.message || '未知錯誤') + '</pre>' +
          '</div>';
      }
    </script>
  </body>
</html>
    `;
    
    iframeRef.current.srcdoc = iframeHtml;
  }, [code, isLoading]);

  return (
    <div className="relative w-full aspect-[4/3] bg-white rounded-3xl shadow-2xl overflow-hidden border border-white/5 ring-1 ring-black/20">
      {isLoading && (
        <div className="absolute inset-0 bg-white/50 backdrop-blur-sm z-50 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          <p className="text-zinc-600 font-medium">即時渲染中...</p>
        </div>
      )}
      <iframe 
        ref={iframeRef} 
        title="Sandbox" 
        className="w-full h-full border-none"
        sandbox="allow-scripts allow-modals allow-popups"
      />
    </div>
  );
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
  
  const [code, setCode] = useState<string>('');
  const [isLoadingCode, setIsLoadingCode] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchLatestCode = async () => {
    try {
      const res = await axios.get('http://localhost:3002/api/get-ui-code');
      if (res.data.success) {
        let raw = res.data.code;
        raw = raw.replace(/import[\s\S]*?\s+from\s+['"].*?['"]/g, '');
        raw = raw.replace(/export\s+default\s+function\s+\w*?\s*\(/g, 'function App(');
        raw = raw.replace(/export\s+default\s+/g, 'const App = ');
        setCode(raw);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setIsLoadingCode(false);
    }
  };

  useEffect(() => {
    const initFramework = async () => {
      try {
        await fetch('http://localhost:3002/api/init-framework');
        await fetchLatestCode();
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
          await fetchLatestCode();
          break;
        }
        const chunkText = decoder.decode(value, { stream: true });
        const lines = chunkText.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.startsWith('data: ')) {
            try {
              const cleanedLine = line.replace('data: ', '').trim();
              if (!cleanedLine) continue;
              const data = JSON.parse(cleanedLine);
              if (data.done) {
                await fetchLatestCode();
                break;
              }
              if (data.chunk) {
                accumulatedContent += data.chunk;
                setMessages(prev => {
                  const updated = [...prev];
                  const lastIdx = updated.length - 1;
                  if (updated[lastIdx].role === 'ai') updated[lastIdx].content = accumulatedContent;
                  return updated;
                });
              }
            } catch (e) {}
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
      <div className="glow-bg" />
      <div className="flex flex-1 overflow-hidden">
        <section className="flex-1 flex flex-col p-6 bg-transparent relative z-10">
          <header className="flex items-center justify-between mb-4 border-b border-white/5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Layout className="w-5 h-5 text-blue-500" />
              </div>
              <h2 className="text-xl font-bold tracking-tight text-white">AI 即時渲染 / Sandbox (Minimal React)</h2>
            </div>
            <div className="flex bg-zinc-900 border border-white/10 p-1 rounded-xl">
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
              className={`${previewMode === 'mobile' ? 'w-[375px]' : 'w-full max-w-6xl'} transition-all duration-500`}
            >
              <SandboxIframe code={code} isLoading={isLoadingCode || isProcessing} />
            </motion.div>
          </main>
        </section>

        <aside className="w-[450px] flex-shrink-0 border-l border-white/10 bg-sidebar flex flex-col relative shadow-2xl z-20">
          <header className="p-6 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3 text-white">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center shadow-lg">
                <MessageSquare className="w-6 h-6 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-bold">AI Agent</h2>
                <span className="text-xs text-green-500 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span> 線上狀態
                </span>
              </div>
            </div>
          </header>

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
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
                <span className="text-[10px] text-zinc-600 mt-1 px-1">{msg.timestamp}</span>
              </motion.div>
            ))}
            {isProcessing && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-zinc-500 text-xs">
                <RefreshCw className="w-3 h-3 animate-spin" />正在生成介面代碼...
              </motion.div>
            )}
          </div>

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
                placeholder="如何修改介面？ (不再使用圖示圖示庫)"
                className="w-full bg-white/5 border border-white/10 rounded-2xl px-5 py-4 pr-14 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all resize-none group-hover:border-white/20 h-24"
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
