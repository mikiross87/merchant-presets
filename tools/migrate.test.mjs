import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { STOCK_DEFAULTS, validateShop, validateStock } from "../scripts/schema.mjs";
import { planShop } from "../scripts/shop.mjs";
import {
  SHOP_SHEET_ID, deriveShop, deriveStock, hasCurrentShop, needsMigration, packShopCandidates, planActorUpdate,
  planAutoRestockDefault, planItemUpdates, planOwnership, planRestockStock, planTokenDisable, planTokenUpdates,
  shouldForceAutoRestockOff, planTokenMigration, tokenNeedsMigration,
  worldHasLegacyShops, derivedShop
} from "../scripts/migrate.mjs";

/** A shipped merchant, straight off `_source`, matched by filename prefix.
 *  Since #99, this already carries the 2.0 `flags.merchant-presets.shop`
 *  and each item's `.stock` beside the Item Piles flags — the ground truth
 *  the cross-check tests below migrate against. */
const merchantsDir = new URL("../_source/merchants/", import.meta.url);
function shipped(prefix) {
  const file = readdirSync(merchantsDir).find(f => f.startsWith(prefix));
  const doc = JSON.parse(readFileSync(new URL(file, merchantsDir), "utf8"));
  return { ...doc, items: doc.items.map(i => structuredClone(i)) };
}

/** Every shipped merchant, as `shipped` returns it. */
function allShipped() {
  return readdirSync(merchantsDir)
    .map(f => JSON.parse(readFileSync(new URL(f, merchantsDir), "utf8")))
    .filter(m => m.flags?.["item-piles"]);
}

/** `merchant`, as it would have sat in a world before 2.0 shipped: with the
 *  new schema flags #99 now ships alongside the Item Piles ones stripped
 *  back off, since a pre-2.0 actor never had them. What #100 actually
 *  migrates from. */
function legacy(merchant) {
  const m = structuredClone(merchant);
  delete m.flags["merchant-presets"].shop;
  for (const item of m.items) delete item.flags?.["merchant-presets"]?.stock;
  return m;
}

/** A dotted-path `Actor#update` payload, applied to a plain-object clone. */
function applied(obj, update) {
  const out = structuredClone(obj);
  for (const [path, value] of Object.entries(update)) {
    const keys = path.split(".");
    const last = keys.pop();
    let at = out;
    for (const k of keys) at = (at[k] ??= {});
    at[last] = value;
  }
  return out;
}

/** `actor`, with every pending `planItemUpdates` entry applied — the items
 *  half of a migration, done. */
function withItemsMigrated(actor) {
  const out = structuredClone(actor);
  for (const u of planItemUpdates(out).updates) {
    const item = out.items.find(i => i._id === u._id);
    item.flags["merchant-presets"] ??= {};
    item.flags["merchant-presets"].stock = u["flags.merchant-presets.stock"];
  }
  return out;
}

/* -------------------------------------------------------------- deriveShop */

test("a shipped merchant migrates to a shop that validates, matching its own data", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const shop = deriveShop(store);
  assert.ok(validateShop(shop).ok, validateShop(shop).errors.join(" | "));
  assert.equal(shop.tier, "Village");
  assert.equal(shop.source, null);
  assert.equal(shop.description, store.flags["item-piles"].data.description);
  assert.deepEqual(shop.terms, { sellsAt: 1, buysAt: 0.5, categories: [] });
  assert.deepEqual(shop.hours, { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } });
  const table = store.flags["item-piles"].data.tablesForPopulate[0];
  assert.equal(shop.restock.table, table.uuid);
  assert.deepEqual(shop.restock.quantities, table.items);
  assert.equal(shop.restock.onOpen, true);
  assert.equal(shop.restock.mode, "reroll");
  // Not fixed (background/class/…/spell/subclass, natural, gear): General
  // Store's own refusal is "weapon", carried; the fixed ones are not.
  assert.deepEqual(shop.wontBuy.types, ["weapon"]);
  assert.ok(!shop.wontBuy.types.includes("spell") && !shop.wontBuy.types.includes("natural"));
  assert.ok(!shop.wontBuy.kinds.includes("gear"));
});

test("a shop with a Valuables override maps its category both ways", () => {
  const shop = deriveShop(legacy(shipped("Alchemists_Apothecaries_Village_")));
  assert.deepEqual(shop.terms.categories, [{ category: "Valuables", sellsAt: 1, buysAt: 1 }]);
  assert.deepEqual(shop.wontBuy.types.sort(), ["equipment", "weapon"]);
});

test("filter values are trimmed, and a blank segment dropped (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["item-piles"].data.overrideItemFilters = [
    { path: "type", filters: " weapon, equipment ,,tool" },
    { path: "flags.merchant-presets.kind", filters: "service, spellcasting " }
  ];
  const shop = deriveShop(store);
  assert.deepEqual(shop.wontBuy.types, ["weapon", "equipment", "tool"]);
  assert.deepEqual(shop.wontBuy.kinds, ["service", "spellcasting"]);
});

test("an invalid category at index 11 doesn't also drop index 1 (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  // 20 override entries, all valid except index 11's rate. A plain
  // string-prefix match on "terms.categories.1" would also catch
  // "terms.categories.11…" and wrongly drop index 1 (and 10, 12-19) too.
  const mods = Array.from({ length: 20 }, (_, i) => ({
    type: "custom", category: `Category ${i}`, override: true, buyPriceModifier: 1, sellPriceModifier: 1
  }));
  mods[11].buyPriceModifier = 0;   // invalid: only this one entry should be dropped
  store.flags["item-piles"].data.itemTypePriceModifiers = mods;
  const { update } = planActorUpdate(store, {});
  const categories = update["flags.merchant-presets.shop"].terms.categories;
  assert.equal(categories.length, 19);
  assert.ok(!categories.some(c => c.category === "Category 11"));
  for (let i = 0; i < 20; i++) {
    if (i === 11) continue;
    assert.ok(categories.some(c => c.category === `Category ${i}`), `Category ${i} missing`);
  }
});

test("hand-retuned Item Piles values win over the pack (#100)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const ip = store.flags["item-piles"].data;
  ip.buyPriceModifier = 1.4;               // the GM raised prices
  ip.sellPriceModifier = 0.2;              // and buys for less
  ip.openTimes.open = { hour: 6, minute: 30 };
  const packShop = { restock: { every: 3, mode: "topup", quantities: {} } };

  const shop = deriveShop(store, packShop);
  assert.equal(shop.terms.sellsAt, 1.4);
  assert.equal(shop.terms.buysAt, 0.2);
  assert.deepEqual(shop.hours.open, { hour: 6, minute: 30 });
  // Item Piles had no restock schedule at all: `every` is the one field the
  // pack contributes, since there is nothing on the actor to retune.
  assert.equal(shop.restock.every, 3);
  // The mode is always "reroll" for a migrated shop, regardless of the pack's.
  assert.equal(shop.restock.mode, "reroll");
});

test("no pack merchant resolvable: restock.every falls back to the schema default", () => {
  const shop = deriveShop(legacy(shipped("General_Store_Village_")));
  assert.equal(shop.restock.every, 7);
});

test("a #57 'Set up as shop' NPC carries its source and stays a shop", () => {
  const npc = legacy(shipped("General_Store_Village_"));
  const marker = { source: "Compendium.merchant-presets.merchants.Actor.abcdefghijklmnop", tier: "Town" };
  npc.flags["merchant-presets"] = { shop: marker };   // the pre-migration #57 marker, no `version`
  delete npc.flags["merchant-presets"].profile;

  assert.equal(needsMigration(npc), true);
  const shop = deriveShop(npc);
  assert.equal(shop.source, "Compendium.merchant-presets.merchants.Actor.abcdefghijklmnop");
  assert.ok(validateShop(shop).ok);
});

test("closed-off hours (openTimes disabled) migrate to null, not Item Piles' 9-18", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["item-piles"].data.openTimes.enabled = false;
  assert.equal(deriveShop(store).hours, null);
});

test("stripped shop-level keys read as Item Piles' own defaults, not ours", () => {
  const bare = {
    flags: { "merchant-presets": { profile: "Commoner" }, "item-piles": { data: { enabled: true, type: "merchant" } } }
  };
  const shop = deriveShop(bare);
  // Item Piles' PILE_DEFAULTS: description "", buy 1, sell 0.5 — not our
  // schema's null/null, which would mean "follow the world default".
  assert.equal(shop.description, "");
  assert.equal(shop.terms.sellsAt, 1);
  assert.equal(shop.terms.buysAt, 0.5);
  assert.equal(shop.restock.table, null);
  assert.deepEqual(shop.restock.quantities, {});
  assert.equal(shop.restock.onOpen, false);      // refreshItemsOnOpen defaults false, not our onOpen: true
  assert.equal(shop.hours, null);                // openTimes.enabled defaults false
});

/* -------------------------------------------------------- packShopCandidates */

test("packShopCandidates prefers the #57 marker's source over the actor's own compendium provenance", () => {
  const actor = {
    // The SRD stat block the NPC was instantiated from — not a shop.
    _stats: { compendiumSource: "Compendium.dnd5e.actors24.Actor.commoner0000000" },
    flags: { "merchant-presets": { shop: { source: "Compendium.merchant-presets.merchants.Actor.generalstore" } } }
  };
  assert.deepEqual(packShopCandidates(actor),
    ["Compendium.merchant-presets.merchants.Actor.generalstore", "Compendium.dnd5e.actors24.Actor.commoner0000000"]);
});

test("packShopCandidates falls back to the actor's own compendium provenance alone", () => {
  const actor = { _stats: { compendiumSource: "Compendium.merchant-presets.merchants.Actor.generalstore" } };
  assert.deepEqual(packShopCandidates(actor), ["Compendium.merchant-presets.merchants.Actor.generalstore"]);
});

test("packShopCandidates is empty when neither is set", () => {
  assert.deepEqual(packShopCandidates({}), []);
});

/* ------------------------------------------------------------- tier fallback */

test("a renamed shipped merchant recovers its tier from the pack, not the name-parse default (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));   // tier "Village", read off its name suffix
  store.name = "Grumm's Trading Post";                       // GM renamed it: no (Village|Town|City) suffix left
  const packShop = { tier: "Village", restock: { every: 3 } };
  assert.equal(deriveShop(store, packShop).tier, "Village");
});

test("with no marker and no pack, tier still falls back to name-parsing, then Town", () => {
  const bare = {
    name: "Grumm",
    flags: { "merchant-presets": { profile: "Commoner" }, "item-piles": { data: { enabled: true, type: "merchant" } } }
  };
  assert.equal(deriveShop(bare).tier, "Town");
});

/* --------------------------------------------------- shop validation & repair */

test("an invalid rate (sellsAt <= 0) repairs to null (follow the world default), not written broken", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["item-piles"].data.buyPriceModifier = 0;   // invalid: sellsAt must be > 0
  const { update, shopError } = planActorUpdate(store, {});
  assert.ok(update);
  assert.equal(shopError, null);
  const shop = update["flags.merchant-presets.shop"];
  assert.equal(shop.terms.sellsAt, null);
  assert.ok(validateShop(shop).ok, validateShop(shop).errors.join(" | "));
});

test("a duplicate category override collapses to the first one, the one Item Piles' .find prices by", () => {
  const store = legacy(shipped("Alchemists_Apothecaries_Village_"));
  const mods = store.flags["item-piles"].data.itemTypePriceModifiers;
  const first = mods[0];
  mods.push({ ...first, buyPriceModifier: 2 });   // a second, later "Valuables" override: never matched
  const shop = deriveShop(store);
  assert.deepEqual(shop.terms.categories, [{ category: "Valuables", sellsAt: first.buyPriceModifier, buysAt: first.sellPriceModifier }]);
  assert.ok(validateShop(shop).ok);
});

test("open == close hours repairs to null (always open) — the schema can't encode Item Piles' own reading of it", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["item-piles"].data.openTimes.close = { ...store.flags["item-piles"].data.openTimes.open };
  const { update } = planActorUpdate(store, {});
  assert.ok(update);
  assert.equal(update["flags.merchant-presets.shop"].hours, null);
});

test("an invalid restock.table repairs to null; an invalid quantities entry coerces or drops (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const ip = store.flags["item-piles"].data;
  ip.tablesForPopulate[0].uuid = 42;   // invalid: restock.table must be a string or null
  const ids = Object.keys(ip.tablesForPopulate[0].items);
  ip.tablesForPopulate[0].items[ids[0]] = 3;         // a bare number Item Piles itself accepts
  ip.tablesForPopulate[0].items[ids[1]] = "2d4kh1";  // keep-highest: valid in Item Piles, not in our schema

  const shop = deriveShop(store);
  assert.equal(shop.restock.table, 42);              // deriveShop itself doesn't repair
  const { update } = planActorUpdate(store, {});
  const repaired = update["flags.merchant-presets.shop"];
  assert.equal(repaired.restock.table, null);
  assert.equal(repaired.restock.quantities[ids[0]], "3");     // coerced to its string form
  assert.ok(!(ids[1] in repaired.restock.quantities));        // unrepairable: dropped
  assert.ok(validateShop(repaired).ok, validateShop(repaired).errors.join(" | "));
});

test("a shop config still invalid after repair leaves shopError set; item migration doesn't depend on it", () => {
  const store = legacy(shipped("General_Store_Village_"));
  // Unrepairable: 0 is neither "never" nor an integer >= 1 nor a dice formula,
  // and restock.every isn't one of repairShop's rules.
  const packShop = { restock: { every: 0 } };
  const { update, shopError } = planActorUpdate(store, { packShop, nativeShop: false });
  assert.equal(update, null);
  assert.match(shopError, /restock\.every/);

  // The item half is a separate write with nothing to do with the shop's own
  // config, and plans normally regardless (#100 review).
  const { updates, errors } = planItemUpdates(store);
  assert.ok(updates.length > 0);
  assert.deepEqual(errors, []);
});

/* ------------------------------------------------------------- deriveStock */

test("per-item hidden and notForSale carry across — the dangerous keys (#97)", () => {
  const stock = deriveStock({ hidden: true, notForSale: true, keepOnMerchant: true, isService: false,
    cantBeSoldToMerchants: false, infiniteQuantity: "no" });
  assert.equal(stock.hidden, true);
  assert.equal(stock.notForSale, true);
  assert.ok(validateStock(stock).ok);
});

test("stripped per-item keys read as Item Piles' defaults, not the schema's", () => {
  const stock = deriveStock({});
  // Item Piles' ITEM_DEFAULTS: keepOnMerchant false — the schema's own
  // STOCK_DEFAULTS.keep is true, and using that instead would silently
  // un-hide an item a GM never touched but Item Piles had already stripped.
  assert.equal(stock.keep, false);
  assert.equal(stock.infinite, null);      // infiniteQuantity: "default"
  assert.equal(stock.service, false);
  assert.equal(stock.noBuyback, false);
  assert.equal(stock.category, "");
  assert.equal(stock.bundle, 1);           // quantityForPrice isn't in ITEM_DEFAULTS; the UI falls back to 1
  assert.equal(stock.hidden, false);
  assert.equal(stock.notForSale, false);
  assert.ok(validateStock(stock).ok);
});

test("every real stock line on a shipped merchant migrates to a valid stock config", () => {
  const store = legacy(shipped("General_Store_Village_"));
  for (const item of store.items) {
    if (item.flags?.["merchant-presets"]?.kind === "gear") continue;
    const ip = item.flags["item-piles"];
    const stock = deriveStock({ ...ip?.item, quantityForPrice: ip?.system?.quantityForPrice });
    const r = validateStock(stock);
    assert.ok(r.ok, `${item.name}: ${r.errors.join(" | ")}`);
  }
});

/* -------------------------------------------------------- needsMigration */

test("a non-module Item Piles merchant is left alone", () => {
  const theirs = { flags: { "item-piles": { data: { enabled: true, type: "merchant" } } } };
  assert.equal(needsMigration(theirs), false);
  assert.deepEqual(planActorUpdate(theirs), { update: null, shopError: null, warnings: [] });
  assert.deepEqual(planItemUpdates(theirs), { updates: [], errors: [] });
});

test("worldHasLegacyShops sees an unmigrated shop and ignores everything else", () => {
  const legacy = { flags: { "merchant-presets": { profile: "Commoner" } } };
  const migrated = { flags: { "merchant-presets": { shop: { version: 1 } } } };
  const notOurs = { flags: { "item-piles": { data: { enabled: true, type: "merchant" } } } };
  assert.equal(worldHasLegacyShops([migrated, notOurs]), false);
  assert.equal(worldHasLegacyShops([migrated, notOurs, legacy]), true);
});

test("a v1.0.0 merchant, which predates the profile flag, is still migrated (#120 review)", () => {
  // v1.0.0 shipped flags.merchant-presets as {purse, itemFlags, containers}; profile arrived in v1.1.0.
  const v100 = legacy(shipped("Adventurers_Store_Town"));
  delete v100.flags["merchant-presets"].profile;
  assert.ok(v100.flags["merchant-presets"].itemFlags);
  assert.equal(needsMigration(v100), true);
  assert.equal(worldHasLegacyShops([v100]), true);
  assert.ok(planItemUpdates(v100).updates.length > 0);
  const { update, shopError } = planActorUpdate(v100);
  assert.equal(shopError, null);
  assert.equal(validateShop(update["flags.merchant-presets.shop"]).ok, true);
});

/** The Town store as a 1.x world held it, with `data` merged over its Item Piles pile data. */
function retuned(data) {
  const actor = legacy(shipped("Adventurers_Store_Town"));
  Object.assign(actor.flags["item-piles"].data, data);
  return actor;
}

test("an Item Piles price modifier by item type becomes that type's category rule (#120 review)", () => {
  const actor = retuned({ itemTypePriceModifiers: [
    { type: "weapon", category: "", override: true, buyPriceModifier: 1.2, sellPriceModifier: 0.3 },
    { type: "tool", category: "", override: false, buyPriceModifier: 9, sellPriceModifier: 9 }
  ] });
  const categories = deriveShop(actor).terms.categories;
  assert.deepEqual(categories.find(c => c.category === "weapon"), { category: "weapon", sellsAt: 1.2, buysAt: 0.3 });
});

test("a relative Item Piles modifier (override off) carries over multiplied by the shop's rate (#120 review)", () => {
  // item-piles.js getMerchantModifiersForActor: override ? the entry's rate : the shop's rate x the entry's.
  const actor = retuned({ buyPriceModifier: 1.2, sellPriceModifier: 0.5, itemTypePriceModifiers: [
    { type: "tool", category: "", override: false, buyPriceModifier: 1.5, sellPriceModifier: 0.8 }
  ] });
  assert.deepEqual(deriveShop(actor).terms.categories, [{ category: "tool", sellsAt: 1.8, buysAt: 0.4 }]);
});

test("repeated Item Piles entries keep the one Item Piles matches: custom first, then the first (#120 review)", () => {
  const actor = retuned({ itemTypePriceModifiers: [
    { type: "weapon", category: "", override: true, buyPriceModifier: 1.2, sellPriceModifier: 0.3 },
    { type: "weapon", category: "", override: true, buyPriceModifier: 2, sellPriceModifier: 0.1 },
    { type: "loot", category: "", override: true, buyPriceModifier: 3, sellPriceModifier: 0.1 },
    { type: "custom", category: "loot", override: true, buyPriceModifier: 1.1, sellPriceModifier: 0.2 }
  ] });
  const categories = deriveShop(actor).terms.categories;
  assert.deepEqual(categories.find(c => c.category === "weapon"), { category: "weapon", sellsAt: 1.2, buysAt: 0.3 });
  assert.deepEqual(categories.find(c => c.category === "loot"), { category: "loot", sellsAt: 1.1, buysAt: 0.2 });
});

test("what the migration can't carry over is warned about, not dropped silently (#120 review)", () => {
  const actor = retuned({
    buyPriceModifier: 0,
    overrideItemFilters: [{ path: "type", filters: "spell" }, { path: "system.type.value", filters: "natural, simpleM" }]
  });
  const { update, warnings } = planActorUpdate(actor);
  assert.equal(update["flags.merchant-presets.shop"].terms.sellsAt, null);
  assert.ok(warnings.some(w => w.includes("terms.sellsAt")), warnings.join(" | "));
  assert.ok(warnings.some(w => w.includes("simpleM")), warnings.join(" | "));
  assert.equal(warnings.some(w => w.includes("natural")), false);   // a fixed refusal: nothing lost
  assert.deepEqual(planActorUpdate(legacy(shipped("Adventurers_Store_Town"))).warnings, []);
});

test("Item Piles' own not-overridden filters (false) migrate, not throw (#120 review)", () => {
  const { update, warnings } = planActorUpdate(retuned({ overrideItemFilters: false }));
  assert.ok(update["flags.merchant-presets.shop"]);
  assert.deepEqual(warnings, []);
});

test("needsMigration stays true when the shop half landed but items still lack .stock (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const shopOnly = applied(store, { "flags.merchant-presets.shop": deriveShop(store) });
  // Shop half done, as if updateEmbeddedDocuments("Item", …) had then thrown.
  assert.equal(needsMigration(shopOnly, false), true);
  // Nothing left for the actor-level update — the shop's current, nativeShop's
  // off — but planItemUpdates independently still has work, and migrateShop
  // (scripts/merchant-presets.mjs) calls it regardless of planActorUpdate's result.
  assert.deepEqual(planActorUpdate(shopOnly, { nativeShop: false }), { update: null, shopError: null, warnings: [] });
  assert.ok(planItemUpdates(shopOnly).updates.length > 0);
});

test("needsMigration is false only once both the shop and every item are migrated", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const migrated = withItemsMigrated(applied(store, { "flags.merchant-presets.shop": deriveShop(store) }));
  assert.equal(needsMigration(migrated, false), false);
});

test("needsMigration reopens the cut-over for a leftover unlinked token still Item Piles-enabled (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update } = planActorUpdate(store, { nativeShop: true });
  const fullyMigrated = withItemsMigrated(applied(store, update));
  // Actor and every item done, nativeShop on, Item Piles off on the actor
  // itself: nothing left when there are no tokens to check.
  assert.equal(needsMigration(fullyMigrated, true), false);
  assert.equal(needsMigration(fullyMigrated, true, []), false);

  const staleToken = { _id: "t1", actorLink: false, flags: { "item-piles": { data: { enabled: true } } } };
  assert.equal(needsMigration(fullyMigrated, true, [staleToken]), true);

  const disabledToken = { _id: "t2", actorLink: false, flags: { "item-piles": { data: { enabled: false } } } };
  assert.equal(needsMigration(fullyMigrated, true, [disabledToken]), false);

  // A linked token has no Item Piles data of its own — it follows the actor,
  // already disabled — so it's never a reason to reopen the cut-over.
  const linkedToken = { _id: "t3", actorLink: true, flags: { "item-piles": { data: { enabled: true } } } };
  assert.equal(needsMigration(fullyMigrated, true, [linkedToken]), false);

  // While nativeShop is off, a token's state is irrelevant: the cut-over
  // hasn't started, so there's nothing for it to leave unfinished.
  assert.equal(needsMigration(fullyMigrated, false, [staleToken]), false);
});

/* ------------------------------------------------------------ planActorUpdate */

test("nativeShop off: only the data half is planned, Item Piles and the sheet untouched", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update, shopError } = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: false });
  assert.ok(update);
  assert.equal(shopError, null);
  assert.equal(update["flags.merchant-presets.shop"].version, 1);
  // next still trades this shop through Item Piles (#97 "Order on next"): none of
  // the cut-over keys are planned, even with a token placed (which would
  // otherwise make ownership Limited) and Item Piles still fully enabled.
  assert.deepEqual(Object.keys(update), ["flags.merchant-presets.shop"]);
});

test("planActorUpdate migrates shop config, disables Item Piles, sets the sheet and (hidden) ownership", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store._id = "abcdefghijklmnop";
  const { update } = planActorUpdate(store, { hasTokenOnScene: false, nativeShop: true });
  assert.ok(update);
  assert.equal(update["flags.merchant-presets.shop"].version, 1);
  assert.equal(update["flags.item-piles.data.enabled"], false);
  assert.equal(update["prototypeToken.flags.item-piles.data.enabled"], false);
  assert.equal(update["flags.core.sheetClass"], SHOP_SHEET_ID);
  // Already hidden (ownership.default: 0) and no token on any scene: nothing to change.
  assert.ok(!("ownership.default" in update));
});

test("planActorUpdate makes a shop with a placed token visitable (Limited)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update } = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true, worldId: "world-a" });
  assert.equal(update["ownership.default"], 1);
  // Marked with this world, so placing another token here never re-opens it after a GM hides it
  // again (#138 review), while a copy exported to another world starts afresh.
  assert.equal(update["flags.merchant-presets.madeVisitable"], "world-a");
});

test("a shop made visitable once and hidden again by the GM stays hidden through a re-run migration (#138 review, round 5)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["merchant-presets"].madeVisitable = "world-a";
  store.ownership = { default: 0 };
  assert.equal(planOwnership(store, true, "world-a"), null);
});

test("a shop marked in another world, its ownership cleared by export, is made visitable here (#138 review, round 6)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["merchant-presets"].madeVisitable = "world-a";
  store.ownership = { default: 0 };
  assert.equal(planOwnership(store, true, "world-b"), 1);
});

test("the OWNER entry Foundry writes for the creating GM isn't a choice: the shop is made visitable (#138 review, round 7)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.ownership = { default: 0, theGmUser000001: 3 };   // fromCompendium and _preCreate both add this
  assert.equal(planOwnership(store, true, "world-a"), 1);
});

test("a shop the GM opened to one player only is the GM's choice, left alone (#138 review, round 6)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.ownership = { default: 0, rogueUser000001: 1 };
  assert.equal(planOwnership(store, true, "world-a"), null);
});

test("planActorUpdate respects a GM's own ownership choice (not 0) and never overwrites it", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.ownership = { default: 3 };   // Owner, or any non-default value a GM set
  const { update } = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true });
  assert.ok(!("ownership.default" in update));
});

test("planActorUpdate is idempotent (nativeShop off): applying its own plan leaves nothing to migrate", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update: first } = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: false });
  const migrated = withItemsMigrated(applied(store, first));
  assert.equal(needsMigration(migrated, false), false);
  assert.deepEqual(planActorUpdate(migrated, { hasTokenOnScene: true, nativeShop: false }), { update: null, shopError: null, warnings: [] });
});

test("planActorUpdate is idempotent (nativeShop on): applying its own plan leaves nothing to migrate", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update: first } = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true });
  const migrated = withItemsMigrated(applied(store, first));
  assert.equal(needsMigration(migrated, true), false);
  assert.deepEqual(planActorUpdate(migrated, { hasTokenOnScene: true, nativeShop: true }), { update: null, shopError: null, warnings: [] });
});

test("Item Piles left on but shop already current: only the switch-off is planned", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const { update: first } = planActorUpdate(store, { nativeShop: true });
  const migrated = applied(store, first);
  // Roll back just the Item Piles switch, as if #97's write had failed partway.
  migrated.flags["item-piles"].data.enabled = true;
  const { update: second } = planActorUpdate(migrated, { nativeShop: true });
  assert.ok(second);
  assert.ok(!("flags.merchant-presets.shop" in second));   // the GM's already-migrated config is untouched
  assert.equal(second["flags.item-piles.data.enabled"], false);
});

test("a data-migrated shop is picked up again once nativeShop flips on", () => {
  const store = legacy(shipped("General_Store_Village_"));
  // nativeShop off: data half only, both actor- and item-level.
  const dataOnly = withItemsMigrated(applied(store, planActorUpdate(store, { nativeShop: false }).update));

  // Not re-opened while the cut-over is still off, however many times it runs.
  assert.equal(needsMigration(dataOnly, false), false);
  assert.deepEqual(planActorUpdate(dataOnly, { nativeShop: false }), { update: null, shopError: null, warnings: [] });

  // Flip NATIVE_SHOP on (#104): the same shop, still Item Piles' own merchant
  // underneath, is picked up again to finish the cut-over — no version bump,
  // no re-deriving the shop config the GM may since have edited by hand.
  assert.equal(needsMigration(dataOnly, true), true);
  const { update: second } = planActorUpdate(dataOnly, { nativeShop: true });
  assert.ok(second);
  assert.ok(!("flags.merchant-presets.shop" in second));
  assert.equal(second["flags.item-piles.data.enabled"], false);
  assert.equal(second["flags.core.sheetClass"], SHOP_SHEET_ID);
});

/* ------------------------------------------------------------ planItemUpdates */

test("planItemUpdates migrates every stock line once, then leaves them alone", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const first = planItemUpdates(store);
  const stockable = store.items.filter(i => i.flags?.["merchant-presets"]?.kind !== "gear");
  assert.equal(first.updates.length, stockable.length);
  assert.deepEqual(first.errors, []);
  for (const u of first.updates) assert.ok(validateStock(u["flags.merchant-presets.stock"]).ok);

  // Apply, then run again: idempotent.
  for (const u of first.updates) {
    const item = store.items.find(i => i._id === u._id);
    item.flags["merchant-presets"] ??= {};
    item.flags["merchant-presets"].stock = u["flags.merchant-presets.stock"];
  }
  assert.deepEqual(planItemUpdates(store), { updates: [], errors: [] });
});

test("a rolled item's recorded itemFlags win over its live, stock-mode-mutated flag", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  // Item Piles' own record still says "default" (follow the world setting);
  // applyStockMode has since rolled a count and flipped the live flag to
  // "no" as bookkeeping (CONTRIBUTING.md). Migrating off the live flag alone
  // would wrongly pin Bell to finite stock forever.
  assert.equal(store.flags["merchant-presets"].itemFlags.Bell.infiniteQuantity, "default");
  bell.flags["item-piles"].item.infiniteQuantity = "no";

  const update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].infinite, null);
});

test("an item never in itemFlags — a GM's own addition — is read from its live flags", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.items.push({
    _id: "gmAddedItem0001", name: "A Curiosity", type: "loot",
    flags: { "item-piles": { item: { infiniteQuantity: "no", keepOnMerchant: true, isService: false,
      cantBeSoldToMerchants: false, hidden: true, notForSale: false } } }
  });
  const update = planItemUpdates(store).updates.find(u => u._id === "gmAddedItem0001");
  assert.equal(update["flags.merchant-presets.stock"].infinite, false);
  assert.equal(update["flags.merchant-presets.stock"].hidden, true);
});

test("a GM-hidden shipped item stays hidden after migration (#100 review: live wins for hidden/notForSale)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  bell.flags["item-piles"].item.hidden = true;      // the GM hid it directly on the live item
  bell.flags["item-piles"].item.notForSale = true;
  const update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].hidden, true);
  assert.equal(update["flags.merchant-presets.stock"].notForSale, true);
});

test("a GM's live re-categorization wins over the shipped record", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  assert.equal(store.flags["merchant-presets"].itemFlags.Bell.customCategory, undefined);   // shipped with none
  bell.flags["item-piles"].item.customCategory = "Curiosities";   // the GM gave it one directly
  const update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].category, "Curiosities");
});

test("bookkeeping keys still come from the record, not a live edit a restock would overwrite anyway", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  const recorded = { ...store.flags["merchant-presets"].itemFlags.Bell };
  // As if a restock's own applyStockMode/reapplyItemFlags pass had briefly
  // left the live flags different from the record, mid-refresh.
  Object.assign(bell.flags["item-piles"].item,
    { infiniteQuantity: "no", keepOnMerchant: false, isService: true, cantBeSoldToMerchants: true });
  const update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  const stock = update["flags.merchant-presets.stock"];
  assert.equal(stock.infinite, { yes: true, no: false, default: null }[recorded.infiniteQuantity]);
  assert.equal(stock.keep, recorded.keepOnMerchant);
  assert.equal(stock.service, recorded.isService);
  assert.equal(stock.noBuyback, recorded.cantBeSoldToMerchants);
});

test("an invalid bundle (a negative or fractional quantityForPrice) repairs to 1", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  delete store.flags["merchant-presets"].itemFlags.Bell.quantityForPrice;
  bell.flags["item-piles"].system = { quantityForPrice: -5 };
  let update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].bundle, 1);

  bell.flags["item-piles"].system.quantityForPrice = 2.5;
  update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].bundle, 1);
});

test("a non-string customCategory repairs to \"\" (STOCK_DEFAULTS.category)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  delete store.flags["merchant-presets"].itemFlags.Bell.customCategory;
  bell.flags["item-piles"].item.customCategory = 42;   // garbage from a corrupted flag
  assert.equal(validateStock(deriveStock({ customCategory: 42 })).ok, false);   // deriveStock alone: invalid
  const update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].category, "");
});

test("an unambiguous boolean stand-in coerces; an ambiguous one falls back to STOCK_DEFAULTS", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  delete store.flags["merchant-presets"].itemFlags.Bell.cantBeSoldToMerchants;

  bell.flags["item-piles"].item.cantBeSoldToMerchants = "true";
  let update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].noBuyback, true);

  bell.flags["item-piles"].item.cantBeSoldToMerchants = "maybe";
  update = planItemUpdates(store).updates.find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].noBuyback, STOCK_DEFAULTS.noBuyback);
});

/* ---------------------------------------------------------------- ownership */

test("planOwnership", () => {
  assert.equal(planOwnership({ ownership: { default: 0 } }, true), 1);
  assert.equal(planOwnership({ ownership: { default: 0 } }, false), null);
  assert.equal(planOwnership({ ownership: { default: 2 } }, false), null);
  assert.equal(planOwnership({ ownership: { default: 3 } }, true), null);
  assert.equal(planOwnership({}, true), 1);   // no ownership at all reads as the field's own default, 0
});

/* ------------------------------------------------------------- planTokenDisable */

test("a linked token is skipped — it follows the actor", () => {
  assert.equal(planTokenDisable({ _id: "t1", actorLink: true,
    flags: { "item-piles": { data: { enabled: true } } } }), null);
});

test("an unlinked token and its delta both get disabled", () => {
  const token = {
    _id: "t2", actorLink: false,
    flags: { "item-piles": { data: { enabled: true } } },
    delta: { flags: { "item-piles": { data: { enabled: true } } } }
  };
  assert.deepEqual(planTokenDisable(token), {
    _id: "t2",
    "flags.item-piles.data.enabled": false,
    "delta.flags.item-piles.data.enabled": false
  });
});

test("an unlinked token with no delta only gets its own flag disabled", () => {
  const token = { _id: "t3", actorLink: false, flags: { "item-piles": { data: { enabled: true } } } };
  assert.deepEqual(planTokenDisable(token), { _id: "t3", "flags.item-piles.data.enabled": false });
});

test("an already-disabled unlinked token plans nothing (idempotent)", () => {
  const token = {
    _id: "t4", actorLink: false,
    flags: { "item-piles": { data: { enabled: false } } },
    delta: { flags: { "item-piles": { data: { enabled: false } } } }
  };
  assert.equal(planTokenDisable(token), null);
});

test("planTokenUpdates plans nothing while nativeShop is off, however many tokens need it", () => {
  const tokens = [
    { _id: "t5", actorLink: false, flags: { "item-piles": { data: { enabled: true } } } },
    { _id: "t6", actorLink: false, flags: { "item-piles": { data: { enabled: true } } } }
  ];
  assert.deepEqual(planTokenUpdates(tokens, false), []);
});

test("planTokenUpdates disables every token that needs it once nativeShop is on", () => {
  const linked = { _id: "t7", actorLink: true, flags: { "item-piles": { data: { enabled: true } } } };
  const unlinked = { _id: "t8", actorLink: false, flags: { "item-piles": { data: { enabled: true } } } };
  const already = { _id: "t9", actorLink: false, flags: { "item-piles": { data: { enabled: false } } } };
  assert.deepEqual(planTokenUpdates([linked, unlinked, already], true),
    [{ _id: "t8", "flags.item-piles.data.enabled": false }]);
});

/* --------------------------------------------------------------- autoRestock */

test("autoRestock: no stored value, a 1.x world — forced off (#105)", () => {
  assert.equal(planAutoRestockDefault(false, true), false);
});

test("autoRestock: no stored value, a fresh 2.0 world — the new default (on) stands", () => {
  assert.equal(planAutoRestockDefault(false, false), null);
});

test("autoRestock: a GM's own stored value is never touched, 1.x world or not", () => {
  assert.equal(planAutoRestockDefault(true, true), null);
  assert.equal(planAutoRestockDefault(true, false), null);
});

test("shouldForceAutoRestockOff fires only when this pass derived a shop's data half and autoRestock is unset", () => {
  const dataHalf = { "flags.merchant-presets.shop": { version: 1 } };
  assert.equal(shouldForceAutoRestockOff(dataHalf, false), true);
  assert.equal(shouldForceAutoRestockOff(dataHalf, true), false);   // a GM's own choice stands
  // Cut-over-only fields (an already-current shop): no shop data derived here.
  const cutOverOnly = { "flags.item-piles.data.enabled": false, "flags.core.sheetClass": SHOP_SHEET_ID };
  assert.equal(shouldForceAutoRestockOff(cutOverOnly, false), false);
  assert.equal(shouldForceAutoRestockOff(null, false), false);
});

/* -------------------------------------------- #119 fix 3: 2.0 "Set up as shop" */

test("a 2.0 'Set up as shop' NPC is never treated as a 1.x shop needing migration", () => {
  const source = shipped("General_Store_Village_");
  const sourceShop = source.flags["merchant-presets"].shop;
  assert.equal(sourceShop.version, 1);   // sanity: the fixture really has a current one

  const plan = planShop({ ...source, uuid: "Actor.sourceuuid0000000000000" },
    { name: "Grumm", items: [], flags: {} }, [], sourceShop);
  const npc = {
    name: "Grumm", items: [],
    flags: { "merchant-presets": { shop: plan.moduleFlags.shop }, "item-piles": { data: plan.pileData } }
  };

  assert.ok(validateShop(plan.moduleFlags.shop).ok, validateShop(plan.moduleFlags.shop).errors.join(" | "));
  assert.equal(needsMigration(npc, false), false);
  assert.deepEqual(planActorUpdate(npc, { nativeShop: false }), { update: null, shopError: null, warnings: [] });
  // With the cut-over live, only its own half is planned: never the shop data, so never the
  // autoRestock switch-off below either.
  const { update: cutOver } = planActorUpdate(npc, { nativeShop: true });
  assert.ok(!("flags.merchant-presets.shop" in cutOver));
  // The consequence that actually matters: since planActorUpdate never
  // derives a shop key for this actor, migrateShop's autoRestock check
  // never fires for it either — nothing here would flip a fresh 2.0 world's
  // default off (#100 review).
  assert.equal(shouldForceAutoRestockOff(planActorUpdate(npc, {}).update, false), false);
});

test("planShop still produces a valid, current config when the source's own had to be derived (defensive fallback)", () => {
  const bareSource = legacy(shipped("General_Store_Village_"));   // no current .shop on the source itself
  assert.equal(hasCurrentShop(bareSource), false);
  const derived = deriveShop(bareSource);

  const plan = planShop({ ...bareSource, uuid: "Actor.baresource000000000000" },
    { name: "Grumm", items: [], flags: {} }, [], derived);
  assert.ok(validateShop(plan.moduleFlags.shop).ok, validateShop(plan.moduleFlags.shop).errors.join(" | "));
  assert.equal(plan.moduleFlags.shop.version, 1);
  assert.equal(plan.moduleFlags.shop.source, "Actor.baresource000000000000");
});

/* --------------------------------------------------- cross-check vs #99's pack */

// "A migrated shop equals a fresh one": every shipped merchant's own
// flags.merchant-presets.shop / each item's .stock (#99, computed straight
// from data/recipes.json) is what #100 must also derive when migrating that
// same merchant's Item Piles data from a pre-2.0 world. Migrating from
// `legacy(shipped(…))` — the committed flags with `.shop`/`.stock` stripped
// back off — must reproduce them exactly, byte for byte.

test("deriveShop reproduces every shipped merchant's own committed shop config (#99)", () => {
  const merchants = allShipped();
  assert.equal(merchants.length, 51);
  for (const doc of merchants) {
    const committed = doc.flags["merchant-presets"].shop;
    // restock.every has no Item Piles source (#105): the runtime resolves it
    // from the pack merchant and passes it as `packShop`, so pass the
    // committed shop itself as that base — the same contract the runtime uses.
    const derived = deriveShop(legacy(doc), committed);
    assert.deepEqual(derived, committed, doc.name);
  }
});

test("planItemUpdates reproduces every shipped stock line's own committed config (#99)", () => {
  let checked = 0;
  for (const doc of allShipped()) {
    const { updates, errors } = planItemUpdates(legacy(doc));
    assert.deepEqual(errors, [], doc.name);   // every shipped stock line is valid as shipped
    for (const item of doc.items) {
      const committed = item.flags?.["merchant-presets"]?.stock;
      if (!committed) continue;   // the shopkeeper's own kit carries no stock config
      const derived = updates.find(u => u._id === item._id)?.["flags.merchant-presets.stock"];
      assert.deepEqual(derived, committed, `${doc.name}: ${item.name}`);
      checked++;
    }
  }
  assert.equal(checked, 1551);   // every stock line schema.test.mjs counts, none silently skipped
});

test("a shop derived for setUpShop is repaired like a migrated one (#120 review)", () => {
  const { shop, ok } = derivedShop(retuned({ buyPriceModifier: 0 }));
  assert.equal(ok, true);
  assert.equal(shop.terms.sellsAt, null);   // repaired to the world rate, never written invalid
  assert.ok(validateShop(shop).ok);
});

test("a second Item Piles stock table is warned about, not dropped silently (#120 review)", () => {
  const actor = legacy(shipped("Adventurers_Store_Town"));
  const tables = actor.flags["item-piles"].data.tablesForPopulate;
  tables.push({ ...tables[0], uuid: "RollTable.GMsOwnExtras" });
  const { warnings } = planActorUpdate(actor);
  assert.ok(warnings.some(w => w.includes("RollTable.GMsOwnExtras")), warnings.join(" | "));
});

/* -------------------------------------------------------------- restock (#119) */

/** `actor` as an Item Piles restock leaves it: every line the shop's record names rebuilt from the
 *  compendium, so an SRD item has no stock config at all and one of our goods has only its
 *  goods-level stamp (a service's `infinite` still null). */
function restocked(actor) {
  const record = actor.flags["merchant-presets"].itemFlags ?? {};
  const out = structuredClone(actor);
  for (const item of out.items) {
    if (!record[item.name] || item.flags?.["merchant-presets"]?.kind === "gear") continue;
    const stock = item.flags["merchant-presets"]?.stock;
    if (stock?.service) stock.infinite = null;
    else if (item.flags["merchant-presets"]) delete item.flags["merchant-presets"].stock;
  }
  return out;
}

test("a restock puts every shipped merchant's stock config back as it shipped (#119)", () => {
  // Folder documents live beside the merchants in _source/merchants; only actors carry items.
  const names = readdirSync(merchantsDir).filter(f => !f.startsWith("!") && JSON.parse(readFileSync(new URL(f, merchantsDir), "utf8")).items)
    .map(f => f.replace(/\.json$/, ""));
  let checked = 0;
  for (const name of names) {
    const shippedActor = shipped(name);
    const after = restocked(shippedActor);
    for (const u of planRestockStock(after).updates) {
      const item = after.items.find(i => i._id === u._id);
      item.flags["merchant-presets"] ??= {};
      item.flags["merchant-presets"].stock = u["flags.merchant-presets.stock"];
    }
    for (const item of after.items) {
      const want = shippedActor.items.find(i => i._id === item._id).flags?.["merchant-presets"]?.stock;
      assert.deepEqual(item.flags?.["merchant-presets"]?.stock, want, `${name}: ${item.name}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test("a restock leaves lines the record doesn't name, and stock already right, alone", () => {
  const first = readdirSync(merchantsDir).find(f => JSON.parse(readFileSync(new URL(f, merchantsDir), "utf8")).items);
  const actor = shipped(first.replace(/\.json$/, ""));
  assert.deepEqual(planRestockStock(actor).updates, [], "a shelf as shipped needs nothing");
  const byHand = { _id: "handAdded000001", name: "A GM's own find", type: "loot", system: {}, flags: {} };
  actor.items.push(byHand);
  assert.deepEqual(planRestockStock(actor).updates, []);
});

/* ---------------------------------------------------- unlinked tokens (#124) */

/** A shop on an unlinked token, as its synthetic actor reads: the (migrated) base actor with the
 *  token's own delta laid over it. `delta` is the token's own data only; `tokenFlags` the token
 *  document's own flags, where Item Piles can keep a token's settings too. */
function onToken(base, delta, tokenFlags = {}) {
  const actor = structuredClone(base);
  actor.items = [...actor.items, ...(delta.items ?? [])];
  if (delta.flags) actor.flags = applied(actor.flags, Object.fromEntries(
    Object.entries(delta.flags["item-piles"]?.data ?? {}).map(([k, v]) => [`item-piles.data.${k}`, v])));
  return { token: { actorLink: false, delta, flags: tokenFlags }, actor, base };
}

const migratedStore = () => withItemsMigrated(shipped("General_Store_Town_"));
const tradedBell = { _id: "tokenBell000001", name: "Brass Bell", type: "equipment", system: { quantity: 1, price: { value: 1, denomination: "gp" } },
  flags: { "item-piles": { item: { hidden: true, infiniteQuantity: "no" } } } };
const nineToFive = { enabled: true, open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } };

test("an unlinked token's own traded items get a stock config, from its own Item Piles flags (#124)", () => {
  const { token, actor, base } = onToken(migratedStore(), { items: [tradedBell] });
  const plan = planTokenMigration(token, actor, base);
  assert.deepEqual(plan.itemUpdates.map(u => u._id), ["tokenBell000001"], "only the token's own item: the base's are done");
  assert.equal(plan.itemUpdates[0]["flags.merchant-presets.stock"].hidden, true);
  assert.equal(plan.itemUpdates[0]["flags.merchant-presets.stock"].infinite, false);
  assert.equal(plan.shop, null, "no shop-level Item Piles overrides on this token");
});

test("a token that re-tuned its own Item Piles settings gets its own shop config from them (#124)", () => {
  const { token, actor, base } = onToken(migratedStore(), { flags: { "item-piles": { data: { openTimes: nineToFive } } } });
  const plan = planTokenMigration(token, actor, base);
  assert.ok(plan.shop, "a shop config for the token");
  assert.deepEqual(plan.shop.hours, { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } });
  assert.deepEqual(plan.itemUpdates, []);
});

test("a token whose delta only copies the base's settings, or its open/closed status, isn't re-tuned (#137 review)", () => {
  const store = migratedStore();
  const copied = structuredClone(store.flags["item-piles"].data);
  copied.openTimes = { ...copied.openTimes, status: "closed" };
  const { token, actor, base } = onToken(store, { flags: { "item-piles": { data: copied } } });
  assert.equal(planTokenMigration(token, actor, base).shop, null);
});

test("Item Piles settings kept on the token document itself count as the token's own (#137 review)", () => {
  const { token, actor, base } = onToken(migratedStore(), {}, { "item-piles": { data: { openTimes: nineToFive } } });
  const plan = planTokenMigration(token, actor, base);
  assert.deepEqual(plan.shop?.hours, { open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } });
});

test("a token's own Item Piles data reads over Item Piles' defaults, not the base's, as Item Piles reads it (#137 review, round 2)", () => {
  // The GM put this token's hours back to Item Piles' own 9:00-18:00, so Item Piles saved only what
  // differs from its defaults: {enabled: true}. The base shop keeps its 7:00-19:00.
  const { token, actor, base } = onToken(migratedStore(), {}, { "item-piles": { data: { openTimes: { enabled: true } } } });
  const plan = planTokenMigration(token, actor, base);
  assert.deepEqual(plan.shop?.hours, { open: { hour: 9, minute: 0 }, close: { hour: 18, minute: 0 } });
});

test("a token whose price went back to Item Piles' default keeps that price, not the base's (#137 review, round 2)", () => {
  const store = migratedStore();
  store.flags["item-piles"].data.buyPriceModifier = 1.5;    // the base shop charges half again
  // The GM set this token back to 1, Item Piles' default, so Item Piles dropped the key from its data.
  const { token, actor, base } = onToken(store, {}, { "item-piles": { data: { enabled: true } } });
  const plan = planTokenMigration(token, actor, base);
  assert.ok(plan.shop, "the token's own price differs from the base's");
  assert.notEqual(plan.shop.terms.sellsAt, derivedShop(base, base.flags["merchant-presets"].shop).shop.terms.sellsAt);
});

test("the cut-over's own enabled:false on a token document isn't a setting of the token's (#137 review, round 3)", () => {
  const { token, actor, base } = onToken(migratedStore(), {}, { "item-piles": { data: { enabled: false } } });
  assert.equal(planTokenMigration(token, actor, base).shop, null);
});

test("the same settings stored in another key order are the same shop (#137 review, round 3)", () => {
  const store = migratedStore();
  const data = structuredClone(store.flags["item-piles"].data);
  for (const table of data.tablesForPopulate ?? []) {
    if (table.items) table.items = Object.fromEntries(Object.entries(table.items).reverse());
  }
  const { token, actor, base } = onToken(store, {}, { "item-piles": { data } });
  assert.ok(Object.keys(data.tablesForPopulate?.[0]?.items ?? {}).length > 1, "the fixture has quantities to reorder");
  assert.equal(planTokenMigration(token, actor, base).shop, null);
});

test("a token's shop config from an older version still migrates, as the base's would (#137 review, round 4)", () => {
  const { token, actor, base } = onToken(migratedStore(), { flags: { "merchant-presets": { shop: { version: 0 } } } },
    { "item-piles": { data: { enabled: true, openTimes: nineToFive } } });
  assert.ok(planTokenMigration(token, actor, base).shop);
});

test("a token plans only its own delta's items, not the base's (#137 review, round 4)", () => {
  const store = migratedStore();
  const unmigrated = { _id: "baseOnly0000001", name: "Base-only Lamp", type: "equipment", system: { quantity: 1 }, flags: {} };
  store.items.push(unmigrated);                                     // the base's own, still to migrate
  const { token, actor, base } = onToken(store, { items: [tradedBell] });
  assert.deepEqual(planTokenMigration(token, actor, base).itemUpdates.map(u => u._id), ["tokenBell000001"]);
});

test("a token already migrated, or one with nothing of its own, or a linked one, needs nothing (#124)", () => {
  const plain = onToken(migratedStore(), {});
  assert.equal(tokenNeedsMigration(plain.token, plain.actor, plain.base), false);
  const done = onToken(migratedStore(), { items: [{ ...tradedBell, flags: { "merchant-presets": { stock: { ...STOCK_DEFAULTS } } } }],
    flags: { "item-piles": { data: { openTimes: nineToFive } }, "merchant-presets": { shop: { version: 1 } } } });
  assert.equal(tokenNeedsMigration(done.token, done.actor, done.base), false);
  const linked = onToken(migratedStore(), { items: [tradedBell] });
  assert.equal(tokenNeedsMigration({ ...linked.token, actorLink: true }, linked.actor, linked.base), false);
  const traded = onToken(migratedStore(), { items: [tradedBell] });
  assert.equal(tokenNeedsMigration(traded.token, traded.actor, traded.base), true);
});
