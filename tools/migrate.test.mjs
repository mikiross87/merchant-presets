import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateShop, validateStock } from "../scripts/schema.mjs";
import {
  SHOP_SHEET_ID, deriveShop, deriveStock, needsMigration, packShopCandidates, planActorUpdate,
  planAutoRestockDefault, planItemUpdates, planOwnership, planTokenDisable, planTokenUpdates, worldHasLegacyShops
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
  for (const u of planItemUpdates(out)) {
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
  const update = planActorUpdate(store, {});
  assert.ok(update);
  const shop = update["flags.merchant-presets.shop"];
  assert.equal(shop.terms.sellsAt, null);
  assert.ok(validateShop(shop).ok, validateShop(shop).errors.join(" | "));
});

test("a duplicate category override collapses to the last one, as Item Piles' own save would", () => {
  const store = legacy(shipped("Alchemists_Apothecaries_Village_"));
  const mods = store.flags["item-piles"].data.itemTypePriceModifiers;
  mods.push({ ...mods[0], buyPriceModifier: 2 });   // a second, later "Valuables" override
  const shop = deriveShop(store);
  assert.deepEqual(shop.terms.categories, [{ category: "Valuables", sellsAt: 2, buysAt: 1 }]);
  assert.ok(validateShop(shop).ok);
});

test("open == close hours repairs to null (always open) — the schema can't encode Item Piles' own reading of it", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.flags["item-piles"].data.openTimes.close = { ...store.flags["item-piles"].data.openTimes.open };
  const update = planActorUpdate(store, {});
  assert.ok(update);
  assert.equal(update["flags.merchant-presets.shop"].hours, null);
});

test("a shop config still invalid after repair is not written or stamped, and throws with the errors", () => {
  const store = legacy(shipped("General_Store_Village_"));
  // Unrepairable: 0 is neither "never" nor an integer >= 1 nor a dice formula,
  // and restock.every isn't one of repairShop's rules.
  const packShop = { restock: { every: 0 } };
  assert.throws(() => planActorUpdate(store, { packShop }), /restock\.every/);
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
  assert.equal(planActorUpdate(theirs), null);
  assert.deepEqual(planItemUpdates(theirs), []);
});

test("worldHasLegacyShops sees an unmigrated shop and ignores everything else", () => {
  const legacy = { flags: { "merchant-presets": { profile: "Commoner" } } };
  const migrated = { flags: { "merchant-presets": { shop: { version: 1 } } } };
  const notOurs = { flags: { "item-piles": { data: { enabled: true, type: "merchant" } } } };
  assert.equal(worldHasLegacyShops([migrated, notOurs]), false);
  assert.equal(worldHasLegacyShops([migrated, notOurs, legacy]), true);
});

test("needsMigration stays true when the shop half landed but items still lack .stock (#100 review)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const shopOnly = applied(store, { "flags.merchant-presets.shop": deriveShop(store) });
  // Shop half done, as if updateEmbeddedDocuments("Item", …) had then thrown.
  assert.equal(needsMigration(shopOnly), true);
  // Nothing left for the actor-level update — the shop's current, nativeShop's
  // off — but planItemUpdates independently still has work, and migrateShop
  // (scripts/merchant-presets.mjs) calls it regardless of planActorUpdate's result.
  assert.equal(planActorUpdate(shopOnly, {}), null);
  assert.ok(planItemUpdates(shopOnly).length > 0);
});

test("needsMigration is false only once both the shop and every item are migrated", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const migrated = withItemsMigrated(applied(store, { "flags.merchant-presets.shop": deriveShop(store) }));
  assert.equal(needsMigration(migrated), false);
});

/* ------------------------------------------------------------ planActorUpdate */

test("nativeShop off (the default): only the data half is planned, Item Piles and the sheet untouched", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const update = planActorUpdate(store, { hasTokenOnScene: true });   // no nativeShop: the module default (off)
  assert.ok(update);
  assert.equal(update["flags.merchant-presets.shop"].version, 1);
  // next still trades this shop through Item Piles (#97 "Order on next"): none of
  // the cut-over keys are planned, even with a token placed (which would
  // otherwise make ownership Limited) and Item Piles still fully enabled.
  assert.deepEqual(Object.keys(update), ["flags.merchant-presets.shop"]);
});

test("planActorUpdate migrates shop config, disables Item Piles, sets the sheet and (hidden) ownership", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store._id = "abcdefghijklmnop";
  const update = planActorUpdate(store, { hasTokenOnScene: false, nativeShop: true });
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
  const update = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true });
  assert.equal(update["ownership.default"], 1);
});

test("planActorUpdate respects a GM's own ownership choice (not 0) and never overwrites it", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.ownership = { default: 3 };   // Owner, or any non-default value a GM set
  const update = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true });
  assert.ok(!("ownership.default" in update));
});

test("planActorUpdate is idempotent (nativeShop off): applying its own plan leaves nothing to migrate", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const first = planActorUpdate(store, { hasTokenOnScene: true });
  const migrated = withItemsMigrated(applied(store, first));
  assert.equal(needsMigration(migrated), false);
  assert.equal(planActorUpdate(migrated, { hasTokenOnScene: true }), null);
});

test("planActorUpdate is idempotent (nativeShop on): applying its own plan leaves nothing to migrate", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const first = planActorUpdate(store, { hasTokenOnScene: true, nativeShop: true });
  const migrated = withItemsMigrated(applied(store, first));
  assert.equal(needsMigration(migrated, true), false);
  assert.equal(planActorUpdate(migrated, { hasTokenOnScene: true, nativeShop: true }), null);
});

test("Item Piles left on but shop already current: only the switch-off is planned", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const first = planActorUpdate(store, { nativeShop: true });
  const migrated = applied(store, first);
  // Roll back just the Item Piles switch, as if #97's write had failed partway.
  migrated.flags["item-piles"].data.enabled = true;
  const second = planActorUpdate(migrated, { nativeShop: true });
  assert.ok(second);
  assert.ok(!("flags.merchant-presets.shop" in second));   // the GM's already-migrated config is untouched
  assert.equal(second["flags.item-piles.data.enabled"], false);
});

test("a data-migrated shop is picked up again once nativeShop flips on", () => {
  const store = legacy(shipped("General_Store_Village_"));
  // nativeShop off: data half only, both actor- and item-level.
  const dataOnly = withItemsMigrated(applied(store, planActorUpdate(store, {})));

  // Not re-opened while the cut-over is still off, however many times it runs.
  assert.equal(needsMigration(dataOnly), false);
  assert.equal(needsMigration(dataOnly, false), false);
  assert.equal(planActorUpdate(dataOnly, {}), null);

  // Flip NATIVE_SHOP on (#104): the same shop, still Item Piles' own merchant
  // underneath, is picked up again to finish the cut-over — no version bump,
  // no re-deriving the shop config the GM may since have edited by hand.
  assert.equal(needsMigration(dataOnly, true), true);
  const second = planActorUpdate(dataOnly, { nativeShop: true });
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
  assert.equal(first.length, stockable.length);
  for (const u of first) assert.ok(validateStock(u["flags.merchant-presets.stock"]).ok);

  // Apply, then run again: idempotent.
  for (const u of first) {
    const item = store.items.find(i => i._id === u._id);
    item.flags["merchant-presets"] ??= {};
    item.flags["merchant-presets"].stock = u["flags.merchant-presets.stock"];
  }
  assert.deepEqual(planItemUpdates(store), []);
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

  const update = planItemUpdates(store).find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].infinite, null);
});

test("an item never in itemFlags — a GM's own addition — is read from its live flags", () => {
  const store = legacy(shipped("General_Store_Village_"));
  store.items.push({
    _id: "gmAddedItem0001", name: "A Curiosity", type: "loot",
    flags: { "item-piles": { item: { infiniteQuantity: "no", keepOnMerchant: true, isService: false,
      cantBeSoldToMerchants: false, hidden: true, notForSale: false } } }
  });
  const update = planItemUpdates(store).find(u => u._id === "gmAddedItem0001");
  assert.equal(update["flags.merchant-presets.stock"].infinite, false);
  assert.equal(update["flags.merchant-presets.stock"].hidden, true);
});

test("a GM-hidden shipped item stays hidden after migration (#100 review: live wins for hidden/notForSale)", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  bell.flags["item-piles"].item.hidden = true;      // the GM hid it directly on the live item
  bell.flags["item-piles"].item.notForSale = true;
  const update = planItemUpdates(store).find(u => u._id === bell._id);
  assert.equal(update["flags.merchant-presets.stock"].hidden, true);
  assert.equal(update["flags.merchant-presets.stock"].notForSale, true);
});

test("a GM's live re-categorization wins over the shipped record", () => {
  const store = legacy(shipped("General_Store_Village_"));
  const bell = store.items.find(i => i.name === "Bell");
  assert.equal(store.flags["merchant-presets"].itemFlags.Bell.customCategory, undefined);   // shipped with none
  bell.flags["item-piles"].item.customCategory = "Curiosities";   // the GM gave it one directly
  const update = planItemUpdates(store).find(u => u._id === bell._id);
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
  const update = planItemUpdates(store).find(u => u._id === bell._id);
  const stock = update["flags.merchant-presets.stock"];
  assert.equal(stock.infinite, { yes: true, no: false, default: null }[recorded.infiniteQuantity]);
  assert.equal(stock.keep, recorded.keepOnMerchant);
  assert.equal(stock.service, recorded.isService);
  assert.equal(stock.noBuyback, recorded.cantBeSoldToMerchants);
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
  assert.deepEqual(planTokenUpdates(tokens), []);            // the module default (off)
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
    const updates = planItemUpdates(legacy(doc));
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
