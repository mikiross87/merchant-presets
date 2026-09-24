import { test } from "node:test";
import assert from "node:assert/strict";
import { planTrade } from "../scripts/trade-plan.mjs";

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

const context = (over = {}) => ({
  shop: shop(over.shop), buyer: buyer(over.buyer), worldSettings: over.worldSettings ?? WORLD,
  currencies: CURRENCIES, deal: over.deal ?? null, now: over.now ?? OPEN
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
  assert.equal("unitPriceCp" in result.line, false);
  assert.equal("plan" in result, false);
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
  const ctx = context({ shop: { items: [dagger(), arrows()] } });
  const result = planTrade({
    tradeId: "t", kind: "buy",
    lines: [
      { itemId: "Dagger000000001", quantity: 1, expectedUnitPriceCp: 999 },   // stale: real price is 200cp
      { itemId: "5BtSFZjMcs6csxDO", quantity: 20, expectedUnitPriceCp: 100 }  // this one's still right
    ]
  }, ctx);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stock-changed");
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].unitPriceCp, 200);
  assert.equal(result.lines[1].unitPriceCp, 100);
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

test("the copy's system.container is dropped even if the stock line somehow had one", () => {
  const inACrate = { ...backpack("Backpack0000002"), system: { ...backpack("x").system, container: "Crate000000001" } };
  const ctx = context({ shop: { items: [inACrate] } });
  const result = planTrade(buyRequest("Backpack0000002", 1), ctx);
  assert.equal(result.ok, true);
  const buyerUpdate = result.plan.updates.find(u => u.actorId === "Buyer000000001");
  assert.equal(buyerUpdate.itemCreates[0].system.container, null);
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
  assert.equal(plan.chatCard.direction, "Paid");
  assert.equal(plan.chatCard.lines[0].label, "Dagger");
  assert.equal(plan.chatCard.totalCp, 200);
});

test("an infinite purse leaves the shop's own currency out of the plan", () => {
  const ctx = context({ shop: { items: [dagger()] }, worldSettings: { ...WORLD, infinitePurse: true } });
  const result = planTrade(buyRequest("Dagger000000001", 1), ctx);
  const shopUpdate = result.plan.updates.find(u => u.actorId === "Shop00000000001");
  assert.equal(shopUpdate.currency, undefined);
});
