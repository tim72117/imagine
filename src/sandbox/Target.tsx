
import React from 'react';
import { Sparkles, Terminal } from 'lucide-react';

export default function Target() {
  return (
    <div className="p-12 bg-zinc-900 border border-zinc-800 rounded-[2.5rem] text-center shadow-3xl">
      <div className="w-16 h-16 bg-blue-500/10 rounded-2xl flex items-center justify-center mx-auto mb-8">
        <Sparkles className="text-blue-500 w-8 h-8" />
      </div>
      <h1 className="text-3xl font-bold mb-4 italic">「幫我做一個淺綠色的登入頁面。看到請回覆。」</h1>
      <p className="text-zinc-500 mb-8 max-w-sm mx-auto">Gemini 正在快馬加鞭處理中（目前處於冷卻階段），這是為您準備的初步設計概念。</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="p-5 bg-white/5 rounded-2xl border border-white/5">現代化介面</div>
        <div className="p-5 bg-white/5 rounded-2xl border border-white/5">即時渲染</div>
      </div>
    </div>
  );
}