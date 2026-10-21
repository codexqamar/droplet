/** @type {import('tailwindcss').Config} */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', '"Inter"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        ink: token("ink"),
        muted: token("muted"),
        line: token("line"),
        surface: token("surface"),
        accent: token("accent"),
        onaccent: token("on-accent"),
        ok: token("ok"),
        warn: token("warn"),
        danger: token("danger"),
      },
      boxShadow: {
        glass: "0 1px 0 0 rgb(var(--highlight)) inset, 0 12px 32px -16px rgb(var(--shadow) / 0.35)",
        dock: "0 1px 0 0 rgb(var(--highlight)) inset, 0 20px 40px -18px rgb(var(--shadow) / 0.45)",
      },
      borderRadius: { "4xl": "1.75rem" },
    },
  },
  plugins: [],
};
