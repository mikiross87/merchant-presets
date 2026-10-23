/**
 * Tests for the design checker's in-page half (`tools/design-collect.mjs`). `collect` reads a live
 * DOM, so this renders a page in the same headless Chromium the checker uses, and skips where
 * that browser isn't installed (CI).
 */
import { existsSync } from "node:fs";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { collect } from "./design-collect.mjs";

const executablePath = process.env.MP_CHROMIUM
  ?? `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const skip = !existsSync(executablePath) && "no Chromium for the design checker";

let browser;
before(async () => { if (!skip) browser = await chromium.launch({ executablePath }); });
after(() => browser?.close());

const texts = async html => {
  const page = await browser.newPage();
  await page.setContent(`<div id="root">${html}</div>`);
  const nodes = await page.evaluate(collect, { rootSelector: "#root", attr: "data-pen", iconAttr: "data-icon" });
  await page.close();
  return Object.fromEntries(nodes.slice(1).map(n => [n.name, n.text]));
};

test("a field shows its value, or its placeholder while empty", { skip }, async () => {
  assert.deepEqual(await texts(`
    <input data-pen="Input" value="Aria">
    <input data-pen="Empty input" placeholder="Name">
    <textarea data-pen="Textarea">Saved the smith's daughter</textarea>
    <textarea data-pen="Empty textarea" placeholder="Why the deal"></textarea>`), {
    "Input": "Aria",
    "Empty input": "Name",
    "Textarea": "Saved the smith's daughter",
    "Empty textarea": "Why the deal"
  });
});

test("a field's value is read as typed, not as first rendered", { skip }, async () => {
  const page = await browser.newPage();
  await page.setContent(`<div id="root"><textarea data-pen="Note"></textarea></div>`);
  await page.fill("textarea", "Saved the smith's daughter");
  const [, note] = await page.evaluate(collect, { rootSelector: "#root", attr: "data-pen", iconAttr: "data-icon" });
  await page.close();
  assert.equal(note.text, "Saved the smith's daughter");
});
