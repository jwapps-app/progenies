import * as d3 from "d3";

// Shared person-card rendering + theme palette, used by both the descendant and
// ancestor charts so they look identical and stay in sync.

// Cards AUTOSIZE to their content (measured text + optional photo), clamped
// between MIN and MAX so a bare first name gets a small box and a novel-length
// name can't blow the layout apart. NODE_WIDTH/NODE_HEIGHT remain the typical
// card size, used only as layout spacing baselines (row step, gaps).
export const NODE_WIDTH = 116;
export const NODE_HEIGHT = 54;
export const MIN_NODE_WIDTH = 72;
export const MAX_NODE_WIDTH = 176;

const PAD_X = 9; // horizontal padding inside the card, each side
const PHOTO_SPACE = 40; // photo circle + gap, when a thumbnail is present
const NAME_FONT = "600 13px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const LIFE_FONT = "10px ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface CardSize {
  w: number;
  h: number;
}

// Canvas used purely for text measurement (never rendered).
let measureCtx: CanvasRenderingContext2D | null = null;

function textWidth(text: string, font: string): number {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7; // measurement unavailable — estimate
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Truncate `text` with an ellipsis so it MEASURES within maxW (the old
 * character-count truncation both overflowed wide names and needlessly cut
 * narrow ones). */
function fitText(text: string, font: string, maxW: number): string {
  if (textWidth(text, font) <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${text.slice(0, mid)}…`, font) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

// Sizes are stable for a given data object; the WeakMap makes repeated lookups
// (layout passes + draw) free and evaporates with the data on refetch.
const sizeCache = new WeakMap<CardPerson, CardSize>();

/** The card's rendered size for this person: measured text width (widest of
 * the name lines and the lifespan) plus padding and photo space, clamped to
 * [MIN_NODE_WIDTH, MAX_NODE_WIDTH]; height from how many lines the card shows. */
export function cardSize(p: CardPerson): CardSize {
  const cached = sizeCache.get(p);
  if (cached) return cached;
  const { line1, line2 } = nameLines(p);
  const lifespan = formatLifespan(p);
  const textW = Math.max(
    textWidth(line1, NAME_FONT),
    line2 ? textWidth(line2, NAME_FONT) : 0,
    lifespan ? textWidth(lifespan, LIFE_FONT) : 0
  );
  const photoW = p.photo_url ? PHOTO_SPACE : 0;
  // ceil + 1: never round the box BELOW the measured text width, or the text
  // that sized the box would then be "too wide" for it and get an ellipsis.
  const w = Math.ceil(
    Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, textW + PAD_X * 2 + photoW + 1))
  );
  const lines = 1 + (line2 ? 1 : 0) + (lifespan ? 1 : 0);
  let h = lines === 1 ? 34 : lines === 2 ? 48 : 60;
  if (p.photo_url) h = Math.max(h, 46); // the 17px-radius photo circle needs room
  const size = { w, h };
  sizeCache.set(p, size);
  return size;
}

/** The fields a card needs — both TreeNode (descendants) and AncestorNode satisfy it. */
export interface CardPerson {
  given_name: string | null;
  middle_name: string | null;
  surname: string | null;
  married_name?: string | null;
  nickname?: string | null;
  sex: string | null;
  birth_date: string | null;
  death_date: string | null;
  age: string | null;
  is_unknown: boolean;
  photo_url?: string | null;
}

// Monotonic id source for per-card photo clip paths (must be unique in the DOM).
let photoClipSeq = 0;

/** Chart colour palette, read from the --chart-* CSS variables so the SVG
 * follows the app's light/dark theme. */
export interface Palette {
  nodeBg: string;
  nodeText: string;
  muted: string;
  borderM: string;
  borderF: string;
  borderU: string;
  unknownBg: string;
  unknownBorder: string;
  unknownText: string;
  link: string;
  marriage: string;
  badgeText: string;
  lensBg: string;
}

export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    nodeBg: v("--chart-node-bg", "#ffffff"),
    nodeText: v("--chart-node-text", "#1f2937"),
    muted: v("--chart-node-muted", "#64748b"),
    borderM: v("--chart-border-m", "#2c5282"),
    borderF: v("--chart-border-f", "#9b2c6f"),
    borderU: v("--chart-border-u", "#64748b"),
    unknownBg: v("--chart-unknown-bg", "#f1f5f9"),
    unknownBorder: v("--chart-unknown-border", "#cbd5e1"),
    unknownText: v("--chart-unknown-text", "#94a3b8"),
    link: v("--chart-link", "#94a3b8"),
    marriage: v("--chart-marriage", "#c9a227"),
    badgeText: v("--chart-badge-text", "#ffffff"),
    lensBg: v("--chart-lens-bg", "#f8fafc"),
  };
}

/** The two-line card name: given name + nickname + middle initial(s) on the top
 * line (e.g. 'Robert "Bob" J.'), surname on the bottom line ('Anderson'). When
 * there is no given name (e.g. an unknown placeholder), the surname — or
 * "Unknown" — takes the single top line instead. */
export function nameLines(p: CardPerson): { line1: string; line2: string } {
  // filter(Boolean) guards a whitespace-only middle name — "".split(/\s+/)
  // yields [""], and [""][0][0] would throw inside the chart render effect.
  const initials = p.middle_name
    ? p.middle_name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((m) => `${m[0].toUpperCase()}.`)
        .join(" ")
    : "";
  const nick = p.nickname?.trim();
  const given = [p.given_name, nick ? `"${nick}"` : "", initials]
    .filter(Boolean)
    .join(" ")
    .trim();
  // Display the married surname when set, otherwise the birth surname.
  const surname = (p.married_name || p.surname || "").trim();
  if (!given) return { line1: surname || "Unknown", line2: "" };
  return { line1: given, line2: surname };
}

export function formatLifespan(p: CardPerson): string {
  if (p.birth_date || p.death_date) {
    return `${p.birth_date || "?"} – ${p.death_date || ""}`.trim();
  }
  return p.age ? `Age ${p.age}` : "";
}

/** Draw a person card (rounded box, sex-coloured border, name + lifespan) at
 * the origin of `g`, autosized via cardSize(). `tag` is an optional corner
 * badge. */
export function drawCard(
  g: d3.Selection<SVGGElement, unknown, null, undefined>,
  person: CardPerson,
  P: Palette,
  tag?: string
) {
  const sexColor = person.sex === "M" ? P.borderM : person.sex === "F" ? P.borderF : P.borderU;
  const { w, h } = cardSize(person);

  g.append("rect")
    .attr("x", -w / 2)
    .attr("y", -h / 2)
    .attr("width", w)
    .attr("height", h)
    .attr("rx", 8)
    .attr("fill", person.is_unknown ? P.unknownBg : P.nodeBg)
    .attr("stroke", person.is_unknown ? P.unknownBorder : sexColor)
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", person.is_unknown ? "4 3" : "none");

  if (tag) {
    const tw = tag.length * 6 + 10;
    const bx = -w / 2 + 6;
    const by = -h / 2 - 8;
    g.append("rect").attr("x", bx).attr("y", by).attr("width", tw).attr("height", 16).attr("rx", 8).attr("fill", P.marriage);
    g.append("text")
      .attr("x", bx + tw / 2)
      .attr("y", by + 11)
      .attr("text-anchor", "middle")
      .attr("font-size", 9)
      .attr("font-weight", 700)
      .attr("fill", P.badgeText)
      .text(tag);
  }

  // Optional profile thumbnail on the left; text shifts right to make room.
  const hasPhoto = !!person.photo_url;
  if (hasPhoto) {
    const r = 17;
    const cx = -w / 2 + 22;
    const clipId = `card-photo-${photoClipSeq++}`;
    g.append("clipPath").attr("id", clipId).append("circle").attr("cx", cx).attr("cy", 0).attr("r", r);
    g.append("image")
      .attr("href", person.photo_url!)
      .attr("x", cx - r)
      .attr("y", -r)
      .attr("width", r * 2)
      .attr("height", r * 2)
      .attr("preserveAspectRatio", "xMidYMid slice")
      .attr("clip-path", `url(#${clipId})`);
    g.append("circle")
      .attr("cx", cx)
      .attr("cy", 0)
      .attr("r", r)
      .attr("fill", "none")
      .attr("stroke", person.is_unknown ? P.unknownBorder : sexColor)
      .attr("stroke-width", 1.5);
  }

  // With a photo the text block starts beside the circle; otherwise centred.
  const textX = hasPhoto ? -w / 2 + PHOTO_SPACE : 0;
  const anchor = hasPhoto ? "start" : "middle";
  const nameFill = person.is_unknown ? P.unknownText : P.nodeText;
  // Available width for text — measured fit, not a character count.
  const maxTextW = w - PAD_X * 2 - (hasPhoto ? PHOTO_SPACE : 0);
  const { line1, line2 } = nameLines(person);
  const lifespan = formatLifespan(person);

  const name = (text: string, y: number) =>
    g
      .append("text")
      .attr("text-anchor", anchor)
      .attr("x", textX)
      .attr("y", y)
      .attr("font-size", 13)
      .attr("font-weight", 600)
      .attr("fill", nameFill)
      .text(fitText(text, NAME_FONT, maxTextW));

  const life = (y: number) =>
    g
      .append("text")
      .attr("text-anchor", anchor)
      .attr("x", textX)
      .attr("y", y)
      .attr("font-size", 10)
      .attr("fill", P.muted)
      .text(fitText(lifespan, LIFE_FONT, maxTextW));

  if (line2) {
    // Two name lines (given over surname), with the lifespan below when present.
    const y1 = lifespan ? -13 : -4;
    name(line1, y1);
    name(line2, y1 + 15);
    if (lifespan) life(y1 + 29);
  } else {
    // Single name line (no surname).
    name(line1, lifespan ? -3 : 4);
    if (lifespan) life(12);
  }
}
