/**
 * Migrating a 1.x Item Piles merchant to this module's own shop config (#100,
 * #98), kept free of Foundry so it can be tested with plain Node
 * (tools/migrate.test.mjs).
 *
 * 1.x stored everything under `flags.item-piles`; 2.0 reads that data once,
 * derives `flags.merchant-presets.shop` and each item's
 * `flags.merchant-presets.stock` from it, and switches Item Piles off on the
 * shop so it stops treating our NPCs as its own merchants (#97). Only this
 * module's shops are touched — `isShop` — so a world's other Item Piles
 * merchants, kept for loot or a GM's own trading, are left exactly as they
 * are.
 *
 * Item Piles strips a key back off a document whenever it is set to its own
 * default, so an *absent* key does not mean "unset" — it means "Item Piles'
 * own default", which is not always the same value this module would choose
 * (`keepOnMerchant` defaults to `false` in Item Piles, `true` in
 * `STOCK_DEFAULTS`). Reading a raw flag with `??` against *our* defaults would
 * silently swap in the wrong one, so every read here goes through the IP_*
 * tables below first — Item Piles 3.3.4's own `CONSTANTS.ITEM_DEFAULTS` and
 * `CONSTANTS.PILE_DEFAULTS`
 * ("/Users/miguelross/Foundry VTT/Data/modules/item-piles/dist/item-piles.js").
 *
 * The shop-level fields all come from the actor's own Item Piles data, not
 * the shipped pack: a merchant a GM re-tuned by hand keeps their values. The
 * one field Item Piles never had is `restock.every` (#105), so that alone
 * comes from `packShop` — the shipped merchant's own `flags.merchant-presets`
 * config, resolved by the caller — and falls back to `SHOP_DEFAULTS` when no
 * pack merchant can be resolved (an NPC set up as a shop with its source
 * since deleted, say).
 */

import { isGearItem, isShop, tierOf } from "./shop.mjs";
import { SHOP_DEFAULTS, SHOP_VERSION } from "./schema.mjs";

/** The 2.0 shop sheet's id, registered with `DocumentSheetConfig` (#104) and
 *  written to every migrated shop's `flags.core.sheetClass` so core's own
 *  double-click, sidebar and token HUD open it with no patching. The sheet
 *  itself doesn't exist yet (#103); this id is the contract between the two. */
export const SHOP_SHEET_ID = "merchant-presets.ShopSheet";

/**
 * Item Piles 3.3.4's `CONSTANTS.ITEM_DEFAULTS` — what a per-item
 * `flags.item-piles.item` key reads as once Item Piles has stripped it back
 * off the document (item-piles.js:46-72). Only the keys #100 maps.
 */
const IP_ITEM_DEFAULTS = {
  hidden: false,                  // item-piles.js:48
  notForSale: false,              // item-piles.js:49
  infiniteQuantity: "default",    // item-piles.js:50
  cantBeSoldToMerchants: false,   // item-piles.js:56
  isService: false,               // item-piles.js:57
  keepOnMerchant: false,          // item-piles.js:58
  customCategory: ""              // item-piles.js:60
};

/** `flags.item-piles.system.quantityForPrice` isn't in `ITEM_DEFAULTS` at
 *  all — the Populate Items UI falls back to `?? 1` when reading it
 *  (item-piles.js:53500). */
const IP_QUANTITY_FOR_PRICE_DEFAULT = 1;

/**
 * Item Piles 3.3.4's `CONSTANTS.PILE_DEFAULTS` — what a
 * `flags.item-piles.data` key reads as once stripped (item-piles.js:121-206).
 * Only the keys #100 maps; `type` and `enabled` are never stripped in
 * practice (every shop we ship sets both), so they aren't read through this.
 */
const IP_PILE_DEFAULTS = {
  description: "",                // item-piles.js:131
  buyPriceModifier: 1,            // item-piles.js:177
  sellPriceModifier: 0.5,         // item-piles.js:178
  itemTypePriceModifiers: [],     // item-piles.js:179
  tablesForPopulate: [],          // item-piles.js:181
  refreshItemsOnOpen: false,      // item-piles.js:203
  openTimes: {
    enabled: false,               // item-piles.js:185
    open: { hour: 9, minute: 0 }, // item-piles.js:192-195
    close: { hour: 18, minute: 0 } // item-piles.js:196-199
  }
};

/**
 * The dnd5e item-type refusals every shop carries regardless of what it
 * stocks (tools/build_srd.py's `DND5E_ITEM_FILTERS`). `overrideItemFilters`
 * REPLACES Item Piles' global filter list rather than adding to it, so every
 * shop's own list starts with these; they are not a shop's own choice and
 * don't belong in `wontBuy`.
 */
const DND5E_ITEM_FILTERS = [
  { path: "type", filters: "background,class,facility,feat,race,spell,subclass" },
  { path: "system.type.value", filters: "natural" }
];

/** The shopkeeper's own kit (`flags.merchant-presets.kind: "gear"`) is the
 *  third fixed refusal — schema.mjs: "non-item types, natural weapons and
 *  shopkeeper gear are never bought" — but expressed through `GOODS_KINDS`
 *  rather than `DND5E_ITEM_FILTERS`, since every shop refuses it whether or
 *  not it happens to stock anything else in that list. Fixed behaviour, so
 *  it stays out of `wontBuy` too (tools/schema.test.mjs's `shopOf`). */
const FIXED_KIND = "gear";

/** `flags.item-piles.data`, with every stripped key read back as Item Piles' own default. */
function pileData(actor) {
  const raw = actor?.flags?.["item-piles"]?.data ?? {};
  return {
    ...IP_PILE_DEFAULTS,
    ...raw,
    openTimes: {
      ...IP_PILE_DEFAULTS.openTimes,
      ...raw.openTimes,
      open: { ...IP_PILE_DEFAULTS.openTimes.open, ...raw.openTimes?.open },
      close: { ...IP_PILE_DEFAULTS.openTimes.close, ...raw.openTimes?.close }
    }
  };
}

/** `terms.categories` from `itemTypePriceModifiers`' custom-category overrides (Valuables, or a GM's own). */
function categoriesFrom(modifiers) {
  return (modifiers ?? [])
    .filter(m => m?.type === "custom" && m.override && m.category)
    .map(m => ({ category: m.category, sellsAt: m.buyPriceModifier, buysAt: m.sellPriceModifier }));
}

/** The values on `filters`' entries at `path`, as a Set, comma-split. */
function valuesOn(filters, path) {
  const values = (filters ?? [])
    .filter(f => f?.path === path)
    .flatMap(f => String(f.filters ?? "").split(",").filter(Boolean));
  return new Set(values);
}

/** `wontBuy` from `overrideItemFilters`: everything on `type` and our own `kind`, minus the fixed ones. */
function wontBuyFrom(filters) {
  if (!Array.isArray(filters)) return { types: [], kinds: [] };
  const fixedTypes = valuesOn(DND5E_ITEM_FILTERS, "type");
  const types = [...valuesOn(filters, "type")].filter(t => !fixedTypes.has(t)).sort();
  const kinds = [...valuesOn(filters, "flags.merchant-presets.kind")].filter(k => k !== FIXED_KIND).sort();
  return { types, kinds };
}

/**
 * The full `flags.merchant-presets.shop` for `actor`, derived from its own
 * Item Piles data over `packShop` (the shipped merchant it was dragged from,
 * or an NPC's #57 source — resolved by the caller, which is Foundry's job).
 *
 * Only `restock.every` ever comes from `packShop`, since Item Piles had no
 * restock schedule; everything else Item Piles can express is read off the
 * actor, so a merchant a GM re-tuned by hand keeps their own values.
 *
 * @param {object} actor     Actor data: `flags`, `items` and `name`.
 * @param {object} [packShop] A resolved shop config to fall back to, shaped
 *   like `SHOP_DEFAULTS`. Omitted when no pack merchant can be resolved.
 * @returns {object} A shop config, not yet validated.
 */
export function deriveShop(actor, packShop) {
  const base = packShop ? structuredClone(packShop) : structuredClone(SHOP_DEFAULTS);
  const ip = pileData(actor);
  const table = ip.tablesForPopulate[0];
  return {
    ...base,
    version: SHOP_VERSION,
    tier: tierOf(actor),
    source: actor?.flags?.["merchant-presets"]?.shop?.source ?? null,
    description: ip.description,
    terms: {
      sellsAt: ip.buyPriceModifier,
      buysAt: ip.sellPriceModifier,
      categories: categoriesFrom(ip.itemTypePriceModifiers)
    },
    hours: ip.openTimes.enabled
      ? { open: { ...ip.openTimes.open }, close: { ...ip.openTimes.close } }
      : null,
    restock: {
      ...base.restock,
      table: table?.uuid ?? null,
      quantities: { ...(table?.items ?? {}) },
      onOpen: ip.refreshItemsOnOpen,
      mode: "reroll"
    },
    wontBuy: wontBuyFrom(ip.overrideItemFilters)
  };
}

/**
 * The full `flags.merchant-presets.stock` for one item, from a flat set of
 * Item Piles item flags — `infiniteQuantity`, `keepOnMerchant`, `isService`,
 * `cantBeSoldToMerchants`, `customCategory`, `hidden`, `notForSale` and
 * `quantityForPrice` (`sourceFlagsOf`'s shape, not the live document's own
 * `.item`/`.system` split).
 *
 * @param {object} [flags]
 * @returns {object} A stock config, not yet validated.
 */
export function deriveStock(flags) {
  const ip = { ...IP_ITEM_DEFAULTS, ...flags };
  const infinite = { yes: true, no: false, default: null }[ip.infiniteQuantity] ?? null;
  return {
    infinite,
    keep: ip.keepOnMerchant,
    service: ip.isService,
    noBuyback: ip.cantBeSoldToMerchants,
    category: ip.customCategory,
    bundle: Number(ip.quantityForPrice) || IP_QUANTITY_FOR_PRICE_DEFAULT,
    hidden: ip.hidden,
    notForSale: ip.notForSale
  };
}

/**
 * The Item Piles flags to migrate `item` from, flattened to `deriveStock`'s
 * shape.
 *
 * `flags.merchant-presets.itemFlags` — this shop's own record of what each
 * stock line should be, restored after every restock (CONTRIBUTING.md) — is
 * preferred when it names the item: a stock-mode pass (`applyStockMode`) can
 * already have overwritten the item's *live* `infiniteQuantity` to `"no"` as
 * bookkeeping once a count is rolled, which `itemFlags` is exactly there to
 * survive. An item never in that record — one a GM added to the shelf by
 * hand, never part of the shipped stock list — is read from its own live
 * flags instead.
 *
 * @param {object} actor
 * @param {object} item
 * @returns {object}
 */
function sourceFlagsOf(actor, item) {
  const recorded = actor?.flags?.["merchant-presets"]?.itemFlags?.[item.name];
  if (recorded) return recorded;
  const ip = item.flags?.["item-piles"] ?? {};
  return { ...ip.item, quantityForPrice: ip.system?.quantityForPrice };
}

/** Whether `actor`'s own `flags.merchant-presets.shop` is already this version's. */
function hasCurrentShop(actor) {
  return actor?.flags?.["merchant-presets"]?.shop?.version === SHOP_VERSION;
}

/**
 * Whether `actor` still needs migrating: one of our shops without a current
 * shop config, or one Item Piles still treats as its own merchant. Idempotent
 * once both are fixed — a second call on the migrated actor returns `false`.
 *
 * @param {object} actor
 * @returns {boolean}
 */
export function needsMigration(actor) {
  if (!isShop(actor)) return false;
  if (!hasCurrentShop(actor)) return true;
  return actor.flags?.["item-piles"]?.data?.enabled === true;
}

/**
 * Whether any of `actors` is one of our shops still on a pre-2.0 config —
 * the signal that this world is upgrading from 1.x, for the `autoRestock`
 * default (#105).
 *
 * @param {Iterable<object>} actors
 * @returns {boolean}
 */
export function worldHasLegacyShops(actors) {
  return Array.from(actors).some(a => isShop(a) && !hasCurrentShop(a));
}

/**
 * Whether the world's `autoRestock` setting should be forced off on this
 * first 2.0 load — #105's decision: `autoRestock` defaults on in 2.0, but a
 * world upgrading from 1.x that never touched the setting must keep the 1.x
 * behaviour (off), since a changed default otherwise flips silently under
 * every world that left it unset.
 *
 * @param {boolean} hasStoredValue        Whether the world's settings storage
 *   already holds a value for `autoRestock` (a GM's own choice, on 1.x or 2.0).
 * @param {boolean} worldHasLegacyShops   `worldHasLegacyShops(game.actors)`.
 * @returns {boolean|null} `false` to write, or `null` to leave the setting alone.
 */
export function planAutoRestockDefault(hasStoredValue, worldHasLegacyShops) {
  if (hasStoredValue) return null;
  return worldHasLegacyShops ? false : null;
}

/** `flags.core.sheetClass`, or `null` if it's already ours. */
function planSheetClass(actor) {
  return actor?.flags?.core?.sheetClass === SHOP_SHEET_ID ? null : SHOP_SHEET_ID;
}

/**
 * The default ownership a migrated shop should get (#104): Limited if it
 * already has a token on a scene, otherwise None — but 1.x never touched
 * ownership, so any value but the field's own default (None) reads as a GM's
 * own choice and is left alone.
 *
 * @param {object} actor
 * @param {boolean} hasTokenOnScene
 * @returns {number|null} A `CONST.DOCUMENT_OWNERSHIP_LEVELS` value to write, or `null`.
 */
export function planOwnership(actor, hasTokenOnScene) {
  const NONE = 0, LIMITED = 1;   // CONST.DOCUMENT_OWNERSHIP_LEVELS (constants.mjs:470-496)
  const current = actor?.ownership?.default ?? NONE;
  if (current !== NONE) return null;             // a GM's own choice, 1.x never sets this
  const target = hasTokenOnScene ? LIMITED : NONE;
  return target === current ? null : target;
}

/**
 * The `Actor#update` payload to bring `actor` into 2.0, or `null` if it
 * needs nothing. Dotted-path keys, as the rest of the runtime writes them.
 *
 * @param {object} actor
 * @param {object} [options]
 * @param {object} [options.packShop]        See `deriveShop`.
 * @param {boolean} [options.hasTokenOnScene] See `planOwnership`.
 * @returns {object|null}
 */
export function planActorUpdate(actor, { packShop, hasTokenOnScene = false } = {}) {
  if (!needsMigration(actor)) return null;
  const update = {};

  if (!hasCurrentShop(actor)) update["flags.merchant-presets.shop"] = deriveShop(actor, packShop);
  if (actor.flags?.["item-piles"]?.data?.enabled !== false) update["flags.item-piles.data.enabled"] = false;
  if (actor.prototypeToken?.flags?.["item-piles"]?.data?.enabled !== false) {
    update["prototypeToken.flags.item-piles.data.enabled"] = false;
  }

  const sheetClass = planSheetClass(actor);
  if (sheetClass) update["flags.core.sheetClass"] = sheetClass;

  const ownership = planOwnership(actor, hasTokenOnScene);
  if (ownership !== null) update["ownership.default"] = ownership;

  return update;
}

/**
 * The `Actor#updateEmbeddedDocuments("Item", …)` payload for `actor`'s stock:
 * one entry per item still missing `flags.merchant-presets.stock`. An item
 * that already has one is left alone — once derived, our schema is the
 * source of truth, not Item Piles. The shopkeeper's own kit is never stock
 * (`isGearItem`) and is skipped, same as everywhere else in the runtime.
 *
 * @param {object} actor
 * @returns {object[]}
 */
export function planItemUpdates(actor) {
  if (!isShop(actor)) return [];
  const updates = [];
  for (const item of actor.items ?? []) {
    if (isGearItem(item) || item.flags?.["merchant-presets"]?.stock) continue;
    const stock = deriveStock(sourceFlagsOf(actor, item));
    updates.push({ _id: item._id, "flags.merchant-presets.stock": stock });
  }
  return updates;
}

/**
 * The `Scene#updateEmbeddedDocuments("Token", …)` entry to switch Item Piles
 * off on one token, or `null` if there's nothing to do.
 *
 * Item Piles reads a merchant's config from three places (#97): the actor,
 * the prototype token (`planActorUpdate` handles that one), and each
 * unlinked token plus its `delta`. A linked token has neither of its own — it
 * follows the actor — so it's skipped.
 *
 * @param {object} token  Token data: `_id`, `actorLink`, `flags`, `delta`.
 * @returns {object|null}
 */
export function planTokenDisable(token) {
  if (token.actorLink) return null;
  const update = { _id: token._id };
  let changed = false;
  if (token.flags?.["item-piles"]?.data?.enabled !== false) {
    update["flags.item-piles.data.enabled"] = false;
    changed = true;
  }
  if (token.delta && token.delta.flags?.["item-piles"]?.data?.enabled !== false) {
    update["delta.flags.item-piles.data.enabled"] = false;
    changed = true;
  }
  return changed ? update : null;
}
