/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Noto Sans Thai", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      colors: {
        base: {
          950: "#0a0e14",
          900: "#0f141c",
          850: "#131a24",
          800: "#1a2230",
          700: "#232d3d",
          600: "#2f3b4e",
          500: "#4a5a72",
          400: "#7489a3",
          300: "#a3b3c7",
          200: "#cdd8e5",
          100: "#eef2f7",
        },
        accent: {
          500: "#4f8cff",
          400: "#6fa1ff",
          300: "#99bcff",
        },
        good: "#34d399",
        warn: "#fbbf24",
        bad: "#f87171",
      },
      boxShadow: {
        card: "0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -8px rgba(0,0,0,0.5)",
      },
      borderRadius: {
        xl2: "1.1rem",
      },
    },
  },
  plugins: [],
};
