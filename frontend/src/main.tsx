import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { setAuthLostHandler } from "./api/client";
import { useAuth } from "./store/auth";
import { APP_TITLE } from "./branding";
import "./index.css";

// Apply the (env-driven) brand name to the document title.
document.title = APP_TITLE;

// In dev, proactively remove any leftover production service worker + caches.
// A stale SW serves old JS and makes code changes appear not to take effect.
if (import.meta.env.DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
  if ("caches" in window) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}

// When a refresh fails, clear the in-memory session so the router redirects.
setAuthLostHandler(() => useAuth.getState().clearSession());

// Try to restore a session from the refresh cookie before first render decisions,
// so a page reload keeps the user signed in instead of bouncing to /login.
void useAuth.getState().restore();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
