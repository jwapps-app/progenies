import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../store/auth";
import type { Tree, UserInfo } from "../types";
import Modal from "../components/ui/Modal";
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
  // Admin user management (only shown when the signed-in account is an admin).
  const [isAdmin, setIsAdmin] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
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
    api
      .me()
      .then((u) => setIsAdmin(u.is_admin))
      .catch(() => setIsAdmin(false));
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
          {isAdmin && (
            <button
              onClick={() => setShowUsers(true)}
              title="Manage user accounts"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Users
            </button>
          )}
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

      {showUsers && <UsersPanel onClose={() => setShowUsers(false)} />}

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

/** Admin-only account management: list, create, reset password, delete. */
function UsersPanel({ onClose }: { onClose: () => void }) {
  const { username: myUsername } = useAuth();
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setUsers(await api.listUsers());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createUser(newName.trim(), newPassword);
      setNewName("");
      setNewPassword("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(user: UserInfo) {
    if (!confirm(`Delete "${user.username}" and ALL their trees? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteUser(user.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
    }
  }

  async function handleResetPassword(user: UserInfo) {
    const password = prompt(`New password for "${user.username}" (min 8 characters):`);
    if (!password) return;
    setError(null);
    try {
      await api.resetUserPassword(user.id, password);
      alert(`Password updated for ${user.username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    }
  }

  return (
    <Modal title="Users" onClose={onClose}>
      <div className="space-y-4">
        <ul className="divide-y divide-gray-200 dark:divide-slate-700">
          {users.map((u) => (
            <li key={u.id} className="flex items-center justify-between py-2">
              <div>
                <span className="font-medium text-gray-800 dark:text-slate-100">{u.username}</span>
                {u.is_admin && (
                  <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand dark:text-brand-soft">
                    admin
                  </span>
                )}
                {u.username === myUsername && (
                  <span className="ml-2 text-xs text-gray-400 dark:text-slate-500">(you)</span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => handleResetPassword(u)}
                  className="text-gray-500 hover:text-brand dark:text-slate-400 dark:hover:text-brand-soft"
                >
                  Reset password
                </button>
                {u.username !== myUsername && (
                  <button
                    onClick={() => handleDelete(u)}
                    className="text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <form onSubmit={handleCreate} className="space-y-2 border-t border-gray-200 pt-4 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-slate-200">Add a user</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Username"
              required
              minLength={3}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Password (min 8 chars)"
              required
              minLength={8}
              autoComplete="new-password"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-brand px-3 py-2 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create user"}
          </button>
        </form>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
}
