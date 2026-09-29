/**
 * A bill line's name wraps in its own width, and its leader starts where the name's last line ends
 * (#198, design mRg3y). A wrapped name is as wide as the line lets it be, so the part after the
 * last line is empty: pull what follows the name (the leader, or a deal tag) back over it, and
 * hold the name at the width it wrapped to, or the room it gives up would re-wrap it. Not when
 * the leader and coins went below the name (a crowded line: the room pulled back would bring them
 * up beside a narrower name, and the pull would overshoot it), nor in a right-to-left window,
 * whose last line ends on the left.
 *
 * Measured in the ledger's own window (a popped-out sheet has its own), and in CSS pixels: a
 * window at a `position.scale` reports its boxes scaled.
 *
 * Plain DOM, no Foundry: tools/leaders.test.mjs drives it with stand-in boxes.
 */
export function hangLeaders(ledger) {
  const lines = [...ledger.querySelectorAll(".mp-entry > .mp-line-name")]
    .map(name => ({ name, next: name.nextElementSibling, cost: name.parentElement.querySelector(":scope > .mp-cost") }));
  for (const { name, next } of lines) {
    name.style.maxWidth = "";
    if (next) next.style.marginLeft = "";
  }
  const doc = ledger.ownerDocument;
  const view = doc.defaultView;
  if (view.getComputedStyle(ledger).direction === "rtl") return;
  // Every line measured before any is changed: one layout, not one per line.
  const range = doc.createRange();
  const measured = lines.map(({ name, next, cost }) => {
    if (!next || !cost) return null;
    const box = name.getBoundingClientRect();
    if (!box.width || cost.getBoundingClientRect().top >= box.bottom) return null;
    range.selectNodeContents(name);
    const rects = [...range.getClientRects()];
    if (!rects.length) return null;
    // The last line's right end: a name mixing scripts can make it of several boxes.
    const last = rects.at(-1);
    const end = Math.max(...rects.filter(r => Math.abs(r.top - last.top) < 1).map(r => r.right));
    // A flex item's computed width is its used width in CSS pixels, unrounded (offsetWidth rounds).
    const width = parseFloat(view.getComputedStyle(name).width);
    return { width, slack: (box.right - end) * (width / box.width) };
  });
  const px = n => `${Math.round(n * 100) / 100}px`;
  lines.forEach(({ name, next }, i) => {
    if (!measured[i] || measured[i].slack < 0.5) return;
    name.style.maxWidth = px(measured[i].width);
    next.style.marginLeft = px(-measured[i].slack);
  });
}
