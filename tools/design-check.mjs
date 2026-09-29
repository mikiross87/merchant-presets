/**
 * The design conformance checker's scoring (#145), free of the browser so it can be tested with
 * plain Node (tools/design-check.test.mjs).
 *
 * The approved design is `design/shop.pen`, exported per frame to `design/export/<id>.html` (Pencil's
 * html-css export: every node an element with `data-pencil-name` and its exact CSS). A rendered shop
 * window marks its own elements with `data-pen="<layer name>"`. `tools/design-check-run.mjs`
 * collects both sides in one headless Chromium as `Node`s; this pairs them by layer name in
 * document order, checks each design node only on what the design sets on it, and scores the frame
 * as checks passed over checks: ≥ 98% per frame and theme is the bar (#145).
 *
 * @typedef {{x: number, y: number, w: number, h: number}} Box  From the window's own top-left.
 * @typedef {{name: string, box: Box, sets: string[], style: Record<string, string>, text: string,
 *   icon: string|null, truncated?: boolean}} Node  `sets`: the CSS properties the design sets on the node (its inline
 *   style's keys); `style`: computed values; `text`: the node's own text; `icon`: a Lucide name;
 *   `truncated`: the window cuts its text off (app nodes only).
 */

/** Pixels a box edge may be off. */
export const BOX_TOLERANCE = 2;
/** ΔE2000 a colour may be off. */
export const COLOR_TOLERANCE = 2;

/* ------------------------------------------------------------------ colour */

/**
 * A CSS colour as a browser's computed style (or the export's inline style) writes it.
 *
 * @param {string} value  `rgb(…)`, `rgba(…)`, `#rgb`, `#rrggbb`, `#rrggbbaa` or `transparent`
 * @returns {{r: number, g: number, b: number, a: number}|null}
 */
export function parseColor(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  const at = i => parseInt(hex.slice(i, i + 2), 16);
  return { r: at(0), g: at(2), b: at(4), a: hex.length === 8 ? at(6) / 255 : 1 };
}

/** sRGB 0-255 to CIE L*a*b* (D65). */
function lab({ r, g, b }) {
  const lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / 1;
  const z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return { L: 116 * f(y) - 16, A: 500 * (f(x) - f(y)), B: 200 * (f(y) - f(z)) };
}

/**
 * CIEDE2000 colour difference between two colours (alpha ignored; see `colorsMatch`).
 * Sharma, Wu & Dalal (2005).
 */
export function deltaE2000(c1, c2) {
  const p = lab(c1), q = lab(c2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(p.A, p.B), C2 = Math.hypot(q.A, q.B);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * p.A, a2 = (1 + G) * q.A;
  const c1p = Math.hypot(a1, p.B), c2p = Math.hypot(a2, q.B);
  const h = (a, b) => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = h(a1, p.B), h2 = h(a2, q.B);
  const dL = q.L - p.L, dC = c2p - c1p;
  let dh = 0;
  if (c1p * c2p !== 0) dh = Math.abs(h2 - h1) <= 180 ? h2 - h1 : h2 - h1 > 180 ? h2 - h1 - 360 : h2 - h1 + 360;
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const Lm = (p.L + q.L) / 2, Cmp = (c1p + c2p) / 2;
  let hm = h1 + h2;
  if (c1p * c2p !== 0) hm = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2);
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad)
    + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cmp ** 7 / (Cmp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cmp, Sh = 1 + 0.015 * Cmp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** Two colours the eye can't tell apart: near-equal alpha, and within `COLOR_TOLERANCE` ΔE2000. */
function colorsMatch(expected, actual) {
  const e = parseColor(expected), a = parseColor(actual);
  if (!e || !a) return false;
  if (Math.abs(e.a - a.a) > 0.05) return false;
  if (e.a === 0) return true;
  return deltaE2000(e, a) < COLOR_TOLERANCE;
}

/* ------------------------------------------------------------------ pairing */

/**
 * Each design node with the app element of the same layer name at the same place among its
 * namesakes (document order), or null when the window has no such element.
 *
 * @param {Node[]} design
 * @param {Node[]} app
 * @returns {{design: Node, index: number, app: Node|null}[]}
 */
export function pairNodes(design, app) {
  const byName = new Map();
  for (const n of app) (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)).push(n);
  const seen = new Map();
  return design.map(d => {
    const index = seen.get(d.name) ?? 0;
    seen.set(d.name, index + 1);
    return { design: d, index, app: byName.get(d.name)?.[index] ?? null };
  });
}

/* ------------------------------------------------------------------ checks */

const BOX = ["x", "y", "w", "h"];

/**
 * What a design node is checked on: that it exists and where it sits, always; then only what the
 * design sets on it. Text and fonts only where it has text of its own.
 *
 * @param {Node} node
 * @returns {string[]}
 */
export function checksFor(node) {
  const sets = new Set(node.sets);
  const hasText = node.text.trim() !== "";
  const checks = ["exists", ...BOX];
  if (hasText) checks.push("text");
  if (node.icon) checks.push("icon");
  if (sets.has("color") && (hasText || node.icon)) checks.push("color");
  if (sets.has("background-color")) checks.push("background-color");
  if (sets.has("border-radius")) checks.push("border-radius");
  if (sets.has("outline") || sets.has("border") || sets.has("border-color")) checks.push("border-color");
  if (hasText) for (const p of ["font-family", "font-size", "font-weight"]) if (sets.has(p)) checks.push(p);
  return checks;
}

const squash = text => String(text ?? "").replace(/\s+/g, " ").trim();
const firstFamily = value => String(value ?? "").split(",")[0].replace(/["']/g, "").trim().toLowerCase();
const px = value => parseFloat(value);

/**
 * The design's text is the window's, or, where the window cuts its text off (an ellipsis, a
 * clamped paragraph), the design draws the cut: a start of it, then "…". Spaces aside, since
 * paragraphs that run on have none between them in the window's text.
 */
function textMatches(designText, app) {
  const drawn = squash(designText);
  if (drawn === squash(app.text)) return true;
  if (!app.truncated || !drawn.endsWith("…")) return false;
  const bare = text => text.replace(/\s+/g, "");
  return bare(app.text).startsWith(bare(drawn.slice(0, -1)));
}

/** Whether `app` passes `check` against `design`; returns [pass, expected, actual]. */
function run(check, design, app) {
  if (check === "exists") return [!!app, true, !!app];
  if (BOX.includes(check)) {
    const e = design.box[check], a = app.box[check];
    return [Math.abs(e - a) <= BOX_TOLERANCE, e, a];
  }
  if (check === "text") return [textMatches(design.text, app), squash(design.text), squash(app.text)];
  if (check === "icon") return [design.icon === app.icon, design.icon, app.icon];
  const e = design.style[check], a = app.style[check];
  if (check.endsWith("color")) return [colorsMatch(e, a), e, a];
  if (check === "border-radius") return [Math.abs(px(e) - px(a)) <= 1, e, a];
  if (check === "font-family") return [firstFamily(e) === firstFamily(a), firstFamily(e), firstFamily(a)];
  if (check === "font-size") return [Math.abs(px(e) - px(a)) <= 0.5, e, a];
  if (check === "font-weight") return [String(e) === String(a), e, a];
  return [false, e, a];
}

/**
 * The frame's score: every check of every design node, passed or not. A node the window lacks
 * fails all its checks.
 *
 * @param {{design: Node, index: number, app: Node|null}[]} pairs
 * @returns {{total: number, passed: number, score: number,
 *   failures: {node: string, index: number, check: string, expected: *, actual: *}[]}}
 */
export function scoreFrame(pairs) {
  let total = 0, passed = 0;
  const failures = [];
  for (const { design, index, app } of pairs) {
    for (const check of checksFor(design)) {
      total++;
      const [ok, expected, actual] = app ? run(check, design, app) : [false, check === "exists" ? true : null, null];
      if (ok) passed++;
      else failures.push({ node: design.name, index, check, expected, actual });
    }
  }
  return { total, passed, score: total ? passed / total : 1, failures };
}
