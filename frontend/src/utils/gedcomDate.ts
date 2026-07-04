// Conversions between a native <input type="date"> value (ISO "YYYY-MM-DD") and
// the GEDCOM 5.5 day-month-year form we store as free text (e.g. "12 MAR 1880").
//
// Only *exact* full dates convert. Anything the calendar can't express —
// approximate ("ABT 1850"), partial ("MAR 1880"), qualified ("BEF 1900"),
// or out-of-range (BC, 4-digit-plus biblical years) — stays free text and is
// handled by the estimate path instead.

const MONTHS = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

/** "1880-03-12" → "12 MAR 1880". Returns "" for anything that isn't a full ISO date. */
export function isoToGedcom(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return "";
  const month = MONTHS[parseInt(m[2], 10) - 1];
  if (!month) return "";
  return `${parseInt(m[3], 10)} ${month} ${m[1]}`;
}

/** "12 MAR 1880" → "1880-03-12", suitable for a date input's value. Returns ""
 * unless the text is an exact day-month-year date the calendar can represent. */
export function gedcomToIso(text: string): string {
  const m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{1,4})$/.exec(text.trim());
  if (!m) return "";
  const monthIdx = MONTHS.indexOf(m[2].slice(0, 3).toUpperCase());
  if (monthIdx < 0) return "";
  const day = parseInt(m[1], 10);
  if (day < 1 || day > 31) return "";
  const yyyy = m[3].padStart(4, "0");
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
