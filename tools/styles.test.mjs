/**
 * styles/shop.css loads for every window in the world, not just the shop's: a bare `.tab` or
 * `.item-row` rule would re-lay-out dnd5e's own sheets. Every selector has to sit under the
 * shop window's own class.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCOPE = ".shop-sheet";

/** Every style rule's selector list in `css`, looking inside @media/@supports but not @keyframes. */
function selectors(css) {
  const out = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  const walk = () => {
    while (i < text.length) {
      const open = text.indexOf("{", i), close = text.indexOf("}", i);
      if (close !== -1 && (open === -1 || close < open)) { i = close + 1; return; }
      if (open === -1) { i = text.length; return; }
      const prelude = text.slice(i, open).trim();
      i = open + 1;
      if (prelude.startsWith("@keyframes")) { skip(); continue; }
      if (prelude.startsWith("@")) { walk(); continue; }
      out.push(prelude);
      skip();
    }
  };
  const skip = () => {
    for (let depth = 1; depth > 0 && i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
  };
  walk();
  return out;
}

test("every shop stylesheet selector is scoped to the shop window", () => {
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8");
  const unscoped = selectors(css).flatMap(list => list.split(",").map(s => s.trim()))
    .filter(s => s !== SCOPE && !s.startsWith(`${SCOPE} `) && !s.startsWith(`${SCOPE}.`) && !s.startsWith(`${SCOPE}:`));
  assert.deepEqual(unscoped, []);
});

test("the shop stylesheet never re-uses a dnd5e background that carries a relative image url (#104 live run)", () => {
  // dnd5e's --dnd5e-application-background (and the textures it points at) hold url("../../ui/…"),
  // which resolves against the stylesheet that *uses* the variable: from styles/shop.css that's
  // /modules/ui/denim075.png, a 404 for every player who opens the window. dnd5e paints it on
  // .dnd5e2.application itself, where it resolves.
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /var\(--dnd5e-(application-background|background-texture-[a-z-]+|journal-content-background)\)/);
});
