/**
 * The shop window's inline icons (#145): scripts/icons.mjs is generated from what the templates
 * name, so a template can't name an icon the module doesn't carry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ICONS, icon } from "../scripts/icons.mjs";
import { iconsUsed } from "./icons-used.mjs";

test("every icon a template or script names is in scripts/icons.mjs (run tools/build-icons.mjs)", () => {
  const missing = [...iconsUsed()].filter(n => !(n in ICONS));
  assert.deepEqual(missing, []);
});

test("scripts/icons.mjs carries no icon nothing uses", () => {
  const used = iconsUsed();
  assert.deepEqual(Object.keys(ICONS).filter(n => !used.has(n)), []);
});

test("an icon is an inline Lucide SVG in the text colour, named for the design checker", () => {
  const svg = icon("scale", { "data-pen": "Terms icon" });
  assert.match(svg, /^<svg class="mp-icon" data-icon="scale" data-pen="Terms icon" viewBox="0 0 24 24"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /<path d="M12 3v18"/);
  assert.throws(() => icon("no-such-icon"), /no icon "no-such-icon"/);
});

test("an attribute value can't close its quotes", () => {
  assert.match(icon("scale", { title: `a "b" <c> & d` }), /title="a &quot;b&quot; &lt;c&gt; &amp; d"/);
});
