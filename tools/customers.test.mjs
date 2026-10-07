/**
 * Other customers (#226): the drain between restocks, checked with plain Node.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { openSecondsPerDay, openSpansByDay } from "../scripts/schedule.mjs";
import {
  RATES, demandCategory, expectedSales, isDrainable, planDrain, poisson, priceModifier, seededRandom,
  settlementMultiplier, tableAverage
} from "../scripts/customers.mjs";

const cal = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const H = 3600, DAY = 86400;
const hours = (o, c) => ({ open: { hour: o, minute: 0 }, close: { hour: c, minute: 0 } });
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

/* ------------------------------------------------------------------ open time */

test("open seconds split by calendar day, the closing minute open as isOpen counts it", () => {
  assert.deepEqual(openSpansByDay(hours(7, 19), 6 * H, DAY + 8 * H, cal),
    [{ day: 0, seconds: 12 * H + 60 }, { day: 1, seconds: H }]);
  assert.equal(openSecondsPerDay(hours(7, 19), cal), 12 * H + 60);
});

test("an overnight shop is open both ends of the day; a closed stretch has no spans", () => {
  assert.deepEqual(openSpansByDay(hours(20, 4), 0, DAY, cal), [{ day: 0, seconds: 8 * H + 60 }]);
  assert.deepEqual(openSpansByDay(hours(7, 19), 20 * H, DAY + 6 * H, cal), []);
});

test("always open counts every second, and nothing is open in an empty or backward stretch", () => {
  assert.deepEqual(openSpansByDay(null, DAY / 2, DAY + H, cal), [{ day: 0, seconds: DAY / 2 }, { day: 1, seconds: H }]);
  assert.equal(openSecondsPerDay(null, cal), DAY);
  assert.deepEqual(openSpansByDay(null, 5 * H, 5 * H, cal), []);
  assert.deepEqual(openSpansByDay(null, 6 * H, 5 * H, cal), []);
});

/* ------------------------------------------------------------------ the busy-day tables */

const DAYS = json("../data/trade-days.json").days;
const tableFor = ti => DAYS.filter(d => d.weights[ti] > 0)
  .map(d => ({ weight: d.weights[ti], flags: { "merchant-presets": { day: { global: d.global, boosts: d.boosts } } } }));

test("the shipped tables average 0.9175, 1.1375 and 1.385 over their global multiplier", () => {
  assert.ok(Math.abs(tableAverage(tableFor(0)) - 0.9175) < 1e-12);
  assert.ok(Math.abs(tableAverage(tableFor(1)) - 1.1375) < 1e-12);
  assert.ok(Math.abs(tableAverage(tableFor(2)) - 1.385) < 1e-12);
});

test("a table with no weight to sum has no average; a result without day flags counts as an ordinary day", () => {
  assert.equal(tableAverage([]), null);
  assert.equal(tableAverage([{ weight: 0, flags: {} }]), null);
  assert.equal(tableAverage([{ weight: 1, flags: {} }, { weight: 1, flags: { "merchant-presets": { day: { global: 3 } } } }]), 2);
});

/* ------------------------------------------------------------------ categories */

// Every shipped stock line, against the recipe category it was filed under.
const recipes = json("../data/recipes.json");
const recipeCat = new Map(recipes.shops.flatMap(s => s.stock.map(l => [l.n, l.cat])));
const merchantsDir = new URL("../_source/merchants/", import.meta.url);
const shipped = readdirSync(merchantsDir).filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(readFileSync(new URL(f, merchantsDir), "utf8"))).filter(d => d.items)
  .flatMap(m => m.items).filter(i => i.flags?.["merchant-presets"]?.kind !== "gear" && !i.flags?.["merchant-presets"]?.stock?.service);

test("a shipped good's demand category is its recipe's, bar the few the recipe files loosely (#226)", () => {
  const seen = new Map();
  for (const i of shipped) seen.set(i.name, [recipeCat.get(i.name), demandCategory(i, i.flags["merchant-presets"].stock)]);
  const off = [...seen].filter(([, [want, got]]) => want !== got && !(want === "Spell Scrolls" && got === "Spell Scrolls"))
    .map(([n, [want, got]]) => `${n}: ${want} → ${got}`).sort();
  // Filed under Adventuring Gear in the recipes, but plainly what dnd5e says they are; the two holy
  // symbols, which dnd5e draws as plain trinkets; and Truth Serum, a poison dnd5e files as a potion.
  assert.deepEqual(off.filter(l => !/: Adventuring Gear → (Ammunition|Potions|Food & Drink|Weapons)$/.test(l)
    && !/: Holy Symbols → Adventuring Gear$/.test(l) && l !== "Truth Serum: Poisons → Potions"), []);
  assert.ok(off.length <= 16, `${off.length} loose: ${off.join("; ")}`);
});

test("every category the drain can name has a rate", () => {
  const cats = new Set(shipped.map(i => demandCategory(i, i.flags["merchant-presets"].stock)));
  for (const c of cats) assert.ok(c in RATES, c);
  assert.equal(demandCategory({ type: "loot", system: {} }, { category: "Weapons" }), "Weapons", "a GM's own rate category wins");
  assert.equal(demandCategory({ type: "loot", system: {} }, { category: "Odds and ends" }), "Adventuring Gear", "an unknown one falls back");
});

test("settlement multipliers: everyday, luxury and the rest", () => {
  assert.deepEqual(["Village", "Town", "City"].map(t => settlementMultiplier("Food & Drink", t)), [0.5, 1, 2]);
  assert.deepEqual(["Village", "Town", "City"].map(t => settlementMultiplier("Magic Items", t)), [0.25, 1, 3]);
  assert.deepEqual(["Village", "Town", "City"].map(t => settlementMultiplier("Weapons", t)), [0.5, 1, 2]);
  assert.equal(settlementMultiplier("Weapons", null), 1, "a shop with no size trades as a town");
});

test("the price modifier: cheaper sells faster, clamped to ×0.25-×2", () => {
  assert.equal(priceModifier(10, 10), 1);
  assert.equal(priceModifier(40, 10), 0.5);
  assert.equal(priceModifier(1000, 10), 0.25);
  assert.equal(priceModifier(0.01, 10), 2);
  assert.equal(priceModifier(5, 0), 1, "no median: no modifier");
});

/* ------------------------------------------------------------------ the issue's sanity checks */

const steady = { global: 1, boosts: {} };
const line = (category, o = {}) => expectedSales({ quantity: 1, category, priceGp: 10, medianGp: 10, tier: "Town",
  day: steady, average: 1, level: 1, fraction: 1, ...o });

test("a weekly armourer sells about 17% of its weapons on Steady days, 35% if every day is Busy", () => {
  assert.ok(Math.abs(7 * line("Weapons") - 0.175) < 1e-12);
  assert.ok(Math.abs(7 * line("Weapons", { day: { global: 2, boosts: {} } }) - 0.35) < 1e-12);
});

test("one suit of plate armour has about a 1.5% chance of selling on a given day", () => {
  assert.ok(Math.abs(1 - Math.exp(-line("Armor")) - 0.0149) < 1e-4);
});

test("a daily inn sells about a third of its food and drink over its open day", () => {
  assert.ok(Math.abs(line("Food & Drink", { quantity: 30 }) - 9) < 1e-12);
});

test("a boost lifts only its own category; Quiet halves; the table's average divides the settlement", () => {
  const caravan = { global: 1, boosts: { "Food & Drink": 3 } };
  assert.equal(line("Food & Drink", { day: caravan }), 3 * line("Food & Drink"));
  assert.equal(line("Weapons", { day: caravan }), line("Weapons"));
  assert.equal(line("Weapons", { level: 0.5 }), line("Weapons") / 2);
  assert.ok(Math.abs(line("Weapons", { tier: "City", average: 1.385 }) - 0.025 * 2 / 1.385) < 1e-12);
  assert.equal(line("Weapons", { average: null }), line("Weapons"), "no average: the plain multiplier");
});

/* ------------------------------------------------------------------ draws */

test("the seeded draw repeats for a seed and averages to its rate", () => {
  const a = seededRandom("shelf|i1|3"), b = seededRandom("shelf|i1|3");
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  for (const lambda of [0.3, 4, 60]) {
    const r = seededRandom(`mean ${lambda}`);
    let sum = 0; const n = 20000;
    for (let k = 0; k < n; k++) sum += poisson(lambda, r);
    assert.ok(Math.abs(sum / n - lambda) < Math.max(0.02, lambda * 0.02), `λ ${lambda}: ${sum / n}`);
  }
  assert.equal(poisson(0, seededRandom("x")), 0);
});

/* ------------------------------------------------------------------ the plan */

const good = (id, name, quantity, o = {}) => ({ _id: id, name, type: "weapon", system: { quantity, price: { value: 10, denomination: "gp" }, type: { value: "martialM" } },
  flags: { "merchant-presets": { drawn: "shelf", stock: { infinite: null, service: false, category: "", bundle: 1 }, ...o } } });

test("only drawn, finite, physical goods drain: never gear, services, hand-added or unlimited goods", () => {
  const ctx = { drawnBy: "shelf", infiniteStock: false };
  assert.equal(isDrainable(good("a", "Longsword", 5), ctx), true);
  assert.equal(isDrainable(good("a", "Longsword", 0), ctx), false, "sold out");
  assert.equal(isDrainable(good("a", "Longsword", 5, { kind: "gear" }), ctx), false);
  assert.equal(isDrainable(good("a", "Longsword", 5, { stock: { service: true } }), ctx), false);
  assert.equal(isDrainable(good("a", "Longsword", 5, { drawn: undefined }), ctx), false, "hand-added");
  assert.equal(isDrainable(good("a", "Longsword", 5, { stock: { infinite: true } }), ctx), false);
  assert.equal(isDrainable(good("a", "Longsword", 5), { ...ctx, infiniteStock: true }), false, "unlimited world");
  assert.equal(isDrainable(good("a", "Longsword", 5, { stock: { infinite: false } }), { ...ctx, infiniteStock: true }), true, "limited line in an unlimited world");
});

const shelf = [good("a", "Longsword", 40), good("b", "Dagger", 40, {}), good("c", "Shovel", 3, { drawn: undefined })];
const plan = (o = {}) => planDrain({ items: shelf, spans: [{ day: 0, seconds: 12 * H, result: { global: 3, boosts: {} } }, { day: 1, seconds: 12 * H, result: steady }],
  perDay: 12 * H, tier: "City", average: 1.385, level: 1, drawnBy: "shelf", infiniteStock: false, unitPriceCpOf: () => 1000, ...o });

test("a drain plan is deterministic, clamps to stock, leaves hand-added goods, and earns what it sold", () => {
  const p = plan();
  assert.deepEqual(plan(), p, "same inputs, same plan");
  assert.ok(p.updates.length > 0);
  assert.ok(p.updates.every(u => u._id !== "c" && u["system.quantity"] >= 0 && u["system.quantity"] < 40));
  const sold = p.sold.reduce((s, x) => s + x.quantity, 0);
  assert.equal(p.earnedCp, sold * 1000);
  assert.equal(sold, p.updates.reduce((s, u) => s + 40 - u["system.quantity"], 0));
});

test("Off drains nothing, and a line that sells out stops there", () => {
  assert.deepEqual(plan({ level: 0 }), { updates: [], sold: [], earnedCp: 0 });
  const busy = plan({ items: [good("a", "Longsword", 1)], spans: Array.from({ length: 400 }, (_, d) => ({ day: d, seconds: 12 * H, result: steady })) });
  assert.deepEqual(busy.updates, [{ _id: "a", "system.quantity": 0 }]);
  assert.equal(busy.earnedCp, 1000);
});
