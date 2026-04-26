import type { Config } from "tailwindcss";

const config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        obsidian: {
          950: "#0B0E14",
          900: "#111827",
          border: "#30363D",
          emerald: "#10B981",
          cyan: "#06B6D4",
          crimson: "#EF4444",
        },
      },
      fontFamily: {
        sans: ["var(--font-geist-sans)"],
        mono: ["var(--font-geist-mono)"],
      },
    },
  },
} satisfies Config;

export default config;
