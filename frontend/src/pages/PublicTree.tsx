import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../api/client";
import DescendantPyramid from "../components/visualizations/DescendantPyramid";
import AncestorChart from "../components/visualizations/AncestorChart";
import ThemeToggle from "../components/ui/ThemeToggle";
import { useTheme } from "../store/theme";
import type { AncestorNode, Family, Individual, TreeNode } from "../types";
import { displayName } from "../types";
import { APP_NAME } from "../branding";

/** Pick the person whose descendant view covers the most of the tree: someone
 * with children who is nobody's child (a top ancestor). Mirrors TreeView's
 * defaultRoot without importing the whole page. */
function defaultRoot(individuals: Individual[], families: Family[]): string | null {
  if (individuals.length === 0) return null;
  const isChild = new Set(families.flatMap((f) => f.children.map((c) => c.individual_id)));
  const parents = new Set(
    families.flatMap((f) => [f.husband_id, f.wife_id]).filter((p): p is string => !!p)
  );
  const top = individuals.find((i) => parents.has(i.id) && !isChild.has(i.id));
  return (top ?? individuals[0]).id;
}

/**
 * Read-only tree view behind a public share link (/share/:token). No account
 * required — the token itself is the credential. Chart + root picker only;
 * every editing affordance is absent by construction.
 */
export default function PublicTreePage() {
  const { token } = useParams<{ token: string }>();
  const theme = useTheme((s) => s.theme);
  const [treeName, setTreeName] = useState<string>("");
  const [individuals, setIndividuals] = useState<Individual[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"descendants" | "ancestors">("descendants");
  const [treeData, setTreeData] = useState<TreeNode | null>(null);
  const [ancestorData, setAncestorData] = useState<AncestorNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [tree, inds, fams] = await Promise.all([
          api.publicTree(token),
          api.publicIndividuals(token),
          api.publicFamilies(token),
        ]);
        if (cancelled) return;
        setTreeName(tree.name);
        document.title = `${tree.name} — ${APP_NAME}`;
        setIndividuals(inds);
        setRootId(defaultRoot(inds, fams));
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "This link is invalid or has been revoked"
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !rootId) return;
    let cancelled = false;
    const onErr = (err: unknown) =>
      !cancelled && setError(err instanceof Error ? err.message : "Failed to load chart");
    if (viewMode === "ancestors") {
      api.publicAncestors(token, rootId).then((d) => !cancelled && setAncestorData(d)).catch(onErr);
    } else {
      api.publicDescendants(token, rootId).then((d) => !cancelled && setTreeData(d)).catch(onErr);
    }
    return () => {
      cancelled = true;
    };
  }, [token, rootId, viewMode]);

  const sorted = useMemo(
    () => [...individuals].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [individuals]
  );

  const onSelect = (id: string) => setRootId(id);

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-gray-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-800">
        <h1 className="font-semibold text-brand dark:text-brand-soft">
          {treeName || "Family tree"}
        </h1>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500 dark:bg-slate-700 dark:text-slate-400">
          👁 Read-only shared view
        </span>
        {individuals.length > 0 && (
          <>
            <label className="ml-auto flex items-center gap-2 text-sm text-gray-600 dark:text-slate-300">
              Root person
              <select
                value={rootId ?? ""}
                onChange={(e) => setRootId(e.target.value)}
                className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100"
              >
                {sorted.map((p) => (
                  <option key={p.id} value={p.id}>
                    {displayName(p)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex overflow-hidden rounded-lg border border-gray-300 text-sm dark:border-slate-600">
              {(["descendants", "ancestors"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setViewMode(m)}
                  className={`px-3 py-1.5 font-medium ${
                    viewMode === m
                      ? "bg-brand text-white"
                      : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                  }`}
                >
                  {m === "descendants" ? "↓ Descendants" : "↑ Ancestors"}
                </button>
              ))}
            </div>
          </>
        )}
        <ThemeToggle />
      </header>

      {error && (
        <p className="bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      <main className="min-h-0 flex-1 bg-slate-50 dark:bg-slate-900">
        {loading ? (
          <div className="flex h-full items-center justify-center text-gray-500 dark:text-slate-400">
            Loading…
          </div>
        ) : viewMode === "ancestors" ? (
          ancestorData ? (
            <AncestorChart root={ancestorData} onSelect={onSelect} theme={theme} />
          ) : null
        ) : treeData ? (
          <DescendantPyramid root={treeData} onSelect={onSelect} theme={theme} />
        ) : null}
      </main>
    </div>
  );
}
