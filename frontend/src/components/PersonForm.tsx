import { FormEvent, useState } from "react";
import type { Individual } from "../types";
import { fileToThumbnail } from "../utils/photo";

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
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Birth date</span>
          <input
            value={fields.birth_date}
            onChange={(e) => update("birth_date", e.target.value)}
            placeholder="e.g. 12 MAR 1880 or ABT 1850"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Birth place</span>
          <input
            value={fields.birth_place}
            onChange={(e) => update("birth_place", e.target.value)}
            className={inputClass}
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Death date</span>
          <input
            value={fields.death_date}
            onChange={(e) => update("death_date", e.target.value)}
            placeholder="e.g. 1945 or BEF 1900"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-gray-600 dark:text-slate-300">Death place</span>
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
