/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f7f4ec",
        parchment: "#efe9db",
        ink: "#1b1a17",
        inkmut: "#5d5a50",
        line: "#cfc7b4",
        navy: "#1d3557",
        navydeep: "#12233a",
        teal: "#0f6b63",
        accent: "#b7791f",
        amberline: "#e8cf9a",
        crimson: "#b91c1c",
        crimsonbg: "#fde8e6",
        amberbg: "#fdf3dd",
        mintbg: "#e6f2ee",
        skybg: "#e8eef7",
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['"SF Mono"', 'Menlo', 'Monaco', '"Cascadia Mono"', '"Roboto Mono"', 'monospace'],
      },
      boxShadow: {
        window: "0 18px 40px -20px rgba(18,35,58,.45), 0 2px 6px rgba(18,35,58,.15)",
        pop: "0 12px 28px -12px rgba(18,35,58,.55)",
      },
      keyframes: {
        ticker: {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-50%)" },
        },
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: ".25" },
        },
      },
      animation: {
        blink: "blink 1.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
