import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f2f0f7",
          100: "#e1dbee",
          200: "#c3b7dd",
          300: "#a593cc",
          400: "#876fbb",
          500: "#6a4baa",
          600: "#553c8a",
          700: "#402d69",
          800: "#2b1e49",
          900: "#160f28",
        },
        estado: {
          ok: "#1a7f37",
          alerta: "#9a6700",
          riesgo: "#cf222e",
        },
      },
    },
  },
  plugins: [],
};

export default config;
