/**
 * Thin fetch wrapper around the backend API.
 *
 * Holds the access token in memory and transparently refreshes it (via the
 * httpOnly refresh cookie) on a 401, retrying the original request once.
 */
/**
 * API base URL.
 *
 * Resolution order:
 * 1. VITE_API_BASE_URL, when set (API on a different domain).
 * 2. Same origin, when the page is served on a standard port (80/443) — the
 *    production setup, where the web server proxies /api and /auth to the
 *    backend on one domain.
 * 3. Otherwise (dev server on :5173, opened at localhost or a LAN IP) the same
 *    host on port 8000, so no per-host configuration is needed.
 */
const ENV_BASE = import.meta.env.VITE_API_BASE_URL?.trim();
const BASE_URL =
  ENV_BASE && ENV_BASE.length > 0
    ? ENV_BASE
    : window.location.port === ""
      ? ""
      : `${window.location.protocol}//${window.location.hostname}:8000`;

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setAuthLostHandler(handler: () => void): void {
  onAuthLost = handler;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawRequest(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(`${BASE_URL}${path}`, { ...options, headers, credentials: "include" });
}

async function doRefresh(): Promise<{ access_token: string; username: string } | null> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) return null;
  const data = await res.json();
  accessToken = data.access_token;
  return data;
}

async function tryRefresh(): Promise<boolean> {
  return (await doRefresh()) !== null;
}

/** Attempt to restore a session from the httpOnly refresh cookie (e.g. after a
 * page reload). Returns the username on success, or null. */
export async function restoreSession(): Promise<string | null> {
  const data = await doRefresh();
  return data ? data.username : null;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let res = await rawRequest(path, options);

  if (res.status === 401 && !path.startsWith("/auth/")) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await rawRequest(path, options);
    } else {
      accessToken = null;
      onAuthLost?.();
    }
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return (await res.text()) as unknown as T;
  return res.json();
}

function jsonBody(body: unknown): RequestInit {
  return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export const api = {
  // Auth
  registrationOpen: () =>
    request<{ open: boolean }>("/auth/registration").then((r) => r.open),
  register: (username: string, password: string) =>
    request("/auth/register", { method: "POST", ...jsonBody({ username, password }) }),
  login: (username: string, password: string) =>
    request<{ access_token: string; expires_in: number; username: string; is_admin: boolean }>(
      "/auth/login",
      { method: "POST", ...jsonBody({ username, password }) }
    ),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<import("../types").UserInfo>("/auth/me"),

  // User management (admin only)
  listUsers: () => request<import("../types").UserInfo[]>("/api/users"),
  createUser: (username: string, password: string) =>
    request<import("../types").UserInfo>("/api/users", {
      method: "POST",
      ...jsonBody({ username, password }),
    }),
  deleteUser: (userId: string) => request<void>(`/api/users/${userId}`, { method: "DELETE" }),
  resetUserPassword: (userId: string, password: string) =>
    request<void>(`/api/users/${userId}/password`, { method: "POST", ...jsonBody({ password }) }),

  // Trees
  listTrees: () => request<import("../types").Tree[]>("/api/trees"),
  getTree: (treeId: string) => request<import("../types").Tree>(`/api/trees/${treeId}`),
  createTree: (name: string, description?: string) =>
    request<import("../types").Tree>("/api/trees", {
      method: "POST",
      ...jsonBody({ name, description: description ?? null }),
    }),
  updateTree: (treeId: string, body: { name?: string; description?: string | null }) =>
    request<import("../types").Tree>(`/api/trees/${treeId}`, { method: "PUT", ...jsonBody(body) }),
  deleteTree: (treeId: string) => request<void>(`/api/trees/${treeId}`, { method: "DELETE" }),

  // Sharing / collaboration (owner-only management)
  userDirectory: () => request<import("../types").DirectoryUser[]>("/api/users/directory"),
  listShares: (treeId: string) =>
    request<import("../types").Share[]>(`/api/trees/${treeId}/shares`),
  upsertShare: (treeId: string, userId: string, role: string) =>
    request<import("../types").Share>(`/api/trees/${treeId}/shares`, {
      method: "PUT",
      ...jsonBody({ user_id: userId, role }),
    }),
  revokeShare: (treeId: string, userId: string) =>
    request<void>(`/api/trees/${treeId}/shares/${userId}`, { method: "DELETE" }),

  // Individuals
  listIndividuals: (treeId: string) =>
    request<import("../types").Individual[]>(`/api/trees/${treeId}/individuals`),
  createIndividual: (treeId: string, body: Partial<import("../types").Individual>) =>
    request<import("../types").Individual>(`/api/trees/${treeId}/individuals`, {
      method: "POST",
      ...jsonBody(body),
    }),
  updateIndividual: (treeId: string, id: string, body: Partial<import("../types").Individual>) =>
    request<import("../types").Individual>(`/api/trees/${treeId}/individuals/${id}`, {
      method: "PUT",
      ...jsonBody(body),
    }),
  deleteIndividual: (treeId: string, id: string) =>
    request<void>(`/api/trees/${treeId}/individuals/${id}`, { method: "DELETE" }),
  mergeIndividual: (treeId: string, survivorId: string, duplicateId: string) =>
    request<void>(`/api/trees/${treeId}/individuals/${survivorId}/merge`, {
      method: "POST",
      ...jsonBody({ duplicate_id: duplicateId }),
    }),

  // Dismissed (not-a-duplicate) pairs
  listDismissedDuplicates: (treeId: string) =>
    request<{ individual_a: string; individual_b: string }[]>(
      `/api/trees/${treeId}/duplicates/dismissed`
    ),
  dismissDuplicate: (treeId: string, idA: string, idB: string) =>
    request<void>(`/api/trees/${treeId}/duplicates/dismiss`, {
      method: "POST",
      ...jsonBody({ id_a: idA, id_b: idB }),
    }),
  undismissDuplicate: (treeId: string, idA: string, idB: string) =>
    request<void>(`/api/trees/${treeId}/duplicates/undismiss`, {
      method: "POST",
      ...jsonBody({ id_a: idA, id_b: idB }),
    }),

  // Dismissed data-integrity warnings (by stable key)
  listDismissedWarnings: (treeId: string) =>
    request<string[]>(`/api/trees/${treeId}/warnings/dismissed`),
  dismissWarning: (treeId: string, key: string) =>
    request<void>(`/api/trees/${treeId}/warnings/dismiss`, {
      method: "POST",
      ...jsonBody({ key }),
    }),
  undismissWarning: (treeId: string, key: string) =>
    request<void>(`/api/trees/${treeId}/warnings/undismiss`, {
      method: "POST",
      ...jsonBody({ key }),
    }),

  // Families
  listFamilies: (treeId: string) =>
    request<import("../types").Family[]>(`/api/trees/${treeId}/families`),
  createFamily: (treeId: string, body: Partial<import("../types").Family>) =>
    request<import("../types").Family>(`/api/trees/${treeId}/families`, {
      method: "POST",
      ...jsonBody(body),
    }),
  updateFamily: (treeId: string, id: string, body: Partial<import("../types").Family>) =>
    request<import("../types").Family>(`/api/trees/${treeId}/families/${id}`, {
      method: "PUT",
      ...jsonBody(body),
    }),
  deleteFamily: (treeId: string, id: string) =>
    request<void>(`/api/trees/${treeId}/families/${id}`, { method: "DELETE" }),

  // Visualization
  descendants: (treeId: string, individualId: string) =>
    request<import("../types").TreeNode>(`/api/trees/${treeId}/descendants/${individualId}`),
  ancestors: (treeId: string, individualId: string) =>
    request<import("../types").AncestorNode>(`/api/trees/${treeId}/ancestors/${individualId}`),

  // GEDCOM
  importGedcom: async (treeId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<import("../types").ImportSummary>(`/api/trees/${treeId}/import`, {
      method: "POST",
      body: form,
    });
  },
  exportUrl: (treeId: string) => `${BASE_URL}/api/trees/${treeId}/export`,
};

export { BASE_URL };
