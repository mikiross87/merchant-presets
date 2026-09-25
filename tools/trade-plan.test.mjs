import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrade } from "../scripts/trade-plan.mjs";
import { totalCp } from "../scripts/pricing.mjs";

/** CONFIG.DND5E.currencies, 6.0.5 shape (same fixture as tools/pricing.test.mjs). */
const CURRENCIES = {
  pp: { conversion: 0.1 },
  gp: { conversion: 1 },
  ep: { conversion: 2 },
  sp: { conversion: 10 },
  cp: { conversion: 100 }
};

/* ------------------------------------------------------------------ fixtures */
/**
 * Trimmed but structurally real: shapes and values copied from a real shop
 * (Adventurers' Store (Town), _source/merchants) and a real named
 * spellcasting good (The Arcane Store's Identify listing), field for field,
 * with the bulk (description HTML, damage blocks) cut.
 */

const arrows = () => ({
  _id: "5BtSFZjMcs6csxDO",
  name: "Arrows",
  type: "consumable",
  img: "icons/weapons/ammunition/arrows-broadhead-white.webp",
  system: {
    price: { value: 1, denomination: "gp" },
    identified: true,
    container: null,
    quantity: 300,
    type: { value: "ammo", subtype: "arrow" }
  },
  flags: { "merchant-presets": { stock: { infinite: null, keep: true, service: false, noBuyback: false, category: "", bundle: 20, hidden: false, notForSale: false } } },
  _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.phbamoArrows0000" }
});

const backpack = id => ({
  _id: id,
  name: "Backpack",
  type: "container",
  img: "icons/containers/bags/pack-leather-brown.webp",
  system: { price: { value: 2, denomination: "gp" }, identified: true, container: null, quantity: 1 },
  flags: { "merchant-presets": { stock: { infinite: false, keep: true, service: false, noBuyback: false, category: "", bundle: 1, hidden: false, notForSale: false } } },
  _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.phbagBackpack000" }
});

const identifyService = () => ({
  _id: "IdentifySvc00001",
  name: "Spellcasting: Identify",
  type: "loot",
  img: "icons/magic/perception/eye-ringed-glow-angry-small-red.webp",
  system: { price: { value: 150, denomination: "gp" }, identified: true, container: null, quantity: 1 },
  flags: { "merchant-presets": { kind: "spellcasting", stock: { infinite: true, keep: true, service: true, noBuyback: true, category: "", bundle: 1, hidden: false, notForSale: false } } }
});

const dagger = () => ({
  _id: "Dagger000000001",
  name: "Dagger",
  type: "weapon",
  img: "icons/weapons/daggers/dagger-guarded-steel.webp",
  system: { price: { value: 2, denomination: "gp" }, identified: true, container: null, quantity: 5, type: { value: "simpleM", subtype: "" } },
  flags: { "merchant-presets": { stock: { infinite: null, keep: true, service: false, noBuyback: false, category: "", bundle: 1, hidden: false, notForSale: false } } },
  _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.phbweDagger0000" }
});

const gearSword = () => ({
  _id: "GearSword0000001",
  name: "Shortsword",
  type: "weapon",
  img: "icons/weapons/swords/sword-guard-brass.webp",
  system: { price: { value: 10, denomination: "gp" }, identified: true, container: null, quantity: 1, type: { value: "martialM", subtype: "" } },
  flags: { "merchant-presets": { kind: "gear" } }
});

const naturalBite = () => ({
  _id: "Bite0000000001",
  name: "Bite",
  type: "weapon",
  img: "icons/creatures/abilities/mouth-teeth-bite-red.webp",
  system: { price: { value: 0, denomination: "gp" }, identified: true, container: null, quantity: 1, type: { value: "natural", subtype: "" } },
  flags: {}
});

const backgroundFeature = () => ({
  _id: "Background000001",
  name: "Feature: Guild Membership",
  type: "background",
  img: "icons/sundries/scrolls/scroll-bound-brown.webp",
  system: { identified: true, container: null },
  flags: {}
});

const unidentifiedRing = () => ({
  _id: "Ring0000000001",
  name: "Ring of Mystery",
  type: "equipment",
  img: "icons/equipment/finger/ring-band-thin-gold.webp",
  system: { price: { value: 0, denomination: "gp" }, identified: false, container: null, quantity: 1, type: { value: "trinket", subtype: "" } },
  flags: {}
});

/** A fresh shop actor: the Town smith's shape, terms 1x sell / 0.5x buy, wontBuy left empty unless overridden. */
function shop({ items = [], currency = { pp: 0, gp: 500, ep: 0, sp: 0, cp: 0 }, wontBuy = { types: [], kinds: [] }, terms } = {}) {
  return {
    _id: "Shop00000000001",
    name: "Adventurers' Store (Town)",
    img: "icons/environment/settlement/market-stall.webp",
    items,
    system: { currency },
    flags: { "merchant-presets": { shop: { version: 1, terms: terms ?? { sellsAt: null, buysAt: null, categories: [] }, wontBuy } } }
  };
}

/** A fresh buyer actor. */
function buyer({ items = [], currency = { pp: 0, gp: 20, ep: 0, sp: 0, cp: 0 } } = {}) {
  return { _id: "Buyer000000001", name: "Aria", items, system: { currency } };
}

const WORLD = { rates: { sellsAt: 1, buysAt: 0.5 }, infiniteStock: false, infinitePurse: false };
const OPEN = { isOpen: true };

const buyRequest = (itemId, quantity, extra = {}) =>
  ({ tradeId: "trade-1", kind: "buy", lines: [{ itemId, quantity, ...extra }] });
const sellRequest = (itemId, quantity, extra = {}) =>
  ({ tradeId: "trade-1", kind: "sell", lines: [{ itemId, quantity, ...extra }] });

/** A deterministic newId(), so a test can predict a bought container's fresh id. */
function idSequence(prefix = "NewId") {
  let n = 0;
  return () => `${prefix}${n++}`;
}

const context = (over = {}) => ({
  shop: shop(over.shop), buyer: buyer(over.buyer), worldSettings: over.worldSettings ?? WORLD,
  currencies: CURRENCIES, deal: over.deal ?? null, now: over.now ?? OPEN, newId: over.newId ?? idSequence(),
  bundleOf: over.bundleOf
});

/* --------------------------------------------------------------- every refusal reason */

test("closed refuses before anything else, buy or sell", () => {
  const ctx = { ...context({ shop: { items: [dagger()] } }), now: { isOpen: false } };
  assert.deepEqual(planTrade(buyRequest("Dagger000000001", 1), ctx), { ok: false, reason: "closed" });
  assert.deepEqual(planTrade(sellRequest("Dagger000000001", 1), ctx), { ok: false, reason: "closed" });
});

test("shopkeeper gear is never visible to buy", () => {
  const ctx = context({ shop: { items: [gearSword()] } });
  const result = planTrade(buyRequest("GearSword0000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "not-visible", line: { itemId: "GearSword0000001", quantity: 1 } });
});

test("a hidden or delisted stock line is not visible to buy", () => {
  const hidden = { ...dagger(), _id: "H1", flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, hidden: true } } } };
  const delisted = { ...dagger(), _id: "H2", flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, notForSale: true } } } };
  const ctx = context({ shop: { items: [hidden, delisted] } });
  assert.equal(planTrade(buyRequest("H1", 1), ctx).reason, "not-visible");
  assert.equal(planTrade(buyRequest("H2", 1), ctx).reason, "not-visible");
});

test("buying more than the finite stock is refused", () => {
  const ctx = context({ shop: { items: [dagger()] } });   // 5 on the shelf
  const result = planTrade(buyRequest("Dagger000000001", 6), ctx);
  assert.equal(result.reason, "out-of-stock");
});

test("selling more than you own is refused", () => {
  const ctx = context({ buyer: { items: [dagger()] } });   // 5 owned
  const result = planTrade(sellRequest("Dagger000000001", 6), ctx);
  assert.equal(result.reason, "out-of-stock");
});

test("a buyer who can't afford it is refused, without any writes", () => {
  const ctx = context({ shop: { items: [dagger()] }, buyer: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  // Affordability is checked once for the whole basket, not per line, so there's no single line to blame.
  assert.deepEqual(result, { ok: false, reason: "cant-afford" });
});

test("a shop whose till can't make change refuses the buy", () => {
  // 1 dagger at 2gp; the buyer has only a platinum piece (10gp), so 8gp of change is owed.
  const ctx = context({
    shop: { items: [dagger()], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 5 } },
    buyer: { currency: { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 } }
  });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  assert.equal(result.reason, "till-short");
});

test("a shop whose till can't pay refuses the sale", () => {
  const ctx = context({
    shop: { items: [], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } },
    buyer: { items: [dagger()] }
  });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "till-short" });
});

test("the fixed exclusions are refused however a shop's own wontBuy reads", () => {
  const ctx = context({ buyer: { items: [naturalBite(), backgroundFeature()] } });
  assert.equal(planTrade(sellRequest("Bite0000000001", 1), ctx).reason, "wont-buy");
  assert.equal(planTrade(sellRequest("Background000001", 1), ctx).reason, "wont-buy");
});

test("the fixed exclusions apply on a buy too, not just gear", () => {
  const ctx = context({ shop: { items: [naturalBite(), backgroundFeature()] } });
  assert.equal(planTrade(buyRequest("Bite0000000001", 1), ctx).reason, "not-visible");
  assert.equal(planTrade(buyRequest("Background000001", 1), ctx).reason, "not-visible");
});

test("a shop's own wontBuy types and kinds are refused", () => {
  const ctx = context({
    shop: { wontBuy: { types: ["weapon"], kinds: ["spellcasting"] } },
    buyer: { items: [dagger(), identifyService()] }
  });
  assert.equal(planTrade(sellRequest("Dagger000000001", 1), ctx).reason, "wont-buy");
  assert.equal(planTrade(sellRequest("IdentifySvc00001", 1), ctx).reason, "wont-buy");
});

test("noBuyback refuses a sale, read off the shop's own matching stock line", () => {
  // The item being sold carries none of its own stock flags any more (they don't travel); the
  // shop's current listing for the same good (by compendiumSource) is what noBuyback reads.
  const listing = { ...dagger(), _id: "ShopDagger00001", flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, noBuyback: true } } } };
  const ctx = context({ shop: { items: [listing] }, buyer: { items: [dagger()] } });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "no-buyback", line: { itemId: "Dagger000000001", quantity: 1 } });
});

test("an unidentified item is refused and never priced", () => {
  const ctx = context({ buyer: { items: [unidentifiedRing()] } });
  const result = planTrade(sellRequest("Ring0000000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "unidentified", line: { itemId: "Ring0000000001", quantity: 1 } });
  assert.equal("bundlePriceCp" in result.line, false);
  assert.equal("lineTotalCp" in result.line, false);
  assert.equal("plan" in result, false);
});

test("an item missing a price is refused as unpriced, buy or sell, never thrown", () => {
  const noPrice = { ...dagger(), system: { ...dagger().system, price: undefined } };
  assert.deepEqual(planTrade(buyRequest("Dagger000000001", 1), context({ shop: { items: [noPrice] } })),
    { ok: false, reason: "unpriced", line: { itemId: "Dagger000000001", quantity: 1 } });
  assert.deepEqual(planTrade(sellRequest("Dagger000000001", 1), context({ buyer: { items: [noPrice] } })),
    { ok: false, reason: "unpriced", line: { itemId: "Dagger000000001", quantity: 1 } });
});

test("an item priced in a denomination the currency config doesn't have is refused as unpriced", () => {
  const badDenomination = { ...dagger(), system: { ...dagger().system, price: { value: 2, denomination: "doubloon" } } };
  const result = planTrade(buyRequest("Dagger000000001", 1), context({ shop: { items: [badDenomination] } }));
  assert.deepEqual(result, { ok: false, reason: "unpriced", line: { itemId: "Dagger000000001", quantity: 1 } });
});

test("a price of 0 is valid and free, not unpriced", () => {
  const free = { ...dagger(), system: { ...dagger().system, price: { value: 0, denomination: "gp" } } };
  const result = planTrade(buyRequest("Dagger000000001", 1), context({ shop: { items: [free] } }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 0);
});

test("a service can't be sold, read off the shop's own matching stock line", () => {
  // The real fixture also sets noBuyback (the generator ties the two together), which would
  // mask this reason; isolate service on its own to test this refusal specifically. The shop
  // has no listing at all here — matched by name, since a service good has no compendiumSource.
  const listing = { ...identifyService(), _id: "ShopIdentify0001", flags: { "merchant-presets": { kind: "spellcasting", stock: { ...identifyService().flags["merchant-presets"].stock, noBuyback: false } } } };
  const ctx = context({ shop: { items: [listing] }, buyer: { items: [identifyService()] } });
  const result = planTrade(sellRequest("IdentifySvc00001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "service", line: { itemId: "IdentifySvc00001", quantity: 1 } });
});

test("a request naming an item that isn't there is refused, not thrown", () => {
  const ctx = context();
  assert.equal(planTrade(sellRequest("NoSuchItem", 1), ctx).reason, "not-found");
});

test("a stale price is refused as stock-changed, with a fresh line for the whole basket", () => {
  // expectedBundlePriceCp is the sticker price the client saw — one whole bundle, not the line
  // total. The arrows line checks the price of one 20-arrow bundle (100cp), regardless of quantity.
  const ctx = context({ shop: { items: [dagger(), arrows()] } });
  const result = planTrade({
    tradeId: "t", kind: "buy",
    lines: [
      { itemId: "Dagger000000001", quantity: 1, expectedBundlePriceCp: 999 },   // stale: real price is 200cp
      { itemId: "5BtSFZjMcs6csxDO", quantity: 20, expectedBundlePriceCp: 100 }  // this one's still right
    ]
  }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stock-changed");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].bundlePriceCp, 200);
  assert.equal(result.lines[0].lineTotalCp, 200);
  assert.equal(result.lines[1].bundlePriceCp, 100);
  assert.equal(result.lines[1].lineTotalCp, 100);
});

test("expectedBundlePriceCp stays valid across a quantity change (bundle price, not the line total)", () => {
  // Buying 40 arrows (two bundles of 20): the line totals 200cp, but the bundle sticker price
  // the client remembers is still 100cp for one bundle of 20 — that's what must match, not 200.
  const ctx = context({ shop: { items: [arrows()] } });
  const result = planTrade(buyRequest("5BtSFZjMcs6csxDO", 40, { expectedBundlePriceCp: 100 }), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 200);
});

/* ------------------------------------------------------------ per stock flag, buy and sell */

test("infinite: true never depletes the shelf", () => {
  const item = { ...dagger(), system: { ...dagger().system, quantity: 1 }, flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, infinite: true } } } };
  const ctx = context({ shop: { items: [item] } });
  const result = planTrade(buyRequest("Dagger000000001", 5), ctx);   // more than the 1 "on the shelf"
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, []);
  assert.deepEqual(shopUpdate.itemDeletes, []);
});

test("infinite: false depletes the shelf by the quantity bought", () => {
  const ctx = context({ shop: { items: [dagger()] } });   // 5 on the shelf, infinite: null but keep defaults
  const result = planTrade(buyRequest("Dagger000000001", 2), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "Dagger000000001", "system.quantity": 3 }]);
});

test("infinite: null follows the world's stock setting", () => {
  const item = dagger();   // infinite: null
  const finite = context({ shop: { items: [{ ...item, system: { ...item.system, quantity: 1 } }] }, worldSettings: { ...WORLD, infiniteStock: false } });
  assert.equal(planTrade(buyRequest("Dagger000000001", 2), finite).reason, "out-of-stock");
  const infinite = context({ shop: { items: [{ ...item, system: { ...item.system, quantity: 1 } }] }, worldSettings: { ...WORLD, infiniteStock: true } });
  assert.equal(planTrade(buyRequest("Dagger000000001", 2), infinite).ok, true);
});

test("keep: false deletes a stock line once it sells out, instead of leaving it at 0", () => {
  const item = { ...dagger(), system: { ...dagger().system, quantity: 1 }, flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, keep: false } } } };
  const ctx = context({ shop: { items: [item] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, []);
  assert.deepEqual(shopUpdate.itemDeletes, ["Dagger000000001"]);
});

test("keep: true (the default) leaves a sold-out line at quantity 0", () => {
  const item = { ...dagger(), system: { ...dagger().system, quantity: 1 } };
  const ctx = context({ shop: { items: [item] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "Dagger000000001", "system.quantity": 0 }]);
  assert.deepEqual(shopUpdate.itemDeletes, []);
});

test("buying a service transfers no item but still charges", () => {
  const ctx = context({ shop: { items: [identifyService()] }, buyer: { currency: { pp: 0, gp: 200, ep: 0, sp: 0, cp: 0 } } });
  const result = planTrade(buyRequest("IdentifySvc00001", 1), ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.deepEqual(buyerUpdate.itemCreates, []);
  assert.deepEqual(buyerUpdate.itemUpdates, []);
  assert.equal(result.plan.hook.totalCp, 15000);   // 150gp, still billed
});

test("a bundle prices per its own quantityForPrice, buy and sell", () => {
  const buy = planTrade(buyRequest("5BtSFZjMcs6csxDO", 20), context({ shop: { items: [arrows()] } }));
  assert.equal(buy.ok, true);
  assert.equal(buy.plan.hook.totalCp, 100);   // 1gp per 20, buying 20 = 100cp

  // The bundle comes from the shop's own matching listing now, not the sold item itself.
  const listing = { ...arrows(), _id: "ShopArrowsBundle1" };
  const owned = { ...arrows(), system: { ...arrows().system, quantity: 20 } };
  const sell = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), context({ shop: { items: [listing] }, buyer: { items: [owned] } }));
  assert.equal(sell.ok, true);
  assert.equal(sell.plan.hook.totalCp, 50);   // buysAt 0.5 of the same 100cp
});

test("selling a bundled good to a shop with no matching line still prices by its own carried bundle", () => {
  // Simulates an item that was originally bought from a shop stocking it at bundle: 20 (so it
  // carries flags.merchant-presets.bundle, per copyOf), then resold somewhere that's never
  // stocked it at all. Bundle 1 would price 20 arrows at 20x too much (10gp instead of 0.5gp).
  const carriedBundle = { ...arrows(), system: { ...arrows().system, quantity: 20 }, flags: { "merchant-presets": { bundle: 20 } } };
  const ctx = context({ buyer: { items: [carriedBundle] } });   // no shop stock at all: no matching line
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 50);
});

test("matchingStockLine falls back to matching by name when the source doesn't match anything", () => {
  const differentSource = { ...dagger(), _stats: { compendiumSource: "Compendium.other.item.SomeOtherId" } };
  const listing = { ...dagger(), _id: "ShopDagger00002", flags: { "merchant-presets": { stock: { noBuyback: true } } } };
  const ctx = context({ shop: { items: [listing] }, buyer: { items: [differentSource] } });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "no-buyback", line: { itemId: "Dagger000000001", quantity: 1 } });
});

test("a sale with no matching line and no bundle flag falls back to context.bundleOf", () => {
  // Starting gear straight from a class kit, never bought from any shop: no matching line, no
  // flags.merchant-presets.bundle. context.bundleOf is the runtime's last resort, resolved from
  // the item's compendium source — a stub here stands in for that lookup.
  const startingArrows = { ...arrows(), system: { ...arrows().system, quantity: 20 }, flags: {} };
  const ctx = context({
    buyer: { items: [startingArrows] },
    bundleOf: item => (item._stats?.compendiumSource === arrows()._stats.compendiumSource ? 20 : undefined)
  });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 50);   // 1gp bundle-of-20 at buysAt 0.5, not 20 * (1gp * 0.5)
});

test("bundleOf is never consulted when a matching line or a carried bundle flag already answers", () => {
  const explodes = () => { throw new Error("bundleOf should not have been called"); };
  const listing = { ...arrows(), _id: "ShopArrowsBundle2" };
  const owned = { ...arrows(), system: { ...arrows().system, quantity: 20 } };
  const matched = context({ shop: { items: [listing] }, buyer: { items: [owned] }, bundleOf: explodes });
  assert.equal(planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), matched).ok, true);

  const carriedFlag = { ...arrows(), system: { ...arrows().system, quantity: 20 }, flags: { "merchant-presets": { bundle: 20 } } };
  const flagged = context({ buyer: { items: [carriedFlag] }, bundleOf: explodes });
  assert.equal(planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), flagged).ok, true);
});

test("selling a bundled good onto a sold-in line with no stock flags prices by the carried bundle", () => {
  // A line created by an earlier sale: copyOf stripped `stock` but kept `bundle`. Matching it must
  // not reset the bundle to STOCK_DEFAULTS' 1, or 20 arrows would pay 20x (10gp, not 0.5gp).
  const soldIn = { ...arrows(), _id: "SoldInArrows001", system: { ...arrows().system, quantity: 20 }, flags: { "merchant-presets": { bundle: 20 } } };
  const owned = { ...arrows(), system: { ...arrows().system, quantity: 20 }, flags: { "merchant-presets": { bundle: 20 } } };
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), context({ shop: { items: [soldIn] }, buyer: { items: [owned] } }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 50);
});

test("buying back a sold-in line prices and steps by its carried bundle", () => {
  const soldIn = { ...arrows(), _id: "SoldInArrows001", system: { ...arrows().system, quantity: 40 }, flags: { "merchant-presets": { bundle: 20 } } };
  const ctx = context({ shop: { items: [soldIn] } });
  const result = planTrade(buyRequest("SoldInArrows001", 20), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 100);   // 1gp for the bundle of 20, not 20gp
  assert.equal(planTrade(buyRequest("SoldInArrows001", 7), ctx).reason, "invalid-request");
});

test("an unidentified item on the shelf is refused to buy, never priced", () => {
  const ring = { ...unidentifiedRing(), system: { ...unidentifiedRing().system, price: { value: 50, denomination: "gp" } } };
  const result = planTrade(buyRequest("Ring0000000001", 1), context({ shop: { items: [ring] } }));
  assert.deepEqual(result, { ok: false, reason: "unidentified", line: { itemId: "Ring0000000001", quantity: 1 } });
});

test("a quantity past the per-line cap is an invalid request, before anything is planned", () => {
  const freeInfinite = { ...backpack("Backpack0000009"), system: { ...backpack("x").system, price: { value: 0, denomination: "gp" } }, flags: { "merchant-presets": { stock: { ...backpack("x").flags["merchant-presets"].stock, infinite: true } } } };
  const ctx = context({ shop: { items: [freeInfinite] } });
  assert.equal(planTrade(buyRequest("Backpack0000009", 1e12), ctx).reason, "invalid-request");
  assert.equal(planTrade(buyRequest("Backpack0000009", 10_001), ctx).reason, "invalid-request");
  // Split across duplicate lines, the merged total is capped too.
  const split = { tradeId: "trade-1", kind: "buy", lines: [{ itemId: "Backpack0000009", quantity: 6000 }, { itemId: "Backpack0000009", quantity: 6000 }] };
  assert.equal(planTrade(split, ctx).reason, "invalid-request");
});

test("a line on the default category is priced by its item type's category rule, both ways", () => {
  // schema.mjs: category "" files an item under its item type.
  const terms = { sellsAt: null, buysAt: null, categories: [{ category: "weapon", sellsAt: 1.5, buysAt: 0.25 }] };
  const bought = planTrade(buyRequest("Dagger000000001", 1), context({ shop: { items: [dagger()], terms } }));
  assert.equal(bought.plan.hook.totalCp, 300);   // 2gp x 1.5
  assert.equal(bought.plan.hook.lines[0].layer, "category");
  const owned = { ...dagger(), flags: {} };
  const sold = planTrade(sellRequest("Dagger000000001", 1), context({ shop: { terms }, buyer: { items: [owned] } }));
  assert.equal(sold.plan.hook.totalCp, 50);      // 2gp x 0.25, a weapon the shop never stocked
});

test("a buy may take a line's odd part-bundle remainder, on top of whole bundles", () => {
  const shelf = { ...arrows(), system: { ...arrows().system, quantity: 305 } };   // 5 sold back onto 300
  const ctx = context({ shop: { items: [shelf] }, buyer: { currency: { pp: 0, gp: 100, ep: 0, sp: 0, cp: 0 } } });
  assert.equal(planTrade(buyRequest("5BtSFZjMcs6csxDO", 5), ctx).plan.hook.totalCp, 25);     // 1gp x 5/20
  assert.equal(planTrade(buyRequest("5BtSFZjMcs6csxDO", 25), ctx).plan.hook.totalCp, 125);
  assert.equal(planTrade(buyRequest("5BtSFZjMcs6csxDO", 305), ctx).plan.hook.totalCp, 1525);
  assert.equal(planTrade(buyRequest("5BtSFZjMcs6csxDO", 7), ctx).reason, "invalid-request");

  const soldIn = { ...arrows(), _id: "SoldInArrows002", system: { ...arrows().system, quantity: 5 }, flags: { "merchant-presets": { bundle: 20 } } };
  assert.equal(planTrade(buyRequest("SoldInArrows002", 5), context({ shop: { items: [soldIn] } })).ok, true);
});

test("an infinite line has no remainder: whole bundles only", () => {
  const endless = { ...arrows(), system: { ...arrows().system, quantity: 305 }, flags: { "merchant-presets": { stock: { ...arrows().flags["merchant-presets"].stock, infinite: true } } } };
  assert.equal(planTrade(buyRequest("5BtSFZjMcs6csxDO", 5), context({ shop: { items: [endless] } })).reason, "invalid-request");
});

test("a remainder that floors to nothing is refused worthless", () => {
  const cheap = { ...arrows(), system: { ...arrows().system, quantity: 25, price: { value: 1, denomination: "cp" } } };
  const result = planTrade(buyRequest("5BtSFZjMcs6csxDO", 5), context({ shop: { items: [cheap] } }));
  assert.deepEqual(result, { ok: false, reason: "worthless", line: { itemId: "5BtSFZjMcs6csxDO", quantity: 5 } });
});

test("a sale stacks onto a hidden line, and stays hidden", () => {
  const hidden = { ...arrows(), _id: "HiddenArrows001", system: { ...arrows().system, quantity: 40 }, flags: { "merchant-presets": { stock: { ...arrows().flags["merchant-presets"].stock, hidden: true } } } };
  const owned = { ...arrows(), system: { ...arrows().system, quantity: 20 }, flags: {} };
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), context({ shop: { items: [hidden] }, buyer: { items: [owned] } }));
  const shopUpdate = result.plan.updates[1];
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "HiddenArrows001", "system.quantity": 60 }]);
  assert.deepEqual(shopUpdate.itemCreates, []);
});

test("a sale that can't stack onto a delisted line lands delisted too", () => {
  const delisted = { ...dagger(), _id: "DelistedDagger1", flags: { "merchant-presets": { stock: { ...dagger().flags["merchant-presets"].stock, notForSale: true } } } };
  const owned = { ...dagger(), flags: {} };
  const result = planTrade(sellRequest("Dagger000000001", 1), context({ shop: { items: [delisted] }, buyer: { items: [owned] } }));
  const [created] = result.plan.updates[1].itemCreates;
  assert.equal(created.flags["merchant-presets"].stock.notForSale, true);
  assert.equal(created.flags["merchant-presets"].stock.hidden, false);
});

test("an unlimited-coin shop pays out in gold, silver and copper, never electrum or platinum", () => {
  const pricey = { ...dagger(), system: { ...dagger().system, quantity: 1, price: { value: 23, denomination: "gp" } }, flags: {} };
  const ctx = context({
    worldSettings: { ...WORLD, infinitePurse: true },
    buyer: { items: [pricey], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } }
  });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);   // 1150cp
  assert.deepEqual(result.plan.updates[0].currency, { pp: 0, gp: 11, ep: 0, sp: 5, cp: 0 });
});

test("containers that hold each other (bad data) are refused, not a stack overflow", () => {
  const a = { ...backpack("LoopA0000000001"), system: { ...backpack("x").system, container: "LoopB0000000001" }, flags: {} };
  const b = { ...backpack("LoopB0000000001"), system: { ...backpack("x").system, container: "LoopA0000000001" }, flags: {} };
  const result = planTrade(sellRequest("LoopA0000000001", 1), context({ buyer: { items: [a, b] } }));
  assert.equal(result.reason, "container-not-empty");
});

test("a sold container matching a delisted line lands delisted too", () => {
  const delisted = { ...backpack("ShopPack0000001"), flags: { "merchant-presets": { stock: { ...backpack("x").flags["merchant-presets"].stock, notForSale: true } } } };
  const owned = { ...backpack("OwnedPack000001"), flags: {} };
  const result = planTrade(sellRequest("OwnedPack000001", 1), context({ shop: { items: [delisted] }, buyer: { items: [owned] } }));
  const [created] = result.plan.updates[1].itemCreates;
  assert.equal(created.flags["merchant-presets"].stock.notForSale, true);
});

test("a copy a sale creates is finite, even in an infinite-stock world", () => {
  const owned = { ...dagger(), system: { ...dagger().system, quantity: 1 }, flags: {} };
  const result = planTrade(sellRequest("Dagger000000001", 1), context({ worldSettings: { ...WORLD, infiniteStock: true }, buyer: { items: [owned] } }));
  const [created] = result.plan.updates[1].itemCreates;
  assert.equal(created.flags["merchant-presets"].stock.infinite, false);
});

/* -------------------------------------------------------------------- stacking */

test("buying a consumable stacks onto an identical one already owned", () => {
  const owned = { ...arrows(), _id: "OwnedArrows0001", system: { ...arrows().system, quantity: 40 } };
  const ctx = context({ shop: { items: [arrows()] }, buyer: { items: [owned] } });
  const result = planTrade(buyRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.deepEqual(buyerUpdate.itemCreates, []);
  assert.deepEqual(buyerUpdate.itemUpdates, [{ _id: "OwnedArrows0001", "system.quantity": 60 }]);
});

test("buying a non-stacking type (a weapon) always creates a new document", () => {
  const owned = { ...dagger(), _id: "OwnedDagger0001" };
  const ctx = context({ shop: { items: [dagger()] }, buyer: { items: [owned] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(buyerUpdate.itemUpdates.length, 0);
  assert.equal(buyerUpdate.itemCreates.length, 1);
});

test("two lines in one basket stack onto each other, not just onto what was already owned", () => {
  // Two separate stock listings of the same good (same source, same name): buying both in one
  // basket should land as one item on the buyer, the second line stacking onto what the first
  // just created, not two documents.
  const first = arrows();
  const second = { ...arrows(), _id: "SecondArrows001" };
  const ctx = context({ shop: { items: [first, second] } });
  const result = planTrade({
    tradeId: "t", kind: "buy",
    lines: [{ itemId: first._id, quantity: 20 }, { itemId: second._id, quantity: 20 }]
  }, ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  // One pending document, not a create-then-immediately-update pair: the second line's 20 folds
  // straight into the first line's still-unsaved create.
  assert.equal(buyerUpdate.itemCreates.length, 1);
  assert.equal(buyerUpdate.itemCreates[0].system.quantity, 40);
  assert.equal(buyerUpdate.itemUpdates.length, 0);
});

test("a sold item lands on the shop the same way, stacking if identical", () => {
  const shopOwned = { ...arrows(), _id: "ShopArrows0001", system: { ...arrows().system, quantity: 60 } };
  const sold = { ...arrows(), system: { ...arrows().system, quantity: 20 } };
  const ctx = context({ shop: { items: [shopOwned] }, buyer: { items: [sold] } });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemCreates, []);
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "ShopArrows0001", "system.quantity": 80 }]);
});

/* ------------------------------------------------------------------- containers */

test("buying several containers at once creates one document each, not one at quantity N", () => {
  const infiniteBackpack = { ...backpack("Backpack0000001"), flags: { "merchant-presets": { stock: { ...backpack("x").flags["merchant-presets"].stock, infinite: true } } } };
  const ctx = context({ shop: { items: [infiniteBackpack] } });
  const result = planTrade(buyRequest("Backpack0000001", 3), ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(buyerUpdate.itemCreates.length, 3);
  assert.ok(buyerUpdate.itemCreates.every(c => c.system.quantity === 1));
});

test("a stock item already sitting inside a container isn't individually buyable", () => {
  // Whatever it's inside is what's for sale; buying the loose item directly would hand it out
  // twice over once its container is bought too (see the "kit contents" tests, below).
  const inACrate = { ...backpack("Backpack0000002"), system: { ...backpack("x").system, container: "Crate000000001" } };
  const ctx = context({ shop: { items: [inACrate] } });
  const result = planTrade(buyRequest("Backpack0000002", 1), ctx);
  assert.equal(result.reason, "not-visible");
});

/* --------------------------------------------------------------- kit contents (#89-safe) */

/** A torch, or anything else, sitting inside `containerId` on whichever actor holds it. */
function torchIn(id, containerId, quantity = 1) {
  return {
    _id: id, name: "Torch", type: "consumable",
    system: { price: { value: 1, denomination: "cp" }, identified: true, container: containerId, quantity, type: { value: "torch", subtype: "" } },
    flags: {}, _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.phbagTorch00000" }
  };
}

test("buying a container brings its contents along, pointed at the new container's id", () => {
  const pack = backpack("Backpack0000003");
  const torch = torchIn("Torch000000001", "Backpack0000003", 3);
  const ctx = context({ shop: { items: [pack, torch] } });
  const result = planTrade(buyRequest("Backpack0000003", 1), ctx);
  assert.equal(result.ok, true);

  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(buyerUpdate.itemCreates.length, 2);
  const newPack = buyerUpdate.itemCreates.find(c => c.name === "Backpack");
  const newTorch = buyerUpdate.itemCreates.find(c => c.name === "Torch");
  assert.equal(newPack._id, "NewId0");            // the injected, deterministic newId()
  assert.equal(newTorch.system.container, "NewId0");
  assert.equal(newTorch.system.quantity, 3);

  // The shop loses the torches outright — free, not priced or decremented separately. The pack
  // itself follows its own stock rule (keep: true, the default): it stays at quantity 0.
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemDeletes, ["Torch000000001"]);
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "Backpack0000003", "system.quantity": 0 }]);
  assert.equal(result.plan.hook.totalCp, 200);   // just the 2gp backpack; the torch was never priced
});

test("a nested container's own contents come along too, recursively", () => {
  const pack = backpack("Backpack0000004");
  const pouch = { ...backpack("Pouch00000001"), name: "Pouch", system: { ...backpack("x").system, container: "Backpack0000004" } };
  const coin = torchIn("Trinket0000001", "Pouch00000001", 1);
  const ctx = context({ shop: { items: [pack, pouch, coin] } });
  const result = planTrade(buyRequest("Backpack0000004", 1), ctx);
  assert.equal(result.ok, true);

  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(buyerUpdate.itemCreates.length, 3);
  const newPouch = buyerUpdate.itemCreates.find(c => c.name === "Pouch");
  const newTrinket = buyerUpdate.itemCreates.find(c => c.name === "Torch");
  assert.equal(newPouch.system.container, "NewId0");        // inside the new backpack
  assert.equal(newTrinket.system.container, newPouch._id);  // inside the new pouch, not the backpack directly

  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemDeletes.sort(), ["Pouch00000001", "Trinket0000001"]);
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "Backpack0000004", "system.quantity": 0 }]);
});

test("an empty container still buys the ordinary way, no newId needed", () => {
  const ctx = context({ shop: { items: [backpack("Backpack0000005")] }, newId: () => { throw new Error("should not be called"); } });
  const result = planTrade(buyRequest("Backpack0000005", 1), ctx);
  assert.equal(result.ok, true);
  const created = result.plan.updates.find(u => u.actorId === "Buyer000000001").itemCreates[0];
  assert.equal("_id" in created, false);   // left for Foundry to assign, as before
});

test("a keep: false container that sells out with contents doesn't orphan them on the shop", () => {
  const pack = { ...backpack("Backpack0000006"), flags: { "merchant-presets": { stock: { ...backpack("x").flags["merchant-presets"].stock, keep: false } } } };
  const torch = torchIn("Torch000000002", "Backpack0000006", 1);
  const ctx = context({ shop: { items: [pack, torch] } });
  const result = planTrade(buyRequest("Backpack0000006", 1), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  // Both gone outright — the depleted, keep: false container line is deleted like any other,
  // and the torch went with it as the container's contents, not left dangling.
  assert.deepEqual(shopUpdate.itemUpdates, []);
  assert.deepEqual(shopUpdate.itemDeletes.sort(), ["Backpack0000006", "Torch000000002"]);
});

test("selling a container with something in it is refused", () => {
  const pack = backpack("Backpack0000007");
  const torch = torchIn("Torch000000003", "Backpack0000007", 1);
  const ctx = context({ buyer: { items: [pack, torch] } });
  const result = planTrade(sellRequest("Backpack0000007", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "container-not-empty", line: { itemId: "Backpack0000007", quantity: 1 } });
});

test("selling a container empty of direct contents but not of nested ones is still refused", () => {
  const pack = backpack("Backpack0000008");
  const pouch = { ...backpack("Pouch00000002"), name: "Pouch", system: { ...backpack("x").system, container: "Backpack0000008" } };
  const coin = torchIn("Trinket0000002", "Pouch00000002", 1);   // nested two deep, not a direct child
  const ctx = context({ buyer: { items: [pack, pouch, coin] } });
  assert.equal(planTrade(sellRequest("Backpack0000008", 1), ctx).reason, "container-not-empty");
});

test("an empty container sells normally", () => {
  const ctx = context({ buyer: { items: [backpack("Backpack0000009")] } });
  const result = planTrade(sellRequest("Backpack0000009", 1), ctx);
  assert.equal(result.ok, true);
});

test("a container's contents can't also be bought as their own line in the same basket", () => {
  // Requesting both the bag and the rope inside it would otherwise hand the rope out twice
  // (once loose, once as the bag's contents) and write conflicting updates for the same shop
  // item. The rope line refuses outright: it's not individually visible once it's inside something.
  const pack = backpack("Backpack0000010");
  const rope = torchIn("Rope0000000001", "Backpack0000010", 5);
  const ctx = context({ shop: { items: [pack, rope] } });
  const result = planTrade({
    tradeId: "t", kind: "buy",
    lines: [{ itemId: "Rope0000000001", quantity: 5 }, { itemId: "Backpack0000010", quantity: 1 }]
  }, ctx);
  assert.deepEqual(result, { ok: false, reason: "not-visible", line: { itemId: "Rope0000000001", quantity: 5 } });
});

test("a container holding shopkeeper gear can't be bought at all", () => {
  const pack = backpack("Backpack0000011");
  const dagger = { ...torchIn("GearItem0000001", "Backpack0000011", 1), flags: { "merchant-presets": { kind: "gear" } } };
  const ctx = context({ shop: { items: [pack, dagger] } });
  const result = planTrade(buyRequest("Backpack0000011", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "not-visible", line: { itemId: "Backpack0000011", quantity: 1 } });
});

test("a container holding a hidden or delisted line can't be bought at all", () => {
  const pack = backpack("Backpack0000012");
  const hiddenItem = { ...torchIn("HiddenItem0001", "Backpack0000012", 1), flags: { "merchant-presets": { stock: { hidden: true } } } };
  const ctx = context({ shop: { items: [pack, hiddenItem] } });
  const result = planTrade(buyRequest("Backpack0000012", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "not-visible", line: { itemId: "Backpack0000012", quantity: 1 } });
});

/* ------------------------------------------------------------- shelf flags don't travel */

/** A stock line drawn by #105's restock, and hidden — both shelf-only, neither should travel. */
function drawnDagger(id) {
  return { ...dagger(), _id: id, flags: { "merchant-presets": {
    kind: "food-drink", drawn: true, stock: { ...dagger().flags["merchant-presets"].stock, hidden: false }
  } } };
}

test("buying strips the shop's stock and drawn flags from the copy, keeping kind", () => {
  const ctx = context({ shop: { items: [drawnDagger("Dagger000000001")] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  assert.equal(result.ok, true);
  const created = result.plan.updates.find(u => u.actorId === "Buyer000000001").itemCreates[0];
  assert.equal(created.flags["merchant-presets"].kind, "food-drink");
  assert.equal("stock" in created.flags["merchant-presets"], false);
  assert.equal("drawn" in created.flags["merchant-presets"], false);
});

test("a drawn item bought then sold back carries no drawn tag onto the next shop", () => {
  const buyCtx = context({ shop: { items: [drawnDagger("Dagger000000001")] } });
  const bought = planTrade(buyRequest("Dagger000000001", 1), buyCtx);
  assert.equal(bought.ok, true);
  const boughtItem = bought.plan.updates.find(u => u.actorId === "Buyer000000001").itemCreates[0];
  assert.equal("drawn" in boughtItem.flags["merchant-presets"], false);

  // A real trade would give it a real _id on the way through; stand that in for the sell.
  const owned = { ...boughtItem, _id: "Dagger000000001" };
  const sellCtx = context({ buyer: { items: [owned] } });   // a different shop, no matching listing
  const sold = planTrade(sellRequest("Dagger000000001", 1), sellCtx);
  assert.equal(sold.ok, true);
  const landed = sold.plan.updates.find(u => u.actorId === "Shop00000000001").itemCreates[0];
  assert.equal("drawn" in landed.flags["merchant-presets"], false);
  assert.equal("stock" in landed.flags["merchant-presets"], false);
  // No matching listing at this shop, so it reads as STOCK_DEFAULTS once there (not hidden, not a service).
  assert.equal(landed.flags["merchant-presets"].kind, "food-drink");
});

/* --------------------------------------------------------------------- writes shape */

test("a plain buy: currency both ways, one item create, the hook and chat card filled in", () => {
  const ctx = context({ shop: { items: [dagger()] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  assert.equal(result.ok, true);
  const { plan } = result;
  assert.equal(plan.tradeId, "trade-1");
  assert.equal(plan.kind, "buy");

  const buyerUpdate = plan.updates.find(u => u.actorId === "Buyer000000001");
  const shopUpdate = plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(buyerUpdate.currency, { pp: 0, gp: 18, ep: 0, sp: 0, cp: 0 });   // 20gp - 2gp
  assert.deepEqual(shopUpdate.currency, { pp: 0, gp: 502, ep: 0, sp: 0, cp: 0 });   // 500gp + 2gp
  assert.equal(buyerUpdate.itemCreates.length, 1);
  assert.equal(buyerUpdate.itemCreates[0].name, "Dagger");

  assert.equal(plan.hook.totalCp, 200);
  assert.equal(plan.hook.changeCp, 0);
  assert.equal(plan.hook.lines[0].bundlePriceCp, 200);
  assert.equal(plan.hook.lines[0].lineTotalCp, 200);
  assert.equal(plan.chatCard.direction, "Paid");
  assert.equal(plan.chatCard.lines[0].label, "Dagger");
  assert.equal(plan.chatCard.lines[0].lineTotalCp, 200);   // not lineTotalCp * quantity again
  assert.equal(plan.chatCard.totalCp, 200);
});

test("an infinite purse leaves the shop's own currency out of the plan", () => {
  const ctx = context({ shop: { items: [dagger()] }, worldSettings: { ...WORLD, infinitePurse: true } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.equal(shopUpdate.currency, undefined);
});

test("the chat card's line total isn't multiplied twice for a bundle", () => {
  // 20 arrows, bundle 20: the line total is 100cp. bundlePriceCp * quantity would wrongly give 2000cp.
  const ctx = context({ shop: { items: [arrows()] } });
  const result = planTrade(buyRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.chatCard.lines[0].lineTotalCp, 100);
  assert.equal(result.plan.hook.lines[0].bundlePriceCp, 100);
});

/* ------------------------------------------------------------------ invalid requests */

test("a negative or zero quantity is refused, never a negative price or reversed stock", () => {
  const ctx = context({ shop: { items: [dagger()] } });
  for (const quantity of [-1, 0, 1.5, NaN, "3"]) {
    const result = planTrade(buyRequest("Dagger000000001", quantity), ctx);
    assert.deepEqual(result, { ok: false, reason: "invalid-request", line: { itemId: "Dagger000000001", quantity } });
  }
});

test("a non-string itemId is refused", () => {
  const ctx = context({ shop: { items: [dagger()] } });
  const result = planTrade(buyRequest(42, 1), ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-request");
});

test("a bad kind or tradeId is refused at the request level, with no line to blame", () => {
  const ctx = context({ shop: { items: [dagger()] } });
  assert.deepEqual(planTrade({ tradeId: "t", kind: "trade", lines: [{ itemId: "Dagger000000001", quantity: 1 }] }, ctx),
    { ok: false, reason: "invalid-request" });
  assert.deepEqual(planTrade({ tradeId: "", kind: "buy", lines: [{ itemId: "Dagger000000001", quantity: 1 }] }, ctx),
    { ok: false, reason: "invalid-request" });
  assert.deepEqual(planTrade({ tradeId: "t", kind: "buy", lines: [] }, ctx), { ok: false, reason: "invalid-request" });
});

test("a basket over the line cap is refused", () => {
  const ctx = context({ shop: { items: [dagger()] } });
  const lines = Array.from({ length: 101 }, () => ({ itemId: "Dagger000000001", quantity: 1 }));
  assert.deepEqual(planTrade({ tradeId: "t", kind: "buy", lines }, ctx), { ok: false, reason: "invalid-request" });
});

test("a buy quantity that isn't a whole multiple of the bundle is invalid", () => {
  const ctx = context({ shop: { items: [arrows()] } });   // bundle 20
  const result = planTrade(buyRequest("5BtSFZjMcs6csxDO", 5), ctx);
  assert.deepEqual(result, { ok: false, reason: "invalid-request", line: { itemId: "5BtSFZjMcs6csxDO", quantity: 5 } });
});

test("buying a single unit of a cheap bundle is refused, not given away for 0cp", () => {
  // 4cp per 20 (Item Piles' own quantityForPrice contract): one unit alone floors to 0cp, so
  // the quantity must be a whole bundle instead of trading for free.
  const bullets = { ...arrows(), _id: "Bullets0000001", name: "Bullets", system: { ...arrows().system, price: { value: 4, denomination: "cp" } } };
  const ctx = context({ shop: { items: [bullets] } });
  assert.equal(planTrade(buyRequest("Bullets0000001", 1), ctx).reason, "invalid-request");
  const wholeBundle = planTrade(buyRequest("Bullets0000001", 20), ctx);
  assert.equal(wholeBundle.ok, true);
  assert.equal(wholeBundle.plan.hook.totalCp, 4);
});

test("a sell whose payout floors to 0cp for a real item is refused as worthless", () => {
  // 4cp per 20 bundle, selling just 1 at buysAt 0.5: floors to 0, but the item is genuinely
  // worth something (price 4cp) — refused, not traded away for nothing.
  const bullets = { ...arrows(), name: "Bullets", system: { ...arrows().system, price: { value: 4, denomination: "cp" }, quantity: 1 }, flags: { "merchant-presets": { bundle: 20 } } };
  const ctx = context({ buyer: { items: [bullets] } });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "worthless", line: { itemId: "5BtSFZjMcs6csxDO", quantity: 1 } });
});

test("a genuinely free item still sells for 0cp, not refused as worthless", () => {
  const free = { ...dagger(), system: { ...dagger().system, price: { value: 0, denomination: "gp" } } };
  const ctx = context({ buyer: { items: [free] } });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 0);
});

test("duplicate itemIds in one basket are merged, not double-refused or double-charged", () => {
  const ctx = context({ shop: { items: [dagger()] } });   // 5 on the shelf
  const result = planTrade({
    tradeId: "t", kind: "buy",
    lines: [{ itemId: "Dagger000000001", quantity: 2 }, { itemId: "Dagger000000001", quantity: 1 }]
  }, ctx);
  assert.equal(result.ok, true);
  assert.equal(result.plan.hook.totalCp, 600);   // 3 daggers total, not 2 separate lines of pricing
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "Dagger000000001", "system.quantity": 2 }]);   // 5 - 3
});

test("selling the same item across two lines can't sell more than owned by splitting the ask", () => {
  // Two lines of 5 for an item with 5 owned: merged into one line of 10, correctly refused.
  const owned = { ...dagger(), system: { ...dagger().system, quantity: 5 } };
  const ctx = context({ buyer: { items: [owned] } });
  const result = planTrade({
    tradeId: "t", kind: "sell",
    lines: [{ itemId: "Dagger000000001", quantity: 5 }, { itemId: "Dagger000000001", quantity: 5 }]
  }, ctx);
  assert.equal(result.reason, "out-of-stock");
});

/* -------------------------------------------------------------- config never throws */

test("a shop with no shop config at all is refused as misconfigured, not thrown", () => {
  const brokenShop = { ...shop({ items: [dagger()] }), flags: {} };   // no merchant-presets.shop flag
  const ctx = { ...context(), shop: brokenShop };
  assert.deepEqual(planTrade(buyRequest("Dagger000000001", 1), ctx), { ok: false, reason: "shop-misconfigured" });
  assert.deepEqual(planTrade(sellRequest("Dagger000000001", 1), { ...ctx, buyer: { items: [dagger()] } }),
    { ok: false, reason: "shop-misconfigured" });
});

test("an item with an invalid stock config is refused as misconfigured, not thrown", () => {
  const broken = { ...dagger(), flags: { "merchant-presets": { stock: { bundle: -1 } } } };
  const ctx = context({ shop: { items: [broken] } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  assert.deepEqual(result, { ok: false, reason: "shop-misconfigured", line: { itemId: "Dagger000000001", quantity: 1 } });
});

/* -------------------------------------------------------------------------- stacking edge cases */

test("a sold item with a leftover container id still stacks onto the shop's top-level one once landed", () => {
  // Selling has no "already contained" restriction (that's a buy-side, shelf-visibility rule),
  // so an item that happens to carry a stray container value can still be sold; the landed copy
  // is always top-level (copyOf clears it), so it should stack onto the shop's existing
  // top-level arrows regardless of what it says it was in.
  const withStrayContainer = { ...arrows(), system: { ...arrows().system, container: "SomeOldQuiver01", quantity: 20 } };
  const shopOwned = { ...arrows(), _id: "ShopArrows0002", system: { ...arrows().system, quantity: 60 } };
  const ctx = context({ shop: { items: [shopOwned] }, buyer: { items: [withStrayContainer] } });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemCreates, []);
  assert.deepEqual(shopUpdate.itemUpdates, [{ _id: "ShopArrows0002", "system.quantity": 80 }]);
});

test("a sold item never stacks onto shopkeeper gear, even if it looks identical", () => {
  const gearArrows = { ...arrows(), _id: "GearArrows0001", flags: { "merchant-presets": { kind: "gear" } } };
  const sold = { ...arrows(), system: { ...arrows().system, quantity: 20 } };
  const ctx = context({ shop: { items: [gearArrows] }, buyer: { items: [sold] } });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, []);      // the gear item's quantity is untouched
  assert.equal(shopUpdate.itemCreates.length, 1);    // a new document instead
});

test("a sold item never stacks onto shopkeeper gear", () => {
  // Hidden and delisted lines are stack targets since #102's 2026-09-25 decision; gear never is.
  const gearArrows = { ...arrows(), _id: "GearArrows00001", flags: { "merchant-presets": { kind: "gear" } } };
  const sold = { ...arrows(), system: { ...arrows().system, quantity: 20 } };
  const ctx = context({ shop: { items: [gearArrows] }, buyer: { items: [sold] } });
  const result = planTrade(sellRequest("5BtSFZjMcs6csxDO", 20), ctx);
  assert.equal(result.ok, true);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.deepEqual(shopUpdate.itemUpdates, []);
  assert.equal(shopUpdate.itemCreates.length, 1);
});

/* --------------------------------------------------------------- the till pays exactly on a sale */

test("the shop pays exactly on a sale, breaking its own coins, even from an empty player purse", () => {
  const sold = { ...dagger(), system: { ...dagger().system, quantity: 1 } };   // sells for 100cp
  const ctx = context({
    shop: { items: [], currency: { pp: 1, gp: 0, ep: 0, sp: 0, cp: 0 } },   // only a platinum piece (1000cp)
    buyer: { items: [sold], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } }   // empty purse
  });
  const result = planTrade(sellRequest("Dagger000000001", 1), ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(totalCp(buyerUpdate.currency, CURRENCIES), 100);   // exactly what the item is worth
  assert.equal(result.plan.hook.changeCp, 0);   // no change concept on a sale any more
});

test("a sale is till-short only when the shop's own total is short, never the player's", () => {
  const sold = { ...dagger(), system: { ...dagger().system, quantity: 1 } };   // sells for 100cp
  const ctx = context({
    shop: { items: [], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 99 } },   // 1cp short
    buyer: { items: [sold], currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } }
  });
  assert.deepEqual(planTrade(sellRequest("Dagger000000001", 1), ctx), { ok: false, reason: "till-short" });
});
