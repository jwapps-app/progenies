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

/** Best-effort year from a free-text GEDCOM date ("12 MAR 1880", "ABT 1900 BC",
 * "c. 1850", "1880-03-12"). Picks the last 3+ digit run — day numbers come
 * FIRST in GEDCOM day-month-year dates, so taking the first run would return
 * the day (e.g. 12 for "12 MAR 1880") — falling back to the last run for short
 * biblical years ("ABT 70"). BC/BCE years are negated so they sort and compare
 * correctly (2000 BC is EARLIER than 1500 BC). Returns null when no digits. */
export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const runs = date.match(/\d{1,5}/g);
  if (!runs) return null;
  const run = [...runs].reverse().find((r) => r.length >= 3) ?? runs[runs.length - 1];
  const year = parseInt(run, 10);
  return /\bB\.?\s*C\.?(\s*E\.?)?\b/i.test(date) ? -year : year;
}

// Accepted month words: the GEDCOM three-letter form or the full English name.
// An exact match is required — prefix matching would accept "12 JUNETEENTH 1880".
const LONG_MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

function monthIndex(word: string): number {
  const w = word.toUpperCase();
  const short = MONTHS.indexOf(w);
  return short >= 0 ? short : LONG_MONTHS.indexOf(w);
}

function daysInMonth(monthIdx: number, year: number): number {
  if (monthIdx === 1) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][monthIdx];
}

/** "12 MAR 1880" → "1880-03-12", suitable for a date input's value. Returns ""
 * unless the text is a REAL exact date the calendar can represent — impossible
 * days ("31 FEB 1900") are rejected rather than emitted as an invalid value the
 * date input would silently blank. */
export function gedcomToIso(text: string): string {
  const m = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{1,4})$/.exec(text.trim());
  if (!m) return "";
  const monthIdx = monthIndex(m[2]);
  if (monthIdx < 0) return "";
  const year = parseInt(m[3], 10);
  const day = parseInt(m[1], 10);
  if (day < 1 || day > daysInMonth(monthIdx, year)) return "";
  const yyyy = m[3].padStart(4, "0");
  const mm = String(monthIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
