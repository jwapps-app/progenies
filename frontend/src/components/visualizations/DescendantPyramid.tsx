import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { TreeNode } from "../../types";
import { NODE_HEIGHT, NODE_WIDTH, drawCard, readPalette } from "./chartCard";

export type MagnifyMode = "loupe" | "bulge" | "off";

interface Props {
  root: TreeNode;
  /** Called when a node is clicked, to re-root the view on that individual. */
  onSelect: (individualId: string) => void;
  /** Expand a married-in spouse's OTHER marriages (converging / step relations). */
  showConverging?: boolean;
  /** Hover magnification style while zoomed out. */
  magnify?: MagnifyMode;
  /** Add a child to a specific couple (called from the "+" on a spouse box). */
  onAddChild?: (parentId: string, coParentId: string) => void;
  /** Current theme ("light"/"dark") — only used to re-draw when it changes. */
  theme?: string;
  /** Person ids to highlight (e.g. a relationship path). */
  highlightIds?: Set<string>;
  /** Person ids that have parents recorded — shows an expand handle on their spouse box. */
  spousesWithParents?: Set<string>;
  /** Married-in spouse id → the pruned family tree (their topmost ancestor as
   * root, spouse as a leaf), grafted above the spouse when expanded. */
  expandedFamily?: Record<string, TreeNode>;
  /** Toggle a married-in spouse's family-of-origin expansion. */
  onToggleAncestry?: (spouseId: string) => void;
  /** "vertical" (top-down, default) or "horizontal" (left-to-right). */
  orientation?: "vertical" | "horizontal";
}


// Set per-render (in the effect) before layout() runs; read by placeConverging.
let RENDER_CONVERGING = false;
// Ids that appear as a bloodline descendant (root + all children, recursively).
// A spouse whose id is in this set will be pedigree-collapsed (shown once, via a
// cross-link), so layout keeps NON-collapsed spouses in the prime adjacent slots.
let BLOODLINE = new Set<string>();
// Orientation, set per-render before layout()/linkPath() run. When TRUE the tree is
// laid out top-down internally then mapped LEFT-TO-RIGHT at draw time (generation axis
// → screen x, sibling axis → screen y); boxes stay horizontal (text readable).
let HORIZONTAL = false;

function computeBloodline(root: TreeNode): Set<string> {
  const ids = new Set<string>();
  const walk = (n: TreeNode) => {
    if (ids.has(n.id)) return;
    ids.add(n.id);
    for (const u of n.unions ?? []) for (const c of u.children ?? []) walk(c);
  };
  walk(root);
  return ids;
}

const SPOUSE_GAP = 18; // gap between a person and an adjacent spouse box
const SIBLING_GAP = 26; // gap between adjacent sibling subtrees
const UNION_GAP = 50; // gap between the child-bands of different unions
const ROW_HEIGHT = NODE_HEIGHT + 96; // distance between generations (vertical layout)
// Generation spacing for horizontal layout: generations run along screen-x, where a
// box spans its full WIDTH, so the step must clear NODE_WIDTH (not NODE_HEIGHT).
const ROW_HEIGHT_H = NODE_WIDTH + 70;
const genStep = () => (HORIZONTAL ? ROW_HEIGHT_H : ROW_HEIGHT);
// Box extent along the SIBLING/across axis used by the layout's packing & spouse
// placement: a box's WIDTH normally, but its HEIGHT in the horizontal layout (where
// siblings stack vertically). Keeps couples/siblings tightly spaced after the swap.
const acrossExt = () => (HORIZONTAL ? NODE_HEIGHT : NODE_WIDTH);
// Box extent along the GENERATION axis (used by connector endpoints that sit at a
// box's leading/trailing edge toward the next generation): a box's HEIGHT normally,
// but its WIDTH horizontally (where generations run along screen-x).
const genExt = () => (HORIZONTAL ? NODE_WIDTH : NODE_HEIGHT);
const SIB_BAR_DROP = 26; // height of the sibling bar above the children

// Hover loupe (magnifying glass).
const CHART_CONTENT_ID = "progenies-chart-content";
const LOUPE_CLIP_ID = "progenies-loupe-clip";
const LOUPE_RADIUS = 110; // lens radius in screen px
const LOUPE_SCALE = 1; // content scale shown inside the lens (readable size)
const BULGE_RADIUS = 180; // fisheye radius in screen px
// The focal node should swell to roughly this ABSOLUTE on-screen scale regardless of
// how far the whole tree is zoomed out — so a 1000-person tree at 0.1× still reads.
// The peak magnification (≈ the fisheye's `distortion`) is derived from this per-move.
const BULGE_READABLE_SCALE = 1.0;
const BULGE_MIN_PEAK = 1.6; // never less than this when active
const BULGE_MAX_PEAK = 16; // cap for absurdly zoomed-out trees

/** Circular fisheye (d3-fisheye style): points within `radius` of the focus are
 * pushed outward (magnifying the centre), points beyond are untouched. Returns a
 * distortion fn mapping a content point to its bulged position, plus a node
 * scale for the focal magnification (capped at `maxScale`). */
function makeFisheye(fx: number, fy: number, radius: number, distortion: number, maxScale: number) {
  const e = Math.exp(distortion);
  const k0 = (e / (e - 1)) * radius;
  const k1 = distortion / radius;
  const map = (x: number, y: number): [number, number] => {
    const dx = x - fx;
    const dy = y - fy;
    const dd = Math.hypot(dx, dy);
    if (!dd || dd >= radius) return [x, y];
    const k = (k0 * (1 - Math.exp(-dd * k1))) / dd;
    return [fx + dx * k, fy + dy * k];
  };
  const scale = (x: number, y: number): number => {
    const dd = Math.hypot(x - fx, y - fy);
    if (dd >= radius) return 1;
    const k = dd ? (k0 * (1 - Math.exp(-dd * k1))) / dd : k0 * k1;
    return Math.min(k, maxScale);
  };
  return { map, scale };
}

type Distort = (x: number, y: number) => [number, number];
const IDENTITY: Distort = (x, y) => [x, y];

// ---------------------------------------------------------------------------
// Custom couple-aware layout.
//
// Each person is laid out with their marriage `unions`. A union's children are
// packed into a band and the children descend FROM that union's gold marriage
// line. For a single couple the gold line sits between the two parents at row
// level. For a person with multiple spouses, each spouse keeps her own children
// band (so nothing overlaps no matter how many spouses there are) and each
// marriage gets its own gold line routed ABOVE the boxes — the children then
// drop from that gold line, never crossing another spouse's box.
//
// layout() returns a self-contained Block in coordinates normalized to left
// edge 0; parents translate child blocks into place to avoid collisions.
// ---------------------------------------------------------------------------

interface PlacedBox {
  x: number;
  y: number;
  person: TreeNode;
  isSpouse: boolean;
  tag?: string; // small label above the box, e.g. "2nd wife"
  coupleWith?: string; // partner's person id (set on spouse boxes) — for "+ child"
}

type Link =
  // A sibling group descending from a marriage: drop from (sourceX,sourceY) on
  // the gold line to a sibling bar, then a vertical down to each child.
  | {
      kind: "family";
      sourceX: number;
      sourceY: number;
      childXs: number[];
      childIds?: string[]; // child person ids, in the same order as childXs
      childTopY: number;
      dotted?: boolean; // unknown-depth descendant link
      aId?: string; // the couple's person ids (set when this union has a spouse)
      bId?: string;
    }
  // Gold marriage line between two adjacent parents at row level. aId/bId are the
  // two partners' person ids (a = anchor/node, b = spouse). `unmarried` → dotted,
  // no marriage symbol.
  | {
      kind: "marriage";
      x1: number;
      x2: number;
      y: number;
      aId?: string;
      bId?: string;
      unmarried?: boolean;
      divorced?: boolean;
    }
  // Gold "comb" for a person with multiple spouses: a riser off the husband's
  // corner, a bar above the boxes, and a drop to each wife (down to her kids).
  // `wife` drops are marriage connections (get a ⚭ / dotted if unmarried); the
  // others are child drops.
  | {
      kind: "comb";
      husbandX: number;
      husbandTopY: number;
      barY: number;
      drops: { x: number; toY: number; wife?: boolean; unmarried?: boolean; divorced?: boolean }[];
    }
  // Marriage between two people who BOTH appear elsewhere in the tree (pedigree
  // collapse): both parents bus down to a shared rail below them, and any of the
  // couple's children drop FROM that rail (so the kids hang off the marriage, not
  // one parent). (ax,ay)/(bx,by) are the two parents' box centres.
  | {
      kind: "crosslink";
      ax: number;
      ay: number;
      bx: number;
      by: number;
      childXs: number[];
      childTopY: number;
      unmarried?: boolean;
      divorced?: boolean;
      // Parallel-routing lane: overlapping cross-link rails get distinct lanes so
      // they run parallel instead of tracing over one another.
      lane?: number;
    };

interface Block {
  width: number;
  centerX: number; // the bloodline person's box center, within the block
  boxes: PlacedBox[];
  links: Link[];
}

interface Band {
  boxes: PlacedBox[];
  links: Link[];
  width: number;
  centers: number[]; // child box centers, relative to the band's left edge (0)
}

function shiftLink(l: Link, dx: number): Link {
  if (l.kind === "family")
    return { ...l, sourceX: l.sourceX + dx, childXs: l.childXs.map((x) => x + dx) };
  if (l.kind === "marriage") return { ...l, x1: l.x1 + dx, x2: l.x2 + dx };
  if (l.kind === "crosslink")
    return { ...l, ax: l.ax + dx, bx: l.bx + dx, childXs: l.childXs.map((x) => x + dx) };
  return {
    ...l,
    husbandX: l.husbandX + dx,
    drops: l.drops.map((d) => ({ ...d, x: d.x + dx })),
  };
}

function shiftBlock(b: Block, dx: number): Block {
  return {
    width: b.width,
    centerX: b.centerX + dx,
    boxes: b.boxes.map((box) => ({ ...box, x: box.x + dx })),
    links: b.links.map((l) => shiftLink(l, dx)),
  };
}

function linkXs(l: Link): number[] {
  if (l.kind === "family") return [l.sourceX, ...l.childXs];
  if (l.kind === "marriage") return [l.x1, l.x2];
  if (l.kind === "crosslink") return [l.ax, l.bx, ...l.childXs];
  return [l.husbandX, ...l.drops.map((d) => d.x)];
}

function normalize(boxes: PlacedBox[], links: Link[], centerX: number): Block {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x - acrossExt() / 2);
    maxX = Math.max(maxX, box.x + acrossExt() / 2);
  }
  for (const l of links) {
    for (const x of linkXs(l)) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  if (!isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }
  return shiftBlock({ width: maxX - minX, centerX, boxes, links }, -minX);
}

/** Pack a union's children left-to-right into a band. */
function packChildren(children: TreeNode[], depth: number): Band {
  const boxes: PlacedBox[] = [];
  const links: Link[] = [];
  const centers: number[] = [];
  let cursor = 0;
  children.forEach((child, i) => {
    const cb = layout(child, depth + 1);
    const placed = shiftBlock(cb, cursor);
    boxes.push(...placed.boxes);
    links.push(...placed.links);
    centers.push(cursor + cb.centerX);
    cursor += cb.width;
    if (i < children.length - 1) cursor += SIBLING_GAP;
  });
  return { boxes, links, width: cursor, centers };
}

function layout(node: TreeNode, depth: number): Block {
  const row = genStep();
  const y = depth * row;
  const topY = y - genExt() / 2;
  const childTopY = (depth + 1) * row - genExt() / 2;
  const unions = node.unions ?? [];

  const boxes: PlacedBox[] = [];
  const links: Link[] = [];
  // A non-biological child (adopted/step/foster) gets a corner badge.
  const relTag =
    node.relation && node.relation !== "biological" ? node.relation : undefined;
  const addPerson = (x: number) =>
    boxes.push({ x, y, person: node, isSpouse: false, tag: relTag });
  const pushShifted = (src: { boxes: PlacedBox[]; links: Link[] }, dx: number) => {
    for (const b of src.boxes) boxes.push({ ...b, x: b.x + dx });
    for (const l of src.links) links.push(shiftLink(l, dx));
  };

  // Leaf person.
  if (unions.length === 0) {
    addPerson(acrossExt() / 2);
    return normalize(boxes, links, acrossExt() / 2);
  }

  // Each union's bloodline children (this person's children with that spouse).
  const data = unions.map((u) => ({
    spouse: u.spouse,
    ordinal: u.ordinal ?? 1,
    gap: u.gap ?? false,
    unmarried: u.unmarried ?? false,
    divorced: u.divorced ?? false,
    childIds: (u.children ?? []).map((c) => c.id),
    band: packChildren(u.children ?? [], depth),
  }));
  // A spouse who is also a bloodline descendant (e.g. a half-sibling who marries
  // in) is pedigree-collapsed: shown once elsewhere and joined by a cross-link, so
  // their spouse box here is dropped. Order those unions LAST so the visible
  // (non-collapsed) spouse keeps the prime slot beside this person instead of
  // being wedged between them and the collapsed relative's far-off box.
  const isCollapsed = (s: TreeNode | null | undefined) => !!s && BLOODLINE.has(s.id);
  if (data.some((d) => isCollapsed(d.spouse))) {
    data.sort((a, b) => (isCollapsed(a.spouse) ? 1 : 0) - (isCollapsed(b.spouse) ? 1 : 0));
  }
  const bandMid = (band: Band) =>
    band.centers.length ? (band.centers[0] + band.centers[band.centers.length - 1]) / 2 : band.width / 2;
  const sibY = childTopY - SIB_BAR_DROP;

  // Lay out a married-in spouse's OTHER marriages (converging) to the RIGHT of
  // `startX`: each shows the other spouse + that marriage's children, joined to
  // the spouse by a gold line. Reserving this space is what keeps the spouse's
  // two sets of children (with the bloodline partner vs. with the other partner)
  // from colliding. Returns the new right edge.
  const placeConverging = (spouse: TreeNode, spouseX: number, startEdge: number, dir = 1): number => {
    if (!RENDER_CONVERGING) return startEdge;
    const label = `m. ${spouse.given_name || "spouse"}`;
    let edge = startEdge;
    for (const u of spouse.unions ?? []) {
      if (!u.spouse) continue;
      const band = packChildren(u.children ?? [], depth);
      // Place the children band just OUTWARD of `edge` (right if dir>0, left if <0).
      const bandLeft = dir > 0 ? edge + UNION_GAP : edge - UNION_GAP - band.width;
      for (const b of band.boxes) boxes.push({ ...b, x: b.x + bandLeft });
      for (const l of band.links) links.push(shiftLink(l, bandLeft));
      const childXs = band.centers.map((c) => c + bandLeft);
      // Kids sit BETWEEN this spouse and the other husband (who sits just past
      // them) and drop from the point on THEIR gold marriage line above them.
      const bandCenter = childXs.length ? bandLeft + bandMid(band) : bandLeft + acrossExt() / 2;
      const husbandX =
        dir > 0
          ? bandLeft + band.width + UNION_GAP + acrossExt() / 2
          : bandLeft - UNION_GAP - acrossExt() / 2;
      boxes.push({ x: husbandX, y, person: u.spouse, isSpouse: true, tag: label, coupleWith: spouse.id });
      links.push({ kind: "marriage", x1: spouseX, x2: husbandX, y, aId: spouse.id, bId: u.spouse.id, unmarried: u.unmarried, divorced: u.divorced });
      if (childXs.length) {
        links.push({ kind: "family", sourceX: bandCenter, sourceY: y, childXs, childTopY, dotted: u.gap, aId: spouse.id, bId: u.spouse.id });
      }
      edge = dir > 0 ? husbandX + acrossExt() / 2 : husbandX - acrossExt() / 2;
    }
    return edge;
  };

  // Single union: parents straddle the band, gold line at row level between them,
  // children drop from its midpoint.
  if (data.length === 1) {
    const d = data[0];
    pushShifted(d.band, 0);
    const childXs = [...d.band.centers];
    const bc = bandMid(d.band);
    if (d.spouse) {
      const leftX = bc - (acrossExt() + SPOUSE_GAP) / 2;
      const rightX = bc + (acrossExt() + SPOUSE_GAP) / 2;
      // The man takes the smaller across-coordinate, which renders as the LEFT of
      // the couple (vertical layout) or the TOP of it (left-to-right layout). Sex
      // decides the side, not which partner is the bloodline anchor. When sex
      // doesn't settle it (same sex / unknown), keep the anchor on the left.
      const spouseLeads = d.spouse.sex === "M" && node.sex !== "M";
      const nodeX = spouseLeads ? rightX : leftX;
      const spouseX = spouseLeads ? leftX : rightX;
      addPerson(nodeX);
      boxes.push({ x: spouseX, y, person: d.spouse, isSpouse: true, coupleWith: node.id });
      links.push({ kind: "marriage", x1: leftX, x2: rightX, y, aId: node.id, bId: d.spouse.id, unmarried: d.unmarried, divorced: d.divorced });
      if (childXs.length) links.push({ kind: "family", sourceX: bc, sourceY: y, childXs, childIds: d.childIds, childTopY, dotted: d.gap, aId: node.id, bId: d.spouse.id });
      // The spouse's OTHER marriages fan out past whichever side the spouse is on.
      if (spouseLeads) placeConverging(d.spouse, spouseX, Math.min(0, spouseX - acrossExt() / 2), -1);
      else placeConverging(d.spouse, spouseX, Math.max(d.band.width, spouseX + acrossExt() / 2), 1);
      return normalize(boxes, links, nodeX);
    }
    addPerson(bc);
    if (childXs.length) links.push({ kind: "family", sourceX: bc, sourceY: topY, childXs, childTopY, dotted: d.gap });
    return normalize(boxes, links, bc);
  }

  // Multiple spouses: the husband is CENTERED. The 1st wife goes to the right
  // and the 2nd to the left, each joined by a row-level gold line with their
  // children dropping from its midpoint — exactly like a single couple. Any
  // further wives sit further out with a gold line routed above the boxes (these
  // lines may cross — unavoidable once a husband has 3+ wives).
  addPerson(0);
  let rightX = acrossExt() / 2;
  let leftX = -acrossExt() / 2;
  let rc = 0;
  let lc = 0;
  const aboveDrops: {
    x: number;
    toY: number;
    wife?: boolean;
    unmarried?: boolean;
    divorced?: boolean;
  }[] = [];
  data.forEach((d, i) => {
    const goRight = i % 2 === 0;
    const dir = goRight ? 1 : -1;
    const inner = goRight ? rc === 0 : lc === 0;
    const start = goRight ? rightX : leftX;
    // Lay the children band on this person's side. For the inner union (whose
    // spouse sits adjacent) centre the band under the couple's midpoint so a lone
    // child drops straight down, clamped so it never crosses to the other side.
    let bandLeft: number;
    if (inner && d.spouse && d.band.centers.length) {
      const coupleMid = goRight ? (acrossExt() + SPOUSE_GAP) / 2 : -(acrossExt() + SPOUSE_GAP) / 2;
      const centered = coupleMid - bandMid(d.band);
      bandLeft = goRight ? Math.max(centered, 0) : Math.min(centered, -d.band.width);
    } else {
      bandLeft = goRight ? start + SIBLING_GAP : start - SIBLING_GAP - d.band.width;
    }
    pushShifted(d.band, bandLeft);
    const childXs = d.band.centers.map((c) => c + bandLeft);
    const bc = childXs.length ? bandLeft + bandMid(d.band) : bandLeft + acrossExt() / 2;

    let wifeX: number;
    let outerEdge: number;
    if (inner && d.spouse) {
      // Wife sits ADJACENT to the husband with a short row-level gold line; the
      // children hang from the couple's midpoint and fan outward via the family
      // link's elbow. (Previously the wife was mirrored out past ALL the children
      // — wifeX = 2*bc — which left a very wide empty gap once a union had several
      // kids, and could overlap the husband for a childless union.)
      wifeX = goRight ? acrossExt() + SPOUSE_GAP : -(acrossExt() + SPOUSE_GAP);
      const coupleMid = wifeX / 2;
      boxes.push({ x: wifeX, y, person: d.spouse, isSpouse: true, tag: unionTag(d.ordinal, d.unmarried, d.divorced), coupleWith: node.id });
      links.push({ kind: "marriage", x1: 0, x2: wifeX, y, aId: node.id, bId: d.spouse.id, unmarried: d.unmarried, divorced: d.divorced });
      if (childXs.length) links.push({ kind: "family", sourceX: coupleMid, sourceY: y, childXs, childIds: d.childIds, childTopY, dotted: d.gap, aId: node.id, bId: d.spouse.id });
    } else if (d.spouse) {
      // Outer wife: gold marriage line routed ABOVE the boxes. She sits just past
      // her children on the outer side; both she and the children hang off the
      // same gold bar — the children dropping from a point between the husband and
      // her — so they read as the COUPLE's children, not attached to the wife
      // alone, and without a big empty gap.
      wifeX = childXs.length
        ? goRight
          ? bandLeft + d.band.width + SPOUSE_GAP + acrossExt() / 2
          : bandLeft - SPOUSE_GAP - acrossExt() / 2
        : bc;
      boxes.push({ x: wifeX, y, person: d.spouse, isSpouse: true, tag: unionTag(d.ordinal, d.unmarried, d.divorced), coupleWith: node.id });
      aboveDrops.push({ x: wifeX, toY: topY, wife: true, unmarried: d.unmarried, divorced: d.divorced });
      if (childXs.length) {
        aboveDrops.push({ x: bc, toY: sibY });
        links.push({ kind: "family", sourceX: bc, sourceY: sibY, childXs, childTopY, dotted: d.gap });
      }
    } else {
      // Single-parent union alongside others (e.g. known children PLUS a gap
      // descendant): fork the children straight down from the PARENT (centred at
      // x = 0) so they stay connected to it. The family link's sibling bar is
      // extended back to the source x, forming the elbow over to this band.
      wifeX = bc;
      if (childXs.length)
        links.push({
          kind: "family",
          sourceX: 0,
          sourceY: y + genExt() / 2,
          childXs,
          childTopY,
          dotted: d.gap,
        });
    }
    outerEdge = goRight
      ? Math.max(bandLeft + d.band.width, wifeX + acrossExt() / 2)
      : Math.min(bandLeft, wifeX - acrossExt() / 2);
    if (d.spouse) outerEdge = placeConverging(d.spouse, wifeX, outerEdge, dir);
    if (goRight) {
      rightX = outerEdge + UNION_GAP;
      rc++;
    } else {
      leftX = outerEdge - UNION_GAP;
      lc++;
    }
  });
  if (aboveDrops.length) {
    links.push({ kind: "comb", husbandX: 0, husbandTopY: topY, barY: topY - 18, drops: aboveDrops });
  }
  return normalize(boxes, links, 0);
}

/** "1st", "2nd", "3rd", "4th", … for marriage ordinals. */
function ordinalLabel(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/**
 * Tag for one of a person's unions, by order: "2nd ⚭" (a marriage), "2nd ⚮" (a
 * marriage that ended in divorce), or "2nd" (an unmarried partnership). Order-based,
 * so it reads the same for concurrent spouses and for a later marriage after a
 * divorce — the symbol matches the ring drawn on that couple's line.
 */
function unionTag(ordinal: number, unmarried?: boolean, divorced?: boolean): string {
  if (unmarried) return ordinalLabel(ordinal);
  return `${ordinalLabel(ordinal)} ${divorced ? "⚮" : "⚭"}`;
}

/**
 * Descendant pyramid: the root sits at the top and descendants fan downward.
 * Children descend from the gold marriage line between their parents; multiple
 * spouses and converging family lines are supported. Pan/zoom enabled; click a
 * person to re-root. Unknown spouses render dashed/grayed.
 */
export default function DescendantPyramid({
  root,
  onSelect,
  showConverging = false,
  magnify = "loupe",
  onAddChild,
  theme,
  highlightIds,
  spousesWithParents,
  expandedFamily,
  onToggleAncestry,
  orientation = "vertical",
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const P = readPalette(svgEl);

    HORIZONTAL = orientation === "horizontal";
    // Map a layout-space point to screen space (axis swap for horizontal).
    const sw = (x: number, y: number): [number, number] => (HORIZONTAL ? [y, x] : [x, y]);
    RENDER_CONVERGING = showConverging;
    BLOODLINE = computeBloodline(root);
    const block = layout(root, 0);

    // Pedigree collapse: a person can appear both as a descendant (a primary,
    // non-spouse box) AND as a married-in spouse box — e.g. two relatives who
    // marry. Show them ONCE (their descendant box) and connect the marriage with
    // a curved cross-link between the existing boxes, instead of a duplicate box.
    {
      const boxesByPerson = new Map<string, PlacedBox[]>();
      for (const b of block.boxes) {
        const arr = boxesByPerson.get(b.person.id) ?? [];
        arr.push(b);
        boxesByPerson.set(b.person.id, arr);
      }
      const primaryBox = (id: string): PlacedBox | undefined => {
        const arr = boxesByPerson.get(id);
        return arr?.find((b) => !b.isSpouse) ?? arr?.[0];
      };
      // A person is "duplicated" when they have a descendant box AND ≥1 other box.
      const duplicated = (id: string) => {
        const arr = boxesByPerson.get(id);
        return !!arr && arr.length > 1 && arr.some((b) => !b.isSpouse);
      };

      const suppressed = new Set<PlacedBox>();
      for (const [id, arr] of boxesByPerson) {
        if (duplicated(id)) for (const b of arr) if (b.isSpouse) suppressed.add(b);
      }

      if (suppressed.size > 0) {
        const samePair = (l: { aId?: string; bId?: string }, x: string, y: string) =>
          (l.aId === x && l.bId === y) || (l.aId === y && l.bId === x);
        // Family (children) links of a collapsed union — folded into its cross-link
        // so the children hang off the connecting rail, not under one parent.
        const foldedFamilies = new Set<Link>();
        const crosslinks: Link[] = [];
        for (const l of block.links) {
          if (l.kind === "marriage" && l.aId && l.bId && duplicated(l.bId)) {
            const a = primaryBox(l.aId);
            const b = primaryBox(l.bId);
            if (a && b) {
              const fam = block.links.find(
                (f) => f.kind === "family" && f.aId && samePair(f, l.aId!, l.bId!)
              ) as Extract<Link, { kind: "family" }> | undefined;
              if (fam) foldedFamilies.add(fam);
              const childXs = fam?.childXs ?? [];
              crosslinks.push({
                kind: "crosslink",
                ax: a.x,
                ay: a.y,
                bx: b.x,
                by: b.y,
                childXs,
                childTopY: fam?.childTopY ?? 0,
                unmarried: l.unmarried,
                divorced: l.divorced,
              });
            }
          }
        }
        // Lanes: cross-links whose horizontal route channels would overlap (similar
        // x-span and rows) get distinct lanes so their routes run in parallel channels
        // instead of tracing. With-children and childless rails live in DIFFERENT
        // channels (different railY formulas), so each kind gets its own lane numbering
        // — otherwise a childless rail can be bumped down onto a sibling bar.
        {
          type CL = Extract<Link, { kind: "crosslink" }>;
          const assign = (group: CL[]) => {
            const meta = group.map((c) => ({
              c,
              xlo: Math.min(c.ax, c.bx),
              xhi: Math.max(c.ax, c.bx),
              ylo: Math.min(c.ay, c.by),
              yhi: Math.max(c.ay, c.by),
              lane: 0,
            }));
            meta.sort((m, n) => m.xlo - n.xlo);
            for (let i = 0; i < meta.length; i++) {
              const used = new Set<number>();
              for (let j = 0; j < i; j++) {
                const A = meta[i];
                const B = meta[j];
                if (A.xlo < B.xhi - 4 && B.xlo < A.xhi - 4 && A.ylo <= B.yhi && B.ylo <= A.yhi)
                  used.add(B.lane);
              }
              let lane = 0;
              while (used.has(lane)) lane++;
              meta[i].lane = lane;
              meta[i].c.lane = lane;
            }
          };
          const cls = crosslinks as CL[];
          assign(cls.filter((c) => c.childXs.length > 0));
          assign(cls.filter((c) => c.childXs.length === 0));
        }
        if (crosslinks.length > 0) {
          block.links = block.links
            .filter((l) => !(l.kind === "marriage" && l.bId && duplicated(l.bId)))
            .filter((l) => !foldedFamilies.has(l))
            .concat(crosslinks);
          block.boxes = block.boxes.filter((b) => !suppressed.has(b));
        }
      }
    }
    // Outer group carries the pan/zoom transform; the inner content group is
    // left untransformed so the hover loupe can reference it via <use> and apply
    // its own magnification.
    const gZoom = svg.append("g");
    const g = gZoom.append("g").attr("id", CHART_CONTENT_ID);

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 2.5])
      .on("zoom", (event) => gZoom.attr("transform", event.transform.toString()));
    svg.call(zoom);

    const linkLayer = g.append("g");
    // Handles kept so the fisheye (bulge) can re-distort each element in place.
    // `childEl` is the blue family-coloured child-drop part of a crosslink/comb.
    const linkEls: {
      el: d3.Selection<SVGPathElement, unknown, null, undefined>;
      childEl?: d3.Selection<SVGPathElement, unknown, null, undefined>;
      link: Link;
    }[] = [];
    const ringEls: { el: d3.Selection<SVGGElement, unknown, null, undefined>; x: number; y: number }[] = [];
    // Marriage symbol above a couple's connection: interlocking rings ⚭ for a current
    // marriage, the divorce symbol ⚮ (rings parted by a slash) when it ended in divorce.
    const drawRing = (cx: number, cy: number, divorced = false) => {
      const [rx, ry] = sw(cx, cy);
      const rg = linkLayer.append("g").attr("transform", `translate(${rx},${ry})`);
      rg.append("text")
        .attr("text-anchor", "middle")
        .attr("dy", "0.35em")
        .attr("font-size", 13)
        .attr("fill", P.marriage)
        .text(divorced ? "⚮" : "⚭")
        .append("title")
        .text(divorced ? "Divorced" : "Married");
      ringEls.push({ el: rg, x: cx, y: cy });
    };
    for (const l of block.links) {
      const { d, width, childD } = linkPath(l, IDENTITY);
      const color = l.kind === "family" ? P.link : P.marriage;
      // Dotted for: gap (unknown-depth) descendant links, and UNMARRIED couples.
      const dotted =
        (l.kind === "family" && l.dotted) ||
        (l.kind === "marriage" && l.unmarried) ||
        (l.kind === "crosslink" && l.unmarried);
      const el = linkLayer
        .append("path")
        .attr("d", d)
        .attr("fill", "none")
        .attr("stroke", color)
        .attr("stroke-width", width)
        .attr("stroke-dasharray", dotted ? "2 5" : null);
      // Child-drops of a crosslink/comb render in the blue family colour.
      let childEl: d3.Selection<SVGPathElement, unknown, null, undefined> | undefined;
      if (childD) {
        childEl = linkLayer
          .append("path")
          .attr("d", childD)
          .attr("fill", "none")
          .attr("stroke", P.link)
          .attr("stroke-width", 1.5);
      }
      linkEls.push({ el, childEl, link: l });

      // Marriage ring above every MARRIED couple's connection (⚮ if divorced).
      if (l.kind === "marriage" && !l.unmarried) drawRing((l.x1 + l.x2) / 2, l.y - 13, l.divorced);
      if (l.kind === "crosslink" && !l.unmarried) {
        // ⚭ sits on the rail: above the children (with kids) or on the U-turn rail.
        const lane = l.lane ?? 0;
        if (l.childXs.length) {
          const cmid = (Math.min(...l.childXs) + Math.max(...l.childXs)) / 2;
          drawRing(cmid, l.childTopY - SIB_BAR_DROP - 24 - lane * 12 - 11, l.divorced);
        } else {
          // Childless U-turn: ⚭ centred on the rail but lifted clear of the line
          // (same as a normal marriage symbol), so the rail doesn't strike through it.
          // Must match the rail Y in linkPath (just below the HIGHER box).
          const railY = Math.min(l.ay, l.by) + genExt() / 2 + 18 + lane * 26;
          drawRing((l.ax + l.bx) / 2, railY - 13, l.divorced);
        }
      }
      if (l.kind === "comb")
        for (const dr of l.drops) if (dr.wife && !dr.unmarried) drawRing(dr.x, dr.toY - 8, dr.divorced);
    }

    const nodeLayer = g.append("g");
    // Main-tree boxes only (used by the fisheye); graft boxes go in graftNodeEls.
    const nodeEls: { el: d3.Selection<SVGGElement, unknown, null, undefined>; x: number; y: number }[] = [];
    const graftNodeEls: { x: number; y: number }[] = [];
    for (const box of block.boxes) {
      const clickable = !box.person.is_unknown;
      const [bx, by] = sw(box.x, box.y);
      const gBox = nodeLayer
        .append("g")
        .attr("transform", `translate(${bx},${by})`)
        .style("cursor", clickable ? "pointer" : "default")
        .on("click", (event: MouseEvent) => {
          event.stopPropagation();
          if (clickable) onSelect(box.person.id);
        });
      drawCard(gBox, box.person, P, box.tag);

      // Relationship-path highlight ring.
      if (highlightIds?.has(box.person.id)) {
        gBox
          .insert("rect", ":first-child")
          .attr("x", -NODE_WIDTH / 2 - 4)
          .attr("y", -NODE_HEIGHT / 2 - 4)
          .attr("width", NODE_WIDTH + 8)
          .attr("height", NODE_HEIGHT + 8)
          .attr("rx", 11)
          .attr("fill", "none")
          .attr("stroke", P.marriage)
          .attr("stroke-width", 3);
      }

      // "+ child" affordance on a couple (spouse box): adds a child straight to
      // this husband+wife pairing, no co-parent dropdown needed. Subtle until
      // hovered so it doesn't clutter.
      if (box.isSpouse && box.coupleWith && onAddChild) {
        const coParent = box.coupleWith;
        const plus = gBox
          .append("g")
          .attr("transform", `translate(0,${NODE_HEIGHT / 2 + 14})`)
          .style("cursor", "pointer")
          .style("opacity", 0.45)
          .on("mouseenter", function () {
            d3.select(this).style("opacity", 1);
          })
          .on("mouseleave", function () {
            d3.select(this).style("opacity", 0.45);
          })
          .on("click", (event: MouseEvent) => {
            event.stopPropagation();
            onAddChild(box.person.id, coParent);
          });
        plus.append("title").text("Add a child to this couple");
        plus
          .append("circle")
          .attr("r", 9)
          .attr("fill", P.nodeBg)
          .attr("stroke", P.marriage)
          .attr("stroke-width", 1.5);
        plus
          .append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.32em")
          .attr("font-size", 14)
          .attr("font-weight", 700)
          .attr("fill", P.marriage)
          .text("+");
      }

      // Expand-ancestry handle on a married-in spouse who has parents recorded.
      // Sits at the top-right corner: "+" to reveal their family above them, "−"
      // to collapse. Skipped when this person is already a bloodline descendant of
      // the chart root (their family is in the tree — e.g. someone who married a
      // relative), since grafting it would only duplicate the tree.
      const isExpanded = !!expandedFamily?.[box.person.id];
      if (
        box.isSpouse &&
        onToggleAncestry &&
        !BLOODLINE.has(box.person.id) &&
        (spousesWithParents?.has(box.person.id) || isExpanded)
      ) {
        const handle = gBox
          .append("g")
          .attr("transform", `translate(${NODE_WIDTH / 2 - 11},${-NODE_HEIGHT / 2 - 11})`)
          .style("cursor", "pointer")
          .style("opacity", isExpanded ? 1 : 0.55)
          .on("mouseenter", function () {
            d3.select(this).style("opacity", 1);
          })
          .on("mouseleave", function () {
            d3.select(this).style("opacity", isExpanded ? 1 : 0.55);
          })
          .on("click", (event: MouseEvent) => {
            event.stopPropagation();
            onToggleAncestry(box.person.id);
          });
        handle.append("title").text(isExpanded ? "Hide ancestry" : "Show ancestry");
        handle
          .append("circle")
          .attr("r", 8)
          .attr("fill", isExpanded ? P.marriage : P.nodeBg)
          .attr("stroke", P.marriage)
          .attr("stroke-width", 1.5);
        handle
          .append("text")
          .attr("text-anchor", "middle")
          .attr("dy", "0.32em")
          .attr("font-size", 13)
          .attr("font-weight", 700)
          .attr("fill", isExpanded ? P.badgeText : P.marriage)
          .text(isExpanded ? "−" : "+");
      }

      nodeEls.push({ el: gBox, x: box.x, y: box.y });
    }

    // Expanded spouse family-of-origin: lay out the pruned family tree (topmost
    // ancestor at the top, the spouse a leaf at the bottom) with the SAME couple
    // layout — so parents, grandparents AND siblings render normally — then graft
    // it above the spouse by aligning the spouse's box. Dashed, to read as a
    // grafted-in branch.
    const mainBloodline = BLOODLINE;
    const mainIds = new Set(block.boxes.map((b) => b.person.id));
    const placedGraft: { x: number; y: number }[] = []; // absolute centres of grafted boxes
    for (const box of block.boxes) {
      if (!box.isSpouse || mainBloodline.has(box.person.id)) continue;
      const fam = expandedFamily?.[box.person.id];
      if (!fam) continue;
      BLOODLINE = computeBloodline(fam);
      const gb = layout(fam, 0);
      const spouseInGraft =
        gb.boxes.find((b) => b.person.id === box.person.id && !b.isSpouse) ??
        gb.boxes.find((b) => b.person.id === box.person.id);
      if (!spouseInGraft) continue;
      const dx = box.x - spouseInGraft.x;
      const baseDy = box.y - spouseInGraft.y;
      // The boxes this graft actually draws (the spouse anchor and anyone already
      // in the main tree are skipped).
      const graftBoxes = gb.boxes.filter((b) => b !== spouseInGraft && !mainIds.has(b.person.id));
      // Lift the whole graft straight up, one row at a time, until none of its
      // boxes collide with a main-tree box (or an already-placed graft) — so a
      // married-in spouse's family can never land on top of unrelated people.
      const hits = (ax: number, ay: number, ox: number, oy: number) =>
        Math.abs(ax - ox) < NODE_WIDTH + SIBLING_GAP && Math.abs(ay - oy) < NODE_HEIGHT + 8;
      const collides = (dyTry: number) =>
        graftBoxes.some((gbx) => {
          const ax = gbx.x + dx;
          const ay = gbx.y + dyTry;
          return (
            block.boxes.some((o) => o.person.id !== box.person.id && hits(ax, ay, o.x, o.y)) ||
            placedGraft.some((o) => hits(ax, ay, o.x, o.y))
          );
        });
      let lift = 0;
      while (collides(baseDy - lift) && lift < 50 * genStep()) lift += genStep();
      const dy = baseDy - lift;
      const gGraft = g.append("g").attr("transform", `translate(${dx},${dy})`);
      const graftLinks = gGraft.append("g");
      const graftNodes = gGraft.append("g");
      for (const l of gb.links) {
        const { d, width, childD } = linkPath(l, IDENTITY);
        graftLinks
          .append("path")
          .attr("d", d)
          .attr("fill", "none")
          .attr("stroke", l.kind === "family" ? P.link : P.marriage)
          .attr("stroke-width", width)
          .attr("stroke-dasharray", "4 3");
        if (childD) {
          graftLinks
            .append("path")
            .attr("d", childD)
            .attr("fill", "none")
            .attr("stroke", P.link)
            .attr("stroke-width", 1.5)
            .attr("stroke-dasharray", "4 3");
        }
        if (l.kind === "marriage" && !l.unmarried) {
          graftLinks
            .append("text")
            .attr("x", (l.x1 + l.x2) / 2)
            .attr("y", l.y - 13)
            .attr("text-anchor", "middle")
            .attr("dy", "0.35em")
            .attr("font-size", 13)
            .attr("fill", P.marriage)
            .text("⚭");
        }
      }
      for (const b of graftBoxes) {
        const clickable = !b.person.is_unknown;
        const gA = graftNodes
          .append("g")
          .attr("transform", `translate(${b.x},${b.y})`)
          .style("cursor", clickable ? "pointer" : "default")
          .on("click", (event: MouseEvent) => {
            event.stopPropagation();
            if (clickable) onSelect(b.person.id);
          });
        drawCard(gA, b.person, P, b.tag);
        graftNodeEls.push({ x: b.x + dx, y: b.y + dy });
        placedGraft.push({ x: b.x + dx, y: b.y + dy });
      }
      // When lifted off the spouse, bridge the floating family down to the spouse
      // box with a dashed connector. It is drawn DIAGONALLY (entering the box top
      // off-centre, toward the family's side) so it can only ever cross the chart's
      // axis-aligned solid lines — never run collinear on top of one.
      if (lift > 0 && graftBoxes.length) {
        const graftCx = graftBoxes.reduce((s, b) => s + b.x + dx, 0) / graftBoxes.length;
        const endX = box.x + (graftCx >= box.x ? 1 : -1) * (NODE_WIDTH / 2 - 10);
        linkLayer
          .append("path")
          .attr(
            "d",
            `M${box.x},${box.y - lift - NODE_HEIGHT / 2}L${endX},${box.y - NODE_HEIGHT / 2}`
          )
          .attr("fill", "none")
          .attr("stroke", P.link)
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "4 3");
      }
    }
    BLOODLINE = computeBloodline(root);

    // Full extent of everything drawn, in SCREEN space (so the axis swap for the
    // horizontal layout is already applied). Boxes are always NODE_WIDTH×NODE_HEIGHT
    // on screen; pad for marriage rings / ordinal tags that sit just outside a box.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const accBounds = (lx: number, ly: number) => {
      const [sx, sy] = sw(lx, ly);
      minX = Math.min(minX, sx - NODE_WIDTH / 2 - 20);
      maxX = Math.max(maxX, sx + NODE_WIDTH / 2 + 20);
      minY = Math.min(minY, sy - NODE_HEIGHT - 20);
      maxY = Math.max(maxY, sy + NODE_HEIGHT + 20);
    };
    for (const box of block.boxes) accBounds(box.x, box.y);
    for (const n of [...nodeEls, ...graftNodeEls]) accBounds(n.x, n.y);
    if (!isFinite(minX)) {
      minX = 0;
      maxX = 0;
      minY = 0;
      maxY = 0;
    }

    // Fit the whole tree to the current viewport. Re-run whenever the available
    // space changes (e.g. the detail panel docks/undocks, or the window resizes)
    // so the tree always stays fully visible.
    const fitToView = () => {
      const bbox = svgEl.getBoundingClientRect();
      const vw = bbox.width || 800;
      const vh = bbox.height || 600;
      const margin = 60;
      const w = maxX - minX || 1;
      const h = maxY - minY || 1;
      const scale = Math.min(1.2, vw / (w + margin * 2), vh / (h + margin * 2));
      const tx = vw / 2 - ((minX + maxX) / 2) * scale;
      const ty = margin - minY * scale;
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    };
    fitToView();

    let fitRaf = 0;
    const resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(fitToView);
    });
    resizeObserver.observe(svgEl);

    // Always clear previous magnify handlers first: they're bound on the
    // PERSISTENT <svg> element (selectAll("*").remove() clears children, not
    // the svg's own listeners), so switching to "off" would otherwise leave a
    // stale bulge handler running O(n) work per mousemove against the detached
    // previous chart — a CPU and memory leak.
    svg.on(".mag", null);
    // The bulge's pending animation frame, cancelled on redraw/unmount.
    let magFrame = 0;

    // ----- Hover loupe (magnifying glass) ---------------------------------
    // A circular lens follows the cursor and shows the chart enlarged to a
    // readable size. It only appears while the tree is zoomed out (scale < the
    // lens scale) — when you've zoomed in enough to read normally, it stays off.
    if (magnify === "loupe") {
      const defs = svg.append("defs");
      const clip = defs.append("clipPath").attr("id", LOUPE_CLIP_ID);
      const clipCircle = clip.append("circle").attr("r", LOUPE_RADIUS);
      const loupe = svg.append("g").style("display", "none").style("pointer-events", "none");
      const lensInner = loupe.append("g").attr("clip-path", `url(#${LOUPE_CLIP_ID})`);
      lensInner.append("circle").attr("r", LOUPE_RADIUS).attr("fill", P.lensBg);
      const lensUse = lensInner.append("use").attr("href", `#${CHART_CONTENT_ID}`);
      const lensBorder = loupe
        .append("circle")
        .attr("r", LOUPE_RADIUS)
        .attr("fill", "none")
        .attr("stroke", P.link)
        .attr("stroke-width", 2);

      svg.on("mousemove.mag", (event: MouseEvent) => {
        const t = d3.zoomTransform(svgEl);
        if (t.k >= LOUPE_SCALE) {
          loupe.style("display", "none");
          return;
        }
        const [sx, sy] = d3.pointer(event, svgEl);
        const cx = (sx - t.x) / t.k; // content-space point under the cursor
        const cy = (sy - t.y) / t.k;
        lensUse.attr(
          "transform",
          `translate(${sx},${sy}) scale(${LOUPE_SCALE}) translate(${-cx},${-cy})`
        );
        clipCircle.attr("cx", sx).attr("cy", sy);
        lensInner.select("circle").attr("cx", sx).attr("cy", sy);
        lensBorder.attr("cx", sx).attr("cy", sy);
        loupe.style("display", null);
      });
      svg.on("mouseleave.mag", () => loupe.style("display", "none"));
    }

    // ----- Fisheye bulge --------------------------------------------------
    // The area under the cursor swells and the surrounding nodes squeeze outward,
    // distorting the layout in place. On each move it re-distorts every node, link
    // path and marriage ring; links anchor to box CENTRES while distorting (the
    // scaled boxes cover the join) so nothing detaches. Resets on mouse-leave.
    //
    // Coordinate spaces: the fisheye map and all stored node/ring/link points
    // are in LAYOUT space; the screen swaps axes in horizontal orientation.
    // linkPath swaps AFTER distorting, so node/ring transforms must do the
    // same (`sw`), and the focus point (from the pointer, i.e. screen space)
    // must be swapped INTO layout space — sw is its own inverse.
    if (magnify === "bulge") {
      // Skip the O(n) reset unless something is actually distorted — otherwise
      // every mousemove while zoomed-in rebuilds every path for no visible change.
      let distorted = false;
      const reset = () => {
        if (!distorted) return;
        distorted = false;
        for (const { el, childEl, link } of linkEls) {
          const lp = linkPath(link, IDENTITY);
          el.attr("d", lp.d);
          if (childEl && lp.childD) childEl.attr("d", lp.childD);
        }
        for (const n of nodeEls) {
          const [nx, ny] = sw(n.x, n.y);
          n.el.attr("transform", `translate(${nx},${ny})`);
        }
        for (const r of ringEls) {
          const [rx, ry] = sw(r.x, r.y);
          r.el.attr("transform", `translate(${rx},${ry})`);
        }
      };
      svg.on("mousemove.mag", (event: MouseEvent) => {
        const t = d3.zoomTransform(svgEl);
        if (t.k >= LOUPE_SCALE) {
          reset();
          return;
        }
        const [sx, sy] = d3.pointer(event, svgEl);
        const cx = (sx - t.x) / t.k; // focus in content (screen) coordinates
        const cy = (sy - t.y) / t.k;
        const [fx, fy] = sw(cx, cy); // → layout space (swap is self-inverse)
        const radius = BULGE_RADIUS / t.k;
        // Peak magnification needed to bring the focal node up to a readable absolute
        // size at the current zoom: readable / current zoom (e.g. 0.1× tree → ~10×).
        // The fisheye's peak scale ≈ its distortion, so drive both from this.
        const peak = Math.min(BULGE_MAX_PEAK, Math.max(BULGE_MIN_PEAK, BULGE_READABLE_SCALE / t.k));
        if (magFrame) cancelAnimationFrame(magFrame);
        magFrame = requestAnimationFrame(() => {
          distorted = true;
          const { map, scale } = makeFisheye(fx, fy, radius, peak, peak);
          for (const { el, childEl, link } of linkEls) {
            const lp = linkPath(link, map, true);
            el.attr("d", lp.d);
            if (childEl && lp.childD) childEl.attr("d", lp.childD);
          }
          for (const n of nodeEls) {
            const [dx, dy] = map(n.x, n.y);
            const [px, py] = sw(dx, dy);
            n.el.attr("transform", `translate(${px},${py}) scale(${scale(n.x, n.y)})`);
          }
          for (const r of ringEls) {
            const [dx, dy] = map(r.x, r.y);
            const [px, py] = sw(dx, dy);
            r.el.attr("transform", `translate(${px},${py}) scale(${scale(r.x, r.y)})`);
          }
        });
      });
      svg.on("mouseleave.mag", () => {
        if (magFrame) cancelAnimationFrame(magFrame);
        reset();
      });
    }

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(fitRaf);
      if (magFrame) cancelAnimationFrame(magFrame);
      svg.on(".mag", null);
    };
  }, [
    root,
    onSelect,
    showConverging,
    magnify,
    theme,
    highlightIds,
    spousesWithParents,
    expandedFamily,
    onToggleAncestry,
    orientation,
  ]);

  return <svg ref={svgRef} className="h-full w-full" />;
}

/** Build a link's full SVG path, distorting every point through `D` (identity by
 * default). One path per link so the fisheye can update it with a single attr.
 *
 * When `anchorToCenter` is set (fisheye mode), endpoints that touch a box are
 * drawn to the box's CENTRE rather than its edge; the scaled box (drawn on top)
 * then covers the overlap, so links never detach from magnified boxes. The base
 * (default) rendering is edge-anchored and visually identical — boxes hide the
 * extra under-box segment either way. */
function linkPath(
  l: Link,
  D: Distort,
  anchorToCenter = false
): { d: string; width: number; childD?: string } {
  const P = (x: number, y: number) => {
    const p = D(x, y);
    // Map layout space → screen: swap axes for the left-to-right (horizontal) layout.
    return HORIZONTAL ? `${p[1]},${p[0]}` : `${p[0]},${p[1]}`;
  };
  // Inset along the across axis (trims a marriage line to the spouse boxes' inner
  // edges): half the box's across-extent — WIDTH vertically, HEIGHT horizontally.
  const eh = anchorToCenter ? 0 : acrossExt() / 2;
  const ev = anchorToCenter ? genExt() / 2 : 0; // push a box-top endpoint to its centre
  if (l.kind === "family") {
    const sibY = l.childTopY - SIB_BAR_DROP;
    // Extend the sibling bar back to the source x so an off-centre source (a
    // parent forking to a child band beside it) stays connected via an elbow.
    const left = Math.min(l.sourceX, ...l.childXs);
    const right = Math.max(l.sourceX, ...l.childXs);
    let d = `M${P(l.sourceX, l.sourceY)}L${P(l.sourceX, sibY)}`;
    if (right > left) d += `M${P(left, sibY)}L${P(right, sibY)}`;
    for (const cx of l.childXs) d += `M${P(cx, sibY)}L${P(cx, l.childTopY + ev)}`;
    return { d, width: 1.5 };
  }
  if (l.kind === "marriage") {
    const a = Math.min(l.x1, l.x2) + eh;
    const b = Math.max(l.x1, l.x2) - eh;
    return { d: `M${P(a, l.y)}L${P(b, l.y)}`, width: 2 };
  }
  if (l.kind === "crosslink") {
    // A marriage between two people shown far apart (pedigree collapse — e.g. a niece
    // who married her uncle, or a far second wife). Drawn as ONE gold rail that
    // connects the two people: each parent drops a vertical to a shared horizontal
    // rail, and the children hang from it. It's a comb (rail + teeth), never a closed
    // loop. Overlapping cross-links get their own `lane` so rails don't stack.
    const lane = l.lane ?? 0;
    if (!l.childXs.length) {
      // No children: a clean U-turn joining the two boxes. The rail sits just below the
      // HIGHER box (`min` of the two ys) — for same-generation partners that's just
      // below their shared row; for different generations it keeps the rail in the
      // channel under the higher partner so its riser never dives through that partner's
      // own children. Each riser enters its box off-centre (never traces the box's
      // centred drop); same-source risers (a person with two far spouses) splay by lane.
      const railY = Math.min(l.ay, l.by) + genExt() / 2 + 18 + lane * 26;
      const aR = l.ax + (l.ax <= l.bx ? 12 : -12) + lane * 8;
      const bR = l.bx + (l.bx < l.ax ? 14 : -14);
      return {
        d: `M${P(aR, l.ay)}L${P(aR, railY)}L${P(bR, railY)}L${P(bR, l.by)}`,
        width: 2,
      };
    }
    const sibY = l.childTopY - SIB_BAR_DROP;
    const cl = Math.min(...l.childXs);
    const cr = Math.max(...l.childXs);
    const cmid = (cl + cr) / 2; // children cluster centre
    const railY = sibY - 24 - lane * 12; // the marriage rail, just above the sibling bar
    // The rail reaches from the children across to both parents; each parent connects
    // with a vertical riser entering off-centre (so it never traces that box's own
    // centred drop); the children hang from the rail. One connected gold comb.
    const aR = l.ax + (l.ax >= cmid ? -14 : 14);
    const bR = l.bx + (l.bx >= cmid ? -14 : 14);
    const left = Math.min(cmid, aR, bR);
    const right = Math.max(cmid, aR, bR);
    let d = `M${P(left, railY)}L${P(right, railY)}`;
    d += `M${P(aR, railY)}L${P(aR, l.ay)}`;
    d += `M${P(bR, railY)}L${P(bR, l.by)}`;
    // Blue: children drop from the rail (at the cluster centre), then fan to each.
    let childD = `M${P(cmid, railY)}L${P(cmid, sibY)}`;
    if (cr > cl) childD += `M${P(cl, sibY)}L${P(cr, sibY)}`;
    for (const cx of l.childXs) childD += `M${P(cx, sibY)}L${P(cx, l.childTopY + ev)}`;
    return { d, width: 2, childD };
  }
  // The husband riser is nudged off the box centre so it runs PARALLEL to (never
  // traces) the incoming parent→child line, which drops to the box-top centre.
  const riserX = l.husbandX + 12;
  const xs = [riserX, ...l.drops.map((dr) => dr.x)];
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  // Gold: husband riser + bar + the drops to WIVES (marriage). Blue (childD): the
  // drops to CHILDREN (family).
  let d = `M${P(riserX, l.husbandTopY + ev)}L${P(riserX, l.barY)}M${P(left, l.barY)}L${P(right, l.barY)}`;
  let childD = "";
  for (const dr of l.drops) {
    const seg = `M${P(dr.x, l.barY)}L${P(dr.x, dr.toY + (dr.wife ? ev : 0))}`;
    if (dr.wife) d += seg;
    else childD += seg;
  }
  return { d, width: 2, childD: childD || undefined };
}

