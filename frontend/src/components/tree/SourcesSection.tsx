import { FormEvent, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Citation, Source } from "../../types";

/**
 * "Sources" block for the person detail panel: lists the person's source
 * citations, with add/remove for editors. Self-contained — fetches its own
 * data keyed on the person and reload counter.
 */
export default function SourcesSection({
  treeId,
  personId,
  canEdit,
  reloadKey,
  onError,
}: {
  treeId: string;
  personId: string;
  canEdit: boolean;
  reloadKey: number;
  onError: (message: string) => void;
}) {
  const [citations, setCitations] = useState<Citation[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  // "new" = create a source inline; otherwise an existing source id.
  const [pick, setPick] = useState<string>("new");
  const [newTitle, setNewTitle] = useState("");
  const [page, setPage] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .listCitations(treeId, personId)
      .then((c) => !cancelled && setCitations(c))
      .catch(
        (err) =>
          !cancelled && onError(err instanceof Error ? err.message : "Failed to load citations")
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeId, personId, reloadKey]);

  // Sources are only needed once the add form opens.
  useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    api
      .listSources(treeId)
      .then((s) => !cancelled && setSources(s))
      .catch(
        (err) =>
          !cancelled && onError(err instanceof Error ? err.message : "Failed to load sources")
      );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeId, adding]);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      let sourceId = pick;
      if (pick === "new") {
        if (!newTitle.trim()) return;
        const src = await api.createSource(treeId, { title: newTitle.trim() });
        sourceId = src.id;
      }
      const cit = await api.createCitation(treeId, personId, {
        source_id: sourceId,
        page: page.trim() || null,
      });
      setCitations((c) => [...c, cit]);
      setAdding(false);
      setNewTitle("");
      setPage("");
      setPick("new");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to add citation");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(cit: Citation) {
    try {
      await api.deleteCitation(treeId, cit.id);
      setCitations((c) => c.filter((x) => x.id !== cit.id));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to remove citation");
    }
  }

  if (!canEdit && citations.length === 0) return null;

  const inputClass =
    "w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand focus:outline-none dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100";

  return (
    <div className="mb-4 border-t border-gray-100 pt-3 dark:border-slate-700">
      <p className="mb-1 flex items-center justify-between text-xs font-medium text-gray-500 dark:text-slate-400">
        Sources
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            className="font-medium text-brand hover:underline dark:text-brand-soft"
          >
            + Add
          </button>
        )}
      </p>
      {citations.length === 0 && !adding && (
        <p className="text-xs italic text-gray-400 dark:text-slate-500">No sources cited.</p>
      )}
      <ul className="space-y-1 text-sm">
        {citations.map((cit) => (
          <li key={cit.id} className="flex items-start gap-1.5">
            <span className="min-w-0 flex-1 text-gray-700 dark:text-slate-200">
              {cit.source_title || "(untitled source)"}
              {cit.page && (
                <span className="text-gray-400 dark:text-slate-500"> · {cit.page}</span>
              )}
            </span>
            {canEdit && (
              <button
                onClick={() => handleRemove(cit)}
                className="shrink-0 px-1 text-gray-400 hover:text-red-600 dark:text-slate-500 dark:hover:text-red-400"
                title="Remove this citation"
              >
                ✕
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <form onSubmit={handleAdd} className="mt-2 space-y-1.5">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={inputClass}>
            <option value="new">New source…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title || "(untitled)"}
              </option>
            ))}
          </select>
          {pick === "new" && (
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Source title (e.g. 1900 Census)"
              required
              className={inputClass}
            />
          )}
          <input
            value={page}
            onChange={(e) => setPage(e.target.value)}
            placeholder="Page / reference (optional)"
            className={inputClass}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-brand px-2 py-1 text-xs font-medium text-white hover:bg-brand-light disabled:opacity-50"
            >
              {busy ? "Saving…" : "Add citation"}
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 dark:text-slate-400 dark:hover:bg-slate-700"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
