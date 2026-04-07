import React, { useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Cpu, Terminal, CheckCircle2, ChevronRight, Activity } from 'lucide-react';

interface LogItem {
  type: string;
  role?: string;
  round?: number;
  prompt?: any;
  output?: any;
  data?: any;
  timestamp: string;
}

export default function ReasoningFlow({ nodes, onContinue }: { nodes: Map<string, any>, onContinue: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  // 當有新節點時自動滾動到最右邊
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, [nodes.size]);

  const sortedNodes = Array.from(nodes.values()).sort((a, b) => {
    // Coordinator 永遠排在最前面
    if (a.role === 'Coordinator') return -1;
    if (b.role === 'Coordinator') return 1;
    return a.id.localeCompare(b.id);
  });

  return (
    <div className="w-full bg-zinc-950/50 backdrop-blur-xl border border-white/5 rounded-2xl overflow-hidden shadow-2xl mb-6 h-64 flex flex-col">
      <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between bg-white/5">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400 animate-pulse" />
          <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Live Reasoning Flow</span>
        </div>
        <div className="flex gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-zinc-800" />
          <div className="w-1.5 h-1.5 rounded-full bg-zinc-800" />
          <div className="w-1.5 h-1.5 rounded-full bg-zinc-800" />
        </div>
      </div>
      
      <div 
        ref={containerRef}
        className="flex-1 overflow-x-auto overflow-y-hidden p-6 flex items-start gap-8 scroll-smooth custom-scrollbar relative"
      >
        <AnimatePresence mode="popLayout">
          {sortedNodes.map((node, i) => (
            <React.Fragment key={node.id}>
              {i > 0 && (
                <div className="flex items-center justify-center h-40">
                  <ChevronRight className="w-5 h-5 text-zinc-800" />
                </div>
              )}
              <motion.div
                initial={{ opacity: 0, x: -20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                className={`flex-shrink-0 w-72 rounded-xl border p-4 relative transition-all duration-500 overflow-hidden ${
                  node.status === 'active' 
                    ? 'bg-blue-500/5 border-blue-500/30 shadow-[0_0_20px_rgba(59,130,246,0.1)]' 
                    : node.status === 'paused'
                    ? 'bg-orange-500/10 border-orange-500/50 shadow-[0_0_20px_rgba(249,115,22,0.2)] animate-pulse'
                    : 'bg-zinc-900/50 border-white/10'
                }`}
              >
                {/* 裝飾背光 */}
                <div className={`absolute -right-10 -top-10 w-32 h-32 blur-3xl opacity-20 pointer-events-none rounded-full ${
                  node.status === 'paused' ? 'bg-orange-500' :
                  node.role === 'Coordinator' ? 'bg-purple-500' : 'bg-blue-500'
                }`} />

                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className={`p-1.5 rounded-lg ${
                      node.status === 'paused' ? 'bg-orange-500/20 text-orange-400' :
                      node.role === 'Coordinator' ? 'bg-purple-500/20 text-purple-400' : 'bg-blue-500/20 text-blue-400'
                    }`}>
                      {node.status === 'paused' ? <Activity className="w-4 h-4" /> : <Cpu className="w-4 h-4" />}
                    </div>
                    <span className="text-sm font-bold text-white tracking-wide">{node.role}</span>
                  </div>
                  <span className="text-[10px] font-mono text-zinc-500">R-{node.round}</span>
                </div>

                <div className="space-y-2 max-h-32 overflow-y-auto pr-1">
                  {node.steps.map((step: any, idx: number) => (
                    <div key={idx} className="flex gap-2">
                      <div className="mt-1">
                        {step.type === 'DEBUG_PAUSE' ? (
                          <div className="w-3 h-3 bg-orange-500 rounded-full animate-ping" />
                        ) : step.type.includes('TOOL') ? (
                          <Terminal className="w-3 h-3 text-emerald-400" />
                        ) : step.type.includes('START') ? (
                          <div className="w-3 h-3 rounded-full border border-zinc-600 animate-spin border-t-blue-500" />
                        ) : (
                          <CheckCircle2 className="w-3 h-3 text-blue-500" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                               {step.type === 'DEBUG_PAUSE' ? (
                                 <div className="flex flex-col gap-1.5 flex-1">
                                   <span className="text-[10px] text-orange-400 font-bold tracking-tight">⚠️ 偵測到中斷點</span>
                                   <button
                                     onClick={onContinue}
                                     className="w-full py-1.5 bg-orange-500/20 hover:bg-orange-500 text-orange-400 hover:text-white text-[10px] font-bold rounded-lg border border-orange-500/30 transition-all flex items-center justify-center gap-1 group/pause"
                                   >
                                     <ChevronRight className="w-3 h-3 fill-current group-hover/pause:translate-x-0.5 transition-transform" /> 點擊繼續推理
                                   </button>
                                 </div>
                               ) : (
                                 <p className="text-[10px] text-zinc-400 font-mono break-all line-clamp-2 leading-tight">
                                   {step.type === 'TOOL_START' ? `🛠️ ${step.data.name}(${Object.keys(step.data.args || {}).join(', ')})` : 
                                    step.type === 'TOOL_RESULT' ? `✅ ${step.data.name} 完成` :
                                    step.type === 'THINK_START' ? `🧠 Thinking...` : 
                                    step.type === 'AGENT_START' ? `🚀 任務分配成功` :
                                    step.type === 'AGENT_END' ? `✨ 任務回報完畢` : `Task Updated`}
                                 </p>
                               )}
                             </div>
                           </div>
                         ))}
                       </div>
       
                       {node.status === 'active' && (
                         <motion.div 
                           initial={{ width: 0 }}
                           animate={{ width: '100%' }}
                           transition={{ duration: 2, repeat: Infinity }}
                           className="absolute bottom-0 left-0 h-0.5 bg-blue-500/50" 
                         />
                       )}
              </motion.div>
            </React.Fragment>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
