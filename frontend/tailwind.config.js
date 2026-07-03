/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Neutral brand palette token, decoupled from the (provisional) product
        // name so the palette and the name can be rebranded independently.
        brand: {
          DEFAULT: "#1e3a5f",
          light: "#2c5282",
          // Legible brand-tinted foreground for dark surfaces (the navy DEFAULT is
          // unreadable as text on a dark background).
          soft: "#8bb4e8",
        },
      },
    },
  },
  plugins: [],
};
