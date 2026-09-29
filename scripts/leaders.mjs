/**
 * A bill line's name wraps in its own width, and its leader starts where the name's last line ends
 * (#198, design mRg3y). A wrapped name is as wide as the line lets it be, so the part after the
 * last line is empty: pull what follows the name (the leader, or a deal tag) back over it, and
 * hold the name at the width it wrapped to, or the room it gives up would re-wrap it. Not in a
 * right-to-left window, whose last line ends on the left.
 *
 * A name breaks between words only. A word sticking out of its name (a line crowded with a deal tag
 * and three coins, a long compound word) marks the entry `is-crowded` instead, which sends the
 * leader and coins to a row of their own, as before #198, and gives the name the line; a word that
 * still sticks out of a row of its own marks the name `is-broken`, the one case it may break in.
 *
 * Measured in the ledger's own window (a popped-out sheet has its own), and in CSS pixels: a
 * window at a `position.scale` reports its boxes scaled.
 *
 * Plain DOM, no Foundry: tools/leaders.test.mjs drives it with stand-in boxes.
 */
export function hangLeaders(ledger) {
  const lines = [...ledger.querySelectorAll(".mp-entry > .mp-line-name")].map(name => ({ name, entry: name.parentElement,
    next: name.nextElementSibling, cost: name.parentElement.querySelector(":scope > .mp-cost") }));
  for (const { name, entry, next } of lines) {
    name.style.maxWidth = "";
    name.classList.remove("is-broken");
    entry.classList.remove("is-crowded");
    if (next) next.style.marginLeft = "";
  }
  // Layout sizes, whole CSS pixels either way: a pixel of rounding isn't a word sticking out.
  const sticksOut = name => name.scrollWidth > name.clientWidth + 1;
  const crowded = lines.filter(({ name, cost }) => cost && sticksOut(name));
  for (const { entry } of crowded) entry.classList.add("is-crowded");
  for (const { name } of crowded) if (sticksOut(name)) name.classList.add("is-broken");

  const doc = ledger.ownerDocument;
  const view = doc.defaultView;
  if (view.getComputedStyle(ledger).direction === "rtl") return;
  // Every line measured before any is changed: one layout, not one per line.
  const range = doc.createRange();
  const measured = lines.map(({ name, entry, next, cost }) => {
    if (!next || !cost || entry.classList.contains("is-crowded")) return null;
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
  // The held width rounds up: any less, and the name's widest line could wrap again.
  const hundredths = (n, round) => `${round(n * 100) / 100}px`;
  lines.forEach(({ name, next }, i) => {
    if (!measured[i] || measured[i].slack < 0.5) return;
    name.style.maxWidth = hundredths(measured[i].width, Math.ceil);
    next.style.marginLeft = hundredths(-measured[i].slack, Math.round);
  });
}
