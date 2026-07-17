const SVG_NS = "http://www.w3.org/2000/svg";

// Browsers cap canvas area (iOS Safari most aggressively, ~16.7M pixels).
// Stay under that or toBlob silently yields null and the export "does nothing".
const MAX_PIXELS = 16_000_000;

/**
 * Export an SVG chart as a downloaded PNG. Measures the full content (not just
 * the visible viewport), drops the pan/zoom transform, paints a background, and
 * rasterises at up to 2× (scaled down for huge trees so the canvas stays under
 * the browser's pixel limit). Rejects with a message on failure instead of
 * failing silently.
 */
export function exportChartPng(svg: SVGSVGElement, filename: string, bg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // The first <g> is the pan/zoom group; its bbox is the whole tree's natural size.
    const zoomG = svg.querySelector("g") as SVGGElement | null;
    if (!zoomG) {
      reject(new Error("Nothing to export"));
      return;
    }
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
    // A Blob object URL, not a base64 data URL — the btoa route spread the whole
    // serialized SVG as call arguments, and engines cap spread length (~65k), so
    // large trees threw RangeError before the pixel guard even ran.
    const svgUrl = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml;charset=utf-8" }));

    // 2× for crispness, scaled down when the tree is so large that would blow
    // past the canvas pixel budget.
    const scale = Math.min(2, Math.sqrt(MAX_PIXELS / (w * h)));
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(svgUrl);
      reject(new Error("Could not render the chart image"));
    };
    img.onload = () => {
      URL.revokeObjectURL(svgUrl);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas unavailable"));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("The tree is too large to export as an image on this device"));
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        resolve();
      }, "image/png");
    };
    img.src = svgUrl;
  });
}
