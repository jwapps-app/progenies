import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// PWA manifest + service worker (Phase 1: offline-capable app shell).
// The brand name is env-driven (VITE_APP_NAME) so the app can be rebranded
// without touching source — see src/branding.ts.
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, ".", "");
  const appName = (env.VITE_APP_NAME || "Progenies").trim();

  // Only build the PWA service worker for production (`vite build`). In dev a
  // service worker just caches the app shell and serves stale code, which is a
  // constant source of "my changes don't show up" confusion.
  const pwa =
    command === "build"
      ? [
          VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["favicon.svg"],
            manifest: {
              name: `${appName} — Genealogy`,
              short_name: appName,
              description: "Multi-tree genealogy and family tree explorer",
              theme_color: "#1e3a5f",
              background_color: "#f8fafc",
              display: "standalone",
              start_url: "/",
              icons: [
                { src: "icon-192.png", sizes: "192x192", type: "image/png" },
                { src: "icon-512.png", sizes: "512x512", type: "image/png" },
              ],
            },
            workbox: {
              navigateFallbackDenylist: [/^\/api/, /^\/auth/],
            },
          }),
        ]
      : [];

  return {
  plugins: [react(), ...pwa],
  server: {
    port: 5173,
    host: "0.0.0.0",
    // Docker bind mounts on macOS don't propagate fs events to the Linux
    // container, so Vite's HMR never sees file edits. Poll for changes instead.
    watch: { usePolling: true, interval: 200 },
  },
  };
});
