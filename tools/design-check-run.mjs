/**
 * The design conformance checker (#145), live half: renders a frame's export
 * (`design/export/<id>.html`) and the real shop window, in the fixture state `design/fixtures.mjs`
 * gives that frame, in one headless Chromium, and scores the window against the frame with
 * `tools/design-check.mjs`. Needs a running Foundry world with the module and the fixture world
 * built (`--setup`); never point it at a world you care about.
 *
 *   node tools/design-check-run.mjs --url http://localhost:30001 [--frames v8ap9,dpdpS] [--out dir]
 *
 * Prints each frame's score and its failing checks; writes `<out>/<frame>.json` and design/app
 * screenshots. Exit code 1 when any frame scores under 98%.
 */
/* global document, getComputedStyle, Node -- `collect` and the fonts wait run inside the pages */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { FRAMES } from "../design/fixtures.mjs";
import { pairNodes, scoreFrame } from "./design-check.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const URL = args.url ?? "http://localhost:30001";
const OUT = args.out ?? new globalThis.URL("../design/check/", import.meta.url).pathname;
const WANTED = args.frames ? args.frames.split(",") : Object.keys(FRAMES);
const BAR = 0.98;
mkdirSync(OUT, { recursive: true });

const executablePath = process.env.MP_CHROMIUM
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

/**
 * Runs in the page: every element under `root` carrying `attr`, in document order, as the scoring
 * core's Node. Boxes are from `root`'s top-left; styles are computed, so both sides compare alike.
 */
function collect({ rootSelector, attr, iconAttr }) {
  const root = document.querySelector(rootSelector);
  if (!root) return { error: `no ${rootSelector}` };
  const origin = root.getBoundingClientRect();
  const nodes = [root, ...root.querySelectorAll(`[${attr}]`)].filter(el => el.hasAttribute(attr));
  return nodes.map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const inline = el.getAttribute("style") ?? "";
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    return {
      name: el.getAttribute(attr),
      box: { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height },
      sets: [...inline.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(m => m[1]),
      style: {
        color: cs.color, "background-color": cs.backgroundColor, "border-radius": cs.borderTopLeftRadius,
        "border-color": outline ? cs.outlineColor : cs.borderTopColor,
        "font-family": cs.fontFamily, "font-size": cs.fontSize, "font-weight": cs.fontWeight
      },
      text: [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" "),
      icon: el.getAttribute(iconAttr) || null
    };
  });
}

const browser = await chromium.launch({ executablePath, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });
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
  const apage = await actx.newPage();
  await apage.goto(`${URL}/join`);
  await apage.fill("input[name=username]", frame.user);
  await apage.click("button[name=join]");
  await apage.waitForFunction(() => globalThis.game?.ready, null, { timeout: 90_000 });
  await apage.waitForTimeout(8000);
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
