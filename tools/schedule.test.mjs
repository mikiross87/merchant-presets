import { test } from "node:test";
import assert from "node:assert/strict";
import { dueRestock, isOpen, nextDue, nextOpen, planRestock } from "../scripts/schedule.mjs";
import { SHOP_VERSION } from "../scripts/schema.mjs";

// game.time.calendar.days, as the core calendar reports it. A day is exactly
// 24*60*60 seconds — one of #105's own fixed points, since it counts whole
// days, not calendar weeks (a tenday and a week disagree; a day never does).
const calendar = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const DAY = 24 * 60 * 60;
const at = (day, hour = 0, minute = 0) => day * DAY + hour * 3600 + minute * 60;
const minute = (hour, min = 0) => hour * 60 + min;

const noRoll = () => { throw new Error("roll() called for a non-dice interval"); };

/* -------------------------------------------------------------------- isOpen */

test("a shop's hours run past midnight (Criminal & Illicit: 20:00-04:00)", () => {
  const hours = { open: { hour: 20, minute: 0 }, close: { hour: 4, minute: 0 } };
  assert.equal(isOpen(hours, minute(21, 40), calendar), true);
  assert.equal(isOpen(hours, minute(1, 40), calendar), true);
  assert.equal(isOpen(hours, minute(20, 0), calendar), true);   // opens on the dot
  assert.equal(isOpen(hours, minute(4, 0), calendar), true);    // still open on the dot
  assert.equal(isOpen(hours, minute(4, 1), calendar), false);
  assert.equal(isOpen(hours, minute(8, 20), calendar), false);
});

test("ordinary hours don't wrap (General Store: 07:00-19:00)", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.equal(isOpen(hours, minute(6, 59), calendar), false);
  assert.equal(isOpen(hours, minute(7, 0), calendar), true);
  assert.equal(isOpen(hours, minute(19, 0), calendar), true);
  assert.equal(isOpen(hours, minute(19, 1), calendar), false);
});

test("null hours means always open", () => {
  assert.equal(isOpen(null, minute(0, 0), calendar), true);
  assert.equal(isOpen(null, minute(12, 0), calendar), true);
  assert.equal(isOpen(null, minute(23, 59), calendar), true);
});

/* ------------------------------------------------------------------ nextOpen */

test("nextOpen counts the wait while closed, and wraps past midnight", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.deepEqual(nextOpen(hours, minute(4, 0), calendar), { opensAt: minute(7), inMinutes: 180 });
  assert.deepEqual(nextOpen(hours, minute(20, 0), calendar), { opensAt: minute(7), inMinutes: 11 * 60 });
});

test("nextOpen is 0 minutes while already open, or always (hours null)", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.equal(nextOpen(hours, minute(12, 0), calendar).inMinutes, 0);
  assert.deepEqual(nextOpen(null, minute(3, 0), calendar), { opensAt: 0, inMinutes: 0 });
});

/* ------------------------------------------------------------------- nextDue */

test("nextDue adds a fixed number of days, at midnight of the due day", () => {
  assert.equal(nextDue(7, at(0), calendar, noRoll), at(7));
  // from's own time of day is dropped: due is the *day*, not the anchor's clock time.
  assert.equal(nextDue(1, at(3, 6, 30), calendar, noRoll), at(4));
});

test("nextDue rolls a dice formula through the injected roll", () => {
  const roll = formula => { assert.equal(formula, "1d4+2"); return 5; };
  assert.equal(nextDue("1d4+2", at(0), calendar, roll), at(5));
});

test("nextDue is null for \"never\", and never calls roll", () => {
  assert.equal(nextDue("never", at(0), calendar, noRoll), null);
});

test("a roll below 1 day floors to 1: a restock can't be due before it starts", () => {
  assert.equal(nextDue("1d2-1", at(3), calendar, () => 0), at(4));
});

/* ---------------------------------------------------------------- dueRestock */

// dueRestock and planRestock take the raw stored flags.merchant-presets.shop,
// incomplete or not, and complete it themselves via schema.mjs's shopFrom —
// so a fixture only ever states what a test actually cares about. Omitting
// `hours` gets the #98 default window (07:00-19:00); `hours: null` is the
// real "always open" value, and the two must not be confused with each
// other. A fixture is "wired" (a real stock table) by default, since that's
// every shipped shop's actual state; restock.table: null is its own case
// (below), not the default one.
const rawShop = (over = {}) => ({
  version: SHOP_VERSION,
  ...over,
  restock: { table: "Compendium.merchant-presets.stock.RollTable.test", ...over.restock }
});
const weeklyShop = rawShop({ restock: { every: 7, onOpen: true } });   // default hours: 07:00-19:00

test("fires the first time the shop opens on or after the due day", () => {
  const state = { lastRestock: at(0), dueAt: at(7) };
  // Still short of the due day: no restock, whatever the doors are doing.
  const early = dueRestock(weeklyShop, state, at(6, 6, 0), at(6, 8, 0), calendar, noRoll);
  assert.equal(early.due, false);
  assert.deepEqual(early.state, state);

  // Due day has arrived, but the shop is shut until 07:00 — waits for it to open.
  const stillClosed = dueRestock(weeklyShop, state, at(7, 0, 0), at(7, 6, 0), calendar, noRoll);
  assert.equal(stillClosed.due, false);

  // The doors open on the due day: fires at the opening itself, not at
  // whatever later instant the caller happened to check, and schedules the
  // next one from there.
  const opens = dueRestock(weeklyShop, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(opens.due, true);
  assert.equal(opens.at, at(7, 7, 0));
  assert.deepEqual(opens.state, { lastRestock: at(7, 7, 0), dueAt: at(14) });
});

test("fires on a jump under a day where both ends happen to be open", () => {
  // Due day 7, 07:00-19:00. 18:00 the evening before is open (that day's
  // hours), and 08:00 the next morning is open too (this day's hours) — the
  // shop closed at 19:00 and reopened at 07:00 somewhere in between, which a
  // was-closed-now-open sample at the two ends alone would never see.
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(weeklyShop, state, at(6, 18, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
  assert.equal(result.at, at(7, 7, 0));
});

test("fires on a jump under a day where both ends happen to be closed", () => {
  // 06:00 and 20:00 on the due day are both outside 07:00-19:00, but the shop
  // plainly opened (and closed again) in between.
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(weeklyShop, state, at(7, 6, 0), at(7, 20, 0), calendar, noRoll);
  assert.equal(result.due, true);
  assert.equal(result.at, at(7, 7, 0));
});

test("a full day or more elapsed doesn't fire before the due day's own opening", () => {
  // Exactly one day passes, but it lands at 06:00 on the due day — an hour
  // before the shop actually opens. The old "any day-long jump opens
  // somewhere" shortcut fired here anyway, with the doors still shut.
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(weeklyShop, state, at(6, 6, 0), at(7, 6, 0), calendar, noRoll);
  assert.equal(result.due, false);
});

test("an overnight shop (18:00-02:00) opens once a day, in the evening, even across the due midnight", () => {
  const overnightShop = rawShop({ restock: { every: 7, onOpen: true },
    hours: { open: { hour: 18, minute: 0 }, close: { hour: 2, minute: 0 } } });
  const state = { lastRestock: at(0), dueAt: at(5) };

  // Still open from day 4's own 18:00 opening, carrying past midnight into
  // day 5 — but day 5's due opening is its *own* 18:00, not the midnight it
  // happens to already be open through.
  const throughMidnight = dueRestock(overnightShop, state, at(4, 23, 0), at(5, 3, 0), calendar, noRoll);
  assert.equal(throughMidnight.due, false);

  const evening = dueRestock(overnightShop, state, at(5, 3, 0), at(5, 21, 0), calendar, noRoll);
  assert.equal(evening.due, true);
  assert.equal(evening.at, at(5, 18, 0));
});

test("a restock that itself lands late in the day doesn't push the next due day's opening back", () => {
  // Last restock ran at 07:05 — 5 minutes after that day's opening. Without
  // flooring the due date to midnight, the following due day's 07:00 opening
  // (07:00 < 07:05) would be seen as "too early" and wait a whole extra day.
  const dueAt = nextDue(7, at(0, 7, 5), calendar, noRoll);
  assert.equal(dueAt, at(7));
  const state = { lastRestock: at(0, 7, 5), dueAt };
  const result = dueRestock(weeklyShop, state, at(7, 6, 55), at(7, 7, 2), calendar, noRoll);
  assert.equal(result.due, true);
});

test("a dice interval is rolled again after each restock, not before", () => {
  const rolls = [4, 6];
  const roll = formula => { assert.equal(formula, "1d4+2"); return rolls.shift(); };
  const diceShop = rawShop({ restock: { every: "1d4+2", onOpen: true } });   // default hours
  const initialDue = nextDue("1d4+2", at(0), calendar, roll);   // first roll: 4
  assert.equal(initialDue, at(4));

  const state = { lastRestock: at(0), dueAt: initialDue };
  const result = dueRestock(diceShop, state, at(4, 6, 0), at(4, 8, 0), calendar, roll);
  assert.equal(result.due, true);
  // second roll: 6, from this restock's own time, not the first one's.
  assert.equal(result.state.dueAt, at(10));
  assert.equal(rolls.length, 0);
});

test("a gap that skips several due openings gives exactly one restock, anchored at the most recent of them", () => {
  // Weekly shop, due day 7. The world isn't checked again until day 30 — six
  // due days go unseen in one jump.
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(weeklyShop, state, at(6), at(30, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
  // Anchored at day 30's own opening — the *most recent* due one — not day
  // 7's, the first one it skipped past: the next due day counts from there,
  // at day 37, not day 14.
  assert.equal(result.at, at(30, 7, 0));
  assert.deepEqual(result.state, { lastRestock: at(30, 7, 0), dueAt: at(37) });

  // The very next tick, a day later, is not due again. Anchoring on day 7
  // instead would have left dueAt at day 14 — already behind `now` — firing
  // a second time here for the same gap.
  const followUp = dueRestock(weeklyShop, result.state, at(30, 8, 0), at(31, 8, 0), calendar, noRoll);
  assert.equal(followUp.due, false);
});

test("rewinding the clock never fires, even past the due day", () => {
  const state = { lastRestock: at(0), dueAt: at(1) };
  const result = dueRestock(weeklyShop, state, at(10, 8, 0), at(3, 8, 0), calendar, noRoll);
  assert.equal(result.due, false);
  assert.deepEqual(result.state, state);
});

test("\"never\" never fires", () => {
  const neverShop = rawShop({ restock: { every: "never", onOpen: true } });
  const state = { lastRestock: at(0), dueAt: null };
  const result = dueRestock(neverShop, state, at(0), at(30), calendar, noRoll);
  assert.equal(result.due, false);
});

test("onOpen: false never fires on its own", () => {
  const byHandOnlyShop = rawShop({ restock: { every: 1, onOpen: false } });
  const state = { lastRestock: at(0), dueAt: at(1) };
  const result = dueRestock(byHandOnlyShop, state, at(1, 6, 0), at(1, 8, 0), calendar, noRoll);
  assert.equal(result.due, false);
  assert.deepEqual(result.state, state);
});

test("an always-open shop (hours: null, a real value) restocks at the start of its due day", () => {
  const alwaysOpenShop = rawShop({ restock: { every: 7, onOpen: true }, hours: null });
  const state = { lastRestock: at(0), dueAt: at(1) };
  // Still day 0, however late: not due yet.
  const late = dueRestock(alwaysOpenShop, state, at(0, 23, 0), at(0, 23, 59), calendar, noRoll);
  assert.equal(late.due, false);
  // Crosses midnight into day 1: opens, and the due day has arrived.
  const midnight = dueRestock(alwaysOpenShop, state, at(0, 23, 59), at(1, 0, 1), calendar, noRoll);
  assert.equal(midnight.due, true);
  assert.equal(midnight.at, at(1));
});

/* --------------------------------------------------- normalising incomplete input */

test("a shop with no restock at all takes its defaults (every: 7, onOpen: true), not a throw", () => {
  const bareShop = rawShop({});
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(bareShop, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
});

test("a restock missing onOpen defaults to true, not a false read off undefined", () => {
  const shopMissingOnOpen = rawShop({ restock: { every: 7 } });
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(shopMissingOnOpen, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
});

test("a restock missing every defaults to 7 days, not roll(undefined)", () => {
  const shopMissingEvery = rawShop({ restock: { onOpen: true } });
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(shopMissingEvery, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
  assert.equal(result.state.dueAt, at(14));   // the default every: 7, from day 7's opening
});

test("a shop missing hours entirely gets the #98 default window, not always-open", () => {
  const shopMissingHours = rawShop({ restock: { every: 7, onOpen: true } });   // no `hours` key
  const state = { lastRestock: at(0), dueAt: at(7) };
  // 02:00 on the due day is outside the default 07:00-19:00 window. Reading
  // a missing `hours` as falsy (always open) would fire here; the default
  // hours correctly wait for 07:00 instead.
  const result = dueRestock(shopMissingHours, state, at(7, 1, 0), at(7, 2, 0), calendar, noRoll);
  assert.equal(result.due, false);
});

test("a shop with no stock table assigned never fires, whatever the schedule says", () => {
  // The schema's own default restock.table is null (a fresh custom shop, set
  // up but never given a stock table); rawShop's own default (below) is what
  // every other test overrides away from.
  const untabledShop = rawShop({ restock: { table: null } });
  const state = { lastRestock: at(0), dueAt: at(7) };
  const result = dueRestock(untabledShop, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, false);
});

/* --------------------------------------------------------------- planRestock */

// A service good (#99: infinite true) and an SRD limited item (keep false) —
// #119 point 1's own examples — each with their full #98 stock config, kept
// on the shop's own record rather than read back off the compendium good.
const arrowsStock = { infinite: false, keep: false, service: false, noBuyback: false,
  category: "", bundle: 20, hidden: false, notForSale: false };
const level1Stock = { infinite: true, keep: true, service: true, noBuyback: true,
  category: "Services", bundle: 1, hidden: false, notForSale: false };
const backpackStock = { infinite: false, keep: true, service: false, noBuyback: false,
  category: "", bundle: 1, hidden: false, notForSale: false };

const draws = [
  { resultId: "r1", name: "Arrows", data: { type: "consumable", name: "Arrows", system: { price: { value: 1, denomination: "gp" } }, flags: {} } },
  { resultId: "r2", name: "Spellcasting: Level 1", data: { type: "loot", name: "Spellcasting: Level 1", system: {}, flags: { "merchant-presets": { kind: "spellcasting" } } } },
  { resultId: "r3", name: "Backpack", data: { type: "container", name: "Backpack", system: { container: "somekit" }, flags: {} } }
];

const shop = rawShop({ restock: { mode: "reroll", quantities: { r1: "2d6+4", r2: "1" } } });

const context = {
  purse: 250,
  currentGp: 100,
  stockFlags: { Arrows: arrowsStock, "Spellcasting: Level 1": level1Stock, Backpack: backpackStock },
  containers: { Backpack: 3 }
};

const drawn = (id, name, type, quantity, extra = {}) =>
  ({ _id: id, name, type, system: { quantity, ...extra }, flags: { "merchant-presets": { drawn: true } } });

const gmAdded = { _id: "gm1", name: "Rope, Silk", type: "loot", system: { quantity: 5 }, flags: {} };
const gear = { _id: "gear1", name: "Longsword", type: "weapon", system: { quantity: 1 }, flags: { "merchant-presets": { kind: "gear" } } };

const rollFor = table => formula => {
  if (!(formula in table)) throw new Error(`unexpected roll(${JSON.stringify(formula)})`);
  return table[formula];
};

test("reroll replaces the whole drawn shelf, and leaves the GM's own goods and gear alone", () => {
  const items = [
    drawn("i1", "Arrows", "consumable", 40),
    drawn("i2", "Spellcasting: Level 1", "loot", 1),
    drawn("i3", "Backpack", "container", 1, { container: null }),
    drawn("i4", "Backpack", "container", 1, { container: null }),
    gmAdded,
    gear
  ];
  const plan = planRestock(shop, items, draws, context, rollFor({ "2d6+4": 10, 1: 1 }));

  assert.deepEqual(plan.deletes, ["i1", "i2", "i3", "i4"]);
  assert.equal(plan.creates.length, 5);   // Arrows, Level 1, and 3 Backpacks (its own target)
  assert.equal(plan.currency, 250);       // 100 < purse: refilled
  // One mention per line, even though the container made three copies.
  assert.deepEqual(plan.restocked, ["Arrows", "Spellcasting: Level 1", "Backpack"]);

  const arrows = plan.creates.find(c => c.name === "Arrows");
  assert.equal(arrows.system.quantity, 10);
  assert.equal(arrows.flags["merchant-presets"].drawn, true);
  assert.deepEqual(arrows.flags["merchant-presets"].stock, arrowsStock);   // keep: false carried over, not re-derived

  const level1 = plan.creates.find(c => c.name === "Spellcasting: Level 1");
  assert.deepEqual(level1.flags["merchant-presets"].stock, level1Stock);   // infinite: true carried over

  const backpacks = plan.creates.filter(c => c.name === "Backpack");
  assert.equal(backpacks.length, 3);
  for (const b of backpacks) {
    assert.equal(b.system.quantity, 1);
    assert.equal(b.system.container, null);
  }
});

test("reroll drops a line that rolls empty, rather than stocking it at zero", () => {
  const items = [drawn("i1", "Arrows", "consumable", 40)];
  const plan = planRestock(shop, items, [draws[0]], { ...context, containers: {} }, rollFor({ "2d6+4": 0 }));
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.restocked, []);
});

// A keep: true good (#99) can sit on the shelf sold out at quantity 0 — a
// keep: false good like Arrows can't; applyStockMode's precedent (and #105's
// own item lifecycle) deletes it outright the moment it sells out. Topup has
// to redraw both: a line still present at zero, and one gone entirely.
const rationsStock = { infinite: false, keep: true, service: false, noBuyback: false,
  category: "", bundle: 1, hidden: false, notForSale: false };
const rationsDraw = { resultId: "r4", name: "Rations",
  data: { type: "consumable", name: "Rations", system: { price: { value: 0.2, denomination: "gp" } }, flags: {} } };
const topupContext = { ...context, stockFlags: { ...context.stockFlags, Rations: rationsStock } };

test("topup redraws a sold-out line whether it's still on the shelf at zero or gone entirely, and leaves the rest alone", () => {
  const topupShop = rawShop({ restock: { mode: "topup", quantities: { r1: "2d6+4", r2: "1", r4: "1d6+2" } } });
  const items = [
    // Arrows (keep: false): sold out and deleted outright — no document at all.
    drawn("i2", "Spellcasting: Level 1", "loot", 1),               // still in stock: untouched
    drawn("i5", "Rations", "consumable", 0),                       // keep: true — sold out, still there
    drawn("i3", "Backpack", "container", 1, { container: null }),  // short of its target (3)
    gmAdded,
    gear
  ];
  const plan = planRestock(topupShop, items, [...draws, rationsDraw], topupContext,
    rollFor({ "2d6+4": 8, "1d6+2": 5 }));

  assert.deepEqual(plan.deletes, []);

  // Gone entirely: redrawn as a fresh create, not an update — there is
  // nothing left to update.
  const arrows = plan.creates.find(c => c.name === "Arrows");
  assert.ok(arrows, "Arrows is redrawn even with no document left to refill");
  assert.equal(arrows.system.quantity, 8);
  assert.equal(arrows.flags["merchant-presets"].drawn, true);
  assert.deepEqual(arrows.flags["merchant-presets"].stock, arrowsStock);

  // Still there at zero: refilled in place, not replaced.
  assert.deepEqual(plan.updates, [
    { _id: "i5", "system.quantity": 5, "flags.merchant-presets.stock": rationsStock }
  ]);

  const backpacks = plan.creates.filter(c => c.name === "Backpack");
  assert.equal(backpacks.length, 2);   // 1 existing, target 3: two more
  for (const b of backpacks) {
    assert.equal(b.system.quantity, 1);
    assert.equal(b.system.container, null);
  }

  assert.deepEqual([...plan.restocked].sort(), ["Arrows", "Backpack", "Rations"]);
  // Still genuinely in stock, the GM's own good, and the shopkeeper's gear: none of them appear anywhere.
  assert.equal(plan.creates.some(i => i.name === "Spellcasting: Level 1"), false);
  assert.equal(plan.updates.some(u => u._id === "i2"), false);
});

test("topup leaves a sold-out line alone when it rolls empty again, present at zero or gone entirely alike", () => {
  const topupShop = rawShop({ restock: { mode: "topup", quantities: { r1: "2d6+4", r4: "1d6+2" } } });
  const items = [drawn("i5", "Rations", "consumable", 0)];   // Arrows: gone; Rations: present at 0
  const plan = planRestock(topupShop, items, [draws[0], rationsDraw], { ...topupContext, containers: {} },
    rollFor({ "2d6+4": 0, "1d6+2": 0 }));
  assert.deepEqual(plan.creates, []);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.restocked, []);
});

test("the till refills to the starting purse, but a surplus is left alone", () => {
  const items = [];
  const below = planRestock(shop, items, [], { ...context, currentGp: 100 }, noRoll);
  assert.equal(below.currency, 250);
  const above = planRestock(shop, items, [], { ...context, currentGp: 400 }, noRoll);
  assert.equal(above.currency, null);
  const exact = planRestock(shop, items, [], { ...context, currentGp: 250 }, noRoll);
  assert.equal(exact.currency, null);
});

/* --------------------------------------------------- normalising incomplete input */

test("a shop with no restock at all takes its defaults (mode: reroll), not a throw", () => {
  const bareShop = rawShop({});
  const items = [drawn("i1", "Arrows", "consumable", 40)];
  const plan = planRestock(bareShop, items, [draws[0]], context, rollFor({ 1: 6 }));   // default quantities: {} -> "1"
  assert.deepEqual(plan.deletes, ["i1"]);
  assert.equal(plan.creates[0].system.quantity, 6);
});

test("topup with no quantities configured falls back to \"1\" per line, not a throw", () => {
  const bareTopupShop = rawShop({ restock: { mode: "topup" } });   // quantities: {} by default
  const items = [drawn("i1", "Arrows", "consumable", 0)];
  const plan = planRestock(bareTopupShop, items, [draws[0]], context, rollFor({ 1: 3 }));
  assert.deepEqual(plan.updates, [
    { _id: "i1", "system.quantity": 3, "flags.merchant-presets.stock": arrowsStock }
  ]);
});

test("a shop with no stock table assigned plans nothing at all", () => {
  const untabledShop = rawShop({ restock: { mode: "reroll", quantities: { r1: "2d6+4" }, table: null } });
  const items = [drawn("i1", "Arrows", "consumable", 40), gmAdded];
  const plan = planRestock(untabledShop, items, draws, { ...context, currentGp: 0 }, noRoll);
  assert.deepEqual(plan, { deletes: [], creates: [], updates: [], currency: null, restocked: [] });
});

test("draws sharing a name collapse to the first, in both modes", () => {
  const duplicateName = { resultId: "r1b", name: "Arrows",
    data: { type: "consumable", name: "Arrows", system: { price: { value: 1, denomination: "gp" } }, flags: {} } };

  const rerollPlan = planRestock(shop, [], [draws[0], duplicateName], { ...context, containers: {} },
    rollFor({ "2d6+4": 10 }));
  assert.equal(rerollPlan.creates.length, 1);   // not two Arrows stacks
  assert.equal(rerollPlan.creates[0].system.quantity, 10);

  const topupShop = rawShop({ restock: { mode: "topup", quantities: { r1: "2d6+4" } } });
  const soldOut = [drawn("i1", "Arrows", "consumable", 0)];
  const topupPlan = planRestock(topupShop, soldOut, [draws[0], duplicateName], { ...context, containers: {} },
    rollFor({ "2d6+4": 10 }));
  assert.equal(topupPlan.updates.length, 1);   // not updated twice
});

test("a missing or invalid purse leaves the till untouched, rather than writing NaN", () => {
  const missing = planRestock(shop, [], [], { ...context, purse: undefined, currentGp: 100 }, noRoll);
  assert.equal(missing.currency, null);
  const invalid = planRestock(shop, [], [], { ...context, purse: NaN, currentGp: 100 }, noRoll);
  assert.equal(invalid.currency, null);
});

test("a missing currentGp reads as an empty till, not as already full", () => {
  const plan = planRestock(shop, [], [], { ...context, currentGp: undefined }, noRoll);
  assert.equal(plan.currency, context.purse);
});
