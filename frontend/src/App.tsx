import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./store/auth";
import LoginPage from "./pages/Login";
import PublicTreePage from "./pages/PublicTree";
import TreesPage from "./pages/Trees";
import TreeViewPage from "./pages/TreeView";

/** Thin amber strip while the device is offline. Cached trees still display
 * (the service worker serves recent GET responses); edits would fail, so say
 * so up front instead of letting saves error mysteriously. */
function OfflineBanner() {
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (!offline) return null;
  return (
    <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
      Offline — showing saved data; changes can't be saved until you're back online.
    </div>
  );
}

function RequireAuth({ children }: { children: JSX.Element }) {
  const isAuthenticated = useAuth((s) => s.isAuthenticated);
  const bootstrapping = useAuth((s) => s.bootstrapping);
  // While restoring a session on first load, don't bounce to /login yet.
  if (bootstrapping) {
    return (
      <div className="flex min-h-full items-center justify-center text-gray-400 dark:text-slate-500">
        Loading…
      </div>
    );
  }
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <div className="flex h-full flex-col">
      <OfflineBanner />
      <div className="min-h-0 flex-1">
        <Routes>
          <Route path="/login" element={<LoginPage />} />
      {/* Public share link — no account required; the token is the credential. */}
      <Route path="/share/:token" element={<PublicTreePage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <TreesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/trees/:treeId"
        element={
          <RequireAuth>
            <TreeViewPage />
          </RequireAuth>
        }
      />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
