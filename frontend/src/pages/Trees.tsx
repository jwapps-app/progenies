import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useAuth } from "../store/auth";
import type { DirectoryUser, Share, Tree, UserInfo } from "../types";
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
  // The tree whose sharing dialog is open (owner only), or null.
  const [sharingTree, setSharingTree] = useState<Tree | null>(null);
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
    setError(null);
    try {
      await api.deleteTree(tree.id);
      setTrees((t) => t.filter((x) => x.id !== tree.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete tree");
    }
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
              <div className="flex items-start justify-between gap-2">
                <button onClick={() => navigate(`/trees/${tree.id}`)} className="min-w-0 text-left">
                  <h3 className="font-semibold text-brand dark:text-brand-soft">{tree.name}</h3>
                  {tree.role !== "owner" && (
                    <span className="mt-1 inline-block rounded bg-brand/10 px-1.5 py-0.5 text-xs font-medium text-brand dark:text-brand-soft">
                      {tree.role === "viewer" ? "👁 View" : "✎ Edit"} · shared by {tree.owner_username}
                    </span>
                  )}
                  {tree.description && (
                    <p className="mt-1 text-sm text-gray-500 dark:text-slate-400">{tree.description}</p>
                  )}
                </button>
                {tree.role === "owner" && (
                  <div className="flex shrink-0 items-center gap-2 text-sm">
                    <button
                      onClick={() => setSharingTree(tree)}
                      className="text-gray-400 hover:text-brand dark:text-slate-500 dark:hover:text-brand-soft"
                      title="Share with collaborators"
                    >
                      Share
                    </button>
                    <button
                      onClick={() => handleDelete(tree)}
                      className="text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                      title="Delete tree"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {sharingTree && (
        <ShareDialog
          tree={sharingTree}
          onClose={() => setSharingTree(null)}
          onUpdated={(updated) => {
            // Keep the list (and the open dialog's tree) in sync with the server —
            // a stale share_token here would offer "Create public link" again,
            // which ROTATES the token and breaks the URL already handed out.
            setTrees((t) => t.map((x) => (x.id === updated.id ? updated : x)));
            setSharingTree(updated);
          }}
        />
      )}
    </div>
  );
}

/** Owner-only dialog to manage who a tree is shared with. Add a collaborator
 * from the user directory at a chosen access level, change a level, or revoke. */
function ShareDialog({
  tree,
  onClose,
  onUpdated,
}: {
  tree: Tree;
  onClose: () => void;
  /** Called with the server's updated tree after a link create/revoke. */
  onUpdated: (tree: Tree) => void;
}) {
  const [shares, setShares] = useState<Share[]>([]);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [pickUser, setPickUser] = useState("");
  const [pickRole, setPickRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(tree.share_token ?? null);
  const [copied, setCopied] = useState(false);

  const shareUrl = shareToken ? `${window.location.origin}/share/${shareToken}` : null;

  async function handleCreateLink() {
    setError(null);
    try {
      const updated = await api.createShareLink(tree.id);
      setShareToken(updated.share_token ?? null);
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create link");
    }
  }

  async function handleRevokeLink() {
    if (!confirm("Revoke the public link? Anyone using it will lose access immediately.")) return;
    setError(null);
    try {
      const updated = await api.revokeShareLink(tree.id);
      setShareToken(null);
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke link");
    }
  }

  async function handleCopyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the URL is visible to copy manually */
    }
  }

  async function refresh() {
    try {
      const [s, d] = await Promise.all([api.listShares(tree.id), api.userDirectory()]);
      setShares(s);
      setDirectory(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sharing");
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.id]);

  // Accounts not already collaborators (and never the owner — the directory
  // already excludes the requesting user, who is the owner here).
  const shareable = directory.filter((u) => !shares.some((s) => s.user_id === u.id));

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    if (!pickUser) return;
    setBusy(true);
    setError(null);
    try {
      await api.upsertShare(tree.id, pickUser, pickRole);
      setPickUser("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to share");
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(share: Share, role: string) {
    setError(null);
    try {
      await api.upsertShare(tree.id, share.user_id, role);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update access");
    }
  }

  async function revoke(share: Share) {
    setError(null);
    try {
      await api.revokeShare(tree.id, share.user_id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke access");
    }
  }

  const selectClass =
    "rounded-lg border border-gray-300 px-2 py-1.5 text-sm focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100";

  return (
    <Modal title={`Share "${tree.name}"`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-sm text-gray-500 dark:text-slate-400">
          Collaborators can open this tree from their own account. Editors can make changes;
          viewers have read-only access.
        </p>

        <div className="rounded-lg border border-gray-200 p-3 dark:border-slate-700">
          <p className="mb-2 text-sm font-semibold text-gray-700 dark:text-slate-200">
            Public link <span className="font-normal text-gray-400">(read-only, no account needed)</span>
          </p>
          {shareUrl ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={shareUrl}
                  onFocus={(e) => e.target.select()}
                  className="min-w-0 flex-1 rounded border border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-600 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-300"
                />
                <button
                  onClick={handleCopyLink}
                  className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-light"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
              <button
                onClick={handleRevokeLink}
                className="text-xs text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
              >
                Revoke link
              </button>
            </div>
          ) : (
            <button
              onClick={handleCreateLink}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              Create public link
            </button>
          )}
        </div>

        {shares.length > 0 ? (
          <ul className="divide-y divide-gray-200 dark:divide-slate-700">
            {shares.map((s) => (
              <li key={s.user_id} className="flex items-center justify-between py-2">
                <span className="font-medium text-gray-800 dark:text-slate-100">{s.username}</span>
                <div className="flex items-center gap-2 text-sm">
                  <select
                    value={s.role}
                    onChange={(e) => changeRole(s, e.target.value)}
                    className={selectClass}
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    onClick={() => revoke(s)}
                    className="text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400 dark:text-slate-500">Not shared with anyone yet.</p>
        )}

        <form
          onSubmit={handleAdd}
          className="flex flex-wrap items-center gap-2 border-t border-gray-200 pt-4 dark:border-slate-700"
        >
          <select
            value={pickUser}
            onChange={(e) => setPickUser(e.target.value)}
            className={`${selectClass} flex-1`}
            disabled={shareable.length === 0}
          >
            <option value="">
              {shareable.length === 0 ? "No other users to add" : "Choose a user…"}
            </option>
            {shareable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
          <select value={pickRole} onChange={(e) => setPickRole(e.target.value)} className={selectClass}>
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
          <button
            type="submit"
            disabled={busy || !pickUser}
            className="rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50"
          >
            {busy ? "Sharing…" : "Share"}
          </button>
        </form>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
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
