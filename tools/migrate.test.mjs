import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateShop, validateStock } from "../scripts/schema.mjs";
import {
  SHOP_SHEET_ID, deriveShop, deriveStock, needsMigration, planActorUpdate, planAutoRestockDefault,
  planItemUpdates, planOwnership, planTokenDisable, worldHasLegacyShops
} from "../scripts/migrate.mjs";

/** A shipped merchant, straight off `_source`, matched by filename prefix. */
const merchantsDir = new URL("../_source/merchants/", import.meta.url);
function shipped(prefix) {
  const file = readdirSync(merchantsDir).find(f => f.startsWith(prefix));
  const doc = JSON.parse(readFileSync(new URL(file, merchantsDir), "utf8"));
  return { ...doc, items: doc.items.map(i => structuredClone(i)) };
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

/* -------------------------------------------------------------- deriveShop */

test("a shipped merchant migrates to a shop that validates, matching its own data", () => {
  const store = shipped("General_Store_Village_");
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
  const shop = deriveShop(shipped("Alchemists_Apothecaries_Village_"));
  assert.deepEqual(shop.terms.categories, [{ category: "Valuables", sellsAt: 1, buysAt: 1 }]);
  assert.deepEqual(shop.wontBuy.types.sort(), ["equipment", "weapon"]);
});

test("hand-retuned Item Piles values win over the pack (#100)", () => {
  const store = shipped("General_Store_Village_");
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
  const shop = deriveShop(shipped("General_Store_Village_"));
  assert.equal(shop.restock.every, 7);
});

test("a #57 'Set up as shop' NPC carries its source and stays a shop", () => {
  const npc = shipped("General_Store_Village_");
  const marker = { source: "Compendium.merchant-presets.merchants.Actor.abcdefghijklmnop", tier: "Town" };
  npc.flags["merchant-presets"] = { shop: marker };   // the pre-migration #57 marker, no `version`
  delete npc.flags["merchant-presets"].profile;

  assert.equal(needsMigration(npc), true);
  const shop = deriveShop(npc);
  assert.equal(shop.source, "Compendium.merchant-presets.merchants.Actor.abcdefghijklmnop");
  assert.ok(validateShop(shop).ok);
});

test("closed-off hours (openTimes disabled) migrate to null, not Item Piles' 9-18", () => {
  const store = shipped("General_Store_Village_");
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
  const store = shipped("General_Store_Village_");
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

/* ------------------------------------------------------------ planActorUpdate */

test("planActorUpdate migrates shop config, disables Item Piles, sets the sheet and (hidden) ownership", () => {
  const store = shipped("General_Store_Village_");
  store._id = "abcdefghijklmnop";
  const update = planActorUpdate(store, { hasTokenOnScene: false });
  assert.ok(update);
  assert.equal(update["flags.merchant-presets.shop"].version, 1);
  assert.equal(update["flags.item-piles.data.enabled"], false);
  assert.equal(update["prototypeToken.flags.item-piles.data.enabled"], false);
  assert.equal(update["flags.core.sheetClass"], SHOP_SHEET_ID);
  // Already hidden (ownership.default: 0) and no token on any scene: nothing to change.
  assert.ok(!("ownership.default" in update));
});

test("planActorUpdate makes a shop with a placed token visitable (Limited)", () => {
  const store = shipped("General_Store_Village_");
  const update = planActorUpdate(store, { hasTokenOnScene: true });
  assert.equal(update["ownership.default"], 1);
});

test("planActorUpdate respects a GM's own ownership choice (not 0) and never overwrites it", () => {
  const store = shipped("General_Store_Village_");
  store.ownership = { default: 3 };   // Owner, or any non-default value a GM set
  const update = planActorUpdate(store, { hasTokenOnScene: true });
  assert.ok(!("ownership.default" in update));
});

test("planActorUpdate is idempotent: applying its own plan leaves nothing to migrate", () => {
  const store = shipped("General_Store_Village_");
  const first = planActorUpdate(store, { hasTokenOnScene: true });
  const migrated = applied(store, first);
  assert.equal(needsMigration(migrated), false);
  assert.equal(planActorUpdate(migrated, { hasTokenOnScene: true }), null);
});

test("Item Piles left on but shop already current: only the switch-off is planned", () => {
  const store = shipped("General_Store_Village_");
  const first = planActorUpdate(store, {});
  const migrated = applied(store, first);
  // Roll back just the Item Piles switch, as if #97's write had failed partway.
  migrated.flags["item-piles"].data.enabled = true;
  const second = planActorUpdate(migrated, {});
  assert.ok(second);
  assert.ok(!("flags.merchant-presets.shop" in second));   // the GM's already-migrated config is untouched
  assert.equal(second["flags.item-piles.data.enabled"], false);
});

/* ------------------------------------------------------------ planItemUpdates */

test("planItemUpdates migrates every stock line once, then leaves them alone", () => {
  const store = shipped("General_Store_Village_");
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
  const store = shipped("General_Store_Village_");
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
  const store = shipped("General_Store_Village_");
  store.items.push({
    _id: "gmAddedItem0001", name: "A Curiosity", type: "loot",
    flags: { "item-piles": { item: { infiniteQuantity: "no", keepOnMerchant: true, isService: false,
      cantBeSoldToMerchants: false, hidden: true, notForSale: false } } }
  });
  const update = planItemUpdates(store).find(u => u._id === "gmAddedItem0001");
  assert.equal(update["flags.merchant-presets.stock"].infinite, false);
  assert.equal(update["flags.merchant-presets.stock"].hidden, true);
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
