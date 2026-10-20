/**
 * styles/shop.css loads for every window in the world, not just the shop's: a bare `.tab` or
 * `.item-row` rule would re-lay-out dnd5e's own sheets. Every selector has to sit under the
 * shop window's own class, or under a trade receipt's (design z5RBkd): the `.mp-receipt` block,
 * or the chat message that holds one, never a chat message as such.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

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

test("a receipt's message content doesn't clip its pictures' rings (#211)", () => {
  // Foundry's `.chat-message .message-content` is overflow: hidden. The receipt takes that box's
  // padding away, so its portrait and goods sit on the box's edge, and their 1px outline, drawn
  // outside them, was cut off on the left and top.
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const content = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, prelude]) => split(prelude).includes(`${RECEIPT} > .message-content`)).map(([, , body]) => body).join(";");
  assert.match(content, /(^|;)\s*overflow:\s*visible\s*(;|$)/);
});

test("every visually hidden input is positioned by its own label, not the window (#176)", () => {
  // `.mp-visually-hidden` is position: absolute. With no positioned ancestor inside the scrolling
  // form it takes the window as its containing block, so it doesn't scroll with the form: it sits
  // where it was laid out, below the window, and focusing it scrolls the whole window to it.
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const positioned = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /position:\s*relative/.test(body)).map(([, prelude]) => prelude);
  const dir = new URL("../templates/parts/", import.meta.url);
  const wrappers = readdirSync(dir).filter(f => f.endsWith(".hbs")).flatMap(f => {
    const hbs = readFileSync(new URL(f, dir), "utf8");
    return [...hbs.matchAll(/<input\b[^>]*class="[^"]*\bmp-visually-hidden\b/g)].map(m => {
      const label = [...hbs.slice(0, m.index).matchAll(/<label\b[^>]*class="([\w-]+)/g)].at(-1);
      return { file: f, label: label?.[1] ?? null };
    });
  });
  assert.ok(wrappers.length > 0);
  const loose = wrappers.filter(w => !w.label || !positioned.some(p => new RegExp(`\\.${w.label}(?![\\w-])`).test(p)));
  assert.deepEqual(loose, []);
});

test("the header's clamped description shows its whole text on hover (#231)", () => {
  // `.mp-description` is clamped to two lines (design IeGac), so a long one (the arcane store's
  // spellcasting note) ends in "…" with the rest unreadable. Its tooltip carries the whole text,
  // as the narrow window's info button does.
  const hbs = readFileSync(new URL("../templates/shop-sheet.hbs", import.meta.url), "utf8");
  const description = hbs.match(/<div\b[^>]*class="[^"]*\bmp-description\b[^"]*"[^>]*>/)?.[0];
  assert.ok(description);
  assert.match(description, /\bdata-tooltip="\{\{header\.descriptionText\}\}"/);
});

test("a good's name gives way to its New badge and price, on the shelf and in Players see (#234 live run)", () => {
  // A long magic name ("Adamantine Chain Mail") ran its New badge into the price in Players see:
  // the name line there had no cap, so it pushed past its column. Both rows cut the name short.
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => ({ sels: split(sel.trim()), body }));
  const ruled = (selector, declaration) => rules.some(r => r.sels.includes(selector) && declaration.test(r.body));
  for (const row of [".mp-row", ".mp-preview-text"]) {
    assert.ok(ruled(`.shop-sheet ${row} .mp-name-line`, /max-width:\s*100%/), `${row}: the name line stays in its column`);
    assert.ok(ruled(`.shop-sheet ${row} .mp-name-line > span:first-child`, /text-overflow:\s*ellipsis/), `${row}: the name is cut short`);
  }
});

test("the SEALED stamp lands at its resting angle, and holds still under reduced motion (#276)", () => {
  // The stamp rests at one angle and its animation ended at another, so it jumped the moment the
  // animation stopped; and the reduced-motion rule named classes no template uses, not the stamp.
  const css = readFileSync(new URL("../styles/shop.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const rest = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .find(([, sel]) => split(sel.trim()).includes(".shop-sheet .mp-stamp"))?.[2].match(/transform:\s*([^;]+)/)?.[1].trim();
  const landing = css.match(/@keyframes mp-stamp\s*\{[\s\S]*?\bto\s*\{([^}]*)\}/)?.[1].match(/transform:\s*([^;]+)/)?.[1].trim();
  assert.ok(rest);
  assert.equal(landing?.match(/rotate\([^)]*\)/)?.[0], rest.match(/rotate\([^)]*\)/)?.[0]);
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
  const still = [...reduced.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /animation:\s*none/.test(body)).flatMap(([, sel]) => split(sel.trim()));
  assert.ok(still.includes(".shop-sheet .mp-stamp"), "the stamp is in the reduced-motion rule");
});
