/**
 * A bill line's leader after its name's last line (#198, scripts/leaders.mjs), driven with stand-in
 * boxes: plain Node has no layout. Each line is drawn the way a browser reports it: the name's box,
 * its text's line boxes, where the leader and coins (.mp-cost) sit, and whether a word sticks out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hangLeaders } from "../scripts/leaders.mjs";

const classSet = initial => {
  const set = new Set(initial ?? []);
  return { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
};

/**
 * A ledger of `lines` in a window at `scale` (ApplicationV2's `position.scale`, a CSS transform:
 * boxes come back scaled, CSS pixels don't), laid out left to right unless `direction` says not.
 * A line: `{box: [left, top, right, bottom], rects: [[top, right], …], costTop, tag, word, row}` in
 * unscaled pixels: `rects` the name's text line boxes in order, `word` its longest word's width (it
 * sticks out of a narrower name unless the name may break words), `row` the width the name gets
 * once its leader and coins have gone below.
 */
function ledgerOf(lines, { scale = 1, direction = "ltr" } = {}) {
  const rect = ([left, top, right, bottom]) => ({ left: left * scale, top: top * scale, right: right * scale,
    bottom: bottom * scale, width: (right - left) * scale, height: (bottom - top) * scale });
  const names = lines.map(line => {
    const cost = { style: {}, getBoundingClientRect: () => rect([0, line.costTop, 0, line.costTop + 18]) };
    const tag = line.tag ? { style: {} } : null;
    const entry = { classList: classSet(line.entryClasses), querySelector: selector => (selector === ":scope > .mp-cost" ? cost : null) };
    const width = () => (entry.classList.contains("is-crowded") && line.row ? line.row : line.box[2] - line.box[0]);
    const name = {
      style: { maxWidth: "stale", ...line.style },
      classList: classSet(line.nameClasses),
      line,
      nextElementSibling: tag ?? cost,
      parentElement: entry,
      getBoundingClientRect: () => rect(line.box),
      // Layout sizes are CSS pixels, whole ones: a transform doesn't scale them.
      get clientWidth() { return Math.floor(width()); },
      get scrollWidth() { return this.classList.contains("is-broken") ? Math.floor(width()) : Math.ceil(Math.max(width(), line.word ?? 0)); }
    };
    // What getComputedStyle reports: the used width, in unscaled CSS pixels.
    Object.defineProperty(name, "cssWidth", { get: () => `${width()}px` });
    return name;
  });
  let selected = null;
  const doc = {
    createRange: () => ({
      selectNodeContents: name => { selected = name; },
      getClientRects: () => selected.line.rects.map(([top, right]) => rect([selected.line.box[0], top, right, top + 17]))
    }),
    defaultView: { getComputedStyle: el => ({ direction, width: el.cssWidth }) }
  };
  return { names, ledger: { ownerDocument: doc, querySelectorAll: () => names } };
}

// "Inn Stay, Comfortable (per day)" as the Inn draws it (mRg3y): a 117 px name on three lines,
// the last, "day)", ending 28 px in; its leader and coins beside it.
const WRAPPED = { box: [22, 0, 139, 51], rects: [[0, 77], [17, 130], [34, 50]], costTop: 33, word: 79 };
// "Calligrapher's Supplies" beside a deal tag and three coins: 80 px, its first word 90.
const CROWDED = { box: [28, 0, 108, 34], rects: [[0, 108], [17, 90]], costTop: 16, word: 90, row: 190 };

test("a wrapped name's leader starts where its last line ends, and the name keeps the width it wrapped to", () => {
  const { names, ledger } = ledgerOf([WRAPPED]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "117px");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
});

test("a deal tag after the name is what moves back, taking the leader with it", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, tag: true }]);
  hangLeaders(ledger);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
});

test("a name on one line, as wide as its text, is left as it is", () => {
  const { names, ledger } = ledgerOf([{ box: [22, 1, 92, 18], rects: [[1, 92]], costTop: 0, word: 70 }]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
});

test("a short name, narrow by its own width, isn't crowded (Crystal on the cover)", () => {
  const { names, ledger } = ledgerOf([{ box: [22, 1, 67, 18], rects: [[1, 67]], costTop: 0, word: 45 }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
});

test("a one-line name whose scripts sit at different heights isn't crowded either", () => {
  const { names, ledger } = ledgerOf([{ box: [22, 0, 62, 18], rects: [[0, 45], [2, 62]], costTop: 0, word: 28 }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
});

test("a name whose longest word doesn't fit beside its cost sends the leader and coins below", () => {
  const { names, ledger } = ledgerOf([CROWDED]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), true);
  assert.equal(names[0].classList.contains("is-broken"), false);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
});

test("a word too wide for a row of its own is the only one that breaks", () => {
  const { names, ledger } = ledgerOf([{ ...CROWDED, word: 260 }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), true);
  assert.equal(names[0].classList.contains("is-broken"), true);
});

test("a line with room again is no longer crowded, and its words whole again", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, entryClasses: ["is-crowded"], nameClasses: ["is-broken"] }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
  assert.equal(names[0].classList.contains("is-broken"), false);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
});

test("a crowded line, whose leader and coins went below the name, keeps them there", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, costTop: 51 }]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
});

test("a last line of several boxes (a name mixing scripts) ends at the rightmost", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, rects: [[0, 77], [17, 130], [34, 90], [34, 110], [34, 60]] }]);
  hangLeaders(ledger);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-29px");
});

test("a right-to-left window hangs no leader, whose last line ends on the left, but still sees a crowded line", () => {
  const plain = ledgerOf([WRAPPED], { direction: "rtl" });
  hangLeaders(plain.ledger);
  assert.equal(plain.names[0].style.maxWidth, "");
  const crowded = ledgerOf([CROWDED], { direction: "rtl" });
  hangLeaders(crowded.ledger);
  assert.equal(crowded.names[0].parentElement.classList.contains("is-crowded"), true);
});

test("a scaled window's boxes are turned back into the CSS pixels the styles take", () => {
  const { names, ledger } = ledgerOf([WRAPPED], { scale: 0.8 });
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "117px");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
});

test("a name's held width is rounded up, never below the width it wrapped at", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, box: [22, 0, 139.454, 51] }]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "117.46px");
});

test("style is read in the ledger's own window, which a popped-out sheet doesn't share", () => {
  const saved = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => { throw new Error("read in the main window"); };
  try {
    const { names, ledger } = ledgerOf([WRAPPED]);
    hangLeaders(ledger);
    assert.equal(names[0].style.maxWidth, "117px");
  } finally {
    if (saved) globalThis.getComputedStyle = saved;
    else delete globalThis.getComputedStyle;
  }
});
