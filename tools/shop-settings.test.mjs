/**
 * The GM's Settings tab edits (#110), as plain config in, config out: every change comes back as
 * a full, valid shop config, or is refused with nothing to write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOP_DEFAULTS, shopFrom, validateShop } from "../scripts/schema.mjs";
import { applyChange, everyChoice, parseTime, percentOf, resetToPreset, timeText } from "../scripts/shop-settings.mjs";

const WORLD = { sellsAt: 1, buysAt: 0.5 };
const shop = (over = {}) => shopFrom({ version: 1, ...over });

/** Applies `change` and asserts it was taken; returns the new config. */
function applied(config, change) {
  const result = applyChange(config, change);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(validateShop(result.shop).ok, true);
  return result.shop;
}

function refused(config, change) {
  const result = applyChange(config, change);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length);
  assert.equal(result.shop, undefined);
}

test("a change never edits the config it was given", () => {
  const before = shop();
  const frozen = structuredClone(before);
  applied(before, { op: "rate", side: "sellsAt", percent: 120 });
  applied(before, { op: "addRule", category: "weapon", world: WORLD });
  assert.deepEqual(before, frozen);
});

/* ------------------------------------------------------------------ terms */

test("a shop rate is set from a percentage, and null hands it back to the world default", () => {
  let config = applied(shop(), { op: "rate", side: "sellsAt", percent: 120 });
  assert.equal(config.terms.sellsAt, 1.2);
  config = applied(config, { op: "rate", side: "buysAt", percent: 57 });
  assert.equal(config.terms.buysAt, 0.57);
  config = applied(config, { op: "rate", side: "sellsAt", percent: null });
  assert.equal(config.terms.sellsAt, null);
  assert.equal(config.terms.buysAt, 0.57);
});

test("a shop can't give its goods away, but it can refuse to pay anything", () => {
  refused(shop(), { op: "rate", side: "sellsAt", percent: 0 });
  refused(shop(), { op: "rate", side: "sellsAt", percent: NaN });
  refused(shop(), { op: "rate", side: "buysAt", percent: -1 });
  assert.equal(applied(shop(), { op: "rate", side: "buysAt", percent: 0 }).terms.buysAt, 0);
});

test("a category rule starts at the rates the shop charges now, and can be edited and removed", () => {
  let config = applied(shop({ terms: { sellsAt: 1.1, buysAt: null } }), { op: "addRule", category: "weapon", world: WORLD });
  assert.deepEqual(config.terms.categories, [{ category: "weapon", sellsAt: 1.1, buysAt: 0.5 }]);
  config = applied(config, { op: "addRule", category: "Valuables", world: WORLD });
  config = applied(config, { op: "ruleRate", category: "Valuables", side: "buysAt", percent: 100 });
  assert.equal(config.terms.categories[1].buysAt, 1);
  config = applied(config, { op: "removeRule", category: "weapon" });
  assert.deepEqual(config.terms.categories.map(c => c.category), ["Valuables"]);
});

test("a category can only be ruled once, and a rule it doesn't have can't be edited", () => {
  const config = applied(shop(), { op: "addRule", category: "weapon", world: WORLD });
  refused(config, { op: "addRule", category: "weapon", world: WORLD });
  refused(config, { op: "addRule", category: "", world: WORLD });
  refused(config, { op: "ruleRate", category: "armor", side: "sellsAt", percent: 100 });
  refused(config, { op: "removeRule", category: "armor" });
  refused(config, { op: "ruleRate", category: "weapon", side: "sellsAt", percent: 0 });
});

/* --------------------------------------------------------------- won't buy */

test("won't-buy types and kinds switch on and off, without duplicates", () => {
  let config = applied(shop(), { op: "wontBuy", list: "types", value: "weapon", on: true });
  config = applied(config, { op: "wontBuy", list: "types", value: "weapon", on: true });
  config = applied(config, { op: "wontBuy", list: "kinds", value: "meal", on: true });
  assert.deepEqual(config.wontBuy, { types: ["weapon"], kinds: ["meal"] });
  config = applied(config, { op: "wontBuy", list: "types", value: "weapon", on: false });
  assert.deepEqual(config.wontBuy, { types: [], kinds: ["meal"] });
  refused(config, { op: "wontBuy", list: "moods", value: "x", on: true });
});

/* ------------------------------------------------------------------ hours */

test("a shop stops keeping hours, and starts again from the hours it's given", () => {
  let config = applied(shop(), { op: "keepHours", on: false, fallback: SHOP_DEFAULTS.hours });
  assert.equal(config.hours, null);
  config = applied(config, { op: "keepHours", on: true, fallback: { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 30 } } });
  assert.deepEqual(config.hours, { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 30 } });
  // Already keeping hours: switching it on again keeps the ones it has.
  config = applied(config, { op: "keepHours", on: true, fallback: SHOP_DEFAULTS.hours });
  assert.equal(config.hours.open.hour, 9);
});

test("opening and closing times are set from a time input's HH:MM", () => {
  let config = applied(shop(), { op: "hour", end: "open", time: "08:30" });
  config = applied(config, { op: "hour", end: "close", time: "02:00" });
  assert.deepEqual(config.hours, { open: { hour: 8, minute: 30 }, close: { hour: 2, minute: 0 } });
  refused(config, { op: "hour", end: "close", time: "08:30" });   // opens and closes at once
  refused(config, { op: "hour", end: "open", time: "25:00" });
  refused(config, { op: "hour", end: "open", time: "" });
  refused(shop({ hours: null }), { op: "hour", end: "open", time: "08:00" });
});

test("times read and write as HH:MM", () => {
  assert.equal(timeText({ hour: 7, minute: 5 }), "07:05");
  assert.deepEqual(parseTime("19:45"), { hour: 19, minute: 45 });
  for (const bad of ["", "7", "24:00", "12:60", "ab:cd", null]) assert.equal(parseTime(bad), null, String(bad));
});

/* ---------------------------------------------------------------- restock */

test("the restock schedule takes a number of days, a dice formula or never", () => {
  let config = applied(shop(), { op: "every", every: "3" });
  assert.equal(config.restock.every, 3);
  config = applied(config, { op: "every", every: "1d4+2" });
  assert.equal(config.restock.every, "1d4+2");
  config = applied(config, { op: "every", every: "never" });
  assert.equal(config.restock.every, "never");
  refused(config, { op: "every", every: "" });
  refused(config, { op: "every", every: "0" });
  refused(config, { op: "every", every: "soon" });
});

test("picking a schedule turns restocking back on for a shop that had it off", () => {
  const config = applied(shop({ restock: { onOpen: false } }), { op: "every", every: 7 });
  assert.equal(config.restock.onOpen, true);
  assert.equal(config.restock.every, 7);
});

test("the schedule reads back as the chip it matches", () => {
  const choice = restock => everyChoice(shop({ restock }).restock);
  assert.deepEqual(choice({ every: 7 }), { chip: "7", formula: "" });
  assert.deepEqual(choice({ every: 5 }), { chip: "dice", formula: "5" });
  assert.deepEqual(choice({ every: "2d4" }), { chip: "dice", formula: "2d4" });
  assert.deepEqual(choice({ every: "never" }), { chip: "never", formula: "" });
  assert.deepEqual(choice({ every: 7, onOpen: false }), { chip: "never", formula: "" });
});

test("a restock re-rolls the shelf or tops it up", () => {
  assert.equal(applied(shop(), { op: "mode", mode: "topup" }).restock.mode, "topup");
  refused(shop(), { op: "mode", mode: "burn" });
});

test("an unknown change is refused", () => {
  refused(shop(), { op: "paint" });
  refused(shop(), null);
});

/* ------------------------------------------------------------ reset, misc */

test("reset puts back the preset's config and keeps which preset the shop came from", () => {
  const preset = shop({ source: "Compendium.merchant-presets.merchants.Actor.abc", tier: "City", terms: { sellsAt: 1.25, buysAt: null } });
  const edited = { ...shop({ source: "Compendium.merchant-presets.merchants.Actor.abc", hours: null }), description: "mine" };
  const { ok, shop: reset } = resetToPreset(edited, { ...preset, source: "somewhere-else" });
  assert.equal(ok, true);
  assert.deepEqual(reset, { ...preset, source: edited.source });
});

test("reset is a change like any other, keeping the shop's own source", () => {
  const preset = shop({ tier: "City", hours: null });
  const config = applied(shop({ source: "Actor.mine" }), { op: "reset", preset });
  assert.deepEqual(config, { ...preset, source: "Actor.mine" });
  refused(shop(), { op: "reset", preset: { version: 1, tier: "Hamlet" } });
});

test("reset refuses a preset config that isn't valid", () => {
  const result = resetToPreset(shop(), { version: 1, tier: "Hamlet" });
  assert.equal(result.ok, false);
  assert.equal(resetToPreset(shop(), null).ok, false);
});

test("a rate shows as a percentage without float noise", () => {
  assert.equal(percentOf(0.57), 57);
  assert.equal(percentOf(1.15), 115);
  assert.equal(percentOf(0.125), 12.5);
});
