/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#0a0a0c',
        sidebar: '#111114',
        accent: '#3b82f6',
      }
    },
  },
  plugins: [],
}
