/**
 * The GM's Settings tab edits (#110), as plain config in, config out: every change comes back as
 * a full, valid shop config, or is refused with nothing to write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHOP_DEFAULTS, shopFrom, validateShop } from "../scripts/schema.mjs";
import { applyChange, dealFields, dealReading, everyChoice, hoursSamples, openMinutes, parseTime, percentOf, quantityRows, resetToPreset, tableIsPreset, timeText, wholeCoins } from "../scripts/shop-settings.mjs";

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
  // Removing a rule that's gone (a second click) changes nothing, and isn't an error.
  assert.deepEqual(applied(config, { op: "removeRule", category: "armor" }), config);
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

/* ------------------------------------------------------------ quantities and table (#190) */

const PRESET_TABLE = "Compendium.merchant-presets.stock.RollTable.QxBxVISyvQqNO94G";
const preset190 = shop({ restock: { table: PRESET_TABLE, quantities: { r1: "2d6+4", r2: "1d2" } } });

test("a line's formula is set, and blanking it puts the preset's back, or hands it to New lines", () => {
  let config = applied(preset190, { op: "quantity", id: "r1", formula: " 1d4 ", preset: preset190 });
  assert.equal(config.restock.quantities.r1, "1d4", "trimmed");
  config = applied(config, { op: "quantity", id: "r1", formula: "", preset: preset190 });
  assert.equal(config.restock.quantities.r1, "2d6+4", "the preset's own formula");
  config = applied(config, { op: "quantity", id: "gm1", formula: "3", preset: preset190 });
  assert.equal(config.restock.quantities.gm1, "3");
  config = applied(config, { op: "quantity", id: "gm1", formula: "  ", preset: preset190 });
  assert.equal(Object.hasOwn(config.restock.quantities, "gm1"), false, "a line the preset never had falls to New lines");
  config = applied(config, { op: "quantity", id: "r2", formula: "", preset: null });
  assert.equal(Object.hasOwn(config.restock.quantities, "r2"), false, "no preset to restore from");
  refused(config, { op: "quantity", id: "r1", formula: "lots", preset: preset190 });
  refused(config, { op: "quantity", id: "", formula: "1", preset: preset190 });
});

test("New lines takes a formula, and blank sets it back to 1", () => {
  let config = applied(preset190, { op: "defaultQuantity", formula: "1d4" });
  assert.equal(config.restock.default, "1d4");
  config = applied(config, { op: "defaultQuantity", formula: "" });
  assert.equal(config.restock.default, null);
  refused(config, { op: "defaultQuantity", formula: "some" });
});

test("a new stock table keeps the formulas of the lines it shares with the old one", () => {
  const config = applied(preset190, { op: "table", uuid: "RollTable.mine", resultIds: ["r1", "new"] });
  assert.equal(config.restock.table, "RollTable.mine");
  assert.deepEqual(config.restock.quantities, { r1: "2d6+4" });
  refused(preset190, { op: "table", uuid: "", resultIds: [] });
  refused(preset190, { op: "table", uuid: "RollTable.mine" });
});

test("resetting the table puts back the preset's table and formulas, and nothing else", () => {
  let config = applied(preset190, { op: "table", uuid: "RollTable.mine", resultIds: ["new"] });
  config = applied(config, { op: "defaultQuantity", formula: "2" });
  config = applied(config, { op: "mode", mode: "topup" });
  config = applied(config, { op: "resetTable", preset: preset190 });
  assert.deepEqual(config.restock, { ...preset190.restock, mode: "topup" });
  refused(config, { op: "resetTable", preset: null });
});

test("the table matches its preset until the table, a formula or New lines changes", () => {
  assert.equal(tableIsPreset(preset190.restock, preset190.restock), true);
  assert.equal(tableIsPreset(preset190.restock, null), true, "no preset: nothing to reset to");
  assert.equal(tableIsPreset({ ...preset190.restock, table: "RollTable.mine" }, preset190.restock), false);
  assert.equal(tableIsPreset({ ...preset190.restock, quantities: { r1: "1", r2: "1d2" } }, preset190.restock), false);
  assert.equal(tableIsPreset({ ...preset190.restock, quantities: { r2: "1d2", r1: "2d6+4" } }, preset190.restock), true, "key order doesn't matter");
  assert.equal(tableIsPreset({ ...preset190.restock, default: "2" }, preset190.restock), false);
});

test("the quantity list shows each line's own formula, or New lines as its placeholder", () => {
  const lines = [{ id: "r1", name: "Chain" }, { id: "gm1", name: "Shovel" }];
  assert.deepEqual(quantityRows(lines, { quantities: { r1: "2d6+4" }, default: "1d4" }), [
    { id: "r1", name: "Chain", value: "2d6+4", placeholder: "1d4" },
    { id: "gm1", name: "Shovel", value: "", placeholder: "1d4" }
  ]);
  assert.equal(quantityRows(lines, { quantities: {}, default: null })[1].placeholder, "1");
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

test("a rule's side can be handed back to the shop's rate, but not both sides (#143 review)", () => {
  let config = applied(shop(), { op: "addRule", category: "Valuables", world: WORLD });
  config = applied(config, { op: "ruleRate", category: "Valuables", side: "sellsAt", percent: null });
  assert.deepEqual(config.terms.categories[0], { category: "Valuables", sellsAt: null, buysAt: 0.5 });
  refused(config, { op: "ruleRate", category: "Valuables", side: "buysAt", percent: null });
});

/* ---------------------------------------------------------- Hours preview (design S2swP) */

const DAYS = { minutesPerHour: 60, hoursPerDay: 24, secondsPerMinute: 60 };
const SMITH = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };

test("Players see an open hour and a closed one: now for whichever the shop is, the other beside it", () => {
  // 10:00, open: now, and four hours before it opens (3:00, the Closed frame's hour).
  assert.deepEqual(hoursSamples(SMITH, 600, DAYS), { open: 600, closed: 180 });
  // 3:00, closed: now, and its opening.
  assert.deepEqual(hoursSamples(SMITH, 180, DAYS), { open: 420, closed: 180 });
  // Past midnight: a tavern open 18:00-02:00, at 20:00, closed at 14:00.
  assert.deepEqual(hoursSamples({ open: { hour: 18, minute: 0 }, close: { hour: 2, minute: 0 } }, 1200, DAYS), { open: 1200, closed: 840 });
});

test("a shop open around the clock has no closed hour to show", () => {
  assert.deepEqual(hoursSamples(null, 600, DAYS), { open: 600, closed: null });
  assert.deepEqual(hoursSamples({ open: { hour: 0, minute: 0 }, close: { hour: 23, minute: 59 } }, 600, DAYS), { open: 600, closed: null });
});

test("how long the shop is open a day, past midnight too", () => {
  assert.equal(openMinutes(SMITH, DAYS), 720);
  assert.equal(openMinutes({ open: { hour: 18, minute: 0 }, close: { hour: 2, minute: 30 } }, DAYS), 510);
  assert.equal(openMinutes(null, DAYS), null);
});

/* ---------------------------------------------------------- the deal form (design Q6UvA) */

test("a deal side reads in plain words beside its field", () => {
  assert.deepEqual(dealReading("buy", "−10"), { key: "BuyLess", percent: 10 });
  assert.deepEqual(dealReading("buy", "15"), { key: "BuyMore", percent: 15 });
  assert.deepEqual(dealReading("sell", "20"), { key: "SellMore", percent: 20 });
  assert.deepEqual(dealReading("sell", "-5"), { key: "SellLess", percent: 5 });
  // Blank, zero or not a number: the shop's own price.
  for (const blank of ["", "0", "abc", null]) assert.deepEqual(dealReading("buy", blank), { key: "ShopPrice", percent: null });
});

test("a deal's percent takes a true minus as typed or pasted (design Q6UvA)", () => {
  const fields = dealFields({ actor: "Actor.a", buy: "−10", sell: "", ends: "never", days: null, note: "" },
    { name: "Aria", worldTime: 0, hours: null, calendar: DAYS, previous: null });
  assert.equal(fields.buy, -10);
  assert.equal(fields.sell, null);
});

test("a deal can't end after some days where shops don't follow the world clock (#149, #161 review)", () => {
  const form = { actor: "Actor.a", buy: "−10", sell: "", ends: "days", days: 3, note: "" };
  const context = { name: "A", worldTime: 0, hours: null, calendar: { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 }, previous: null };
  assert.ok(dealFields(form, { ...context, clock: false }).error);
  assert.equal(dealFields(form, context).ends.when, "date");
});

test("a till field takes a whole number of coins, and nothing else (#147)", () => {
  for (const [text, count] of [["212", 212], [" 0 ", 0], ["07", 7]]) assert.equal(wholeCoins(text), count, text);
  for (const text of ["", "  ", "-3", "1.5", "12gp", "abc", "1e3", "+5"]) assert.equal(wholeCoins(text), null, text);
});

test("the Customers table card names a busy-day table, or goes back to the shipped one (#226)", () => {
  const own = applyChange(shop(), { op: "customersTable", uuid: "RollTable.mine" });
  assert.equal(own.ok, true);
  assert.equal(own.shop.customers.table, "RollTable.mine");
  assert.equal(applyChange(own.shop, { op: "customersTable", uuid: null }).shop.customers.table, null);
});
