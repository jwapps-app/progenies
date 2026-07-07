import * as d3 from "d3";

// Shared person-card rendering + theme palette, used by both the descendant and
// ancestor charts so they look identical and stay in sync.

// Narrower boxes: the name is stacked over two lines (given + nickname/initials
// on top, surname below), so the card doesn't need to be wide enough for a
// whole name on one line. Slightly taller to fit the extra line.
export const NODE_WIDTH = 116;
export const NODE_HEIGHT = 54;

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

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The two-line card name: given name + nickname + middle initial(s) on the top
 * line (e.g. 'Robert "Bob" J.'), surname on the bottom line ('Anderson'). When
 * there is no given name (e.g. an unknown placeholder), the surname — or
 * "Unknown" — takes the single top line instead. */
export function nameLines(p: CardPerson): { line1: string; line2: string } {
  const initials = p.middle_name
    ? p.middle_name
        .trim()
        .split(/\s+/)
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

/** Draw a person card (rounded box, sex-coloured border, name + lifespan) at the
 * origin of `g`. `tag` is an optional corner badge. */
export function drawCard(
  g: d3.Selection<SVGGElement, unknown, null, undefined>,
  person: CardPerson,
  P: Palette,
  tag?: string
) {
  const sexColor = person.sex === "M" ? P.borderM : person.sex === "F" ? P.borderF : P.borderU;

  g.append("rect")
    .attr("x", -NODE_WIDTH / 2)
    .attr("y", -NODE_HEIGHT / 2)
    .attr("width", NODE_WIDTH)
    .attr("height", NODE_HEIGHT)
    .attr("rx", 8)
    .attr("fill", person.is_unknown ? P.unknownBg : P.nodeBg)
    .attr("stroke", person.is_unknown ? P.unknownBorder : sexColor)
    .attr("stroke-width", 2)
    .attr("stroke-dasharray", person.is_unknown ? "4 3" : "none");

  if (tag) {
    const w = tag.length * 6 + 10;
    const bx = -NODE_WIDTH / 2 + 6;
    const by = -NODE_HEIGHT / 2 - 8;
    g.append("rect").attr("x", bx).attr("y", by).attr("width", w).attr("height", 16).attr("rx", 8).attr("fill", P.marriage);
    g.append("text")
      .attr("x", bx + w / 2)
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
    const cx = -NODE_WIDTH / 2 + 22;
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

  const textX = hasPhoto ? -NODE_WIDTH / 2 + 44 : 0;
  const anchor = hasPhoto ? "start" : "middle";
  const nameFill = person.is_unknown ? P.unknownText : P.nodeText;
  const nameMax = hasPhoto ? 11 : 15;
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
      .text(truncate(text, nameMax));

  if (line2) {
    // Two name lines (given over surname), with the lifespan below when present.
    const y1 = lifespan ? -13 : -5;
    name(line1, y1);
    name(line2, y1 + 15);
    if (lifespan) {
      g.append("text")
        .attr("text-anchor", anchor)
        .attr("x", textX)
        .attr("y", y1 + 29)
        .attr("font-size", 10)
        .attr("fill", P.muted)
        .text(truncate(lifespan, hasPhoto ? 12 : 18));
    }
  } else {
    // Single name line (no surname): keep it vertically centred.
    name(line1, lifespan ? -3 : 4);
    if (lifespan) {
      g.append("text")
        .attr("text-anchor", anchor)
        .attr("x", textX)
        .attr("y", 12)
        .attr("font-size", 10)
        .attr("fill", P.muted)
        .text(truncate(lifespan, hasPhoto ? 12 : 18));
    }
  }
}
