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
            includeAssets: ["favicon.svg", "apple-touch-icon.png"],
            manifest: {
              name: `${appName} — Genealogy`,
              short_name: appName,
              description: "Multi-tree genealogy and family tree explorer",
              theme_color: "#1e3a5f",
              background_color: "#f8fafc",
              display: "standalone",
              start_url: "/",
              icons: [
                { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
                { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
                // Same square art doubles as the Android maskable icon — the
                // mark sits inside the safe zone so corner masking won't clip it.
                { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
              ],
            },
            workbox: {
              navigateFallbackDenylist: [/^\/api/, /^\/auth/],
              // Take control and drop the previous version's precache as soon
              // as a new service worker activates, so a deploy doesn't leave
              // devices serving a stale app shell.
              clientsClaim: true,
              skipWaiting: true,
              cleanupOutdatedCaches: true,
              // Always try the network for the app HTML first (fall back to the
              // cached shell only when offline). This is what stops "my update
              // never shows up": the newest index.html — which points at the
              // newest JS — is fetched whenever the device is online.
              runtimeCaching: [
                {
                  urlPattern: ({ request }: { request: Request }) => request.mode === "navigate",
                  handler: "NetworkFirst",
                  options: {
                    cacheName: "app-shell",
                    networkTimeoutSeconds: 5,
                  },
                },
                // Read-only API data: network-first with a cache fallback so an
                // already-visited tree still DISPLAYS offline (at a cemetery, on
                // a plane, showing relatives). Mutations are never cached.
                {
                  urlPattern: ({ url, request }: { url: URL; request: Request }) =>
                    request.method === "GET" &&
                    (url.pathname.startsWith("/api/") || url.pathname.startsWith("/public/")),
                  handler: "NetworkFirst",
                  options: {
                    cacheName: "api-reads",
                    networkTimeoutSeconds: 8,
                    expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
                  },
                },
              ],
            },
          }),
        ]
      : [];

  // Substitute %VITE_APP_NAME% in index.html at build time (title + the PWA
  // apple-mobile-web-app-title). Vite's built-in %ENV% replacement only fires
  // when the var is actually set, so without this the static HTML ships the
  // literal token — harmless for the browser tab (JS fixes it at runtime) but
  // wrong for the installed app's name, which is read from the static markup.
  const htmlAppName = {
    name: "html-app-name",
    transformIndexHtml(html: string) {
      return html.replace(/%VITE_APP_NAME%/g, appName);
    },
  };

  // Dev-only: serve a self-destructing service worker at /sw.js. If a device
  // ever registered a production service worker on this origin (e.g. from a
  // prod build once served on this port), it caches the app shell and keeps
  // showing stale code no matter how you refresh. On its next update check the
  // browser fetches this script, which unregisters the SW, clears all caches,
  // and reloads open tabs — self-healing the "my changes never show up" trap.
  // Not part of the production build, where VitePWA emits the real sw.js.
  const killDevServiceWorker = {
    name: "kill-dev-service-worker",
    apply: "serve" as const,
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      const selfDestruct = [
        "self.addEventListener('install', () => self.skipWaiting());",
        "self.addEventListener('activate', (event) => {",
        "  event.waitUntil((async () => {",
        "    try { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); } catch (e) {}",
        "    try { await self.registration.unregister(); } catch (e) {}",
        "    const clients = await self.clients.matchAll({ type: 'window' });",
        "    clients.forEach((c) => c.navigate(c.url));",
        "  })());",
        "});",
      ].join("\n");
      server.middlewares.use((req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (url === "/sw.js" || url === "/service-worker.js") {
          res.setHeader("Content-Type", "application/javascript");
          res.setHeader("Cache-Control", "no-store");
          res.end(selfDestruct);
          return;
        }
        next();
      });
    },
  };

  return {
  plugins: [react(), htmlAppName, killDevServiceWorker, ...pwa],
  server: {
    port: 5173,
    host: "0.0.0.0",
    // Docker bind mounts on macOS don't propagate fs events to the Linux
    // container, so Vite's HMR never sees file edits. Poll for changes instead.
    watch: { usePolling: true, interval: 200 },
  },
  };
});
