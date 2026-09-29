import { test } from "node:test";
import assert from "node:assert/strict";
import {
  basketTotals, buyRow, coinAriaLabel, coinBreakdown, dealtIn, groupCategories, isGearItem, isVisibleStock,
  fitQuantity, isFresh, isNewGood, daysUntil, presetSchedule, commonFormula, itemMeta, matchingStockLine, sellRowMeta, sellWorth, wontBuyReason, wontBuyTerms, compactMeta, billSummary, partOfDay, purseAfter, rateFraction, rateTag, sealState, sellRow, shelfGroup, signedPercent,
  stepQuantity, stockLabel, titleParts, goodName, levelService, sealsShort, inspectTargets, itemTooltipHtml, shelfCardProperties,
  currentSection
} from "../scripts/shop-view.mjs";

/** CONFIG.DND5E.currencies, 6.0.5 shape. */
const CURRENCIES = {
  pp: { conversion: 0.1, label: "Platinum Pieces", abbreviation: "pp", icon: "platinum.webp" },
  gp: { conversion: 1, label: "Gold Pieces", abbreviation: "gp", icon: "gold.webp" },
  ep: { conversion: 2, label: "Electrum Pieces", abbreviation: "ep", icon: "electrum.webp" },
  sp: { conversion: 10, label: "Silver Pieces", abbreviation: "sp", icon: "silver.webp" },
  cp: { conversion: 100, label: "Copper Pieces", abbreviation: "cp", icon: "copper.webp" }
};

/* -------------------------------------------------------------- SRD food and drink (#150) */

const SRD_RATIONS = { type: "consumable", name: "Rations", system: { type: { value: "food" } }, flags: {} };
const SMITH_WONT_BUY = { wontBuy: { types: [], kinds: ["food-drink", "meal"] } };

test("a smith that won't buy food and drink refuses SRD rations, which carry no kind of ours (#150)", () => {
  assert.equal(dealtIn(SRD_RATIONS, SMITH_WONT_BUY), false);
  assert.deepEqual(wontBuyReason(SRD_RATIONS, SMITH_WONT_BUY), { kind: "food-drink" });
});

test("our own kind wins over dnd5e's food type: a meal is a meal (#150)", () => {
  const meal = { ...SRD_RATIONS, name: "Meal, Modest", flags: { "merchant-presets": { kind: "meal" } } };
  assert.deepEqual(wontBuyReason(meal, { wontBuy: { types: [], kinds: ["food-drink"] } }), null);
});

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

test("a price reads in everyday coin, as the design writes it: 12 gp 5 sp, not 1 pp 2 gp 1 ep", () => {
  assert.deepEqual(coinBreakdown(1250, CURRENCIES).map(c => [c.denomination, c.count]), [["gp", 12], ["sp", 5]]);
  assert.deepEqual(coinBreakdown(1500, CURRENCIES).map(c => [c.denomination, c.count]), [["gp", 15]]);
});

test("a currency config without gold, silver or copper breaks over what it has", () => {
  const pp = { pp: CURRENCIES.pp };
  // Amounts count in the config's finest coin, which here is the platinum piece itself.
  assert.deepEqual(coinBreakdown(3, pp).map(c => [c.denomination, c.count]), [["pp", 3]]);
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
  assert.deepEqual(rateTag({ rate: 0.9, layer: "deal" }, 1), { kind: "discount", text: "−10%" });
});

test("a category layer landing on full value tags 'Full value', not a percentage", () => {
  assert.deepEqual(rateTag({ rate: 1, layer: "category" }, 0.5), { kind: "full", text: null });
});

test("a category layer at full value that matches the chip needs no tag", () => {
  assert.deepEqual(rateTag({ rate: 1, layer: "category" }, 1), { kind: null, text: null });
});

test("a category layer away from full value is an ordinary markup or discount", () => {
  assert.deepEqual(rateTag({ rate: 0.75, layer: "category" }, 1), { kind: "discount", text: "−25%" });
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
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: false, icon: "lucide:stamp" });
});

test("out-of-stock says there aren't that many left, and waits for the bill to change", () => {
  assert.deepEqual(sealState("out-of-stock", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.OutOfStock", disabled: true, icon: "lucide:circle-slash" });
});

test("a refusal the window has no words for still reads as one, not as ready to seal", () => {
  for (const reason of ["not-visible", "shop-misconfigured", "wont-buy", "no-buyback", "unidentified"]) {
    assert.deepEqual(sealState(reason, true),
      { labelKey: "MERCHANT_PRESETS.Shop.Seal.Invalid", disabled: true, icon: "lucide:circle-slash" }, reason);
  }
});

test("an idle, empty basket disables the seal without a refusal reason", () => {
  assert.equal(sealState("idle", false).disabled, true);
});

test("sealing shows a spinner and is disabled", () => {
  assert.deepEqual(sealState("sealing", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.Sealing", disabled: true, icon: "lucide:loader" });
});

test("sealed offers to keep shopping and is never disabled", () => {
  assert.deepEqual(sealState("sealed", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.KeepShopping", disabled: false, icon: "lucide:store" });
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

test("an unanswered bill keeps the seal live while a GM is online, so it can be sent again", () => {
  assert.deepEqual(sealState("no-gm", true),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoGm", disabled: false, icon: "lucide:hourglass" });
  assert.equal(sealState("no-gm", false).disabled, true);
});

test("with no GM at the table the seal waits for one (design WNYhA, state 4)", () => {
  assert.deepEqual(sealState("no-gm", true, { gmOnline: false }),
    { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoGmWaiting", disabled: true, icon: "lucide:hourglass" });
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

test("a buy row with no bundle of its own reads it through the runtime's bundleOf, as the trade does (#102)", () => {
  // A GM dragged SRD Arrows straight onto the shelf: no stock flags, so no stated bundle.
  const item = { _id: "a1", img: "a.webp", name: "Arrows", type: "consumable", flags: {},
    _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.arrows" }, system: { price: { value: 1, denomination: "gp" }, quantity: 60 } };
  const stock = { category: "", service: false, infinite: false, hidden: false, notForSale: false, noBuyback: false, keep: true };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1 };
  const bundleOf = i => (i._stats?.compendiumSource?.endsWith(".arrows") ? 20 : undefined);
  assert.equal(buyRow(item, stock, rates, null, CURRENCIES5E, false, bundleOf).bundle, 20);
  assert.equal(buyRow(item, stock, rates, null, CURRENCIES5E, false).bundle, 1);
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

test("a sell row knows the fewest that sell for a coin, and a lone copper piece isn't one at half", () => {
  const chalk = { _id: "c1", img: "", name: "Chalk", type: "loot", system: { price: { value: 1, denomination: "cp" }, quantity: 5 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const shop = { wontBuy: { types: [], kinds: [] } };
  const row = sellRow(chalk, shop, { category: "", bundle: 1, service: false, noBuyback: false }, rates, null, CURRENCIES5E);
  assert.equal(row.refusal, null);
  assert.equal(row.minQuantity, 2);
});

test("a basket line is fitted to what a buy of the shelf accepts now", () => {
  const shelf = { bundle: 20, available: 28, infinite: false };
  assert.equal(fitQuantity(30, shelf), 28, "down to the whole shelf, remainder included");
  assert.equal(fitQuantity(25, shelf), 20, "down to whole bundles when the remainder doesn't fit");
  assert.equal(fitQuantity(5, shelf), 0, "an old remainder that no longer matches is dropped");
  assert.equal(fitQuantity(40, { bundle: 20, available: 0, infinite: true }), 40, "an infinite line keeps whole bundles");
  assert.equal(fitQuantity(305, { bundle: 20, available: 0, infinite: true }), 300, "an infinite line has no remainder to keep");
});

test("a sell row says what its price buys: one bundle", () => {
  const arrows = { _id: "a1", img: "", name: "Arrows", type: "consumable", system: { price: { value: 1, denomination: "gp" }, quantity: 37 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipBuysAt: 0.5 };
  const shop = { wontBuy: { types: [], kinds: [] } };
  const row = sellRow(arrows, shop, { category: "", bundle: 20, service: false, noBuyback: false }, rates, null, CURRENCIES5E, { bundle: 20 });
  assert.equal(row.bundle, 20);
});

test("a buy row that floors to nothing a bundle at a time starts at the fewest worth a coin", () => {
  const candle = { _id: "k1", img: "", name: "Candle", type: "loot", system: { price: { value: 1, denomination: "cp" }, quantity: 10 } };
  const rates = { world: { sellsAt: 0.5, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 0.5 };
  const row = buyRow(candle, { category: "", hidden: false, notForSale: false, infinite: false, service: false }, rates, null, CURRENCIES5E, false);
  assert.equal(row.worthless, false);
  assert.equal(row.minQuantity, 2);
});

test("a buy row whose whole shelf floors to nothing is worthless, as the engine refuses it", () => {
  const candle = { _id: "k1", img: "", name: "Candle", type: "loot", system: { price: { value: 1, denomination: "cp" }, quantity: 1 } };
  const rates = { world: { sellsAt: 0.5, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 0.5 };
  const row = buyRow(candle, { category: "", hidden: false, notForSale: false, infinite: false, service: false }, rates, null, CURRENCIES5E, false);
  assert.equal(row.worthless, true);
});

test("a shelf holding only a part-bundle can still be bought, the remainder at its own price", () => {
  const arrows = { _id: "a1", img: "", name: "Arrows", type: "consumable", system: { price: { value: 1, denomination: "gp" }, quantity: 5 },
    flags: { "merchant-presets": { stock: { bundle: 20 } } } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1 };
  const row = buyRow(arrows, { category: "", hidden: false, notForSale: false, infinite: false, service: false, bundle: 20 }, rates, null, CURRENCIES5E, false);
  assert.equal(row.worthless, false);
  assert.equal(row.minQuantity, 5);
});

test("a sold-out line kept on the shelf shows its price, not worthless", () => {
  const rope = { _id: "r1", img: "", name: "Rope", type: "loot", system: { price: { value: 1, denomination: "gp" }, quantity: 0 } };
  const rates = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1 };
  const row = buyRow(rope, { category: "", hidden: false, notForSale: false, infinite: false, service: false, keep: true }, rates, null, CURRENCIES5E, false);
  assert.equal(row.worthless, false);
  assert.equal(row.bundlePriceCp, 100);
});

test("a rate tag against a zero chip rate is no tag, not an infinite percentage", () => {
  assert.deepEqual(rateTag({ rate: 0.5, layer: "category" }, 0), { kind: null, text: null });
});

test("a row whose one-bundle price floors to nothing shows the fewest worth a coin: 2 for 1 cp", () => {
  const chalk = { _id: "c1", img: "", name: "Chalk", type: "loot", system: { price: { value: 1, denomination: "cp" }, quantity: 5 } };
  const half = { world: { sellsAt: 0.5, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 0.5, chipBuysAt: 0.5 };
  const shelf = { category: "", hidden: false, notForSale: false, infinite: false, service: false, noBuyback: false, bundle: 1 };
  const buy = buyRow(chalk, shelf, half, null, CURRENCIES5E, false);
  assert.deepEqual([buy.priceFor, buy.priceForCp], [2, 1]);
  const sell = sellRow(chalk, { wontBuy: { types: [], kinds: [] } }, shelf, half, null, CURRENCIES5E);
  assert.deepEqual([sell.priceFor, sell.priceForCp], [2, 1]);
});

/* -------------------------------------------------------------- deals (#111) */

const LONGSWORD = { _id: "ls", img: "i.webp", name: "Longsword", type: "weapon", system: { price: { value: 15, denomination: "gp" }, quantity: 3 } };
const PLAIN_STOCK = { category: "", bundle: 1, service: false, infinite: false, hidden: false, notForSale: false, noBuyback: false, keep: true };
const LIST = { world: { sellsAt: 1, buysAt: 0.5 }, shopTerms: { sellsAt: null, buysAt: null, categories: [] }, chipSellsAt: 1, chipBuysAt: 0.5 };

test("a deal shows on the row as the list price struck and what the deal takes off", () => {
  const row = buyRow(LONGSWORD, PLAIN_STOCK, LIST, { buy: -0.1, sell: null }, CURRENCIES5E, false);
  assert.equal(row.bundlePriceCp, 1350);
  assert.equal(row.listPriceCp, 1500);
  assert.deepEqual(row.tag, { kind: "deal", text: "−10%" });
});

test("without a deal, or with one only on the other side, a row has no list price to strike", () => {
  assert.equal(buyRow(LONGSWORD, PLAIN_STOCK, LIST, null, CURRENCIES5E, false).listPriceCp, null);
  const row = buyRow(LONGSWORD, PLAIN_STOCK, LIST, { buy: null, sell: 0.1 }, CURRENCIES5E, false);
  assert.equal(row.listPriceCp, null);
  assert.deepEqual(row.tag, { kind: null, text: null });
});

test("a sale with a deal shows the shop's usual offer struck and the deal's lift", () => {
  const item = { ...LONGSWORD, system: { ...LONGSWORD.system, quantity: 1 } };
  const row = sellRow(item, shopConfig, PLAIN_STOCK, LIST, { buy: null, sell: 0.2 }, CURRENCIES5E);
  assert.equal(row.bundlePriceCp, 900);
  assert.equal(row.listPriceCp, 750);
  assert.deepEqual(row.tag, { kind: "deal", text: "+20%" });
  assert.equal(sellRow(item, shopConfig, PLAIN_STOCK, LIST, null, CURRENCIES5E).listPriceCp, null);
});

test("a deal the cap cuts short shows what it really does, not what it asked for", () => {
  // The shop buys at 90% and sells at list: a +50% offer deal would pay 135%, capped at 100%.
  const rates = { ...LIST, shopTerms: { sellsAt: null, buysAt: 0.9, categories: [] }, chipBuysAt: 0.9 };
  const item = { ...LONGSWORD, system: { ...LONGSWORD.system, quantity: 1 } };
  const row = sellRow(item, shopConfig, PLAIN_STOCK, rates, { buy: null, sell: 0.5 }, CURRENCIES5E);
  assert.equal(row.bundlePriceCp, 1500);
  assert.deepEqual(row.tag, { kind: "deal", text: "+11.11%" });
});

test("a deal's size reads signed, to a hundredth of a percent", () => {
  assert.equal(signedPercent(-0.1), "−10%");
  assert.equal(signedPercent(0.2), "+20%");
  assert.equal(signedPercent(-0.125), "−12.5%");
  assert.equal(signedPercent(1 / 9), "+11.11%");
});

test("a deal too small to move a cheap row's coins claims nothing on it (#142 review)", () => {
  const twine = { _id: "tw", img: "i.webp", name: "Twine", type: "loot", system: { price: { value: 1, denomination: "sp" }, quantity: 5 } };
  // 10.2 cp floors to 10, the list price: no strike, no tag.
  const row = buyRow(twine, PLAIN_STOCK, LIST, { buy: 0.02, sell: null }, CURRENCIES5E, false);
  assert.equal(row.bundlePriceCp, 10);
  assert.equal(row.listPriceCp, null);
  assert.deepEqual(row.tag, { kind: null, text: null });
  const cord = { ...twine, system: { price: { value: 2, denomination: "sp" }, quantity: 1 } };
  const sold = sellRow(cord, shopConfig, PLAIN_STOCK, LIST, { buy: null, sell: 0.02 }, CURRENCIES5E);
  assert.equal(sold.bundlePriceCp, 10);
  assert.equal(sold.listPriceCp, null);
  assert.equal(sold.tag, null);
});

/* -------------------------------------------------------------- shelf groups and meta (#145) */

/** CONFIG.DND5E's labels a row's meta line reads, 6.0.5 shape (weaponTypes etc. already localized). */
const LABELS = {
  weaponTypes: { simpleM: "Simple Melee", martialM: "Martial Melee" },
  armorTypes: { light: "Light Armor", medium: "Medium Armor", heavy: "Heavy Armor", natural: "Natural Armor", shield: "Shield" },
  toolTypes: { art: "Artisan's Tools" },
  consumableTypes: { potion: { label: "Potion" }, food: { label: "Food" } },
  typeLabels: { loot: "Loot", tool: "Tool" },
  properties: { ver: { label: "Versatile" }, lgt: { label: "Light" }, thr: { label: "Thrown" }, gear: { label: "Gear" } },
  weaponProperties: ["lgt", "thr", "ver"],
  weightUnits: { lb: { abbreviation: "lb" } },
  goodKinds: { vehicle: "Vehicle", tack: "Tack", mount: "Mount" }
};
const words = { JoinsBuyer: "joins the buyer", SpellOf: "Level {level} {school}", CantripOf: "{school} cantrip", AnyCantrip: "any cantrip",
  AnySpell: "any Level {level} spell", AnySpells: "any Level {min} or {max} spell", AnySpellRange: "any Level {min}–{max} spell", Service: "Service", FeedsBuyer: "feeds the buyer", Drink: "Drink", CountsAsWater: "counts as water", Worth: "Worth {amount}", WorthEach: "Worth {amount} each", DealWorth: "Your deal · worth {amount}", DealWorthEach: "Your deal · worth {amount} each", Weight: "{weight} {units}", Ac: "AC {ac}", Dex: " + Dex", DexMax: " + Dex (max {max})", Str: "Str {str}", ShieldAc: "+{ac} AC" };
const t = (key, data = {}) => words[key].replace(/\{(\w+)\}/g, (_, k) => data[k]);
const gear = (type, system) => ({ type, system: { weight: { value: 0, units: "lb" }, ...system } });

test("a row's meta line says what the good is, then what matters about it (design y6iNf)", () => {
  const lb = value => ({ weight: { value, units: "lb" } });
  assert.equal(itemMeta(gear("weapon", { type: { value: "martialM" }, properties: ["ver"], ...lb(3) }), LABELS, t), "Martial melee · Versatile · 3 lb");
  assert.equal(itemMeta(gear("weapon", { type: { value: "simpleM" }, properties: ["lgt", "thr"], ...lb(2) }), LABELS, t), "Simple melee · Light, thrown · 2 lb");
  // Armour: its AC and what wearing it asks, not its weight.
  assert.equal(itemMeta(gear("equipment", { type: { value: "medium" }, armor: { value: 14, dex: 2 }, ...lb(20) }), LABELS, t), "Medium armor · AC 14 + Dex (max 2)");
  assert.equal(itemMeta(gear("equipment", { type: { value: "heavy" }, armor: { value: 16, dex: 0 }, strength: 13, ...lb(55) }), LABELS, t), "Heavy armor · AC 16 · Str 13");
  assert.equal(itemMeta(gear("equipment", { type: { value: "light" }, armor: { value: 11, dex: null }, ...lb(10) }), LABELS, t), "Light armor · AC 11 + Dex");
  assert.equal(itemMeta(gear("equipment", { type: { value: "shield" }, armor: { value: 2 }, ...lb(6) }), LABELS, t), "+2 AC · 6 lb");
  assert.equal(itemMeta(gear("tool", { type: { value: "art" }, ...lb(8) }), LABELS, t), "Artisan's tools · 8 lb");
  // Anything else by its own type; a weightless good says nothing of weight.
  assert.equal(itemMeta(gear("consumable", { type: { value: "potion" }, ...lb(0.5) }), LABELS, t), "Potion · 0.5 lb");
  assert.equal(itemMeta(gear("loot", {}), LABELS, t), "Loot");
});

test("a good sits under the category its line names, else its kind of good", () => {
  const armorTypes = LABELS.armorTypes;
  const weapon = { type: "weapon", system: {}, flags: {} };
  assert.deepEqual(shelfGroup(weapon, { category: "" }, armorTypes), { id: "weapons", named: null, icon: "lucide:sword" });
  assert.deepEqual(shelfGroup(weapon, { category: "Heirlooms" }, armorTypes), { id: "named:Heirlooms", named: "Heirlooms", icon: "lucide:tag" });
  assert.equal(shelfGroup({ type: "equipment", system: { type: { value: "shield" } } }, {}, armorTypes).id, "armor");
  // SRD food and drink carry no kind of ours; dnd5e's own "food" type makes them food and drink (#150).
  assert.equal(shelfGroup({ type: "consumable", name: "Water (Pint)", system: { type: { value: "food" } }, flags: {} }, {}, armorTypes).id, "food-drink");
  assert.equal(shelfGroup({ type: "equipment", system: { type: { value: "trinket" } } }, {}, armorTypes).id, "gear");
  assert.equal(shelfGroup({ type: "tool", system: {} }, {}, armorTypes).id, "tools");
  // The module's own goods, by their kind (design mRg3y): an inn's meals and rooms.
  assert.deepEqual(shelfGroup({ type: "loot", system: {}, flags: { "merchant-presets": { kind: "meal" } } }, {}, armorTypes),
    { id: "meal", named: null, icon: "lucide:soup" });
  assert.equal(shelfGroup({ type: "loot", system: {}, flags: { "merchant-presets": { kind: "lodging" } } }, {}, armorTypes).id, "lodging");
});

test("the part of the day an hour falls in, on any length of day", () => {
  assert.deepEqual([3, 6, 8, 10, 12, 15, 19, 23].map(h => partOfDay(h)),
    ["night", "dawn", "morning", "midMorning", "midday", "afternoon", "evening", "night"]);
  assert.equal(partOfDay(5, 12), "midMorning");
});

/* -------------------------------------------------------------- purseAfter */

test("a buyer's purse after the bill keeps the coins the payment didn't touch", () => {
  // Aria, 3 pp 47 gp 12 sp 30 cp, owes 30 gp. The engine's pay() settles it exactly with her 3 pp;
  // the rest of her purse is as it was, not the total re-split (48 gp 5 sp).
  const aria = { pp: 3, gp: 47, ep: 0, sp: 12, cp: 30 };
  assert.deepEqual(purseAfter("buy", aria, 3000, { gp: 212 }, CURRENCIES), { pp: 0, gp: 47, ep: 0, sp: 12, cp: 30 });
  assert.deepEqual(purseAfter("buy", { gp: 47, sp: 12 }, 3000, { gp: 212 }, CURRENCIES), { gp: 17, sp: 12 });
});

test("a buyer who has to break a coin gets the change from the till", () => {
  assert.deepEqual(purseAfter("buy", { gp: 1 }, 50, { sp: 10 }, CURRENCIES), { gp: 0, sp: 5 });
});

test("a seller's purse gains exactly the coins the till pays out", () => {
  assert.deepEqual(purseAfter("sell", { gp: 2 }, 150, { gp: 3, sp: 9 }, CURRENCIES), { gp: 3, sp: 5 });
});

test("a bottomless till (null) pays and changes anything", () => {
  assert.deepEqual(purseAfter("sell", {}, 1250, null, CURRENCIES), { gp: 12, sp: 5 });
  assert.deepEqual(purseAfter("buy", { pp: 1 }, 50, null, CURRENCIES), { pp: 0, gp: 9, sp: 5 });
});

test("a bill the engine would refuse has no purse after", () => {
  assert.equal(purseAfter("buy", { gp: 1 }, 200, { gp: 100 }, CURRENCIES), null);
  assert.equal(purseAfter("buy", { gp: 1 }, 50, {}, CURRENCIES), null);
  assert.equal(purseAfter("sell", {}, 200, { gp: 1 }, CURRENCIES), null);
});

/* -------------------------------------------------------------- isFresh */

const DAYS = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const DAY = 86_400;
const H = (h, m = 0) => h * 3600 + m * 60;
const SMITH_HOURS = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };

test("a restock stays fresh until the shop closes: through its closing minute, not after (#152, design aaJcp)", () => {
  const at = 10 * DAY + H(8);
  assert.equal(isFresh(at, at, SMITH_HOURS, DAYS), true);
  assert.equal(isFresh(at, 10 * DAY + H(18, 59), SMITH_HOURS, DAYS), true);
  assert.equal(isFresh(at, 10 * DAY + H(19) + 30, SMITH_HOURS, DAYS), true);
  assert.equal(isFresh(at, 10 * DAY + H(19, 1), SMITH_HOURS, DAYS), false);
});

test("a restock while the shop is closed stays fresh until it next closes (#152)", () => {
  const at = 10 * DAY + H(21);
  assert.equal(isFresh(at, 11 * DAY + H(12), SMITH_HOURS, DAYS), true);
  assert.equal(isFresh(at, 11 * DAY + H(19, 1), SMITH_HOURS, DAYS), false);
});

test("a shop that never closes keeps a restock fresh for a whole day from it (#152, review round 5)", () => {
  const at = 10 * DAY + H(8);
  for (const hours of [null, { open: { hour: 0, minute: 0 }, close: { hour: 23, minute: 59 } }]) {
    assert.equal(isFresh(at, 11 * DAY + H(7, 59), hours, DAYS), true, "past midnight");
    assert.equal(isFresh(at, 11 * DAY + H(8), hours, DAYS), false);
  }
});

test("a hand restock just before a never-closing shop's opening stays fresh a day, not minutes (#152 review)", () => {
  const at = 10 * DAY + H(6, 55);
  assert.equal(isFresh(at, 10 * DAY + H(12), null, DAYS), true);
  assert.equal(isFresh(at, 11 * DAY + H(6, 55), null, DAYS), false);
});

test("a good is New while the restock that brought it back is fresh, and only on the shop that drew it (#152)", () => {
  const good = (newAt, drawn = "shelfA", quantity = 3) => ({ system: { quantity }, flags: { "merchant-presets": { newAt, drawn } } });
  const at = 10 * DAY + H(8);
  assert.equal(isNewGood(good(at), "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), true);
  assert.equal(isNewGood(good(at), "shelfA", 10 * DAY + H(19, 1), SMITH_HOURS, DAYS), false, "cleared at closing");
  assert.equal(isNewGood(good(at, true), "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), true, "drawn before shelves had keys");
  assert.equal(isNewGood(good(at, "shelfB"), "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), false, "dragged in from another shop");
  assert.equal(isNewGood(good(undefined), "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), false);
  assert.equal(isNewGood({ flags: {} }, "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), false);
});

test("a New good that sells out again isn't New: New is for goods back in stock (#152 review)", () => {
  const soldOut = { system: { quantity: 0 }, flags: { "merchant-presets": { newAt: 10 * DAY + H(8), drawn: "shelfA" } } };
  assert.equal(isNewGood(soldOut, "shelfA", 10 * DAY + H(12), SMITH_HOURS, DAYS), false);
});

test("a shop with no closing hours (trading hours off) keeps a restock fresh a whole day (#152 review)", () => {
  const at = 3 * DAY + H(20);
  assert.equal(isFresh(at, 4 * DAY + H(3), null, DAYS), true);
  assert.equal(isFresh(at, 4 * DAY + H(5), null, DAYS), true, "past the hour it would close at");
  assert.equal(isFresh(at, 4 * DAY + H(20), null, DAYS), false, "a whole day on");
});

test("a shop open round the clock from 7:00 keeps its restock fresh until its own day starts again (#152 review)", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 6, minute: 59 } };
  const at = 10 * DAY + H(7);
  assert.equal(isFresh(at, 11 * DAY + H(6, 59), hours, DAYS), true);
  assert.equal(isFresh(at, 11 * DAY + H(7), hours, DAYS), false);
});

test("no restock yet isn't fresh", () => {
  assert.equal(isFresh(null, 10 * DAY, SMITH_HOURS, DAYS), false);
  assert.equal(isFresh(undefined, 10 * DAY, null, DAYS), false);
});

test("a clock wound back before the restock keeps it fresh: the goods it brought are still on the shelf (#153)", () => {
  assert.equal(isFresh(10 * DAY + H(7), 10 * DAY + H(6, 30), SMITH_HOURS, DAYS), true);
  assert.equal(isFresh(10 * DAY + H(8), 10 * DAY + H(8), null, DAYS), true);
  assert.equal(isFresh(10 * DAY + H(8), 9 * DAY + H(8), SMITH_HOURS, DAYS), true, "a day back");
  assert.equal(isFresh(10 * DAY + H(8), 9 * DAY + H(7, 59), SMITH_HOURS, DAYS), false, "more than a day back: not today's stock (#158 review)");
  assert.equal(isFresh(40 * DAY, 10 * DAY, null, DAYS), false, "a month back");
});

/* -------------------------------------------------------------- Restock section (design aaJcp) */

test("the next restock counts whole calendar days from today, not 24-hour spans", () => {
  const now = 14 * DAY + H(10);
  assert.equal(daysUntil(now, 21 * DAY + H(7), DAYS), 7);
  assert.equal(daysUntil(now, 15 * DAY + H(7), DAYS), 1);
  assert.equal(daysUntil(now, 14 * DAY + H(18), DAYS), 0);
});

test("the preset line names the preset's tier and only the tiers that restock on another schedule", () => {
  const line = presetSchedule({ tier: "Town", every: "7 days" },
    [{ tier: "City", every: "7 days" }, { tier: "Town", every: "7 days" }, { tier: "Village", every: "14 days" }]);
  assert.deepEqual(line, { tier: "Town", every: "7 days", others: [{ tier: "Village", every: "14 days" }] });
  assert.deepEqual(presetSchedule({ tier: null, every: "Daily" }, []), { tier: null, every: "Daily", others: [] });
});

test("a stock table's quantities read as the formula most of its goods roll, or none when all are one", () => {
  assert.equal(commonFormula({ a: "2d6+4", b: "2d6+4", c: "1d4" }), "2d6+4");
  assert.equal(commonFormula({ a: "1", b: "1" }), null);
  assert.equal(commonFormula({}), null);
});

test("a weapon's meta line lists only weapon properties, not dnd5e's other tags (a restocked copy's \"gear\")", () => {
  const sword = gear("weapon", { type: { value: "martialM" }, properties: ["ver", "gear"], weight: { value: 3, units: "lb" } });
  assert.equal(itemMeta(sword, LABELS, t), "Martial melee · Versatile · 3 lb");
});

/* -------------------------------------------------------------- sellWorth */

test("a pack row's ratio chip says what one is worth at list, \"each\" when several are held (#177)", () => {
  const sword = gear("weapon", { type: { value: "martialM" }, properties: ["ver"], quantity: 1 });
  assert.equal(sellWorth(sword, t, "15 gp"), "Worth 15 gp");
  const potions = gear("consumable", { type: { value: "potion" }, quantity: 2 });
  assert.equal(sellWorth(potions, t, "50 gp"), "Worth 50 gp each");
});

test("the Your deal tag that replaces the chip carries the worth too, and a good with no price says nothing of worth (#177)", () => {
  const sword = gear("weapon", { type: { value: "martialM" }, quantity: 1 });
  assert.equal(sellWorth(sword, t, "15 gp", { deal: true }), "Your deal · worth 15 gp");
  assert.equal(sellWorth(gear("consumable", { type: { value: "potion" }, quantity: 2 }), t, "50 gp", { deal: true }), "Your deal · worth 50 gp each");
  assert.equal(sellWorth(gear("loot", {}), t, null), null);
});

/* -------------------------------------------------------------- wontBuyReason */

test("a good the shop won't deal in names what it won't buy: its kind, else its type", () => {
  const shop = { wontBuy: { types: ["loot"], kinds: ["food-drink"] } };
  const rations = { type: "consumable", flags: { "merchant-presets": { kind: "food-drink" } } };
  assert.deepEqual(wontBuyReason(rations, shop), { kind: "food-drink" });
  assert.deepEqual(wontBuyReason({ type: "loot", flags: {} }, shop), { type: "loot" });
  assert.equal(wontBuyReason({ type: "weapon", flags: {} }, shop), null);
});

test("a shop that won't buy magic items turns away anything magic, whatever its kind or type (#184)", () => {
  const shop = { wontBuy: { types: ["loot"], kinds: ["food-drink", "magic"] } };
  // As dnd5e stores them: a rarity and the Magical property on a potion, the property alone on a scroll.
  const potion = { type: "consumable", system: { rarity: "common", properties: ["mgc"] }, flags: {} };
  const scroll = { type: "consumable", system: { rarity: "", properties: ["mgc"] }, flags: {} };
  // A live document's properties are a Set.
  const ring = { type: "equipment", system: { rarity: "rare", properties: new Set(["mgc"]) }, flags: {} };
  const sword = { type: "weapon", system: { rarity: "", properties: ["ver"] }, flags: {} };
  for (const item of [potion, scroll, ring]) {
    assert.equal(dealtIn(item, shop), false);
    assert.deepEqual(wontBuyReason(item, shop), { kind: "magic" });
  }
  assert.equal(dealtIn(sword, shop), true);
  // Its own kind comes first, its type last: a magic loot item is refused as magic.
  const magicRations = { type: "consumable", system: { rarity: "common" }, flags: { "merchant-presets": { kind: "food-drink" } } };
  assert.deepEqual(wontBuyReason(magicRations, shop), { kind: "food-drink" });
  assert.deepEqual(wontBuyReason({ type: "loot", system: { rarity: "uncommon" }, flags: {} }, shop), { kind: "magic" });
  // Without the entry, magic is bought like anything else.
  assert.equal(dealtIn(ring, { wontBuy: { types: [], kinds: ["food-drink"] } }), true);
});

/* -------------------------------------------------------------- wontBuyTerms */

const NOUNS = { "food-drink": "food", meal: "food", mount: "mounts", service: "services", vehicle: "vehicles", tack: "tack",
  lodging: "lodging", travel: "passage", spellcasting: "spellcasting", component: "spell components", magic: "magic items" };

test("the Terms popover leads with three things a shop won't buy and lists the rest after (design ChoNd)", () => {
  // The smith's own list, in its config order.
  const smith = ["vehicle", "mount", "tack", "food-drink", "meal", "lodging", "service", "spellcasting", "component", "travel"];
  assert.deepEqual(wontBuyTerms(smith, [], k => NOUNS[k]), {
    lead: ["food", "mounts", "services"],
    rest: ["vehicles", "tack", "lodging", "passage", "spellcasting", "spell components"]
  });
});

test("magic items come last among the kinds a shop won't buy (#184)", () => {
  assert.deepEqual(wontBuyTerms(["magic", "vehicle", "mount", "service"], [], k => NOUNS[k]), {
    lead: ["mounts", "services", "vehicles"], rest: ["magic items"]
  });
  assert.deepEqual(wontBuyTerms(["magic"], ["loot"], k => NOUNS[k]), { lead: ["magic items", "loot"], rest: [] });
});

test("a short list is all lead, item types come after the kinds, and nothing refused is nothing", () => {
  assert.deepEqual(wontBuyTerms(["travel", "meal"], [], k => NOUNS[k]), { lead: ["food", "passage"], rest: [] });
  assert.deepEqual(wontBuyTerms(["mount"], ["loot", "tool"], k => NOUNS[k]), { lead: ["mounts", "loot", "tool"], rest: [] });
  assert.deepEqual(wontBuyTerms([], [], k => NOUNS[k]), { lead: [], rest: [] });
});

/* -------------------------------------------------------------- itemMeta: services and drinks (design mRg3y) */

const meal = gear("loot", { quantity: 1 });
meal.flags = { "merchant-presets": { kind: "meal", nutrition: { food: 1, water: 0.25 } } };
const room = gear("loot", { quantity: 1 });
room.flags = { "merchant-presets": { kind: "lodging" } };
const drink = identifier => gear("consumable", { type: { value: "food" }, identifier, weight: { value: 0.5, units: "lb" } });

test("a service says so, and a meal says it feeds the buyer only where meals do", () => {
  assert.equal(itemMeta(meal, LABELS, t, { service: true, feeds: true }), "Service · feeds the buyer");
  assert.equal(itemMeta(meal, LABELS, t, { service: true, feeds: false }), "Service");
  assert.equal(itemMeta(room, LABELS, t, { service: true, feeds: true }), "Service");
});

test("a drink reads as one, and ale or wine counts as water only where drinks hydrate", () => {
  assert.equal(itemMeta(drink("ale"), LABELS, t, { hydrates: true }), "Drink · counts as water");
  assert.equal(itemMeta(drink("wine-fine"), LABELS, t, { hydrates: false }), "Drink");
  assert.equal(itemMeta(drink("water-pint"), LABELS, t, { hydrates: true }), "Drink");
  assert.equal(itemMeta(drink("bread"), LABELS, t, { hydrates: true }), "Food · 0.5 lb");
});

/* -------------------------------------------------------------- narrow rows and dock (design r7HIUl) */

test("a narrow row's meta says what the good is, its weight and its stock, in one line", () => {
  const lb = value => ({ weight: { value, units: "lb" } });
  assert.equal(compactMeta(gear("weapon", { type: { value: "martialM" }, properties: ["ver"], ...lb(3) }), LABELS, t, "7 left"), "Martial melee · 3 lb · 7 left");
  assert.equal(compactMeta(gear("equipment", { type: { value: "medium" }, armor: { value: 14, dex: 2 }, ...lb(20) }), LABELS, t, "Last one"), "Medium armor · Last one");
  assert.equal(compactMeta(gear("equipment", { type: { value: "shield" }, armor: { value: 2 }, ...lb(6) }), LABELS, t, "Sold out"), "+2 AC · Sold out");
});

test("the docked bill sums its lines up in one line", () => {
  assert.equal(billSummary([{ name: "Longsword", quantity: 1 }, { name: "Handaxe", quantity: 2 }, { name: "Javelin", quantity: 10 }]),
    "Longsword, 2 × Handaxe, 10 × Javelin");
  assert.equal(billSummary([]), "");
});

/* -------------------------------------------------------------- service shops (#151, design IeGac / pI7Yd) */

const good = (kind, name, flags = {}, system = {}) => ({ type: "loot", name, system: { weight: { value: 0, units: "lb" }, ...system }, flags: { "merchant-presets": { kind, ...flags } } });

test("a named spell's row says its level and school; a cantrip says so (#151, design IeGac)", () => {
  const named = good("spellcasting", "Spellcasting: Protection from Evil and Good", { spell: "Compendium.dnd5e.spells24.Item.x" });
  assert.equal(itemMeta(named, LABELS, t, { service: true, spell: { level: 1, school: "Abjuration" } }), "Service · Level 1 Abjuration");
  assert.equal(itemMeta(named, LABELS, t, { service: true, spell: { level: 0, school: "Evocation" } }), "Service · Evocation cantrip");
  // A spell that can't be found reads as the service it is.
  assert.equal(itemMeta(named, LABELS, t, { service: true, spell: null }), "Service");
});

test("a level service says the buyer picks any spell of its level (#151, design IeGac)", () => {
  const svc = name => itemMeta(good("spellcasting", name), LABELS, t, { service: true });
  assert.equal(svc("Spellcasting: Cantrip"), "Service · any cantrip");
  assert.equal(svc("Spellcasting: Level 1"), "Service · any Level 1 spell");
  assert.equal(svc("Spellcasting: Level 4-5"), "Service · any Level 4 or 5 spell");
  // A span wider than two levels names its range: Level 7 is in "6-8" too (#163 review).
  assert.equal(svc("Spellcasting: Level 6-8"), "Service · any Level 6–8 spell");
  assert.equal(svc("Hired Spellcaster"), "Service", "a GM's own spellcasting good says only that");
  assert.deepEqual([levelService("Spellcasting: Cantrip"), levelService("Spellcasting: Level 3"), levelService("Spellcasting: Level 4-5"), levelService("Spellcasting: Revivify")],
    [{ min: 0, max: 0 }, { min: 3, max: 3 }, { min: 4, max: 5 }, null]);
});

test("a named spell shows the spell's name alone; everything else keeps its own (#151, design IeGac)", () => {
  assert.equal(goodName(good("spellcasting", "Spellcasting: Revivify", { spell: "uuid" })), "Revivify");
  assert.equal(goodName(good("spellcasting", "Spellcasting: Level 1")), "Spellcasting: Level 1");
  assert.equal(goodName(good("mount", "Horse, Riding")), "Horse, Riding");
  assert.equal(goodName({ name: "Rope", flags: {} }), "Rope");
});

test("a mount joins the buyer only where bought animals spawn and it has a stat block (#151, design pI7Yd)", () => {
  const horse = good("mount", "Horse, Riding", { actor: "Compendium.dnd5e.actors24.Actor.h" });
  assert.equal(itemMeta(horse, LABELS, t, { spawns: true }), "Mount · joins the buyer");
  assert.equal(itemMeta(horse, LABELS, t, { spawns: false }), "Mount");
  assert.equal(itemMeta(good("mount", "Statue Horse"), LABELS, t, { spawns: true }), "Mount");
});

test("a mount on the Sell tab never says it joins the buyer: the seller is the one parting with it (#177)", () => {
  const horse = good("mount", "Horse, Riding", { actor: "Compendium.dnd5e.actors24.Actor.h" });
  assert.equal(sellRowMeta(horse, LABELS, t, { spawns: true, hydrates: true }), "Mount");
});

test("tack and vehicles read by what they are, not as loot (#151, design pI7Yd)", () => {
  const saddle = good("tack", "Saddle, Riding", {}, { weight: { value: 25, units: "lb" }, quantity: 1 });
  const cart = good("vehicle", "Cart", {}, { weight: { value: 200, units: "lb" }, quantity: 2 });
  assert.equal(itemMeta(saddle, LABELS, t), "Tack · 25 lb");
  assert.equal(itemMeta(cart, LABELS, t), "Vehicle · 200 lb");
  assert.equal(compactMeta(saddle, LABELS, t, "3 left"), "Tack · 25 lb · 3 left");
});

test("the seal takes its short label once the price is longer than a few characters (#151, design IeGac)", () => {
  assert.equal(sealsShort("76 gp", 1), false);
  assert.equal(sealsShort("105 gp", 1), true);
  assert.equal(sealsShort("1 gp 9 sp 2 cp", 3), true);
  assert.equal(sealsShort("30 gp", 1), false);
});

/* ------------------------------------------------------------ a good's details (#168) */

const SHOP_ITEM = "Actor.shop0000000000001.Item.bell000000000001";
const BELL_SRC = "Compendium.dnd5e.equipment24.Item.phbagBell0000000";
const bell = (over = {}) => ({ _id: "bell000000000001", name: "Bell", system: { identified: true }, _stats: { compendiumSource: BELL_SRC }, ...over });

test("a player hovering a good sees the shop's own copy, as it stands, and a click opens its compendium page (#168 live check)", () => {
  // The shop's copy is what they'd buy, edits included; dnd5e gives the compendium item's card the
  // same "Not Equipped · Not Proficient" pills, so the source's card is no cleaner.
  assert.deepEqual(inspectTargets(bell(), { kind: "buy", isGM: false, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: BELL_SRC });
});

test("a GM sees and opens the shop's own copy, as it stands, edits included (#168, #169 review)", () => {
  assert.deepEqual(inspectTargets(bell(), { kind: "buy", isGM: true, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: SHOP_ITEM });
});

test("a good with no compendium source shows the shop's copy, and opens only for the GM (#168)", () => {
  const handmade = bell({ _stats: {} });
  assert.deepEqual(inspectTargets(handmade, { kind: "buy", isGM: false, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: null });
  assert.deepEqual(inspectTargets(handmade, { kind: "buy", isGM: true, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: SHOP_ITEM });
});

test("an unidentified good never gives its true item away: its card is the shop's copy, and a player opens nothing (#168)", () => {
  const mystery = bell({ system: { identified: false } });
  assert.deepEqual(inspectTargets(mystery, { kind: "buy", isGM: false, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: null });
  assert.deepEqual(inspectTargets(mystery, { kind: "buy", isGM: true, uuid: SHOP_ITEM }), { tip: SHOP_ITEM, open: SHOP_ITEM });
});

test("on the Sell tab a good is the seller's own: its own card and its own sheet (#168)", () => {
  const own = "Actor.aria000000000001.Item.bell000000000001";
  assert.deepEqual(inspectTargets(bell(), { kind: "sell", isGM: false, uuid: own }), { tip: own, open: own });
});

test("the card's markup is dnd5e's own loading section, which dnd5e fills from the uuid (#168)", () => {
  assert.equal(itemTooltipHtml(BELL_SRC),
    '<section class="loading" data-uuid="' + BELL_SRC + '"><i class="fas fa-spinner fa-spin-pulse" inert></i></section>');
  assert.equal(itemTooltipHtml(null), null);
});

test("a shop's good keeps only its attunement pill: Not Equipped and proficiency are the shop NPC's, not the buyer's (#170)", () => {
  // dnd5e 6.0.5 `equippableItemCardProperties`, as it returns them for an unequipped weapon needing attunement.
  const props = [
    { type: "attunement", attuned: false, attunement: "required" },
    { type: "label", label: "DND5E.Unequipped" },
    { type: "proficiency", proficiency: 1 }
  ];
  assert.deepEqual(shelfCardProperties(props), [{ type: "attunement", attuned: false, attunement: "required" }]);
  assert.deepEqual(shelfCardProperties([{ type: "label", label: "DND5E.Unequipped" }, { type: "proficiency", proficiency: 0 }]), []);
  assert.deepEqual(shelfCardProperties(undefined), []);
});

test("the shopkeeper's own gear keeps every pill: its Proficient is the NPC's, and true (#171 review)", () => {
  const props = [{ type: "label", label: "DND5E.Unequipped" }, { type: "proficiency", proficiency: 1 }];
  const gear = { flags: { "merchant-presets": { kind: "gear" } } };
  assert.deepEqual(shelfCardProperties(props, gear), props);
  assert.deepEqual(shelfCardProperties(props, { flags: { "merchant-presets": { kind: "food-drink" } } }), []);
});

/* ------------------------------------------------------------ the Settings nav (#172) */

/** The Settings form's six headings, 300 px apart in its scrolled content, in a 400 px tall form. */
const SECTIONS = ["terms", "deals", "wontBuy", "hours", "restock", "till"].map((id, i) => ({ id, top: i * 300 }));
const view = (scrollTop, over = {}) => ({ scrollTop, clientHeight: 400, scrollHeight: 1700, pad: 0, ...over });

test("the section being read is the last one whose heading has reached the top of the form (#172)", () => {
  assert.equal(currentSection(SECTIONS, view(0)), "terms");
  assert.equal(currentSection(SECTIONS, view(650)), "wontBuy");
  // Between two headings, the one above is still the one being read.
  assert.equal(currentSection(SECTIONS, view(599)), "deals");
  assert.equal(currentSection(SECTIONS, view(1250)), "restock");
});

test("the form's scroll padding counts as the top: a heading resting on it is current (#172)", () => {
  // A jump leaves the heading `pad` below the top edge (the form's scroll-padding-top).
  assert.equal(currentSection(SECTIONS, view(592, { pad: 8 })), "wontBuy");
  assert.equal(currentSection(SECTIONS, view(591, { pad: 8 })), "deals");
});

test("scrolled to the bottom, the last heading in view is current, so a short last section can be (#172)", () => {
  // Till's heading (1500) never reaches the top: the form bottoms out at 1300 + 400 = 1700.
  assert.equal(currentSection(SECTIONS, view(1300)), "till");
  // A form too short to scroll at all: the top one.
  assert.equal(currentSection(SECTIONS, { scrollTop: 0, clientHeight: 400, scrollHeight: 400, pad: 0 }), "terms");
});

test("no sections, no current one (#172)", () => {
  assert.equal(currentSection([], view(0)), null);
});
