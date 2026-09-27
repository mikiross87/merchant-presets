/**
 * The design conformance checker (#145), live half: renders a frame's export
 * (`design/export/<id>.html`) and the real shop window, in the fixture state `design/fixtures.mjs`
 * gives that frame, in one headless Chromium, and scores the window against the frame with
 * `tools/design-check.mjs`. Needs a running Foundry world with the module, and the fixture world:
 * `--setup` builds it first (design/fixtures.mjs `setup`). It rewrites that world's shop, clock and
 * calendar, so never point it at a world you care about.
 *
 *   node tools/design-check-run.mjs --url http://localhost:30001 [--setup] [--frames v8ap9,dpdpS] [--out dir]
 *     [--show 60] [--dump "^(Hero|Tabs)$"]   (--dump prints both sides' boxes for the layers it matches)
 *
 * Prints each frame's score and its failing checks; writes `<out>/<frame>.json` and design/app
 * screenshots. Exit code 1 when any frame scores under 98%.
 */
/* global document, getComputedStyle, Node -- `collect` and the fonts wait run inside the pages */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { FRAMES, setup } from "../design/fixtures.mjs";
import { pairNodes, scoreFrame } from "./design-check.mjs";

// A flag followed by another flag (or nothing) is a switch: `--setup`.
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--")
  ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") === false ? all[i + 1] : true]] : acc), []));
const URL = args.url ?? "http://localhost:30001";
const OUT = args.out ?? new globalThis.URL("../design/check/", import.meta.url).pathname;
const WANTED = args.frames ? args.frames.split(",") : Object.keys(FRAMES);
const BAR = 0.98;
mkdirSync(OUT, { recursive: true });

const executablePath = process.env.MP_CHROMIUM
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

/**
 * Runs in the page: `root`, then every rendered element under it carrying `attr`, in document
 * order, as the scoring core's Node. The root is named "(frame)" on both sides, since the frame's
 * layer name ("03 Settings (GM) — Light") is no name a window could carry. An element with no box
 * (a hidden tab's), or one wholly outside an ancestor that clips it (a shelf row scrolled below
 * the fold, which the frame doesn't draw either), is left out, so it can't take a namesake's place. Boxes are from `root`'s
 * top-left; styles are computed, so both sides compare alike. Layer names are trimmed (the canvas
 * keeps a stray trailing space on some). An element's text is what it shows: its own text, a
 * field's value, or all of a rich-text block's (a description's paragraphs) when nothing inside it
 * is named; in capitals where CSS sets them.
 */
function collect({ rootSelector, attr, iconAttr }) {
  const textOf = (el, cs) => {
    // A field shows its value, or its placeholder while empty.
    let text = el.tagName === "INPUT" ? (el.value || el.placeholder)
      : [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ");
    if (!text.trim() && el.children.length && !el.querySelector(`[${attr}]`) && !el.querySelector("svg")) text = el.textContent;
    return cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  };
  const root = document.querySelector(rootSelector);
  if (!root) return { error: `no ${rootSelector}` };
  const origin = root.getBoundingClientRect();
  const clipped = el => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const c = a.getBoundingClientRect();
      if (r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right) return true;
    }
    return false;
  };
  const nodes = [root, ...[...root.querySelectorAll(`[${attr}]`)].filter(el => el.getClientRects().length > 0 && !clipped(el))];
  // An empty field shows its placeholder: measured as that text, its width and its colour.
  const placeholder = el => el.tagName === "INPUT" && !el.value && el.placeholder;
  const textWidth = (text, cs) => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(text).width;
  };
  return nodes.map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const shown = placeholder(el);
    const inline = el.getAttribute("style") ?? "";
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const sets = [...inline.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(m => m[1]);
    // An icon's colour: the export fills its outlined paths; the window strokes in currentColor.
    const icon = el.getAttribute(iconAttr) || null;
    const fill = icon && el.querySelector("path")?.getAttribute("fill");
    const color = icon && fill && fill !== "none" ? fill : shown ? getComputedStyle(el, "::placeholder").color : cs.color;
    if (icon) sets.push("color");
    return {
      name: el === root ? "(frame)" : el.getAttribute(attr).trim(),
      box: { x: r.left - origin.left, y: r.top - origin.top, w: shown ? textWidth(el.placeholder, cs) : r.width, h: r.height },
      sets,
      style: {
        color, "background-color": cs.backgroundColor, "border-radius": cs.borderTopLeftRadius,
        "border-color": outline ? cs.outlineColor : cs.borderTopColor,
        "font-family": cs.fontFamily, "font-size": cs.fontSize, "font-weight": cs.fontWeight
      },
      text: textOf(el, cs),
      icon
    };
  });
}

/**
 * Runs in the export's page: each text line as tall as Pencil draws it. The export writes
 * `line-height: normal`, which a browser leaves fractional (Roboto 10px: 11.72); Pencil rounds
 * every line to a whole pixel (12), and a column of text drifts a pixel a line without this. The
 * window states the same heights in its CSS.
 */
function pencilLineHeights() {
  const ratios = new Map();
  const ratio = cs => {
    const key = `${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}`;
    if (!ratios.has(key)) {
      const probe = document.createElement("div");
      probe.textContent = "Hg";
      probe.style.cssText = `font-family:${cs.fontFamily};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};font-size:100px;line-height:normal;position:absolute`;
      document.body.append(probe);
      ratios.set(key, probe.getBoundingClientRect().height / 100);
      probe.remove();
    }
    return ratios.get(key);
  };
  for (const el of document.querySelectorAll("[data-pencil-name]")) {
    const cs = getComputedStyle(el);
    if (cs.lineHeight === "normal") el.style.lineHeight = `${Math.round(parseFloat(cs.fontSize) * ratio(cs))}px`;
  }
}

/**
 * Runs in the export's page: strokes that take no room, as on the canvas. Pencil draws a stroke
 * inside the node over its padding (Button Secondary's label sits 16 px in, its padding), where
 * the export's border pushes the content in by its width (the notice's 3 px stripe left its text
 * 171 px of 175, and a line wrapped that Pencil keeps). Each side's padding gives up the border.
 */
function pencilStrokes() {
  for (const el of document.querySelectorAll("[data-pencil-id]")) {
    const cs = getComputedStyle(el);
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const border = parseFloat(cs[`border${side}Width`]);
      if (border) el.style[`padding${side}`] = `${Math.max(0, parseFloat(cs[`padding${side}`]) - border)}px`;
    }
  }
}

const browser = await chromium.launch({ executablePath, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
/** A page in `context`, joined to the world as `user` and settled. */
async function login(context, user) {
  const page = await context.newPage();
  await page.goto(`${URL}/join`);
  await page.fill("input[name=username]", user);
  await page.click("button[name=join]");
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 90_000 });
  // Core's banners (headless Chromium has no GPU, and says so) would sit over the window's shot.
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(8000);
  return page;
}

if (args.setup) {
  const sctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  let page = await login(sctx, "Gamemaster");
  let out = await page.evaluate(`(${setup})()`);
  if (out === "reload") {
    await page.close();
    page = await login(sctx, "Gamemaster");
    out = await page.evaluate(`(${setup})()`);
  }
  console.log(`setup: shop ${out}`);
  await sctx.close();
}

const results = [];
for (const id of WANTED) {
  const frame = FRAMES[id];
  if (!frame) { console.log(`unknown frame ${id}`); continue; }
  // A frame that is a board of several parts (the Buyer Picker's two menus) is measured part by
  // part: `export` names the frame's export, `part` the node in it the window is held to.
  const file = frame.export ?? id;
  const rootId = frame.part ?? id;
  const shot = id.replace(/[^\w-]/g, "-");
  if (!frame.open) { console.log(`SKIP ${id} ${frame.name}: no fixture yet`); results.push({ id, name: frame.name, score: null }); continue; }

  // The design, as exported.
  const dctx = await browser.newContext({ viewport: { width: frame.width + 40, height: frame.height + 40 } });
  // The export names its art relative to the canvas (design/assets/); it's written into design/export/.
  await dctx.route(/\/design\/export\/assets\//, route => route.fulfill({ path: new globalThis.URL(route.request().url().replace("/export/assets/", "/assets/")).pathname }));
  const dpage = await dctx.newPage();
  await dpage.goto(new globalThis.URL(`../design/export/${file}.html`, import.meta.url).href);
  // The export writes its stroked nodes as content-box, so a browser adds their padding and
  // border to the size Pencil gave them (Section Nav 200.5 wide, not the canvas's 179.5). The
  // canvas is the spec: its sizes hold padding and stroke, as border-box does. Pencil's layout
  // has no min-content floor either: a `flex: 1 1 0` body stays the frame's size and clips what
  // overflows, where a browser's `min-height: auto` grows it to its content (Storefront's Body
  // 532 px tall in a 680 px frame).
  await dpage.addStyleTag({ content: "[data-pencil-id] { box-sizing: border-box !important; min-height: 0 !important; }" });
  await dpage.evaluate(() => document.fonts.ready);
  await dpage.evaluate(pencilLineHeights);
  await dpage.evaluate(pencilStrokes);
  const design = await dpage.evaluate(collect, { rootSelector: `[data-pencil-id="${rootId}"]`, attr: "data-pencil-name", iconAttr: "data-icon-name" });
  await dpage.locator(`[data-pencil-id="${rootId}"]`).screenshot({ path: `${OUT}${shot}-design.png` });

  // The window, in the frame's fixture state.
  const actx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const apage = await login(actx, frame.user);
  const appId = await apage.evaluate(`(${frame.open})(${JSON.stringify({ theme: frame.theme, width: frame.width, height: frame.height })})`);
  await apage.waitForTimeout(1500);
  await apage.evaluate(() => document.fonts.ready);
  const app = await apage.evaluate(collect, { rootSelector: `#${appId}`, attr: "data-pen", iconAttr: "data-icon" });
  await apage.locator(`#${appId}`).screenshot({ path: `${OUT}${shot}-app.png` });
  await dctx.close();
  await actx.close();

  if (design.error || app.error) { console.log(id, design.error ?? app.error); results.push({ id, score: 0 }); continue; }
  const pairs = pairNodes(design, app);
  const result = scoreFrame(pairs);
  // `--dump <regex>`: both sides' boxes for the layers it names, to see where a drift starts.
  if (typeof args.dump === "string") {
    const box = b => (b ? `${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}x${b.h.toFixed(1)}` : "missing");
    for (const p of pairs.filter(p => new RegExp(args.dump).test(p.design.name))) {
      console.log(`   ${p.design.name}#${p.index} design ${box(p.design.box)} app ${box(p.app?.box)}`);
    }
  }
  writeFileSync(`${OUT}${shot}.json`, JSON.stringify({ id, name: frame.name, ...result }, null, 2));
  results.push({ id, name: frame.name, score: result.score, total: result.total, passed: result.passed });
  console.log(`${result.score >= BAR ? "PASS" : "FAIL"} ${id} ${frame.name}: ${(result.score * 100).toFixed(1)}% (${result.passed}/${result.total})`);
  for (const f of result.failures.slice(0, Number(args.show ?? 25))) {
    console.log(`   ${f.node}#${f.index} ${f.check}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
  }
}
await browser.close();
writeFileSync(`${OUT}summary.json`, JSON.stringify(results, null, 2));
process.exit(results.every(r => r.score === null || r.score >= BAR) ? 0 : 1);
