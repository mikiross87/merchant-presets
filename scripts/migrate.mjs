/**
 * Migrating a 1.x Item Piles merchant to this module's own shop config (#100,
 * #98), kept free of Foundry so it can be tested with plain Node
 * (tools/migrate.test.mjs).
 *
 * 1.x stored everything under `flags.item-piles`; 2.0 reads that data once
 * and derives `flags.merchant-presets.shop` and each item's
 * `flags.merchant-presets.stock` from it — safe on `next` at any time, since
 * nothing there reads those flags yet. Switching Item Piles off on the shop,
 * so it stops treating our NPCs as its own merchants (#97), is a second,
 * separate half gated behind `NATIVE_SHOP`: see its own comment. Only this
 * module's shops are touched — `isMigratable` — so a world's other Item Piles
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

import { isGearItem, isShop, TIERS, tierOf } from "./shop.mjs";
import { SHOP_DEFAULTS, SHOP_VERSION, STOCK_DEFAULTS, validateShop, validateStock } from "./schema.mjs";

/** The 2.0 shop sheet's id, registered with `DocumentSheetConfig` (#104) and
 *  written to every migrated shop's `flags.core.sheetClass` so core's own
 *  double-click, sidebar and token HUD open it with no patching. The sheet
 *  itself doesn't exist yet (#103); this id is the contract between the two. */
export const SHOP_SHEET_ID = "merchant-presets.ShopSheet";

/**
 * Whether the cut-over to the native shop is live. `next` keeps trading,
 * opening and restocking every shop through Item Piles until #102-#104 land
 * (the #97 decision, "Order on next"): switching Item Piles off, or pointing
 * `flags.core.sheetClass` at a window that doesn't exist yet, would break
 * every shop the moment this migration ran. So while this is `false`, only
 * the data half of the migration runs — `flags.merchant-presets.shop` and
 * `.stock` are derived and written, safe beside the Item Piles flags Item
 * Piles keeps reading — and the cut-over half (Item Piles disabled, the
 * sheet, the ownership default) is skipped, not merely deferred: flip this
 * to `true` once #104 makes the shop window the sheet, and `needsMigration`
 * picks every already-data-migrated shop back up to finish the cut-over.
 */
export const NATIVE_SHOP = false;

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

/**
 * `PHYSICAL_TYPES` and `GOODS_KINDS`, straight off tools/build_srd.py: the
 * declared order a freshly-built shop's `wontBuy.types`/`.kinds` list its
 * refusals in (`refuse_types`/`refuse_kinds` there both walk these lists in
 * order). Matched here so a migrated shop's lists come out in the same
 * order as one dragged fresh from the compendium, not merely the same set.
 */
const PHYSICAL_TYPES_ORDER = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
const GOODS_KINDS_ORDER = ["vehicle", "mount", "tack", "food-drink", "meal", "lodging", "service",
  "spellcasting", "component", "travel", "gear"];

/** `values` (a Set) ordered by `canonical`'s declared order first, then
 *  anything `canonical` doesn't name — a GM's own item type or kind,
 *  outside this module's fixed lists — alphabetically after. */
function canonicalOrder(values, canonical) {
  const known = canonical.filter(v => values.has(v));
  const rest = [...values].filter(v => !canonical.includes(v)).sort();
  return [...known, ...rest];
}

/**
 * The tier a migrated shop should carry: the actor's own #57 marker when it
 * names one; else `packShop`'s own tier; else `tierOf(actor)`'s last resort
 * (parsing the actor's name, then "Town"). `packShop` comes before the
 * name-parse because a shipped merchant's own name is the only thing that
 * parse can read — a GM who renamed "General Store (Village)" to something
 * of their own loses the "(Village)" suffix, and `tierOf` would silently
 * default such a shop to Town. The shipped merchant's *own* document, kept
 * at `packShop`, still carries its original name and tier (#100 review).
 *
 * @param {object} actor
 * @param {object} [packShop]
 * @returns {"Village"|"Town"|"City"}
 */
function tierFrom(actor, packShop) {
  const marked = actor?.flags?.["merchant-presets"]?.shop?.tier;
  if (TIERS.includes(marked)) return marked;
  if (TIERS.includes(packShop?.tier)) return packShop.tier;
  return tierOf(actor);
}

/**
 * The merchant document(s) `packShop` (`deriveShop`'s pack fallback) might be
 * resolved from, most authoritative first: the actor's own #57 marker
 * (`flags.merchant-presets.shop.source`) — the shipped merchant an NPC was
 * set up *as* — before the actor's own compendium provenance
 * (`_stats.compendiumSource`), which for a #57 NPC points at the SRD stat
 * block it was *instantiated from*, not a shop at all (#100 review). An
 * ordinary shipped merchant has no #57 marker, so its own provenance is the
 * only candidate.
 *
 * @param {object} actor
 * @returns {string[]}
 */
export function packShopCandidates(actor) {
  return [actor?.flags?.["merchant-presets"]?.shop?.source, actor?._stats?.compendiumSource].filter(Boolean);
}

/**
 * Whether `actor` is one of this module's shops, for the migration: `isShop`,
 * or a v1.0.0 merchant. v1.0.0 shipped `flags.merchant-presets` as `purse`,
 * `itemFlags` and `containers` only; `profile`, which `isShop` reads, arrived
 * in v1.1.0. Every 1.x release carries `itemFlags`, and nothing else writes
 * it. Kept out of `isShop` itself, so the rest of the runtime still sees
 * such an actor only once it's migrated.
 *
 * @param {object} actor
 * @returns {boolean}
 */
export function isMigratable(actor) {
  return isShop(actor) || Boolean(actor?.flags?.["merchant-presets"]?.itemFlags);
}

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

/**
 * `terms.categories` from `itemTypePriceModifiers`: a custom category's
 * entry (Valuables, or a GM's own) under its own name, an item type's under
 * the type, which is where a stock line on the default category files
 * (schema.mjs: `""` files it under its item type). Mirrors Item Piles'
 * `getMerchantModifiersForActor` (item-piles.js 3.3.4): an entry with
 * `override` replaces the shop's rate, one without multiplies it, so that
 * one carries over with the product baked in; and it prices by the first
 * match, custom categories sorted ahead of types, so a repeated category
 * keeps that one, not the last (#120 review).
 *
 * @param {object[]} modifiers  `itemTypePriceModifiers`
 * @param {{buyPriceModifier: number, sellPriceModifier: number}} shopRates  the pile's own
 */
function categoriesFrom(modifiers, { buyPriceModifier, sellPriceModifier }) {
  const byCategory = new Map();
  const ordered = [...(modifiers ?? [])].sort((a, b) => (a?.type === "custom" && b?.type !== "custom" ? -1 : 0));
  for (const m of ordered) {
    const category = m?.type === "custom" ? m.category : m?.type;
    if (!category || byCategory.has(category)) continue;
    const sellsAt = m.override ? m.buyPriceModifier : clean(buyPriceModifier * m.buyPriceModifier);
    const buysAt = m.override ? m.sellPriceModifier : clean(sellPriceModifier * m.sellPriceModifier);
    byCategory.set(category, { category, sellsAt, buysAt });
  }
  return [...byCategory.values()];
}

/** Float noise off a product of two rates (1.2 * 1.5 is 1.7999999999999998). */
const clean = v => (typeof v === "number" ? Number(v.toPrecision(12)) : v);

/** The values on `filters`' entries at `path`, as a Set, comma-split and
 *  trimmed — Item Piles' own filter editor doesn't strip spaces after a
 *  comma, so "weapon, equipment" splits to "weapon" and " equipment"
 *  untrimmed, and " equipment" would neither match a fixed refusal meant to
 *  exclude it nor read back the same on a later migration (#100 review).
 *  A blank segment (a stray comma) is dropped, before or after trimming. */
function valuesOn(filters, path) {
  const values = (filters ?? [])
    .filter(f => f?.path === path)
    .flatMap(f => String(f.filters ?? "").split(",").map(v => v.trim()).filter(Boolean));
  return new Set(values);
}

/** `wontBuy` from `overrideItemFilters`: everything on `type` and our own `kind`, minus the fixed ones. */
function wontBuyFrom(filters) {
  if (!Array.isArray(filters)) return { types: [], kinds: [] };
  const fixedTypes = valuesOn(DND5E_ITEM_FILTERS, "type");
  const typeValues = valuesOn(filters, "type");
  for (const t of fixedTypes) typeValues.delete(t);
  const kindValues = valuesOn(filters, "flags.merchant-presets.kind");
  kindValues.delete(FIXED_KIND);
  return { types: canonicalOrder(typeValues, PHYSICAL_TYPES_ORDER), kinds: canonicalOrder(kindValues, GOODS_KINDS_ORDER) };
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
    tier: tierFrom(actor, packShop),
    source: actor?.flags?.["merchant-presets"]?.shop?.source ?? null,
    description: ip.description,
    terms: {
      sellsAt: ip.buyPriceModifier,
      buysAt: ip.sellPriceModifier,
      categories: categoriesFrom(ip.itemTypePriceModifiers, ip)
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
 * Keys a restock overwrites on the *live* item as bookkeeping, so the live
 * flag is not this module's own current truth for them —
 * `flags.merchant-presets.itemFlags`'s record is:
 *
 * - `infiniteQuantity`: `applyStockMode` sets it to `"no"` on every item a
 *   count gets rolled for, import or restock, whatever it shipped as.
 * - `keepOnMerchant`, `isService`, `cantBeSoldToMerchants`, and
 *   `quantityForPrice`: `reapplyItemFlags` writes all four straight back
 *   from the record after every restock (Item Piles rebuilds the shelf from
 *   the compendium, which carries none of this module's flags at all).
 *
 * `hidden`, `notForSale` and `customCategory` are untouched by either, so a
 * GM's live edit to one of those — hiding a shipped item, say (#97) — is
 * durable and outlives a restock; the record was only ever a snapshot of
 * what the item shipped with, and doesn't even carry `hidden`/`notForSale`
 * at all (#100 review).
 */
const RECORD_WINS = new Set(["infiniteQuantity", "keepOnMerchant", "isService", "cantBeSoldToMerchants",
  "quantityForPrice"]);

/**
 * The Item Piles flags to migrate `item` from, flattened to `deriveStock`'s
 * shape: the item's own live flags, with `RECORD_WINS`' keys overridden from
 * `flags.merchant-presets.itemFlags` when it names the item — this shop's
 * own record of what each stock line should be, restored after every
 * restock (CONTRIBUTING.md). An item never in that record — one a GM added
 * to the shelf by hand, never part of the shipped stock list — is read
 * entirely from its own live flags.
 *
 * @param {object} actor
 * @param {object} item
 * @returns {object}
 */
function sourceFlagsOf(actor, item) {
  const ip = item.flags?.["item-piles"] ?? {};
  const live = { ...ip.item, quantityForPrice: ip.system?.quantityForPrice };
  const recorded = actor?.flags?.["merchant-presets"]?.itemFlags?.[item.name];
  if (!recorded) return live;
  const merged = { ...live };
  for (const key of RECORD_WINS) if (key in recorded) merged[key] = recorded[key];
  return merged;
}

/** Whether `actor`'s own `flags.merchant-presets.shop` is already this
 *  version's. Also what `setUpShop` (merchant-presets.mjs) uses to decide
 *  whether a chosen merchant's own shop config is safe to copy wholesale,
 *  rather than the pre-#98 `{source, tier}` marker it might still carry
 *  (#119 fix 3, folded into #100). */
export function hasCurrentShop(actor) {
  return actor?.flags?.["merchant-presets"]?.shop?.version === SHOP_VERSION;
}

/** Whether any of `actor`'s own stock lines (the shopkeeper's own kit
 *  aside) still lack `flags.merchant-presets.stock` — the item half of the
 *  migration, tracked apart from the shop half: `Actor#update` and
 *  `Actor#updateEmbeddedDocuments` are two separate writes, and either can
 *  land while the other throws (#100 review). */
function itemsNeedStock(actor) {
  return (actor?.items ?? []).some(i => !isGearItem(i) && !i.flags?.["merchant-presets"]?.stock);
}

/** Whether any of `tokens` — this actor's own, already gathered by the
 *  caller — still needs Item Piles switched off: `planTokenDisable`'s own
 *  criterion, reused so `needsMigration` reopens the cut-over for a token
 *  left over on a scene even once the actor's and every item's own writes
 *  have already landed (#100 review). */
function tokensNeedDisable(tokens) {
  return (tokens ?? []).some(t => planTokenDisable(t) !== null);
}

/**
 * Whether `actor` still needs migrating: one of our shops without a current
 * shop config or with any stock line still unmigrated (the data half —
 * always due), or, once `nativeShop` is live, one Item Piles still treats as
 * its own merchant — on the actor itself, or on any of `tokens` (the
 * cut-over half). Idempotent once all are fixed — a second call on the
 * migrated actor returns `false` — and re-opens on its own once `nativeShop`
 * flips: a shop already on a current config but still Item Piles' own
 * merchant is picked up again to finish the cut-over, without needing a
 * version bump.
 *
 * @param {object} actor
 * @param {boolean} [nativeShop] Defaults to `NATIVE_SHOP`.
 * @param {object[]} [tokens] This actor's own tokens, across every scene —
 *   omit when the caller has none to hand (the actor-level check alone still
 *   applies).
 * @returns {boolean}
 */
export function needsMigration(actor, nativeShop = NATIVE_SHOP, tokens = []) {
  if (!isMigratable(actor)) return false;
  if (!hasCurrentShop(actor) || itemsNeedStock(actor)) return true;
  if (!nativeShop) return false;      // data half already done; the cut-over isn't live yet
  if (actor.flags?.["item-piles"]?.data?.enabled === true) return true;
  return tokensNeedDisable(tokens);
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
  return Array.from(actors).some(a => isMigratable(a) && !hasCurrentShop(a));
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

/**
 * Whether migrating `actor`'s data — this pass's own `planActorUpdate`
 * `update` — should force the world's `autoRestock` setting off right now,
 * outside `applyAutoRestockDefault`'s usual first-load check (#105, #100
 * review). A 1.x merchant sitting in a world compendium or an Adventure
 * only proves "this world is upgrading from 1.x" once a GM actually imports
 * it — which can be long after the world's first 2.0 load already looked at
 * `game.actors` and found nothing. `update` carries
 * `flags.merchant-presets.shop` only the *first* time a shop's data half is
 * derived from raw Item Piles flags, never on one already current, so its
 * presence alone is the signal: no need to re-scan every actor in the world
 * the way `worldHasLegacyShops` does.
 *
 * @param {object|null} update      `planActorUpdate`'s own `update` for this actor.
 * @param {boolean} hasStoredValue  Whether `autoRestock` already has a
 *   value — a GM's own choice, on 1.x or 2.0, is never overwritten.
 * @returns {boolean} whether to write `autoRestock: false` now.
 */
export function shouldForceAutoRestockOff(update, hasStoredValue) {
  return !hasStoredValue && !!update?.["flags.merchant-presets.shop"];
}

/**
 * Whether any of `errors` is scoped to exactly `path` — one of its own
 * sub-fields (`"path.field: …"`) or a bare check on `path` itself
 * (`"path: …"`). A plain string-prefix test would also match a sibling
 * whose index merely starts the same way — `"terms.categories.1"` is a
 * prefix of `"terms.categories.10"` — so `path` must be followed by `.` or
 * `: ` (schema.mjs's own separator), never another index digit (#100
 * review).
 *
 * @param {string[]} errors
 * @param {string} path
 * @returns {boolean}
 */
function errorsAt(errors, path) {
  return errors.some(e => e.startsWith(`${path}.`) || e.startsWith(`${path}: `));
}

/**
 * `shop` (a `deriveShop` result), repaired by rule if it fails
 * `validateShop`. Item Piles enforces none of this schema's invariants, so a
 * GM's raw data can violate them even though Item Piles itself never
 * complained — and unrepaired, an invalid config would still get written
 * and stamped current (`hasCurrentShop` reads only the version), so
 * `shopFrom` throws on every later read of it, forever (#100 review).
 *
 * - `terms.sellsAt`/`.buysAt`, or a `terms.categories` entry's own, invalid
 *   (a rate must be positive; a category's must both be present) → the
 *   top-level rate becomes `null`, the schema's own "follow the world
 *   default" (#110) and the closest a migration can get to a value Item
 *   Piles allowed but this schema doesn't; an unfixable category entry is
 *   dropped rather than kept with a rate it can't validly carry.
 * - A `terms.categories` entry naming the same category as an earlier one
 *   can't reach here — `categoriesFrom` already collapses those.
 * - `hours` invalid (open == close, or an out-of-range hour/minute) →
 *   `null` ("always open"). Item Piles' own `isMerchantClosed` treats
 *   open == close as closed all but the one minute they coincide on
 *   (item-piles.js:~36219), not always open — but the schema has no way to
 *   encode that degenerate state at all, and leaving a shop permanently
 *   open is the safer failure than leaving it permanently unmigrated.
 * - `restock.table` invalid (Item Piles enforces no shape on a `RollTable`
 *   reference at all) → `null`.
 * - A `restock.quantities` entry invalid — a GM's own per-result formula in
 *   Item Piles' Populate Items tab can use syntax this schema doesn't (keep
 *   dice like `"2d4kh1"`, exploding dice, a roll-data reference like
 *   `"@level"`) — is coerced to its plain string form when it's actually a
 *   finite positive whole number (Item Piles itself accepts a bare number
 *   there); anything still invalid is dropped outright, the same as a
 *   result this shop's own table never had — a missing entry reads as `"1"`
 *   at roll time, not zero.
 *
 * @param {object} shop
 * @returns {{shop: object, ok: boolean, errors: string[], repaired: string[]}}
 *   `ok`: whether `shop` (repaired or not) now validates. `repaired`: the
 *   first pass's errors — what was replaced or dropped — for the caller to
 *   warn about.
 */
function repairShop(shop) {
  let { ok, errors } = validateShop(shop);
  if (ok) return { shop, ok, errors, repaired: [] };
  const firstPass = errors;

  const repaired = structuredClone(shop);
  if (errorsAt(errors, "terms.sellsAt")) repaired.terms.sellsAt = null;
  if (errorsAt(errors, "terms.buysAt")) repaired.terms.buysAt = null;
  repaired.terms.categories = repaired.terms.categories.filter((c, i) =>
    !errorsAt(errors, `terms.categories.${i}`));
  if (errorsAt(errors, "hours")) repaired.hours = null;
  if (errorsAt(errors, "restock.table")) repaired.restock.table = null;
  for (const id of Object.keys(repaired.restock.quantities)) {
    if (!errorsAt(errors, `restock.quantities.${id}`)) continue;
    const v = repaired.restock.quantities[id];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) repaired.restock.quantities[id] = String(v);
    else delete repaired.restock.quantities[id];
  }

  ({ ok, errors } = validateShop(repaired));
  return { shop: repaired, ok, errors, repaired: firstPass };
}

/**
 * `deriveShop`, then `repairShop` — the config a migration would write, for a
 * caller outside the migration (`setUpShop`'s fallback for a source with no
 * current shop). Never write `shop` when `ok` is false: it carries the
 * current version, so it would never be picked up again.
 *
 * @param {object} actor
 * @param {object} [packShop]
 * @returns {{shop: object, ok: boolean, errors: string[], repaired: string[]}}
 */
export function derivedShop(actor, packShop) {
  return repairShop(deriveShop(actor, packShop));
}

/** `v` as a boolean when it's an unambiguous stand-in for one —
 *  `"true"`/`"false"`, `1`/`0` — or `fallback` otherwise. Guessing at
 *  anything less clear-cut risks silently un-hiding a good or unlocking its
 *  buyback, so a value that isn't obviously one or the other takes the safe
 *  default rather than a guess. */
function coerceBool(v, fallback) {
  if (v === "true" || v === 1) return true;
  if (v === "false" || v === 0) return false;
  return fallback;
}

/**
 * `stock` (a `deriveStock` result), repaired by rule if it fails
 * `validateStock` — mirrors `repairShop`, for the same reason: Item Piles
 * enforces none of this schema's invariants either, so a raw item flag can
 * carry a value the schema rejects outright.
 *
 * - `bundle` not a whole number 1 or more (a negative or fractional
 *   `quantityForPrice`, say) → `STOCK_DEFAULTS.bundle` (1).
 * - `category` not a string → `STOCK_DEFAULTS.category` ("").
 * - A boolean field holding something else is `coerceBool`d against its own
 *   `STOCK_DEFAULTS`. `infinite` can't actually reach here invalid —
 *   `deriveStock` only ever produces `true`, `false` or `null` for it — so
 *   it's left out.
 *
 * @param {object} stock
 * @returns {{stock: object, ok: boolean, errors: string[]}}
 */
function repairStock(stock) {
  let { ok, errors } = validateStock(stock);
  if (ok) return { stock, ok, errors };

  const repaired = { ...stock };
  if (errorsAt(errors, "bundle")) repaired.bundle = STOCK_DEFAULTS.bundle;
  if (errorsAt(errors, "category")) repaired.category = STOCK_DEFAULTS.category;
  for (const field of ["keep", "service", "noBuyback", "hidden", "notForSale"]) {
    if (errorsAt(errors, field)) repaired[field] = coerceBool(stock[field], STOCK_DEFAULTS[field]);
  }

  ({ ok, errors } = validateStock(repaired));
  return { stock: repaired, ok, errors };
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
 * The `Actor#update` payload to bring `actor` into 2.0, and whether the
 * shop config could be derived at all. Dotted-path keys, as the rest of the
 * runtime writes them.
 *
 * Always attempts the data half — `flags.merchant-presets.shop`, once —
 * regardless of `nativeShop`. The cut-over half — Item Piles switched off on
 * the actor and its prototype token, `flags.core.sheetClass`, the ownership
 * default — is included only while `nativeShop` is `true`; until then the
 * shop keeps trading through Item Piles exactly as it did on 1.x. Neither
 * half depends on the other succeeding: a shop still invalid after
 * `repairShop` leaves `shopError` set and the shop key out of `update`, but
 * the cut-over fields (when `nativeShop` is on) are still planned, and — the
 * caller's job, since it's a separate write — so is the items half
 * (`planItemUpdates`), which has nothing to do with the shop's own config
 * (#100 review).
 *
 * @param {object} actor
 * @param {object} [options]
 * @param {object} [options.packShop]         See `deriveShop`.
 * @param {boolean} [options.hasTokenOnScene] See `planOwnership`.
 * @param {boolean} [options.nativeShop]      Defaults to `NATIVE_SHOP`.
 * @returns {{update: object|null, shopError: string|null, warnings: string[]}} `update`: `null`
 *   if there's nothing to write. `shopError`: set, and the shop key left out
 *   of `update`, when the derived shop config is still invalid after
 *   `repairShop` — nothing is stamped current, so it's retried, unrepaired,
 *   on every later pass rather than silently stuck on a broken config; the
 *   caller logs it. `warnings`: Item Piles settings the shop config can't
 *   carry — a value `repairShop` replaced, a `system.type.value` refusal
 *   other than the fixed `natural` — for the caller to warn about, since
 *   once the shop is current its Item Piles data is never read again.
 */
export function planActorUpdate(actor, { packShop, hasTokenOnScene = false, nativeShop = NATIVE_SHOP } = {}) {
  if (!needsMigration(actor, nativeShop)) return { update: null, shopError: null, warnings: [] };
  const update = {};
  let shopError = null;
  const warnings = [];

  if (!hasCurrentShop(actor)) {
    const { shop, ok, errors, repaired } = derivedShop(actor, packShop);
    if (ok) update["flags.merchant-presets.shop"] = shop;
    else shopError = `Invalid migrated shop config for "${actor.name}": ${errors.join("; ")}`;
    for (const e of repaired) warnings.push(`"${actor.name}": Item Piles setting not carried over, reset to the default: ${e}`);
    const filters = pileData(actor).overrideItemFilters;   // false: Item Piles' own "not overridden"
    const subtypes = valuesOn(Array.isArray(filters) ? filters : [], "system.type.value");
    for (const t of valuesOn(DND5E_ITEM_FILTERS, "system.type.value")) subtypes.delete(t);
    if (subtypes.size) {
      warnings.push(`"${actor.name}": Item Piles refusal by item subtype not carried over: ${[...subtypes].join(", ")}`);
    }
  }

  if (nativeShop) {
    if (actor.flags?.["item-piles"]?.data?.enabled !== false) update["flags.item-piles.data.enabled"] = false;
    if (actor.prototypeToken?.flags?.["item-piles"]?.data?.enabled !== false) {
      update["prototypeToken.flags.item-piles.data.enabled"] = false;
    }

    const sheetClass = planSheetClass(actor);
    if (sheetClass) update["flags.core.sheetClass"] = sheetClass;

    const ownership = planOwnership(actor, hasTokenOnScene);
    if (ownership !== null) update["ownership.default"] = ownership;
  }

  return { update: Object.keys(update).length ? update : null, shopError, warnings };
}

/**
 * The `Actor#updateEmbeddedDocuments("Item", …)` payload for `actor`'s stock:
 * one entry per item still missing `flags.merchant-presets.stock`. An item
 * that already has one is left alone — once derived, our schema is the
 * source of truth, not Item Piles. The shopkeeper's own kit is never stock
 * (`isGearItem`) and is skipped, same as everywhere else in the runtime.
 *
 * An item whose derived stock is still invalid after `repairStock` is left
 * out of `updates` — not written, not stamped — rather than block every
 * other item on the same shop; `needsMigration`'s `itemsNeedStock` keeps
 * asking for it on every later pass, so it's retried, not silently given up
 * on. `errors` names each one, for the caller to log.
 *
 * @param {object} actor
 * @returns {{updates: object[], errors: {item: string, errors: string[]}[]}}
 */
export function planItemUpdates(actor) {
  if (!isMigratable(actor)) return { updates: [], errors: [] };
  const updates = [];
  const errors = [];
  for (const item of actor.items ?? []) {
    if (isGearItem(item) || item.flags?.["merchant-presets"]?.stock) continue;
    const repaired = repairStock(deriveStock(sourceFlagsOf(actor, item)));
    if (!repaired.ok) { errors.push({ item: item.name, errors: repaired.errors }); continue; }
    updates.push({ _id: item._id, "flags.merchant-presets.stock": repaired.stock });
  }
  return { updates, errors };
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

/**
 * The `Scene#updateEmbeddedDocuments("Token", …)` payload for one shop's
 * tokens on one scene — `planTokenDisable` over each, dropping the `null`s —
 * or `[]` while `nativeShop` is off. Token disabling is entirely the
 * cut-over half: while Item Piles is still running the shop, its tokens must
 * keep the flags it reads.
 *
 * @param {object[]} tokens        Token data for one actor on one scene.
 * @param {boolean} [nativeShop]   Defaults to `NATIVE_SHOP`.
 * @returns {object[]}
 */
export function planTokenUpdates(tokens, nativeShop = NATIVE_SHOP) {
  if (!nativeShop) return [];
  return tokens.map(planTokenDisable).filter(Boolean);
}
