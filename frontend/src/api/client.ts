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
 * 2. A PRODUCTION build always uses the same origin: that bundle is only ever
 *    served by the web container, whose nginx proxies /api, /auth and /public
 *    to the backend. The port the site happens to be published on is
 *    irrelevant — http://nas.lan:8091 must work exactly like https://app.example.
 *    (This used to key off `window.location.port === ""`, which silently sent
 *    the API to port 8000 whenever production was reached on a non-standard
 *    port — a port the prod stack never publishes, so every request failed.)
 * 3. A DEV build (vite dev on :5173) talks to the backend on port 8000 of the
 *    same host, so no per-host configuration is needed on the LAN.
 */
const ENV_BASE = import.meta.env.VITE_API_BASE_URL?.trim();
const BASE_URL =
  ENV_BASE && ENV_BASE.length > 0
    ? ENV_BASE
    : import.meta.env.PROD
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

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawRequest(path: string, options: RequestInit): Promise<Response> {
  const headers = new Headers(options.headers);
  // Public share-link reads are unauthenticated — don't attach the Bearer token
  // or send the session/refresh cookie to them.
  const isPublic = path.startsWith("/public/");
  if (accessToken && !isPublic) headers.set("Authorization", `Bearer ${accessToken}`);
  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: isPublic ? "omit" : "include",
  });
}

// Single-flight: concurrent 401s (e.g. three parallel fetches after token
// expiry) share ONE refresh call instead of racing the endpoint — with token
// rotation, the losers of that race would present a stale token and log the
// user out spuriously.
let refreshInFlight: Promise<{ access_token: string; username: string } | null> | null = null;

function doRefresh(): Promise<{ access_token: string; username: string } | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE_URL}/auth/refresh`, {
          method: "POST",
          credentials: "include",
        });
        if (!res.ok) return null;
        const data = await res.json();
        accessToken = data.access_token;
        return data;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
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

  if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/public/")) {
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

/** Options for a share-link read. The token travels in a request header, never
 * in the URL — a path token was written into every access log between the
 * browser and the app (nginx, uvicorn, the tunnel). */
function shareOpts(token: string, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("X-Share-Token", token);
  return { ...init, headers };
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
  createShareLink: (treeId: string) =>
    request<import("../types").Tree>(`/api/trees/${treeId}/share-link`, { method: "POST" }),
  revokeShareLink: (treeId: string) =>
    request<import("../types").Tree>(`/api/trees/${treeId}/share-link`, { method: "DELETE" }),

  // Public (unauthenticated) share-link reads — the token goes in a header.
  publicTree: (token: string) =>
    request<{ name: string; description: string | null }>("/public/tree", shareOpts(token)),
  publicIndividuals: (token: string) =>
    request<import("../types").PublicIndividual[]>("/public/individuals", shareOpts(token)),
  publicFamilies: (token: string) =>
    request<import("../types").PublicFamily[]>("/public/families", shareOpts(token)),
  publicDescendants: (token: string, individualId: string) =>
    request<import("../types").TreeNode>(`/public/descendants/${individualId}`, shareOpts(token)),
  publicAncestors: (token: string, individualId: string) =>
    request<import("../types").AncestorNode>(`/public/ancestors/${individualId}`, shareOpts(token)),
  publicPhotos: (token: string, ids: string[]) =>
    request<Record<string, string>>(
      "/public/photos",
      shareOpts(token, { method: "POST", ...jsonBody({ ids }) })
    ),

  // Individuals. The list omits photo thumbnails and notes (they multiply the
  // payload); a person's detail carries both, and `photos` serves thumbnails
  // for a whole chart in one batch.
  listIndividuals: (treeId: string) =>
    request<import("../types").Individual[]>(`/api/trees/${treeId}/individuals`),
  // Photo thumbnails keyed by id, for just the ids given (max 2,000 per call;
  // ids without a photo are absent). A POST because a chart's worth of ids
  // does not fit in a URL — it is a read.
  photos: (treeId: string, ids: string[]) =>
    request<Record<string, string>>(`/api/trees/${treeId}/photos`, {
      method: "POST",
      ...jsonBody({ ids }),
    }),
  getIndividual: (treeId: string, id: string) =>
    request<import("../types").Individual>(`/api/trees/${treeId}/individuals/${id}`),
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

  // Sources & citations
  listSources: (treeId: string) =>
    request<import("../types").Source[]>(`/api/trees/${treeId}/sources`),
  createSource: (treeId: string, body: Partial<import("../types").Source>) =>
    request<import("../types").Source>(`/api/trees/${treeId}/sources`, {
      method: "POST",
      ...jsonBody(body),
    }),
  deleteSource: (treeId: string, id: string) =>
    request<void>(`/api/trees/${treeId}/sources/${id}`, { method: "DELETE" }),
  listCitations: (treeId: string, individualId: string) =>
    request<import("../types").Citation[]>(
      `/api/trees/${treeId}/individuals/${individualId}/citations`
    ),
  createCitation: (
    treeId: string,
    individualId: string,
    body: { source_id: string; page?: string | null; notes?: string | null }
  ) =>
    request<import("../types").Citation>(
      `/api/trees/${treeId}/individuals/${individualId}/citations`,
      { method: "POST", ...jsonBody(body) }
    ),
  deleteCitation: (treeId: string, citationId: string) =>
    request<void>(`/api/trees/${treeId}/citations/${citationId}`, { method: "DELETE" }),

  // GEDCOM
  importGedcom: async (treeId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<import("../types").ImportSummary>(`/api/trees/${treeId}/import`, {
      method: "POST",
      body: form,
    });
  },
  // Fetched through request() so the Bearer token is attached — a bare link
  // navigation carries no Authorization header and 401s.
  exportGedcom: (treeId: string) => request<string>(`/api/trees/${treeId}/export`),
};
