import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveRates, itemPriceCp, pay, totalCp } from "../scripts/pricing.mjs";

/** CONFIG.DND5E.currencies, 6.0.5 shape: conversion is coins per reference unit (gp). */
const DND5E_CURRENCIES = {
  pp: { conversion: 0.1 },
  gp: { conversion: 1 },
  ep: { conversion: 2 },
  sp: { conversion: 10 },
  cp: { conversion: 100 }
};

/* --------------------------------------------------------------- itemPriceCp */

test("a base-price item in cp: price times rate, no bundle", () => {
  assert.equal(itemPriceCp({ value: 5, denomination: "gp" }, 1, 1, DND5E_CURRENCIES), 500);
  assert.equal(itemPriceCp({ value: 5, denomination: "gp" }, 0.5, 1, DND5E_CURRENCIES), 250);
});

test("a bundle priced per 10 divides the price by the bundle", () => {
  // A pack of 10 arrows for 1 gp: one arrow costs a tenth of the pack.
  const arrow = itemPriceCp({ value: 1, denomination: "gp" }, 1, 10, DND5E_CURRENCIES);
  assert.equal(arrow, 10);
});

test("a zero-price 'Worthless' item prices at 0, whatever the rate or bundle", () => {
  assert.equal(itemPriceCp({ value: 0, denomination: "gp" }, 1, 1, DND5E_CURRENCIES), 0);
  assert.equal(itemPriceCp({ value: 0, denomination: "sp" }, 2.5, 5, DND5E_CURRENCIES), 0);
});

test("a fractional cp result rounds down, per the module's rounding decision", () => {
  // 1 cp split three ways: a third of a copper piece is worth nothing.
  assert.equal(itemPriceCp({ value: 1, denomination: "cp" }, 1, 3, DND5E_CURRENCIES), 0);
  // 7 sp at a generous 0.9 buysAt over a bundle of 4: 15.75cp, floored.
  assert.equal(itemPriceCp({ value: 7, denomination: "sp" }, 0.9, 4, DND5E_CURRENCIES), 15);
});

test("a rate that lands exactly on a whole cp isn't knocked down by float noise", () => {
  // 15gp * 1.15 is 1724.9999999999998 in plain float arithmetic; the true price is 1725.
  assert.equal(itemPriceCp({ value: 15, denomination: "gp" }, 1.15, 1, DND5E_CURRENCIES), 1725);
  assert.equal(itemPriceCp({ value: 10, denomination: "gp" }, 0.7, 1, DND5E_CURRENCIES), 700);
  assert.equal(itemPriceCp({ value: 10, denomination: "gp" }, 1.1, 1, DND5E_CURRENCIES), 1100);
});

test("an unknown denomination is rejected", () => {
  assert.throws(() => itemPriceCp({ value: 1, denomination: "platinum" }, 1, 1, DND5E_CURRENCIES), RangeError);
});

test("a homebrew currency prices the same way, off the config alone", () => {
  // A two-coin economy: shards (fine) and chips (coarse), 20 shards to a chip.
  const homebrew = { shard: { conversion: 20 }, chip: { conversion: 1 } };
  assert.equal(itemPriceCp({ value: 3, denomination: "chip" }, 1, 1, homebrew), 60);
  assert.equal(itemPriceCp({ value: 45, denomination: "shard" }, 1, 1, homebrew), 45);
});

/* ------------------------------------------------------------- effectiveRates */

const world = { sellsAt: 1, buysAt: 0.5 };
const noTerms = { sellsAt: null, buysAt: null, categories: [] };

test("with nothing set, both rates are the world default", () => {
  const { sellsAt, buysAt } = effectiveRates(world, noTerms);
  assert.deepEqual(sellsAt, { rate: 1, layer: "world" });
  assert.deepEqual(buysAt, { rate: 0.5, layer: "world" });
});

test("each layer overrides the one before it, and reports having done so", () => {
  const shop = { sellsAt: 1.1, buysAt: 0.4, categories: [{ category: "Valuables", sellsAt: 1, buysAt: 1 }] };

  // Layer 2: shop terms override the world default.
  let rates = effectiveRates(world, shop);
  assert.deepEqual(rates.sellsAt, { rate: 1.1, layer: "shop" });
  assert.deepEqual(rates.buysAt, { rate: 0.4, layer: "shop" });

  // Layer 3: a matching category rule overrides the shop terms.
  rates = effectiveRates(world, shop, "Valuables");
  assert.deepEqual(rates.sellsAt, { rate: 1, layer: "category" });
  assert.deepEqual(rates.buysAt, { rate: 1, layer: "category" });

  // A category that doesn't match this shop's rules falls back to the shop terms.
  rates = effectiveRates(world, shop, "Gemstones");
  assert.deepEqual(rates.sellsAt, { rate: 1.1, layer: "shop" });

  // Layer 4: a deal overrides whichever layer set the rate before it. Here the
  // sale deal pushes buysAt (1.05) past sellsAt (0.9), so the cap catches it.
  rates = effectiveRates(world, shop, "Valuables", { buy: -0.1, sell: 0.05 });
  assert.deepEqual(rates.sellsAt, { rate: 0.9, layer: "deal" });
  assert.deepEqual(rates.buysAt, { rate: 0.9, layer: "cap" });
});

test("a deal is a percentage of this shop's own rate, not a flat add", () => {
  // A shop marked up 25% (sellsAt 1.25) with a character's "10% off" deal
  // charges 1.25 * 0.9 = 1.125, not 1.25 - 0.1 = 1.15.
  const shop = { sellsAt: 1.25, buysAt: 1, categories: [] };
  const rates = effectiveRates(world, shop, null, { buy: -0.1 });
  assert.deepEqual(rates.sellsAt, { rate: 1.125, layer: "deal" });
});

test("a null shop term follows the world default instead of overriding it", () => {
  const rates = effectiveRates(world, { sellsAt: null, buysAt: 0.6, categories: [] });
  assert.deepEqual(rates.sellsAt, { rate: 1, layer: "world" });
  assert.deepEqual(rates.buysAt, { rate: 0.6, layer: "shop" });
});

test("the cap holds under a stacked deal on generous shop terms", () => {
  // A shop marked up 25% (sellsAt 1.25) that already buys generously (0.9), plus a
  // character's 10% off purchases and +30% deal on sales: sellsAt lands at 1.25 * 0.9 =
  // 1.125 (the lead's worked example), and buysAt would reach 0.9 * 1.3 = 1.17 without the
  // cap, which is more than the shop would ever charge that character.
  const shop = { sellsAt: 1.25, buysAt: 0.9, categories: [] };
  const rates = effectiveRates(world, shop, null, { buy: -0.1, sell: 0.3 });
  assert.deepEqual(rates.sellsAt, { rate: 1.125, layer: "deal" });
  assert.equal(rates.buysAt.rate, rates.sellsAt.rate);
  assert.equal(rates.buysAt.layer, "cap");
});

test("the cap doesn't fire when the stack stays under sellsAt", () => {
  const shop = { sellsAt: 1, buysAt: 0.5, categories: [] };
  const rates = effectiveRates(world, shop, null, { sell: 0.2 });
  assert.deepEqual(rates.buysAt, { rate: 0.6, layer: "deal" });   // 0.5 * 1.2, not 0.5 + 0.2
});

/* --------------------------------------------------------------------- pay */

test("exact coins need no change, and the till just receives them", () => {
  const purse = { pp: 0, gp: 0, ep: 0, sp: 3, cp: 0 };
  const till = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  const result = pay(purse, 30, till, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 0);
  assert.equal(result.purse.sp, 0);
  assert.equal(result.till.sp, 3);
});

test("a purse holding only large coins pays with one and gets change back", () => {
  // Only gold on hand, paying a 1 sp (10 cp) price.
  const purse = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };
  const till = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 90 };   // exactly the change owed, 90cp
  const result = pay(purse, 10, till, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.purse.gp, 0);
  assert.equal(result.changeCp, 90);
  assert.equal(totalCp(result.purse, DND5E_CURRENCIES), 90);   // the gold went in, 90cp of change came back
});

test("change that needs electrum comes from breaking the till's coins as needed", () => {
  const purse = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };   // pays a 30cp price, wants 70cp change
  const till = { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 };    // only a platinum piece (1000cp) on hand
  const result = pay(purse, 30, till, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 70);
  // 70cp breaks down as 1 ep (50cp) + 2 sp (20cp): the smallest coin count that hits it exactly.
  assert.equal(result.purse.ep, 1);
  assert.equal(result.purse.sp, 2);
});

test("a till with enough total value but none of the needed coin still pays out", () => {
  const purse = { pp: 0, gp: 2, ep: 0, sp: 0, cp: 0 };   // pays a 150cp price with 2 gold, wants 50cp change
  const till = { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 };    // 1000cp total, but no sp/cp/ep on hand
  const result = pay(purse, 150, till, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 50);
  assert.equal(totalCp(result.purse, DND5E_CURRENCIES), 50);
  // The till only breaks what it must; net it only ever gains the price (150).
  assert.equal(totalCp(result.till, DND5E_CURRENCIES), 1150);
});

test("a till giving change from its own gold doesn't turn into platinum", () => {
  // 212 gold in the till, paying out 90cp of change on a 10cp price — a re-minted
  // till would express its new 21290cp total canonically as pp/gp/ep/sp, losing
  // almost all of its gold to platinum. The till should stay gold, breaking only
  // as many coins as the change actually needs.
  const purse = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };
  const till = { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 };
  const result = pay(purse, 10, till, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 90);
  assert.equal(result.till.gp, 212);        // the gold count is exactly what it started at
  assert.equal(result.till.pp ?? 0, 0);     // and no platinum ever appears
  assert.equal(totalCp(result.till, DND5E_CURRENCIES), 21200 + 10);   // net gain is just the price
});

test("paying the other way round leaves the payee's untouched coins alone", () => {
  // A sale: the shop's till pays the player, so the shop's coins go in as `purse`
  // and the player's own purse is the `till` receiving payment and giving change.
  // The player already holds some unrelated copper that the trade never needs.
  const shopTill = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };     // pays a 70cp price
  const playerPurse = { pp: 0, gp: 0, ep: 0, sp: 5, cp: 8 };  // 58cp on hand already
  const result = pay(shopTill, 70, playerPurse, DND5E_CURRENCIES);
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 30);
  assert.equal(result.till.cp, 8);   // the player's existing copper never had to move
});

test("a price the purse can't cover is refused, without touching the till", () => {
  const purse = { pp: 0, gp: 0, ep: 0, sp: 1, cp: 0 };   // 10cp total
  const till = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 1000 };
  const result = pay(purse, 11, till, DND5E_CURRENCIES);
  assert.deepEqual(result, { ok: false, reason: "purse" });
});

test("a till that's short on total refuses the trade", () => {
  const purse = { pp: 0, gp: 1, ep: 0, sp: 0, cp: 0 };   // pays 100cp, wants 90cp change
  const till = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 5 };    // only 5cp on hand
  const result = pay(purse, 10, till, DND5E_CURRENCIES);
  assert.deepEqual(result, { ok: false, reason: "till" });
});

test("a homebrew currency purse pays and makes change off its own config", () => {
  const homebrew = { chip: { conversion: 1 }, shard: { conversion: 20 } };   // 1 chip = 20 shards
  const purse = { chip: 1, shard: 0 };
  const till = { chip: 0, shard: 25 };   // 25 shards = 1.25 chips, enough for 5 shards' change
  const result = pay(purse, 15, till, homebrew);   // 15 shards' worth
  assert.equal(result.ok, true);
  assert.equal(result.changeCp, 5);
  assert.equal(result.purse.shard, 5);
});
