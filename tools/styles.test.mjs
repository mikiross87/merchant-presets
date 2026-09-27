/**
 * styles/shop.css loads for every window in the world, not just the shop's: a bare `.tab` or
 * `.item-row` rule would re-lay-out dnd5e's own sheets. Every selector has to sit under the
 * shop window's own class, or under a trade receipt's (design z5RBkd): the `.mp-receipt` block,
 * or the chat message that holds one, never a chat message as such.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SCOPE = ".shop-sheet";
const RECEIPT = ".chat-message:has(> .message-content > .mp-receipt)";
/** A receipt selector: the receipt's own block, or the message holding one (maybe under a theme). */
const receiptScoped = s => /^\.mp-receipt[\s.:-]|^\.mp-receipt$/.test(s) || s.includes(RECEIPT);

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

/** A selector list's selectors: split at its own commas, not those inside `:is(…)` and the like. */
function split(list) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  return [...out, list.slice(start)].map(s => s.trim());
}

test("a selector list splits at its own commas only", () => {
  assert.deepEqual(split(".shop-sheet :is(.a, .b), .shop-sheet .c"), [".shop-sheet :is(.a, .b)", ".shop-sheet .c"]);
});

test("every shop stylesheet selector is scoped to the shop window", () => {
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8");
  const unscoped = selectors(css).flatMap(split)
    .filter(s => s !== SCOPE && !s.startsWith(`${SCOPE} `) && !s.startsWith(`${SCOPE}.`) && !s.startsWith(`${SCOPE}:`) && !receiptScoped(s));
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
