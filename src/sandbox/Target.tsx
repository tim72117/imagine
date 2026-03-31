const { useState, useEffect } = React;

const App = () => {
  const [score, setScore] = useState(0);
  const [dotPosition, setDotPosition] = useState({ x: 0, y: 0 });
  const [isGameStarted, setIsGameStarted] = useState(false);

  const getRandomPosition = () => {
    const dotSize = 64; // w-16 h-16 = 64px
    const minX = dotSize / 2;
    const maxX = window.innerWidth - dotSize / 2;
    const minY = dotSize / 2;
    const maxY = window.innerHeight - dotSize / 2;

    return {
      x: Math.random() * (maxX - minX) + minX,
      y: Math.random() * (maxY - minY) + minY,
    };
  };

  useEffect(() => {
    if (isGameStarted) {
      setDotPosition(getRandomPosition());
    }
  }, [isGameStarted]);

  const handleDotClick = () => {
    if (isGameStarted) {
      setScore(score + 1);
      setDotPosition(getRandomPosition());
    }
  };

  const startGame = () => {
    setScore(0);
    setIsGameStarted(true);
  };

  const stopGame = () => {
    setIsGameStarted(false);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4 overflow-hidden">
      <h1 className="text-5xl font-extrabold mb-8 text-yellow-400 drop-shadow-lg text-center">點點樂</h1>
      {isGameStarted ? (
        <>
          <div className="text-3xl font-bold mb-4">得分: {score}</div>
          <div
            className="absolute bg-red-500 rounded-full w-16 h-16 cursor-pointer transform -translate-x-1/2 -translate-y-1/2 transition-all duration-75 ease-out"
            style={{ left: dotPosition.x, top: dotPosition.y }}
            onClick={handleDotClick}
          ></div>
          <button
            onClick={stopGame}
            className="mt-8 px-8 py-4 bg-gray-700 text-white text-2xl font-bold rounded-lg shadow-lg hover:bg-gray-600 transition duration-300 transform hover:scale-105"
          >
            停止遊戲
          </button>
        </>
      ) : (
        <button
          onClick={startGame}
          className="px-12 py-6 bg-green-500 text-white text-3xl font-bold rounded-xl shadow-xl hover:bg-green-600 transition duration-300 transform hover:scale-110"
        >
          開始遊戲
        </button>
      )}
    </div>
  );
};