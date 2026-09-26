/**
 * Deals (#111): one character's own price at one shop. The config shape (schema.mjs), which deal
 * is in force at a moment of the world clock (deals.mjs), and the Settings tab's deal edits
 * (shop-settings.mjs `applyChange`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shopFrom, validateShop } from "../scripts/schema.mjs";
import { activeDeal, endsAfterDays, nextCloseAt } from "../scripts/deals.mjs";
import { applyChange } from "../scripts/shop-settings.mjs";

const ARIA = "Actor.aria000000000000";
const TOMAS = "Actor.tomas000000000000";
const deal = (over = {}) => ({ actor: ARIA, name: "Aria", buy: -0.1, sell: null, note: "", ends: null, ...over });
const shop = (deals = []) => shopFrom({ version: 1, deals });

/* ------------------------------------------------------------------ schema */

test("a shop has no deals until the GM makes one", () => {
  assert.deepEqual(shopFrom({ version: 1 }).deals, []);
});

test("a deal names its character and changes buying, selling or both", () => {
  assert.equal(validateShop({ version: 1, deals: [deal()] }).ok, true);
  assert.equal(validateShop({ version: 1, deals: [deal({ buy: null, sell: 0.1 })] }).ok, true);
  assert.equal(validateShop({ version: 1, deals: [deal({ buy: -0.1, sell: 0.1, note: "Saved the smith's daughter" })] }).ok, true);
  assert.equal(validateShop({ version: 1, deals: [deal({ ends: { at: 86_400, when: "close" } })] }).ok, true);
  assert.equal(validateShop({ version: 1, deals: [deal({ ends: { at: 86_400.5, when: "date" } })] }).ok, true);
});

test("a deal that is malformed, free, or changes nothing is refused", () => {
  const bad = [
    deal({ actor: "" }),
    deal({ actor: 7 }),
    deal({ name: 3 }),
    deal({ buy: -1 }),              // a deal can't give the goods away
    deal({ buy: -1.5 }),
    deal({ sell: -1 }),
    deal({ buy: "−10%" }),
    deal({ buy: NaN }),
    deal({ buy: null, sell: null }),   // changes nothing
    deal({ buy: 0, sell: null }),
    deal({ buy: 0, sell: 0 }),
    deal({ note: null }),
    deal({ ends: { at: "soon", when: "date" } }),
    deal({ ends: { at: 5, when: "tuesday" } }),
    deal({ ends: { at: 5 } }),
    { ...deal(), extra: true }
  ];
  for (const d of bad) assert.equal(validateShop({ version: 1, deals: [d] }).ok, false, JSON.stringify(d));
  const { actor, ...noActor } = deal();
  assert.equal(validateShop({ version: 1, deals: [noActor] }).ok, false, `no actor (was ${actor})`);
});

test("one deal per character at a shop", () => {
  assert.equal(validateShop({ version: 1, deals: [deal(), deal({ buy: -0.2 })] }).ok, false);
  assert.equal(validateShop({ version: 1, deals: [deal(), deal({ actor: TOMAS, name: "Tomas" })] }).ok, true);
});

/* ------------------------------------------------------------------ in force */

test("a character's deal is in force for that character only", () => {
  const config = shop([deal(), deal({ actor: TOMAS, name: "Tomas", buy: null, sell: 0.1 })]);
  assert.deepEqual(activeDeal(config, ARIA, 0), { buy: -0.1, sell: null });
  assert.deepEqual(activeDeal(config, TOMAS, 0), { buy: null, sell: 0.1 });
  assert.equal(activeDeal(config, "Actor.nobody0000000000", 0), null);
  assert.equal(activeDeal(config, null, 0), null);
  assert.equal(activeDeal(shop(), ARIA, 0), null);
});

test("a deal ends at its end, not a moment before", () => {
  const config = shop([deal({ ends: { at: 1000, when: "date" } })]);
  assert.deepEqual(activeDeal(config, ARIA, 999.5), { buy: -0.1, sell: null });
  assert.equal(activeDeal(config, ARIA, 1000), null);
  assert.equal(activeDeal(config, ARIA, 5000), null);
});

/* ------------------------------------------------------------------ ends */

const CAL = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const DAY = 86_400;
const at = (day, hour, minute = 0) => day * DAY + hour * 3600 + minute * 60;
const HOURS = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
const NIGHT = { open: { hour: 20, minute: 0 }, close: { hour: 4, minute: 0 } };

test("'until the shop closes' is the shop's next closing, after now", () => {
  assert.equal(nextCloseAt(HOURS, at(3, 10), CAL), at(3, 19));
  assert.equal(nextCloseAt(HOURS, at(3, 19), CAL), at(4, 19));    // closing right now: the next one
  assert.equal(nextCloseAt(HOURS, at(3, 20), CAL), at(4, 19));    // closed: the close after it reopens
  assert.equal(nextCloseAt(HOURS, at(3, 5), CAL), at(3, 19));
  assert.equal(nextCloseAt(NIGHT, at(3, 23), CAL), at(4, 4));     // runs past midnight
  assert.equal(nextCloseAt(NIGHT, at(3, 2), CAL), at(3, 4));
  assert.equal(nextCloseAt(HOURS, at(3, 10) + 0.5, CAL), at(3, 19));
});

test("a shop that never closes has no closing for a deal to end at", () => {
  assert.equal(nextCloseAt(null, at(3, 10), CAL), null);
});

test("'for N days' ends that many whole days from now", () => {
  assert.equal(endsAfterDays(3, at(2, 10), CAL), at(5, 10));
  assert.equal(endsAfterDays(1, 0, { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 10 }), 36_000);
});

/* ------------------------------------------------------------------ edits */

/** Applies `change` and asserts it was taken; returns the new config. */
function applied(config, change) {
  const result = applyChange(config, change);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(validateShop(result.shop).ok, true);
  return result.shop;
}

function refused(config, change) {
  const result = applyChange(config, change);
  assert.equal(result.ok, false, JSON.stringify(change));
  assert.ok(result.errors.length);
}

const add = over => ({ op: "addDeal", actor: ARIA, name: "Aria", buy: -10, sell: null, note: "", ends: null, ...over });

test("a deal is added from percentages, the way the tab shows it", () => {
  const config = applied(shop(), add({ note: "Saved the smith's daughter", ends: { at: 500, when: "close" } }));
  assert.deepEqual(config.deals, [deal({ note: "Saved the smith's daughter", ends: { at: 500, when: "close" } })]);
  const both = applied(shop(), add({ buy: -12.5, sell: 10 }));
  assert.equal(both.deals[0].buy, -0.125);
  assert.equal(both.deals[0].sell, 0.1);
});

test("a 0% side is no change on that side, and a deal that changes nothing isn't one", () => {
  assert.equal(applied(shop(), add({ buy: -10, sell: 0 })).deals[0].sell, null);
  refused(shop(), add({ buy: 0, sell: 0 }));
  refused(shop(), add({ buy: null, sell: null }));
});

test("a deal can't make the goods free, or add a second deal for the same character", () => {
  refused(shop(), add({ buy: -100 }));
  refused(shop(), add({ buy: NaN }));
  refused(shop(), add({ actor: "" }));
  refused(shop([deal()]), add({ buy: -20 }));
});

test("a deal is edited and removed by its character, never its place in the list", () => {
  let config = shop([deal(), deal({ actor: TOMAS, name: "Tomas", buy: null, sell: 0.1 })]);
  config = applied(config, { op: "editDeal", actor: TOMAS, name: "Tomas", buy: null, sell: 15, note: "Ore", ends: null });
  assert.equal(config.deals[1].sell, 0.15);
  assert.equal(config.deals[1].note, "Ore");
  assert.equal(config.deals[0].buy, -0.1);
  config = applied(config, { op: "removeDeal", actor: ARIA });
  assert.deepEqual(config.deals.map(d => d.actor), [TOMAS]);
  // Already gone (a double click): nothing to do.
  assert.deepEqual(applied(config, { op: "removeDeal", actor: ARIA }).deals.map(d => d.actor), [TOMAS]);
  refused(config, { op: "editDeal", actor: ARIA, name: "Aria", buy: -5, sell: null, note: "", ends: null });
});

test("reset to preset keeps the shop's deals: they're with a character, not the preset", () => {
  const preset = { version: 1, terms: { sellsAt: 1.25, buysAt: 0.35, categories: [] } };
  const config = applied(shop([deal()]), { op: "reset", preset });
  assert.equal(config.terms.sellsAt, 1.25);
  assert.deepEqual(config.deals, [deal()]);
});
