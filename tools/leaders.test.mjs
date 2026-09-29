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
    const name = {
      style: { maxWidth: "stale", ...line.style },
      line,
      offsetWidth: line.box[2] - line.box[0],
      nextElementSibling: tag ?? cost,
      parentElement: { querySelector: selector => (selector === ":scope > .mp-cost" ? cost : null) },
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
    defaultView: { getComputedStyle: () => ({ direction }) }
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
