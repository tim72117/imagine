
import React from 'react';

const BlankPage = () => {
  return (
    <div className="flex flex-col h-screen">
      {/* Top Toolbar */}
      <nav className="w-full bg-gray-800 p-4 flex items-center justify-between shadow-md">
        <div className="text-white text-lg font-bold">我的應用程式</div>
        <div className="flex space-x-4">
          <a href="#" className="text-gray-300 hover:text-white">首頁</a>
          <a href="#" className="text-gray-300 hover:text-white">關於</a>
          <a href="#" className="text-gray-300 hover:text-white">服務</a>
          <a href="#" className="text-gray-300 hover:text-white">聯絡</a>
        </div>
      </nav>

      {/* Main Content Area (Sidebar + Content) */}
      <div className="flex-grow flex">
        {/* Left Sidebar */}
        <aside className="w-64 bg-gray-200 p-4 shadow-md">
          <ul className="space-y-2">
            <li><a href="#" className="block text-gray-700 hover:text-gray-900 font-medium">選項 1</a></li>
            <li><a href="#" className="block text-gray-700 hover:text-gray-900 font-medium">選項 2</a></li>
            <li><a href="#" className="block text-gray-700 hover:text-gray-900 font-medium">選項 3</a></li>
          </ul>
        </aside>

        {/* Main Content */}
        <main className="flex-grow bg-white flex items-center justify-center">
          <p className="text-center text-gray-500 text-xl">這是一個空白的範例網頁</p>
        </main>
      </div>
    </div>
  );
};

export default BlankPage;
