import { test } from "node:test";
import assert from "node:assert/strict";
import {
  basketTotals, buyRow, coinAriaLabel, coinBreakdown, dealtIn, groupCategories, isGearItem, isVisibleStock,
  matchingStockLine, rateFraction, rateTag, sealState, sellRow, stepQuantity, stockLabel, titleParts
} from "../scripts/shop-view.mjs";

/** CONFIG.DND5E.currencies, 6.0.5 shape. */
const CURRENCIES = {
  pp: { conversion: 0.1, label: "Platinum Pieces", abbreviation: "pp", icon: "platinum.webp" },
  gp: { conversion: 1, label: "Gold Pieces", abbreviation: "gp", icon: "gold.webp" },
  ep: { conversion: 2, label: "Electrum Pieces", abbreviation: "ep", icon: "electrum.webp" },
  sp: { conversion: 10, label: "Silver Pieces", abbreviation: "sp", icon: "silver.webp" },
  cp: { conversion: 100, label: "Copper Pieces", abbreviation: "cp", icon: "copper.webp" }
};

/* -------------------------------------------------------------- titleParts */

test("a trailing settlement tier moves out of the title", () => {
  assert.deepEqual(titleParts("Armourer & Blacksmith (Town)"), { title: "Armourer & Blacksmith", tierFromName: "Town" });
  assert.deepEqual(titleParts("General Store (Village)"), { title: "General Store", tierFromName: "Village" });
});

test("a name with no tier suffix is the title as-is", () => {
  assert.deepEqual(titleParts("Aria's Curiosities"), { title: "Aria's Curiosities", tierFromName: null });
});

test("a name that merely contains parentheses elsewhere isn't mistaken for a tier", () => {
  assert.deepEqual(titleParts("The (Almost) Honest Trader"), { title: "The (Almost) Honest Trader", tierFromName: null });
});

/* -------------------------------------------------------------- coinBreakdown */

test("a price breaks into coins largest denomination first", () => {
  // 1250 cp, greedy over every configured denomination: 1 pp (1000), 2 gp (200), 1 ep (50).
  assert.deepEqual(coinBreakdown(1250, CURRENCIES).map(c => [c.denomination, c.count]), [["pp", 1], ["gp", 2], ["ep", 1]]);
});

test("a price breaks into only the denominations a leaner currency config defines", () => {
  const gpSpCp = { gp: CURRENCIES.gp, sp: CURRENCIES.sp, cp: CURRENCIES.cp };
  // 12 gp 5 sp = 1250 cp, with no platinum or electrum to reach for.
  assert.deepEqual(coinBreakdown(1250, gpSpCp).map(c => [c.denomination, c.count]), [["gp", 12], ["sp", 5]]);
});

test("a non-positive amount breaks into no coins", () => {
  assert.deepEqual(coinBreakdown(0, CURRENCIES), []);
  assert.deepEqual(coinBreakdown(-5, CURRENCIES), []);
});

test("a small amount still reaches for the coins that cover it", () => {
  // 12 cp is 1 sp 2 cp once silver is on the table.
  assert.deepEqual(coinBreakdown(12, CURRENCIES).map(c => [c.denomination, c.count]), [["sp", 1], ["cp", 2]]);
});

test("a coin's aria label reads as a lowercase count and name", () => {
  assert.equal(coinAriaLabel({ count: 15, label: "Gold Pieces" }), "15 gold pieces");
});

/* -------------------------------------------------------------- rateFraction */

test("a common trade ratio shows as its glyph", () => {
  assert.equal(rateFraction(0.5), "½");
  assert.equal(rateFraction(0.25), "¼");
  assert.equal(rateFraction(1), "1");
});

test("an uncommon ratio falls back to a whole percentage", () => {
  assert.equal(rateFraction(0.6), "60%");
  assert.equal(rateFraction(1.15), "115%");
});

/* -------------------------------------------------------------- rateTag */

test("a row at the shop's own chip rate carries no tag", () => {
  assert.deepEqual(rateTag({ rate: 1, layer: "shop" }, 1), { kind: null, text: null });
});

test("a row priced above the chip is an amber markup", () => {
  assert.deepEqual(rateTag({ rate: 1.25, layer: "category" }, 1), { kind: "markup", text: "+25%" });
});

test("a row priced below the chip is a green discount", () => {
  assert.deepEqual(rateTag({ rate: 0.9, layer: "deal" }, 1), { kind: "discount", text: "-10%" });
});

test("a category layer landing on full value tags 'Full value', not a percentage", () => {
  assert.deepEqual(rateTag({ rate: 1, layer: "category" }, 0.5), { kind: "full", text: null });
});

test("a category layer at full value that matches the chip needs no tag", () => {
  assert.deepEqual(rateTag({ rate: 1, layer: "category" }, 1), { kind: null, text: null });
});

test("a category layer away from full value is an ordinary markup or discount", () => {
  assert.deepEqual(rateTag({ rate: 0.75, layer: "category" }, 1), { kind: "discount", text: "-25%" });
});

/* -------------------------------------------------------------- groupCategories */

test("categories are counted and led by an All goods entry", () => {
  const rows = [{ category: "Weapons" }, { category: "Weapons" }, { category: "Armor" }];
  assert.deepEqual(groupCategories(rows), [
    { id: "all", label: "all", count: 3 },
    { id: "Weapons", label: "Weapons", count: 2 },
    { id: "Armor", label: "Armor", count: 1 }
  ]);
});

test("an empty stock still gets an All goods entry, at zero", () => {
  assert.deepEqual(groupCategories([]), [{ id: "all", label: "all", count: 0 }]);
});

/* -------------------------------------------------------------- basketTotals */

test("a buy basket's purse-after is what's left once it's paid", () => {
  assert.deepEqual(
    basketTotals([{ lineTotalCp: 1500 }, { lineTotalCp: 500 }], 5000, "buy"),
    { sumCp: 2000, afterCp: 3000, shortfallCp: 0 }
  );
});

test("a buy basket over the purse reports the shortfall and clamps purse-after at 0", () => {
  assert.deepEqual(
    basketTotals([{ lineTotalCp: 6000 }], 5000, "buy"),
    { sumCp: 6000, afterCp: 0, shortfallCp: 1000 }
  );
});

test("a sell basket's purse-after is what's gained, with no shortfall", () => {
  assert.deepEqual(
    basketTotals([{ lineTotalCp: 750 }], 300, "sell"),
    { sumCp: 750, afterCp: 1050, shortfallCp: 0 }
  );
});

/* -------------------------------------------------------------- sealState */

test("an idle basket with lines reads as ready to seal", () => {
  assert.deepEqual(sealState("idle", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: false, icon: "fa-solid fa-stamp" });
});

test("out-of-stock says there aren't that many left, and waits for the bill to change", () => {
  assert.deepEqual(sealState("out-of-stock", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.OutOfStock", disabled: true, icon: "fa-solid fa-ban" });
});

test("a refusal the window has no words for still reads as one, not as ready to seal", () => {
  for (const reason of ["not-visible", "shop-misconfigured", "wont-buy", "no-buyback", "unidentified"]) {
    assert.deepEqual(sealState(reason, true),
      { labelKey: "MERCHANT_PRESETS.Shop.Seal.Invalid", disabled: true, icon: "fa-solid fa-ban" }, reason);
  }
});

test("an idle, empty basket disables the seal without a refusal reason", () => {
  assert.equal(sealState("idle", false).disabled, true);
});

test("sealing shows a spinner and is disabled", () => {
  assert.deepEqual(sealState("sealing", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.Sealing", disabled: true, icon: "fa-solid fa-spinner fa-spin" });
});

test("sealed offers to keep shopping and is never disabled", () => {
  assert.deepEqual(sealState("sealed", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.KeepShopping", disabled: false, icon: "fa-solid fa-store" });
});

for (const [reason, labelKey] of [
  ["cant-afford", "MERCHANT_PRESETS.Shop.Seal.CantAfford"],
  ["till-short", "MERCHANT_PRESETS.Shop.Seal.TillShort"],
  ["closed", "MERCHANT_PRESETS.Shop.Seal.Closed"]
]) {
  test(`${reason} disables the seal with its own reason`, () => {
    const result = sealState(reason, true);
    assert.equal(result.labelKey, labelKey);
    assert.equal(result.disabled, true);
  });
}

test("no GM keeps the seal live, so the bill can be sent again once one connects", () => {
  assert.deepEqual(sealState("no-gm", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoGm", disabled: false, icon: "fa-solid fa-rotate-right" });
  assert.equal(sealState("no-gm", false).disabled, true);
});

test("stock-changed stays active, recomputed, unless it emptied the basket", () => {
  assert.equal(sealState("stock-changed", true).disabled, false);
  assert.equal(sealState("stock-changed", false).disabled, true);
});

/* -------------------------------------------------------------- stock rules */

test("shopkeeper gear is never stock, whatever else is true of it", () => {
  assert.equal(isGearItem({ flags: { "merchant-presets": { kind: "gear" } } }), true);
  assert.equal(isGearItem({ flags: { "merchant-presets": { kind: "food-drink" } } }), false);
  assert.equal(isGearItem({}), false);
});

test("a hidden or delisted line isn't a visible stock row, gear or not", () => {
  assert.equal(isVisibleStock({}, { hidden: false, notForSale: false }), true);
  assert.equal(isVisibleStock({}, { hidden: true, notForSale: false }), false);
  assert.equal(isVisibleStock({}, { hidden: false, notForSale: true }), false);
  assert.equal(isVisibleStock({ flags: { "merchant-presets": { kind: "gear" } } }, { hidden: false, notForSale: false }), false);
});

const shopConfig = { wontBuy: { types: ["consumable"], kinds: ["food-drink"] } };

test("a shop deals in ordinary goods outside its fixed and configured exclusions", () => {
  assert.equal(dealtIn({ type: "weapon", system: {} }, shopConfig), true);
});

test("a shop never deals in the fixed-excluded types, whatever wontBuy says", () => {
  assert.equal(dealtIn({ type: "spell", system: {} }, { wontBuy: { types: [], kinds: [] } }), false);
  assert.equal(dealtIn({ type: "feat", system: {} }, { wontBuy: { types: [], kinds: [] } }), false);
});

test("a shop never buys a natural weapon", () => {
  assert.equal(dealtIn({ type: "weapon", system: { type: { value: "natural" } } }, shopConfig), false);
});

test("a shop's own configured wontBuy refuses by type or by kind flag", () => {
  assert.equal(dealtIn({ type: "consumable", system: {} }, shopConfig), false);
  assert.equal(dealtIn({ type: "loot", system: {}, flags: { "merchant-presets": { kind: "food-drink" } } }, shopConfig), false);
});

test("shopkeeper gear is never bought back, even if its type would otherwise pass", () => {
  assert.equal(dealtIn({ type: "weapon", system: {}, flags: { "merchant-presets": { kind: "gear" } } }, shopConfig), false);
});

/* -------------------------------------------------------------- stockLabel */

test("a service or infinite line always reads 'Always'", () => {
  assert.deepEqual(stockLabel({ service: true, infinite: null }, 0, false), { state: "always", text: null, count: null });
  assert.deepEqual(stockLabel({ service: false, infinite: true }, 0, false), { state: "always", text: null, count: null });
  assert.deepEqual(stockLabel({ service: false, infinite: null }, 5, true), { state: "always", text: null, count: null });
});

test("a finite line at zero is sold out, at one is the last one, otherwise a count", () => {
  const stock = { service: false, infinite: false };
  assert.deepEqual(stockLabel(stock, 0, false), { state: "soldOut", text: null, count: 0 });
  assert.deepEqual(stockLabel(stock, 1, false), { state: "last", text: null, count: 1 });
  assert.deepEqual(stockLabel(stock, 7, false), { state: "count", text: null, count: 7 });
});

/* -------------------------------------------------------------- buyRow / sellRow */

const CURRENCIES5E = {
  pp: { conversion: 0.1 }, gp: { conversion: 1 }, ep: { conversion: 2 }, sp: { conversion: 10 }, cp: { conversion: 100 }
};

test("a buy row prices at the category rate and carries the fallback category", () => {
  const item = { _id: "i1", img: "img.webp", name: "Longsword", type: "weapon", system: { price: { value: 15, denomination: "gp" }, quantity: 7 } };
  const stock = { category: "", bundle: 1, service: false, infinite: false, hidden: false, notForSale: false, noBuyback: false, keep: true };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1 };
  const row = buyRow(item, stock, rates, null, CURRENCIES5E, false);
  assert.equal(row.category, "weapon");   // stock.category empty: falls back to item.type
  assert.equal(row.bundlePriceCp, 1500);
  assert.equal(row.unpriced, false);
  assert.deepEqual(row.tag, { kind: null, text: null });
  assert.deepEqual(row.stock, { state: "count", text: null, count: 7 });
});

test("an unpriced item (no price data) reads as unpriced rather than throwing", () => {
  const item = { _id: "i2", img: "img.webp", name: "Trophy", type: "loot", system: { price: { value: 1, denomination: "doubloon" }, quantity: 1 } };
  const stock = { category: "Gear", bundle: 1, service: false, infinite: false };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1 };
  const row = buyRow(item, stock, rates, null, CURRENCIES5E, false);
  assert.equal(row.unpriced, true);
  assert.equal(row.bundlePriceCp, null);
});

test("a sell row for an unidentified item never prices — the shop can't see what it is", () => {
  const item = { _id: "i3", img: "i.webp", name: "Ring", system: { identified: false, quantity: 1 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const row = sellRow(item, shopConfig, { category: "", bundle: 1, service: false, noBuyback: false }, rates, null, CURRENCIES5E);
  assert.equal(row.refusal, "Unidentified");
  assert.equal(row.bundlePriceCp, null);
});

test("a sell row the shop deals in prices at its buysAt and carries the ratio glyph", () => {
  const item = { _id: "i4", img: "i.webp", name: "Longsword", type: "weapon", system: { price: { value: 15, denomination: "gp" }, quantity: 1, equipped: true } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const row = sellRow(item, shopConfig, { category: "", bundle: 1, service: false, noBuyback: false }, rates, null, CURRENCIES5E);
  assert.equal(row.refusal, null);
  assert.equal(row.bundlePriceCp, 750);
  assert.equal(row.ratio, "½");
  assert.equal(row.equipped, true);
});

/* -------------------------------------------------------------- matchingStockLine */

test("a sold item matches the shop's shelf by compendium source first", () => {
  const shopItems = [
    { _id: "s1", name: "Longsword", _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.abc" }, flags: {} }
  ];
  const item = { name: "Longsword (renamed)", _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.abc" } };
  assert.equal(matchingStockLine(item, shopItems)?._id, "s1");
});

test("a sold item with no source falls back to matching by name", () => {
  const shopItems = [{ _id: "s2", name: "Dagger", flags: {} }];
  assert.equal(matchingStockLine({ name: "Dagger" }, shopItems)?._id, "s2");
});

test("shopkeeper gear is never matched, even by name", () => {
  const shopItems = [{ _id: "s3", name: "Warhammer", flags: { "merchant-presets": { kind: "gear" } } }];
  assert.equal(matchingStockLine({ name: "Warhammer" }, shopItems), undefined);
});

test("goods the shop has never carried match nothing", () => {
  assert.equal(matchingStockLine({ name: "A Very Unusual Hat" }, []), undefined);
});

/* -------------------------------------------------------------- parity with trade-plan.mjs */

test("a sell row on the default category prices by its item type's category rule, as a sale does", () => {
  const item = { _id: "i5", img: "i.webp", name: "Longsword", type: "weapon", system: { price: { value: 15, denomination: "gp" }, quantity: 1 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [{ category: "weapon", sellsAt: 1.5, buysAt: 0.25 }] }, chipBuysAt: 0.5 };
  const row = sellRow(item, shopConfig, { category: "", bundle: 1, service: false, noBuyback: false }, rates, null, CURRENCIES5E);
  assert.equal(row.bundlePriceCp, 375);
});

test("the Buy tab hides what a buy would refuse: contained, natural, unidentified", () => {
  const shown = { hidden: false, notForSale: false };
  assert.equal(isVisibleStock({ system: { container: "Bag0000000000001" } }, shown), false);
  assert.equal(isVisibleStock({ type: "weapon", system: { type: { value: "natural" } } }, shown), false);
  assert.equal(isVisibleStock({ system: { identified: false } }, shown), false);
});

test("the Buy tab hides a container holding something the shop won't hand over, as a buy does", () => {
  const shown = { hidden: false, notForSale: false };
  const bag = { _id: "Bag0000000000001", type: "container", system: {} };
  const gear = { _id: "Gear000000000001", system: { container: bag._id }, flags: { "merchant-presets": { kind: "gear" } } };
  const rope = { _id: "Rope000000000001", system: { container: bag._id } };
  assert.equal(isVisibleStock(bag, shown, [bag, rope]), true);
  assert.equal(isVisibleStock(bag, shown, [bag, rope, gear]), false);
});

test("a sold item whose source isn't on the shelf still matches by name, as a sale does", () => {
  const shopItems = [{ _id: "s4", name: "Dagger", _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.xyz" }, flags: {} }];
  const item = { name: "Dagger", _stats: { compendiumSource: "Compendium.world.homebrew.Item.q" } };
  assert.equal(matchingStockLine(item, shopItems)?._id, "s4");
});

/* -------------------------------------------------------------- the buy stepper */

test("a buy stepper steps by whole bundles", () => {
  assert.equal(stepQuantity(0, 1, { bundle: 20, available: 300, infinite: false }), 20);
  assert.equal(stepQuantity(40, -1, { bundle: 20, available: 300, infinite: false }), 20);
  assert.equal(stepQuantity(20, -1, { bundle: 20, available: 300, infinite: false }), 0);
  assert.equal(stepQuantity(300, 1, { bundle: 20, available: 300, infinite: false }), 300);   // nothing more
  assert.equal(stepQuantity(0, 1, { bundle: 20, available: 5, infinite: true }), 20);        // infinite: no ceiling
});

test("a buy stepper reaches a sold-back part-bundle, and steps back off it", () => {
  const shelf = { bundle: 20, available: 305, infinite: false };
  assert.equal(stepQuantity(300, 1, shelf), 305);
  assert.equal(stepQuantity(305, -1, shelf), 300);
  assert.equal(stepQuantity(0, 1, { bundle: 20, available: 5, infinite: false }), 5);
});

/* -------------------------------------------------------------- sell refusals the planner makes */

test("a sell row that would pay nothing even for all of it is worthless", () => {
  const nail = { _id: "i6", img: "i.webp", name: "Bent Nail", type: "loot", system: { price: { value: 1, denomination: "cp" }, quantity: 1 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const row = sellRow(nail, shopConfig, { category: "", bundle: 1, service: false, noBuyback: false }, rates, null, CURRENCIES5E);
  assert.equal(row.refusal, "Worthless");
});

test("a container with something in it is refused until it's emptied", () => {
  const pack = { _id: "i7", img: "i.webp", name: "Backpack", type: "container", system: { price: { value: 2, denomination: "gp" }, quantity: 1 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const stock = { category: "", bundle: 1, service: false, noBuyback: false };
  assert.equal(sellRow(pack, shopConfig, stock, rates, null, CURRENCIES5E, { hasContents: true }).refusal, "NotEmpty");
  assert.equal(sellRow(pack, shopConfig, stock, rates, null, CURRENCIES5E).refusal, null);
});

test("the seal button explains the planner's other refusals instead of offering the bargain", () => {
  for (const reason of ["worthless", "container-not-empty", "unpriced", "invalid-request"]) {
    const seal = sealState(reason, true);
    assert.equal(seal.disabled, true, reason);
    assert.notEqual(seal.labelKey, "MERCHANT_PRESETS.Shop.Seal.Bargain", reason);
  }
});
