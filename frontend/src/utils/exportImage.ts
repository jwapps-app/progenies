const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Export an SVG chart as a downloaded PNG. Measures the full content (not just
 * the visible viewport), drops the pan/zoom transform, paints a background, and
 * rasterises at 2× for a crisp image.
 */
export function exportChartPng(svg: SVGSVGElement, filename: string, bg: string): void {
  // The first <g> is the pan/zoom group; its bbox is the whole tree's natural size.
  const zoomG = svg.querySelector("g") as SVGGElement | null;
  if (!zoomG) return;
  const bbox = zoomG.getBBox();
  const pad = 28;
  const x = bbox.x - pad;
  const y = bbox.y - pad;
  const w = Math.max(1, bbox.width + pad * 2);
  const h = Math.max(1, bbox.height + pad * 2);

  const clone = svg.cloneNode(true) as SVGSVGElement;
  const cloneG = clone.querySelector("g") as SVGGElement;
  // Keep only the content group; drop defs, the loupe overlay, etc.
  for (const child of [...clone.children]) {
    if (child !== cloneG) child.remove();
  }
  cloneG.removeAttribute("transform"); // export at natural scale, not the current zoom

  clone.setAttribute("viewBox", `${x} ${y} ${w} ${h}`);
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  clone.setAttribute("xmlns", SVG_NS);

  const bgRect = document.createElementNS(SVG_NS, "rect");
  bgRect.setAttribute("x", String(x));
  bgRect.setAttribute("y", String(y));
  bgRect.setAttribute("width", String(w));
  bgRect.setAttribute("height", String(h));
  bgRect.setAttribute("fill", bg);
  clone.insertBefore(bgRect, cloneG);

  const xml = new XMLSerializer().serializeToString(clone);
  const dataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;

  const scale = 2;
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  img.src = dataUrl;
}
