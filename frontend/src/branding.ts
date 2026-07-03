/**
 * Single source of truth for the app's brand identity.
 *
 * The product name is "Progenies". To rebrand, set `VITE_APP_NAME` (and the
 * backend `APP_NAME`) — nothing else in the UI hardcodes the name. The brand
 * *color* palette lives separately in tailwind.config.js under the neutral
 * `brand` token, so colors and name can change independently.
 */
export const APP_NAME: string = import.meta.env.VITE_APP_NAME?.trim() || "Progenies";

export const APP_TAGLINE = "Genealogy & Family Trees";

/** Full document title, e.g. "Progenies — Genealogy". */
export const APP_TITLE = `${APP_NAME} — Genealogy`;
