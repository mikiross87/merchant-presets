/**
 * The design conformance checker (#145), live half: renders a frame's export
 * (`design/export/<id>.html`) and the real shop window, in the fixture state `design/fixtures.mjs`
 * gives that frame, in one headless Chromium, and scores the window against the frame with
 * `tools/design-check.mjs`. Needs a running Foundry world with the module, and the fixture world:
 * `--setup` builds it first (design/fixtures.mjs `setup`). It rewrites that world's shop, clock and
 * calendar, so never point it at a world you care about.
 *
 *   node tools/design-check-run.mjs --url http://localhost:30001 [--setup] [--frames v8ap9,dpdpS] [--out dir]
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
 * (a hidden tab's) is left out, so it can't take a namesake's place. Boxes are from `root`'s
 * top-left; styles are computed, so both sides compare alike. Layer names are trimmed (the canvas
 * keeps a stray trailing space on some). An element's text is what it shows: its own text, a
 * field's value, or all of a rich-text block's (a description's paragraphs) when nothing inside it
 * is named; in capitals where CSS sets them.
 */
function collect({ rootSelector, attr, iconAttr }) {
  const textOf = (el, cs) => {
    let text = el.tagName === "INPUT" ? el.value
      : [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ");
    if (!text.trim() && el.children.length && !el.querySelector(`[${attr}]`) && !el.querySelector("svg")) text = el.textContent;
    return cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  };
  const root = document.querySelector(rootSelector);
  if (!root) return { error: `no ${rootSelector}` };
  const origin = root.getBoundingClientRect();
  const nodes = [root, ...[...root.querySelectorAll(`[${attr}]`)].filter(el => el.getClientRects().length > 0)];
  return nodes.map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inline = el.getAttribute("style") ?? "";
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    return {
      name: el === root ? "(frame)" : el.getAttribute(attr).trim(),
      box: { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height },
      sets: [...inline.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(m => m[1]),
      style: {
        color: cs.color, "background-color": cs.backgroundColor, "border-radius": cs.borderTopLeftRadius,
        "border-color": outline ? cs.outlineColor : cs.borderTopColor,
        "font-family": cs.fontFamily, "font-size": cs.fontSize, "font-weight": cs.fontWeight
      },
      text: textOf(el, cs),
      icon: el.getAttribute(iconAttr) || null
    };
  });
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
  if (!frame.open) { console.log(`SKIP ${id} ${frame.name}: no fixture yet`); results.push({ id, name: frame.name, score: null }); continue; }

  // The design, as exported.
  const dctx = await browser.newContext({ viewport: { width: frame.width + 40, height: frame.height + 40 } });
  const dpage = await dctx.newPage();
  await dpage.goto(new globalThis.URL(`../design/export/${id}.html`, import.meta.url).href);
  await dpage.evaluate(() => document.fonts.ready);
  const design = await dpage.evaluate(collect, { rootSelector: `[data-pencil-id="${id}"]`, attr: "data-pencil-name", iconAttr: "data-icon-name" });
  await dpage.locator(`[data-pencil-id="${id}"]`).screenshot({ path: `${OUT}${id}-design.png` });

  // The window, in the frame's fixture state.
  const actx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const apage = await login(actx, frame.user);
  const appId = await apage.evaluate(`(${frame.open})(${JSON.stringify({ theme: frame.theme, width: frame.width, height: frame.height })})`);
  await apage.waitForTimeout(1500);
  await apage.evaluate(() => document.fonts.ready);
  const app = await apage.evaluate(collect, { rootSelector: `#${appId}`, attr: "data-pen", iconAttr: "data-icon" });
  await apage.locator(`#${appId}`).screenshot({ path: `${OUT}${id}-app.png` });
  await dctx.close();
  await actx.close();

  if (design.error || app.error) { console.log(id, design.error ?? app.error); results.push({ id, score: 0 }); continue; }
  const result = scoreFrame(pairNodes(design, app));
  writeFileSync(`${OUT}${id}.json`, JSON.stringify({ id, name: frame.name, ...result }, null, 2));
  results.push({ id, name: frame.name, score: result.score, total: result.total, passed: result.passed });
  console.log(`${result.score >= BAR ? "PASS" : "FAIL"} ${id} ${frame.name}: ${(result.score * 100).toFixed(1)}% (${result.passed}/${result.total})`);
  for (const f of result.failures.slice(0, Number(args.show ?? 25))) {
    console.log(`   ${f.node}#${f.index} ${f.check}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
  }
}
await browser.close();
writeFileSync(`${OUT}summary.json`, JSON.stringify(results, null, 2));
process.exit(results.every(r => r.score === null || r.score >= BAR) ? 0 : 1);
