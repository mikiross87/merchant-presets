/**
 * A bill line's name wraps in its own width, and its leader starts where the name's last line ends
 * (#198, design mRg3y). A wrapped name is as wide as the line lets it be, so the part after the
 * last line is empty: pull what follows the name (the leader, or a deal tag) back over it, and
 * hold the name at the width it wrapped to, or the room it gives up would re-wrap it. Not in a
 * right-to-left window, whose last line ends on the left.
 *
 * A line crowded enough to squeeze its name under 5em (ten of a good at a deal's price, three
 * coins) would cut the name into pieces of words: its entry is marked `is-crowded` instead, which
 * sends the leader and coins to a row of their own, as before #198, and gives the name the line.
 * The name can't take 5em as a CSS floor: a short name's box would outgrow its text.
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
    name.parentElement.classList.remove("is-crowded");
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
    // A flex item's computed width is its used width in CSS pixels, unrounded (offsetWidth rounds).
    const style = view.getComputedStyle(name);
    const width = parseFloat(style.width);
    if (width < 5 * parseFloat(style.fontSize)) return { crowded: true };
    range.selectNodeContents(name);
    const rects = [...range.getClientRects()];
    if (!rects.length) return null;
    // The last line's right end: a name mixing scripts can make it of several boxes.
    const last = rects.at(-1);
    const end = Math.max(...rects.filter(r => Math.abs(r.top - last.top) < 1).map(r => r.right));
    return { width, slack: (box.right - end) * (width / box.width) };
  });
  const px = n => `${Math.round(n * 100) / 100}px`;
  lines.forEach(({ name, next }, i) => {
    if (measured[i]?.crowded) return name.parentElement.classList.add("is-crowded");
    if (!measured[i] || measured[i].slack < 0.5) return;
    name.style.maxWidth = px(measured[i].width);
    next.style.marginLeft = px(-measured[i].slack);
  });
}
