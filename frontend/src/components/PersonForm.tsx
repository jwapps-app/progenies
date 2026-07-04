import { FormEvent, useState } from "react";
import type { Individual } from "../types";
import { fileToThumbnail } from "../utils/photo";
import { gedcomToIso, isoToGedcom } from "../utils/gedcomDate";

export interface PersonFields {
  given_name: string;
  middle_name: string;
  surname: string;
  married_name: string;
  nickname: string;
  sex: "M" | "F" | "U";
  birth_date: string;
  birth_place: string;
  death_date: string;
  death_place: string;
  age: string;
  notes: string;
  photo_url: string;
}

interface Props {
  initial?: Partial<Individual>;
  submitLabel: string;
  busy?: boolean;
  onSubmit: (fields: PersonFields) => void;
}

function toFields(initial?: Partial<Individual>): PersonFields {
  return {
    given_name: initial?.given_name ?? "",
    middle_name: initial?.middle_name ?? "",
    surname: initial?.surname ?? "",
    married_name: initial?.married_name ?? "",
    nickname: initial?.nickname ?? "",
    sex: (initial?.sex as "M" | "F" | "U") ?? "U",
    birth_date: initial?.birth_date ?? "",
    birth_place: initial?.birth_place ?? "",
    death_date: initial?.death_date ?? "",
    death_place: initial?.death_place ?? "",
    age: initial?.age ?? "",
    notes: initial?.notes ?? "",
    photo_url: initial?.photo_url ?? "",
  };
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:placeholder-slate-400";

/** A birth/death date field with two modes: a real calendar picker for exact,
 * known dates, and free text for estimates ("ABT 1850", "BEF 1900", a bare year,
 * or a biblical age). Exact dates are stored in GEDCOM day-month-year form so
 * they round-trip and display consistently with everything else. */
function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  // Start in "exact" mode for a new/empty field or a value the calendar can
  // represent; drop to "estimate" for anything free-text that it can't.
  const [mode, setMode] = useState<"exact" | "estimate">(
    value.trim() === "" || gedcomToIso(value) ? "exact" : "estimate"
  );
  const iso = gedcomToIso(value);

  const tab = (m: "exact" | "estimate", text: string) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
        mode === m
          ? "bg-brand text-white"
          : "bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-slate-600 dark:text-slate-300 dark:hover:bg-slate-500"
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="block">
      <div className="mb-1 flex h-6 items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600 dark:text-slate-300">{label}</span>
        <span className="flex gap-1">
          {tab("exact", "Exact")}
          {tab("estimate", "Estimate")}
        </span>
      </div>
      {mode === "exact" ? (
        <input
          type="date"
          value={iso}
          onChange={(e) => onChange(isoToGedcom(e.target.value))}
          className={inputClass}
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. ABT 1850, BEF 1900, or 930"
          className={inputClass}
        />
      )}
    </div>
  );
}

/** Form for creating or editing an individual. GEDCOM-style free-text dates are allowed. */
export default function PersonForm({ initial, submitLabel, busy, onSubmit }: Props) {
  const [fields, setFields] = useState<PersonFields>(() => toFields(initial));
  const [photoError, setPhotoError] = useState<string | null>(null);

  function update<K extends keyof PersonFields>(key: K, value: PersonFields[K]) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handlePhoto(file: File | undefined) {
    if (!file) return;
    setPhotoError(null);
    try {
      update("photo_url", await fileToThumbnail(file));
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Could not load that image");
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onSubmit(fields);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex items-center gap-3">
        {fields.photo_url ? (
          <img
            src={fields.photo_url}
            alt="Profile"
            className="h-16 w-16 rounded-full object-cover ring-2 ring-gray-200 dark:ring-slate-600"
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-100 text-2xl text-gray-400 dark:bg-slate-700 dark:text-slate-500">
            👤
          </div>
        )}
        <div className="flex flex-col gap-1">
          <label className="cursor-pointer text-sm font-medium text-brand hover:underline dark:text-brand-soft">
            {fields.photo_url ? "Change photo" : "Add photo"}
            <input
              type="file"
              accept="image/*"
              onChange={(e) => void handlePhoto(e.target.files?.[0])}
              className="hidden"
            />
          </label>
          {fields.photo_url && (
            <button
              type="button"
              onClick={() => update("photo_url", "")}
              className="text-left text-xs text-gray-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {photoError && <p className="text-xs text-red-600 dark:text-red-400">{photoError}</p>}

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Given name</span>
          <input
            value={fields.given_name}
            onChange={(e) => update("given_name", e.target.value)}
            className={inputClass}
            autoFocus
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Middle name(s)</span>
          <input
            value={fields.middle_name}
            onChange={(e) => update("middle_name", e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
            Surname <span className="text-gray-400">(birth / maiden)</span>
          </span>
          <input
            value={fields.surname}
            onChange={(e) => update("surname", e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
            Married name <span className="text-gray-400">(optional)</span>
          </span>
          <input
            value={fields.married_name}
            onChange={(e) => update("married_name", e.target.value)}
            placeholder="Name taken on marriage"
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
            Nickname <span className="text-gray-400">(optional)</span>
          </span>
          <input
            value={fields.nickname}
            onChange={(e) => update("nickname", e.target.value)}
            placeholder='e.g. Bob'
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Sex</span>
          <select
            value={fields.sex}
            onChange={(e) => update("sex", e.target.value as PersonFields["sex"])}
            className={inputClass}
          >
            <option value="U">Unknown</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <DateField
          label="Birth date"
          value={fields.birth_date}
          onChange={(v) => update("birth_date", v)}
        />
        <label className="block">
          <span className="mb-1 flex h-6 items-center text-xs font-medium text-gray-600 dark:text-slate-300">
            Birth place
          </span>
          <input
            value={fields.birth_place}
            onChange={(e) => update("birth_place", e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <DateField
          label="Death date"
          value={fields.death_date}
          onChange={(v) => update("death_date", v)}
        />
        <label className="block">
          <span className="mb-1 flex h-6 items-center text-xs font-medium text-gray-600 dark:text-slate-300">
            Death place
          </span>
          <input
            value={fields.death_place}
            onChange={(e) => update("death_place", e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">
          Age / lifespan <span className="text-gray-400 dark:text-slate-500">(if exact dates unknown)</span>
        </span>
        <input
          value={fields.age}
          onChange={(e) => update("age", e.target.value)}
          placeholder="e.g. 930 or ~72"
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Notes</span>
        <textarea
          value={fields.notes}
          onChange={(e) => update("notes", e.target.value)}
          rows={2}
          className={inputClass}
        />
      </label>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-lg bg-brand py-2.5 font-medium text-white transition hover:bg-brand-light disabled:opacity-50"
      >
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

/** Convert form fields into an API payload, turning blank strings into null. */
export function fieldsToPayload(fields: PersonFields): Partial<Individual> {
  const blankToNull = (s: string) => (s.trim() === "" ? null : s.trim());
  return {
    given_name: blankToNull(fields.given_name),
    middle_name: blankToNull(fields.middle_name),
    surname: blankToNull(fields.surname),
    married_name: blankToNull(fields.married_name),
    nickname: blankToNull(fields.nickname),
    sex: fields.sex,
    birth_date: blankToNull(fields.birth_date),
    birth_place: blankToNull(fields.birth_place),
    death_date: blankToNull(fields.death_date),
    death_place: blankToNull(fields.death_place),
    age: blankToNull(fields.age),
    notes: blankToNull(fields.notes),
    photo_url: blankToNull(fields.photo_url),
  };
}
