import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../store/auth";
import type { Tree } from "../types";
import ThemeToggle from "../components/ui/ThemeToggle";
import {
  getGlobalOrientation,
  setGlobalOrientation,
  type Orientation,
} from "../utils/orientation";

export default function TreesPage() {
  const navigate = useNavigate();
  const { username, logout } = useAuth();
  const [trees, setTrees] = useState<Tree[]>([]);
  const [globalOrientation, setGlobalOrientationState] = useState<Orientation>(
    getGlobalOrientation
  );
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setTrees(await api.listTrees());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trees");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const tree = await api.createTree(name.trim(), description.trim() || undefined);
      setName("");
      setDescription("");
      setTrees((t) => [tree, ...t]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create tree");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(tree: Tree) {
    if (!confirm(`Delete "${tree.name}"? This cannot be undone.`)) return;
    await api.deleteTree(tree.id);
    setTrees((t) => t.filter((x) => x.id !== tree.id));
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-brand dark:text-brand-soft">Your Family Trees</h1>
          <p className="text-sm text-gray-500 dark:text-slate-400">Signed in as {username}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              const next: Orientation =
                globalOrientation === "vertical" ? "horizontal" : "vertical";
              setGlobalOrientation(next);
              setGlobalOrientationState(next);
            }}
            title="Default chart layout for all trees (each tree's own toggle can override this)"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Default: {globalOrientation === "vertical" ? "⬇ Top-down" : "➡ Left-right"}
          </button>
          <ThemeToggle />
          <button
            onClick={async () => {
              await logout();
              navigate("/login");
            }}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </header>

      <form onSubmit={handleCreate} className="mb-8 rounded-xl bg-white p-5 shadow dark:bg-slate-800">
        <h2 className="mb-3 font-semibold text-gray-800 dark:text-slate-100">Create a new tree</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tree name (e.g. Smith Family)"
            className="rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:placeholder-slate-400"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            className="rounded-lg border border-gray-300 px-3 py-2 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:placeholder-slate-400"
          />
        </div>
        <button
          type="submit"
          disabled={creating}
          className="mt-3 rounded-lg bg-brand px-4 py-2 font-medium text-white hover:bg-brand-light disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create tree"}
        </button>
      </form>

      {error && <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {loading ? (
        <p className="text-gray-500 dark:text-slate-400">Loading trees…</p>
      ) : trees.length === 0 ? (
        <p className="text-gray-500 dark:text-slate-400">No trees yet. Create one above to get started.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {trees.map((tree) => (
            <li
              key={tree.id}
              className="rounded-xl bg-white p-5 shadow transition hover:shadow-md dark:bg-slate-800"
            >
              <div className="flex items-start justify-between">
                <button onClick={() => navigate(`/trees/${tree.id}`)} className="text-left">
                  <h3 className="font-semibold text-brand dark:text-brand-soft">{tree.name}</h3>
                  {tree.description && (
                    <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{tree.description}</p>
                  )}
                </button>
                <button
                  onClick={() => handleDelete(tree)}
                  className="text-sm text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                  title="Delete tree"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
