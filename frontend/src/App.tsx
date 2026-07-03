import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./store/auth";
import LoginPage from "./pages/Login";
import TreesPage from "./pages/Trees";
import TreeViewPage from "./pages/TreeView";

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
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
  );
}
