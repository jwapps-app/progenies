import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { AncestorNode } from "../../types";
import {
  MAX_NODE_H,
  cardSize,
  drawCard,
  drawHighlightRing,
  readPalette,
  setupChartViewport,
} from "./chartCard";
import type { CardSize, Palette } from "./chartCard";

interface Props {
  root: AncestorNode;
  /** Called when a node is clicked, to re-root the view on that ancestor. */
  onSelect: (individualId: string) => void;
  /** Current theme ("light"/"dark") — only used to re-draw when it changes. */
  theme?: string;
  /** Person ids to highlight (e.g. a relationship path). */
  highlightIds?: Set<string>;
}

const ROW_HEIGHT = MAX_NODE_H + 64; // vertical distance between generations

const H_GAP = 30; // horizontal gap between adjacent ancestors

/**
 * Ancestor / pedigree chart: the focus person sits at the BOTTOM and ancestors
 * fan upward (father to the left, mother to the right of each person). Pan/zoom
 * enabled; click a person to re-root the chart on them. Uses d3.tree for layout
 * (each person's `children` are their parents).
 */
export default function AncestorChart({ root, onSelect, theme, highlightIds }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Preserve the user's pan/zoom across redraws of the SAME root (edits, theme
  // changes); only fit-to-view when the root changes.
  const savedTransform = useRef<d3.ZoomTransform | null>(null);
  const viewKey = useRef<string>("");
  // Per-person node group + card size, recorded by the main draw so the
  // highlight effect can swap rings without a re-layout. A person can appear
  // more than once (pedigree collapse duplicates shared ancestors), hence the
  // array values.
  const nodeByPerson = useRef(
    new Map<string, { el: d3.Selection<SVGGElement, unknown, null, undefined>; size: CardSize }[]>()
  );
  const paletteRef = useRef<Palette | null>(null);
  // Read through a ref so the main draw (which deliberately does NOT depend on
  // highlightIds) can re-apply the current rings after a rebuild.
  const highlightRef = useRef(highlightIds);
  highlightRef.current = highlightIds;

  const applyHighlights = () => {
    const svgEl = svgRef.current;
    const P = paletteRef.current;
    if (!svgEl || !P) return;
    d3.select(svgEl).selectAll("rect.highlight-ring").remove();
    const ids = highlightRef.current;
    if (!ids?.size) return;
    for (const id of ids)
      for (const e of nodeByPerson.current.get(id) ?? []) drawHighlightRing(e.el, e.size, P);
  };

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const P = readPalette(svgEl);
    paletteRef.current = P;
    nodeByPerson.current = new Map();

    const hierarchy = d3.hierarchy<AncestorNode>(root, (d) => d.children);
    // Cards autosize, so sibling spacing comes from a separation function over
    // the two ACTUAL widths (nodeSize x = 1 makes separation return pixels).
    const layout = d3
      .tree<AncestorNode>()
      .nodeSize([1, ROW_HEIGHT])
      .separation(
        (a, b) =>
          cardSize(a.data).w / 2 +
          cardSize(b.data).w / 2 +
          H_GAP +
          (a.parent === b.parent ? 0 : 14)
      );
    layout(hierarchy);
    const nodes = hierarchy.descendants();
    // Screen coordinates: x from d3; y grows UPWARD (ancestors above the focus).
    const sx = (d: d3.HierarchyNode<AncestorNode>) => d.x ?? 0;
    const sy = (d: d3.HierarchyNode<AncestorNode>) => -(d.y ?? 0);

    const gZoom = svg.append("g");
    const g = gZoom.append("g");

    // Links: each person up to its parents (an inverted fork).
    const linkLayer = g.append("g");
    for (const n of nodes) {
      const parents = n.children ?? [];
      if (!parents.length) continue;
      const nodeTop = sy(n) - cardSize(n.data).h / 2;
      // The fork bar sits midway between this row's tallest possible box top
      // and the parents' row; each riser then runs to ITS parent's real bottom.
      const midY = (sy(n) - MAX_NODE_H / 2 + sy(parents[0]) + MAX_NODE_H / 2) / 2;
      const xs = parents.map(sx);
      const left = Math.min(sx(n), ...xs);
      const right = Math.max(sx(n), ...xs);
      let d = `M${sx(n)},${nodeTop}L${sx(n)},${midY}M${left},${midY}L${right},${midY}`;
      for (const p of parents)
        d += `M${sx(p)},${midY}L${sx(p)},${sy(p) + cardSize(p.data).h / 2}`;
      linkLayer
        .append("path")
        .attr("d", d)
        .attr("fill", "none")
        .attr("stroke", P.link)
        .attr("stroke-width", 1.5);
    }

    // Nodes.
    const nodeLayer = g.append("g");
    for (const n of nodes) {
      const clickable = !n.data.is_unknown;
      const gBox = nodeLayer
        .append("g")
        .attr("transform", `translate(${sx(n)},${sy(n)})`)
        .style("cursor", clickable ? "pointer" : "default")
        .on("click", (event: MouseEvent) => {
          event.stopPropagation();
          if (clickable) onSelect(n.data.id);
        });
      drawCard(gBox, n.data, P);
      const entry = { el: gBox, size: cardSize(n.data) };
      const arr = nodeByPerson.current.get(n.data.id);
      if (arr) arr.push(entry);
      else nodeByPerson.current.set(n.data.id, [entry]);
    }
    // Ring the currently-highlighted people (the rebuild wiped any old rings).
    applyHighlights();

    // Fit to view (or restore the saved pan/zoom); re-fit when the available
    // space changes.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const cs = cardSize(n.data);
      minX = Math.min(minX, sx(n) - cs.w / 2);
      maxX = Math.max(maxX, sx(n) + cs.w / 2);
      minY = Math.min(minY, sy(n) - cs.h / 2);
      maxY = Math.max(maxY, sy(n) + cs.h / 2);
    }
    const vp = setupChartViewport({
      svgEl,
      zoomTarget: gZoom,
      bounds: { minX, maxX, minY, maxY },
      fitAnchor: "center",
      savedTransform,
      viewKey,
      key: root.id,
    });

    return vp.cleanup;
    // theme is a full-redraw dependency ON PURPOSE (a rare user action): colors
    // are written as literal attributes rather than CSS var references so the
    // PNG export path — which serializes the SVG standalone, where CSS
    // variables wouldn't resolve — stays correctly colored.
  }, [root, onSelect, theme]);

  // Relationship-path highlight changes only swap rings on the recorded node
  // groups — no re-layout, no O(n) DOM rebuild.
  useEffect(() => {
    applyHighlights();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlightIds]);

  return <svg ref={svgRef} className="h-full w-full" />;
}
