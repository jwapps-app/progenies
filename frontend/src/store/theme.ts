import { create } from "zustand";

export type Theme = "light" | "dark";

const KEY = "theme";

function systemPrefersDark(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Resolve the initial theme: an explicit saved choice wins, else follow the OS.
 * Must match the inline pre-paint script in index.html. */
function initialTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return systemPrefersDark() ? "dark" : "light";
}

/** Reflect the theme onto <html> (the `dark` class Tailwind keys off) and the
 * browser chrome color. */
function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1220" : "#1e3a5f");
}

interface ThemeState {
  theme: Theme;
  toggle: () => void;
  setTheme: (theme: Theme) => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: initialTheme(),
  toggle: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  setTheme: (theme) => {
    localStorage.setItem(KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
}));
