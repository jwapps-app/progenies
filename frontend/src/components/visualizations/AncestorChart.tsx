import { useEffect, useRef } from "react";
import * as d3 from "d3";
import type { AncestorNode } from "../../types";
import { NODE_HEIGHT, NODE_WIDTH, drawCard, readPalette } from "./chartCard";

interface Props {
  root: AncestorNode;
  /** Called when a node is clicked, to re-root the view on that ancestor. */
  onSelect: (individualId: string) => void;
  /** Current theme ("light"/"dark") — only used to re-draw when it changes. */
  theme?: string;
  /** Person ids to highlight (e.g. a relationship path). */
  highlightIds?: Set<string>;
}

const ROW_HEIGHT = NODE_HEIGHT + 70; // vertical distance between generations
const H_GAP = 30; // horizontal gap between adjacent ancestors

/**
 * Ancestor / pedigree chart: the focus person sits at the BOTTOM and ancestors
 * fan upward (father to the left, mother to the right of each person). Pan/zoom
 * enabled; click a person to re-root the chart on them. Uses d3.tree for layout
 * (each person's `children` are their parents).
 */
export default function AncestorChart({ root, onSelect, theme, highlightIds }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Preserve the user's pan/zoom across redraws of the SAME root (edits,
  // theme/highlight changes); only fit-to-view when the root changes.
  const savedTransform = useRef<d3.ZoomTransform | null>(null);
  const viewKey = useRef<string>("");

  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = d3.select(svgEl);
    svg.selectAll("*").remove();
    const P = readPalette(svgEl);

    const hierarchy = d3.hierarchy<AncestorNode>(root, (d) => d.children);
    const layout = d3.tree<AncestorNode>().nodeSize([NODE_WIDTH + H_GAP, ROW_HEIGHT]);
    layout(hierarchy);
    const nodes = hierarchy.descendants();
    // Screen coordinates: x from d3; y grows UPWARD (ancestors above the focus).
    const sx = (d: d3.HierarchyNode<AncestorNode>) => d.x ?? 0;
    const sy = (d: d3.HierarchyNode<AncestorNode>) => -(d.y ?? 0);

    const gZoom = svg.append("g");
    const g = gZoom.append("g");
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 2.5])
      .on("zoom", (event) => {
        gZoom.attr("transform", event.transform.toString());
        savedTransform.current = event.transform;
      });
    svg.call(zoom);

    // Links: each person up to its parents (an inverted fork).
    const linkLayer = g.append("g");
    for (const n of nodes) {
      const parents = n.children ?? [];
      if (!parents.length) continue;
      const nodeTop = sy(n) - NODE_HEIGHT / 2;
      const parentBottom = sy(parents[0]) + NODE_HEIGHT / 2;
      const midY = (nodeTop + parentBottom) / 2;
      const xs = parents.map(sx);
      const left = Math.min(sx(n), ...xs);
      const right = Math.max(sx(n), ...xs);
      let d = `M${sx(n)},${nodeTop}L${sx(n)},${midY}M${left},${midY}L${right},${midY}`;
      for (const p of parents) d += `M${sx(p)},${midY}L${sx(p)},${parentBottom}`;
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
      if (highlightIds?.has(n.data.id)) {
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
    }

    // Fit to view; re-fit when the available space changes.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      minX = Math.min(minX, sx(n) - NODE_WIDTH / 2);
      maxX = Math.max(maxX, sx(n) + NODE_WIDTH / 2);
      minY = Math.min(minY, sy(n) - NODE_HEIGHT / 2);
      maxY = Math.max(maxY, sy(n) + NODE_HEIGHT / 2);
    }
    const fitToView = () => {
      const bbox = svgEl.getBoundingClientRect();
      const vw = bbox.width || 800;
      const vh = bbox.height || 600;
      const margin = 60;
      const w = maxX - minX || 1;
      const h = maxY - minY || 1;
      const scale = Math.min(1.2, vw / (w + margin * 2), vh / (h + margin * 2));
      const tx = vw / 2 - ((minX + maxX) / 2) * scale;
      const ty = vh / 2 - ((minY + maxY) / 2) * scale;
      svg.call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    };
    // Same root as the previous draw → restore the user's pan/zoom instead of
    // yanking them back to the whole-chart fit.
    if (viewKey.current === root.id && savedTransform.current) {
      svg.call(zoom.transform, savedTransform.current);
    } else {
      viewKey.current = root.id;
      fitToView();
    }

    let fitRaf = 0;
    // ResizeObserver fires once immediately on observe() — skip that initial
    // callback or it would override the transform we just restored.
    let firstObserve = true;
    const resizeObserver = new ResizeObserver(() => {
      if (firstObserve) {
        firstObserve = false;
        return;
      }
      cancelAnimationFrame(fitRaf);
      fitRaf = requestAnimationFrame(fitToView);
    });
    resizeObserver.observe(svgEl);

    return () => {
      resizeObserver.disconnect();
      cancelAnimationFrame(fitRaf);
    };
  }, [root, onSelect, theme, highlightIds]);

  return <svg ref={svgRef} className="h-full w-full" />;
}
