/**
 * A bill line's leader after its name's last line (#198, scripts/leaders.mjs), driven with stand-in
 * boxes: plain Node has no layout. Each line is drawn the way a browser reports it: the name's box,
 * its text's line boxes, and where the leader and coins (.mp-cost) sit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { hangLeaders } from "../scripts/leaders.mjs";

/**
 * A ledger of `lines` in a window at `scale` (ApplicationV2's `position.scale`, a CSS transform:
 * boxes come back scaled, CSS pixels don't), laid out left to right unless `direction` says not.
 * A line: `{box: [left, top, right, bottom], rects: [[top, right], …], costTop, tag}` in unscaled
 * pixels, `rects` the name's text line boxes in order.
 */
function ledgerOf(lines, { scale = 1, direction = "ltr" } = {}) {
  const rect = ([left, top, right, bottom]) => ({ left: left * scale, top: top * scale, right: right * scale,
    bottom: bottom * scale, width: (right - left) * scale, height: (bottom - top) * scale });
  const names = lines.map(line => {
    const cost = { style: {}, getBoundingClientRect: () => rect([0, line.costTop, 0, line.costTop + 18]) };
    const tag = line.tag ? { style: {} } : null;
    const classes = new Set(line.classes ?? []);
    const entry = {
      classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
      querySelector: selector => (selector === ":scope > .mp-cost" ? cost : null)
    };
    const name = {
      style: { maxWidth: "stale", ...line.style },
      line,
      // What getComputedStyle reports: the used width, in unscaled CSS pixels, and the font size.
      cssWidth: `${line.box[2] - line.box[0]}px`,
      fontSize: "15px",
      nextElementSibling: tag ?? cost,
      parentElement: entry,
      getBoundingClientRect: () => rect(line.box)
    };
    return name;
  });
  let selected = null;
  const doc = {
    createRange: () => ({
      selectNodeContents: name => { selected = name; },
      getClientRects: () => selected.line.rects.map(([top, right]) => rect([selected.line.box[0], top, right, top + 17]))
    }),
    defaultView: { getComputedStyle: el => ({ direction, width: el.cssWidth, fontSize: el.fontSize }) }
  };
  return { names, ledger: { ownerDocument: doc, querySelectorAll: () => names } };
}

// "Inn Stay, Comfortable (per day)" as the Inn draws it (mRg3y): a 141.6 px name on three lines,
// the last, "day)", ending 28 px in; its leader and coins beside it.
const WRAPPED = { box: [22, 0, 139, 51], rects: [[0, 77], [17, 130], [34, 50]], costTop: 33 };

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
  const { names, ledger } = ledgerOf([{ box: [22, 1, 92, 18], rects: [[1, 92]], costTop: 0 }]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
});

test("a crowded line, whose leader and coins went below the name, keeps them there", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, costTop: 51 }]);
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
});

test("a name squeezed under 5em by a crowded line (a deal tag, three coins) sends its leader and coins below", () => {
  // "10 × Potion of Greater Healing −10% — 19 gp 1 sp 7 cp": 40 px left for the name, in pieces of words.
  const { names, ledger } = ledgerOf([{ box: [28, 0, 68, 102], rects: [[0, 66], [17, 60], [34, 67], [51, 62], [68, 66], [85, 55]], costTop: 84 }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), true);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "");
});

test("a short name on one line is under 5em by its own width, not crowded (Crystal on the cover)", () => {
  const { names, ledger } = ledgerOf([{ box: [22, 1, 67, 18], rects: [[1, 67]], costTop: 0 }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
});

test("a line with room again is no longer crowded", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, classes: ["is-crowded"] }]);
  hangLeaders(ledger);
  assert.equal(names[0].parentElement.classList.contains("is-crowded"), false);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
});

test("a last line of several boxes (a name mixing scripts) ends at the rightmost", () => {
  const { names, ledger } = ledgerOf([{ ...WRAPPED, rects: [[0, 77], [17, 130], [34, 90], [34, 110], [34, 60]] }]);
  hangLeaders(ledger);
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-29px");
});

test("a right-to-left window, whose last line ends on the left, is left as it is", () => {
  const { names, ledger } = ledgerOf([WRAPPED], { direction: "rtl" });
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "");
});

test("a scaled window's boxes are turned back into the CSS pixels the styles take", () => {
  const { names, ledger } = ledgerOf([WRAPPED], { scale: 0.8 });
  hangLeaders(ledger);
  assert.equal(names[0].style.maxWidth, "117px");
  assert.equal(names[0].nextElementSibling.style.marginLeft, "-89px");
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
