/**
 * The pure planning half of a trade (#102): validate a buy or sell request
 * against plain snapshot data and, if it holds up, the minimal writes to
 * carry it out. No Foundry globals — `tools/trade-plan.test.mjs` runs this
 * under plain Node. The runtime half (the `CONFIG.queries` handler, GM-tab
 * election, serialising trades, the hook, chat) is a later step (#102's
 * spike findings, spike/FINDINGS.md) that calls `planTrade` and carries out
 * the plan it returns; none of that lives here.
 *
 * `context` carries everything Foundry would otherwise supply:
 * - `shop`: the merchant actor's plain data (`items`, `system.currency`,
 *   `flags.merchant-presets.shop`, and each item's own
 *   `flags.merchant-presets.stock`).
 * - `buyer`: the trading character's plain data, same shape minus the shop
 *   config. #103: the GM can choose any actor, so this is whichever one the
 *   caller resolved from the request, not assumed to be the querying user's.
 * - `worldSettings`: `{ rates: {sellsAt, buysAt} }` (Configure Settings
 *   world defaults, #110), `infiniteStock` (the world's stock-mode default,
 *   for a stock line whose own `infinite` is null) and `infinitePurse` (the
 *   existing "merchant coin: infinite" world setting).
 * - `currencies`: `CONFIG.DND5E.currencies`, passed to pricing.mjs untouched.
 * - `deal`: the buyer's deal at this shop, or null (#111; storage isn't
 *   designed here — pricing.mjs's `{buy?, sell?}` shape is all this module
 *   assumes).
 * - `now`: `{ isOpen }`. The runtime computes this from the shop's hours and
 *   the world clock; this module only ever sees the boolean.
 * - `newId`: `() => string`, a fresh Foundry-style id. Only called, and only
 *   needed, when a bought container turns out to hold something (see "kit
 *   contents" below) — its contents need a real id to point
 *   `system.container` at, ahead of the actual `createEmbeddedDocuments`
 *   call the runtime makes with `keepId: true`. Deterministic in tests; the
 *   runtime passes `foundry.utils.randomID`.
 * - `bundleOf`: `(item: object) => number | undefined`, optional. The last
 *   resolver in a sale's bundle chain (see "bundled quantities") — only
 *   called, and only needed, for a good that never carried a bundle flag at
 *   all: starting gear from a class kit, say, never bought from any shop.
 *   The runtime resolves it from `item._stats.compendiumSource`: the source
 *   document's own `system.quantity`, when that's more than 1 and the
 *   source is a dnd5e SRD equipment pack — the same fact `system.quantity:
 *   20, system.price.value: 1` on the SRD's own Arrows means "1gp buys a
 *   bundle of 20" even with no `quantityForPrice`-style flag anywhere.
 *   Undefined (no source, not an SRD pack, or a quantity of 1) falls
 *   through to the chain's plain default of 1, same as if `bundleOf` were
 *   never passed at all.
 *
 * **Decisions, each made once and documented here:**
 *
 * - **"Identical", for stacking:** dnd5e only stacks a dropped `consumable`
 *   onto an existing item with the same source, name and container —
 *   `Actor5e#_onDropStackConsumables` — dnd5e.mjs:66413-66422. Every other
 *   type always creates a new document, even if a duplicate already exists.
 *   `stacksOnto` below matches that exactly. Containers are never
 *   consumables, so they already fall under "always a new document"; the
 *   `quantity`-1-each rule for them is enforced on top, in case that ever
 *   changes upstream.
 * - **Shelf flags don't travel.** `copyOf` strips `flags.merchant-presets.stock`
 *   and `.drawn` from the copy landing on the other side, both directions:
 *   `hidden`/`infinite`/etc. describe a spot on a shelf, not a player's pack,
 *   and a `drawn` item (#105's restock tag, `schedule.mjs`'s `isDrawn`)
 *   carried to another shop would be swept up and deleted by *that* shop's
 *   next reroll, which never drew it. `system.container` is dropped too
 *   (#89). `kind` and the behaviour flags (`nutrition`/`actor`/`spell`) are
 *   untouched — the runtime still needs those, on either side. An item that
 *   lands on a shop this way reads as `STOCK_DEFAULTS` until a GM says
 *   otherwise, or it matches an existing line (see `matchingStockLine`).
 * - **A sold item lands on the shop**, stacked the same way a bought item
 *   lands on the buyer. 1.x did this too (see the animal-deed comment at
 *   `merchant-presets.mjs:890-899`, which only makes sense if a sold item
 *   becomes "the merchant's entry"); this module keeps it rather than
 *   silently dropping sold goods from the world.
 * - **`keepZeroQuantity`** (1.x set it `true` on every preset) **is just
 *   `keep`'s default now**: a finite stock line that sells out stays at
 *   `system.quantity: 0` when `keep` is true (the default) and is deleted
 *   when `keep` is false. No separate field; #98's schema already has the
 *   one that matters.
 * - **`wontBuy.kinds`** matches `flags.merchant-presets.kind` — the generator's
 *   own classification (`tools/build_srd.py`'s `GOODS_KINDS`: "component",
 *   "spellcasting", "food-drink", "meal", "lodging", "mount", "vehicle",
 *   "tack", "travel", "gear"), which is coarser than any single dnd5e type or
 *   subtype (a mount is an actor-linked `loot` item, a meal is a
 *   `consumable`) and is what a shop's own generated `wontBuy.kinds` is
 *   already built from (`refuse_kinds`, `build_srd.py:533-542`). It's read on
 *   the item being sold, so it works whether or not that item ever came from
 *   this shop's stock — an ordinary item with no `kind` flag at all never
 *   matches anything here.
 * - **`noBuyback`, `service`, bundle and category, on a sale, come from a
 *   matching line on the shop's own shelf**, not from the item being sold —
 *   it no longer carries its own stock flags (see "shelf flags don't
 *   travel"). `matchingStockLine` finds one by source (the same signal
 *   `stacksOnto` uses) or, failing that, name. No match: `STOCK_DEFAULTS`,
 *   so ordinary loot this shop has never stocked is sellable, not a service,
 *   priced one at a time, and files under no category — the sensible
 *   defaults either way.
 * - **Bundle pricing for `quantity` units, floored once.** pricing.mjs's
 *   `itemPriceCp` floors a single computation; calling it once per unit and
 *   summing would floor `quantity` times, and a bundle cheap enough to floor
 *   to 0 per unit would then be free in any amount. Passing `bundle /
 *   quantity` as the bundle argument is algebraically the same as pricing
 *   `quantity` units and flooring once — see `lineTotalCp`.
 * - **Prices are never computed for an unidentified item.** The check runs
 *   before any call into pricing.mjs, so a refused line never has a rate or
 *   a price attached to it, matching #102's decision.
 * - **A trade is a basket, priced and paid as one.** Each line is validated
 *   on its own (visibility, stock, what the shop deals in), but "can the
 *   payer afford it" is checked once against the whole basket's total, the
 *   same way `pricing.pay` is meant to be used.
 * - **The shop's "purse" for `pricing.pay` is a synthetic, effectively
 *   bottomless one when `worldSettings.infinitePurse` is set** (the existing
 *   "merchant coin: infinite" setting) — see `bottomlessTill`. Its currency
 *   is left out of the plan's writes either way, since a number that large
 *   is never meant to be persisted.
 * - **Reason codes** beyond the issue's own list: `not-found` (a request
 *   line naming an item that isn't where the request says — a stale or
 *   malformed request, not a real refusal a player should see) and
 *   `out-of-stock` doing double duty for a sale that asks for more of an
 *   item than the seller actually owns (the same "not enough of this to
 *   trade" idea, from the other side); `invalid-request` (the request's own
 *   shape doesn't hold up — see "the request is untrusted" and "bundled
 *   quantities"), `shop-misconfigured` (see "config never throws"),
 *   `unpriced` (see "an unpriceable item"), `container-not-empty` (see "kit
 *   contents"), and `worthless` (see "bundled quantities").
 * - **The request is untrusted client input**, validated before anything
 *   else runs: `tradeId` a non-empty string, `kind` `"buy"` or `"sell"`,
 *   `lines` a non-empty array of at most `MAX_LINES`, each line an `itemId`
 *   string and an integer `quantity` of at least 1. A negative or zero
 *   quantity would otherwise turn into a negative price, stock rising on a
 *   purchase, or a bundle division by zero. Anything that fails is
 *   `"invalid-request"`, with the offending `line` when there is one.
 *   Duplicate `itemId`s across lines are merged into one (their quantities
 *   summed) rather than rejected — kinder to a client that split a basket
 *   oddly, and it also means every later check only ever sees one line per
 *   item, so "sold more than owned" can't slip through by asking for it
 *   across two lines instead of one.
 * - **`bundlePriceCp` and `lineTotalCp` are two different numbers, both
 *   returned.** `bundlePriceCp` is what a row shows as the item's price —
 *   one whole bundle, at the shop's rate (the design's "per 10" tag sits
 *   next to this number, not the line total). `lineTotalCp` is what the
 *   whole line costs at the requested `quantity`, floored once (see "bundle
 *   pricing", above). A request line's `expectedBundlePriceCp` is checked
 *   against the fresh `bundlePriceCp` for `"stock-changed"` — the sticker
 *   price, not the total, so it stays valid across a quantity the player
 *   changes without a fresh price coming from the server. This is the
 *   contract #103's client code should follow.
 * - **Config never throws.** `schema.mjs`'s `shopFrom`/`stockFrom` throw on
 *   data that doesn't validate, which is right for code writing that data —
 *   but a trade only ever reads it, and must never throw on a shop or item
 *   some other bug already left invalid. `safeShopOf`/`safeStockOf` catch
 *   and turn that into `"shop-misconfigured"` instead.
 * - **On a sale, the shop pays exactly** (`payExact`, added to pricing.mjs
 *   for this): the till is a money-changer both ways (#101), so when it's
 *   the one paying, it breaks its own coins to the cent rather than handing
 *   over a big coin and expecting the seller to make change back. The
 *   seller's purse only ever grows on a sale; `"till-short"` means the
 *   shop's own total came up short, never the player's.
 * - **An unpriceable item** — `system.price` missing or naming a
 *   denomination `currencies` doesn't have — refuses just that line with
 *   `"unpriced"`, caught around the same call that would otherwise throw.
 *   A price of 0 is not this: it's a valid, free item, and keeps trading
 *   normally (`itemPriceCp` never throws for that, only floors to 0).
 * - **Kit contents.** Checked directly in `_source/merchants`: not one of
 *   the 51 shipped merchants' 2,000-odd items has a non-empty
 *   `system.container` — every container on every shelf is empty, which
 *   checks out against #89 (`load_srd` was changed to prefer a good's
 *   standalone SRD copy over one sitting inside a pack precisely so a
 *   shop's copy never points at a container id the shop doesn't also
 *   carry) and `reconcileContainers` (`merchant-presets.mjs:362-379`, which
 *   only ever restores a missing container as an empty clone of an existing
 *   one — it has no contents-handling of its own to restore). A shop's kit
 *   (Explorer's Pack, say) is priced and stocked as a container on its own;
 *   whatever it would notionally hold ships as its own separate stock line
 *   at the SRD's own price for that good, not bundled in or discounted.
 *   Given that, this module still handles contents generically rather than
 *   assuming a shop container is always empty, since nothing stops a GM
 *   nesting an item into one by hand on the actor sheet, and the plan
 *   should still do the right thing: buying a container brings along
 *   whatever (recursively) sits inside it on the shop, at no extra charge —
 *   the container's own price already covers it, so contents are never
 *   priced or validated on their own (`landContainer`/`landContentsOf`).
 *   Selling one is refused as `"container-not-empty"` unless it (and, down
 *   the chain, anything inside anything inside it) is empty first —
 *   `contentsOf` — so a sale can never orphan a `system.container` pointing
 *   at an id the shop never receives (repeating #89) or the seller silently
 *   loses items the request never named. The same reasoning is why a bought
 *   container's contents are removed from the shop outright, never
 *   decremented: they don't have an independent price to account for
 *   separately, and a `keep: false` container line being deleted once fully
 *   sold can't orphan contents that were already stripped from the shop in
 *   that same purchase.
 *
 *   Two more `isVisible` needed, once a container's contents could actually
 *   move: an item already inside a shop container is never individually
 *   buyable (it's `"not-visible"`, same as gear) — the container is what's
 *   for sale, buying its contents separately would hand them out twice
 *   over, once loose and once inside the container. And a container whose
 *   contents, recursively, include anything the shop wouldn't otherwise
 *   hand over (shopkeeper gear, a hidden or delisted line) is itself
 *   `"not-visible"`: there's no request line for "the bag, minus what's not
 *   for sale", so the whole line refuses rather than quietly leaving
 *   something out (`hasUngivableContents`).
 * - **The fixed exclusions apply on a buy too.** `isVisible` used to only
 *   check for shopkeeper gear, so a natural weapon or one of the
 *   never-tradeable types (background, class, ...) could be bought if a GM
 *   ever left one sitting in a shop's items. `isFixedExcluded` is now
 *   shared between `isVisible` and `dealtIn`, so both directions refuse the
 *   same things.
 * - **Bundled quantities.** Item Piles only ever sold `quantityForPrice` in
 *   whole bundles, and this keeps that: a buy quantity that isn't a whole
 *   multiple of the stock line's `bundle` is `"invalid-request"` (the
 *   quantity stepper is meant to step by the bundle size, so this is a
 *   malformed request, not a normal refusal) — which also closes off buying
 *   a single unit of a cheap bundle for a price that floors to 0. A sale
 *   has no shelf to bundle by, so any quantity is allowed and the price
 *   floors same as ever; but if that floor lands on 0 for an item that
 *   isn't actually free (`item.system.price.value` above 0), that's not a
 *   trade, so it's refused `"worthless"` rather than paid for nothing.
 *   A sale's own bundle, in order: the matched shop line's own `bundle`;
 *   failing that, the item's carried-over `flags.merchant-presets.bundle`
 *   (see `copyOf`'s "Kept: bundle"); failing that, `context.bundleOf(item)`
 *   — for a good that was never bought from any shop at all, so never had
 *   either (starting gear from a class kit is the common case: dnd5e's own
 *   SRD prices a stack of 20 arrows at 1gp with no bundle flag of ours
 *   anywhere, and selling them back with no matching shop line would
 *   otherwise price each of the 20 individually, 20x over); failing that, 1.
 */

import { effectiveRates, itemPriceCp, pay, payExact } from "./pricing.mjs";
import { shopFrom, stockFrom } from "./schema.mjs";

const MODULE = "merchant-presets";

/** Never traded, buy or sell, by any shop: not physical inventory (schema.mjs's header). */
const FIXED_EXCLUDED_TYPES = ["background", "class", "facility", "feat", "race", "spell", "subclass"];

const VALID_KINDS = ["buy", "sell"];
const MAX_LINES = 100;

const idOf = doc => doc._id ?? doc.id;
const findById = (docs, id) => docs.find(d => idOf(d) === id);

const stockOf = item => stockFrom(item.flags?.[MODULE]?.stock ?? {});
const shopOf = actor => shopFrom(actor.flags?.[MODULE]?.shop ?? {});
const kindOf = item => item.flags?.[MODULE]?.kind ?? null;
const isGear = item => kindOf(item) === "gear";
const sourceOf = item => item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? null;

/** `shopOf`/`stockOf`, but never throwing: a trade only reads config, and must survive data some other bug already left invalid. */
const safeShopOf = actor => { try { return shopOf(actor); } catch { return null; } };
const safeStockOf = item => { try { return stockOf(item); } catch { return null; } };

/** Never traded, either direction, by any shop — the fixed exclusions shared by both `isVisible` and `dealtIn`. */
function isFixedExcluded(item) {
  return FIXED_EXCLUDED_TYPES.includes(item.type) || item.system?.type?.value === "natural" || isGear(item);
}

/** Whether a stock line would refuse to hand `item` over at all, on its own: shopkeeper gear, hidden, or delisted. */
function isShelfHidden(item, stock) {
  return isFixedExcluded(item) || stock.hidden || stock.notForSale;
}

/**
 * Not a real stock line a player can pick directly: shopkeeper gear, one of the fixed exclusions
 * (background/class/... and natural weapons — buy and sell refuse the same things), the GM has
 * hidden or delisted it, or it's sitting inside a container already on the shelf (its container
 * is the thing to buy; buying it separately would hand it out twice over — see `landContainer`).
 */
function isVisible(item, stock) {
  return !isShelfHidden(item, stock) && (item.system?.container ?? null) === null;
}

/**
 * Whether `container`'s own contents, recursively, include anything `shop` wouldn't otherwise
 * hand over on its own: shopkeeper gear or a hidden/delisted line. A container holding one is
 * refused whole (`planBuy`) rather than handing over only the rest — there's no request line
 * asking for "everything in the bag except the smith's own dagger".
 */
function hasUngivableContents(containerId, shopItems) {
  return shopItems.some(i => (i.system?.container ?? null) === containerId
    && (isShelfHidden(i, safeStockOf(i) ?? stockFrom({})) || hasUngivableContents(idOf(i), shopItems)));
}

/** Whether `shop` deals in `item` at all — the fixed exclusions, then its own `wontBuy`. */
function dealtIn(item, shop) {
  if (isFixedExcluded(item)) return false;
  if (shop.wontBuy.types.includes(item.type)) return false;
  const kind = kindOf(item);
  return !(kind && shop.wontBuy.kinds.includes(kind));
}

/**
 * dnd5e stacks only a dropped consumable onto an existing, top-level one sharing source and
 * name. `incoming` is compared as it will land — top-level, `system.container` already dropped
 * by `copyOf` — never against whatever container it happened to start in (inside a quiver, say);
 * an item that starts in a container never stacks onto one that didn't, or vice versa.
 */
function stacksOnto(existing, incoming) {
  const source = sourceOf(incoming);
  return incoming.type === "consumable" && source != null
    && sourceOf(existing) === source
    && existing.name === incoming.name
    && (existing.system?.container ?? null) === null;
}

/**
 * The shop's own current stock line for `item`, if it has one — by source (the same signal
 * `stacksOnto` uses) when that finds a match, falling back to name either way: when `item`
 * carries no source at all, or when it does but nothing on the shelf shares it. Gear is never a
 * match: it isn't stock. This is what a sale's `noBuyback`/`service`/category read (bundle is
 * its own fallback — see "kept: bundle", below), since the item being sold no longer carries its
 * own stock flags (see `copyOf`).
 */
function matchingStockLine(item, shopItems) {
  const source = sourceOf(item);
  const bySource = source != null ? shopItems.find(i => !isGear(i) && sourceOf(i) === source) : null;
  return bySource ?? shopItems.find(i => !isGear(i) && i.name === item.name);
}

/** A purse so large `pricing.pay` never refuses it: stands in for "this side's coin is infinite". */
function bottomlessTill(currencies) {
  return Object.fromEntries(Object.keys(currencies).map(d => [d, Number.MAX_SAFE_INTEGER]));
}

/**
 * `item`'s sticker price at `rate` — what a row shows, and what the "per 10" tag sits beside.
 * `item.system.price` already prices one whole bundle (dnd5e's own quantityForPrice contract:
 * 1gp *is* the cost of the 20 arrows it buys), so this only ever applies the rate, never divides
 * by the bundle size — that division is `lineTotalCp`'s job, for a specific `quantity` traded.
 */
function bundlePriceCp(item, rate, currencies) {
  return itemPriceCp(item.system.price, rate, 1, currencies);
}

/** `item`'s price for one of the `quantity` being traded, at `rate`, floored once for the lot. */
function lineTotalCp(item, rate, bundle, quantity, currencies) {
  return itemPriceCp(item.system.price, rate, bundle / quantity, currencies);
}

/**
 * A copy of `item` fit to land on a new actor: at `quantity`, `system.container` set to
 * `containerId` (top-level, `null`, unless the copy is landing *inside* a container a container
 * purchase just created — see `landContainer`), and with `flags.merchant-presets.stock` and
 * `.drawn` stripped — shelf metadata (hidden, infinite, ...) has no business following an item
 * into a pack or another shop, and a drawn item (#105's restock tag) landing anywhere else would
 * otherwise be deleted by that shop's next restock, not the one that actually drew it. The item
 * then reads as `STOCK_DEFAULTS` until something (a GM, or landing back on a shop with a matching
 * line) says otherwise. `kind` and the behaviour flags (nutrition/actor/spell) are untouched —
 * the runtime still needs those.
 *
 * **Kept: `bundle`.** Unlike the rest of `stock`, a bundle size is a property of the good
 * itself (20 arrows *are* a bundle of 20, wherever they end up), not the shelf they came from —
 * so it survives as its own flag, `flags.merchant-presets.bundle`, when it's more than 1. A sale
 * with no matching shop line reads it from here instead of assuming a bundle of 1 (which priced
 * 20 arrows as 20 individual purchases at the bundle's own rate — 20x too much).
 */
function copyOf(item, quantity, containerId = null) {
  const base = structuredClone(item);
  delete base._id;
  base.system = { ...base.system, container: containerId, quantity };
  const bundle = item.flags?.[MODULE]?.stock?.bundle;
  if (base.flags?.[MODULE]) {
    base.flags[MODULE] = { ...base.flags[MODULE] };
    delete base.flags[MODULE].stock;
    delete base.flags[MODULE].drawn;
  }
  if (bundle > 1) base.flags = { ...base.flags, [MODULE]: { ...base.flags?.[MODULE], bundle } };
  return base;
}

/**
 * Where a basket's items land on one destination actor (plain data, read but never mutated):
 * stacked onto an identical item already there, or created fresh — one call per line, in order,
 * so a later line can stack onto what an earlier one in the same basket just created. Containers
 * always create, one document per unit, per the quantity-1-each invariant.
 *
 * @param {object[]} existingItems  the destination actor's current items
 * @param {(item: object) => boolean} [isValidTarget]  whether an existing item is even eligible
 *   to stack onto — every item, by default (landing on a buyer). Landing on a shop passes a
 *   stricter check: only a visible stock line, never shopkeeper gear or a hidden/delisted one,
 *   so a sold item can't disappear into the merchant's own kit.
 * @returns {{land(item: object, quantity: number): void, landExact(itemData: object): void,
 *   result(): {itemUpdates: object[], itemCreates: object[]}}}
 */
function lander(existingItems, isValidTarget = () => true) {
  const updateQuantities = new Map();   // real item id -> its new total quantity
  const pendingCreates = [];            // this basket's own new items, not yet given a real id

  return {
    land(item, quantity) {
      if (item.type === "container") {
        for (let i = 0; i < quantity; i++) pendingCreates.push(copyOf(item, 1));
        return;
      }
      const pending = pendingCreates.find(d => stacksOnto(d, item));
      if (pending) { pending.system.quantity += quantity; return; }
      const existing = existingItems.find(d => isValidTarget(d) && stacksOnto(d, item));
      if (existing) {
        const id = idOf(existing);
        updateQuantities.set(id, (updateQuantities.get(id) ?? existing.system?.quantity ?? 0) + quantity);
        return;
      }
      pendingCreates.push(copyOf(item, quantity));
    },
    // A create that never attempts to stack: a container's contents (see `landContainer`), which
    // dnd5e itself never merges into an unrelated top-level stack just because the names match.
    landExact(itemData) {
      pendingCreates.push(itemData);
    },
    result() {
      return {
        itemUpdates: [...updateQuantities].map(([_id, quantity]) => ({ _id, "system.quantity": quantity })),
        itemCreates: pendingCreates
      };
    }
  };
}

/**
 * Lands one instance of `container` (already confirmed a container type) on `targetLander`, with
 * whatever of `shopItems` is still (recursively) inside it — a nested container's own contents
 * come along too. Each landed container gets a fresh id from `newId`, since its contents need a
 * real one to point `system.container` at; a container with nothing inside keeps the ordinary
 * auto-assigned id (`landExact` doesn't need one to work). Every transferred item's original id
 * is added to `removedIds`, so a second instance in the same line (only possible for an infinite
 * container) doesn't claim contents an earlier instance already took, and so the caller knows
 * what to remove from the shop — the container's price already covers them; they aren't priced
 * or charged separately.
 */
function landContainer(container, shopItems, removedIds, newId, targetLander) {
  const hasContents = shopItems.some(i => !removedIds.has(idOf(i)) && (i.system?.container ?? null) === idOf(container));
  const copy = copyOf(container, 1);
  if (hasContents) copy._id = newId();
  targetLander.landExact(copy);
  if (hasContents) landContentsOf(idOf(container), copy._id, shopItems, removedIds, newId, targetLander);
}

/**
 * The recursive half of `landContainer`: `sourceId`'s own contents, landing inside `destId`.
 * Skips anything the shop wouldn't hand over on its own (gear, hidden, delisted) — belt and
 * braces: `planBuy` already refuses the whole container first if any of its contents,
 * recursively, would hit this (`hasUngivableContents`), so this should never actually trigger.
 */
function landContentsOf(sourceId, destId, shopItems, removedIds, newId, targetLander) {
  for (const content of shopItems) {
    if (removedIds.has(idOf(content)) || (content.system?.container ?? null) !== sourceId) continue;
    if (isShelfHidden(content, safeStockOf(content) ?? stockFrom({}))) continue;
    removedIds.add(idOf(content));
    const contentCopy = copyOf(content, content.system?.quantity ?? 1, destId);
    if (content.type === "container") {
      contentCopy._id = newId();
      targetLander.landExact(contentCopy);
      landContentsOf(idOf(content), contentCopy._id, shopItems, removedIds, newId, targetLander);
    } else {
      targetLander.landExact(contentCopy);
    }
  }
}

/** Every item on `buyer`, directly or indirectly, whose `system.container` chain reaches `containerId`. */
function contentsOf(containerId, items) {
  const direct = items.filter(i => (i.system?.container ?? null) === containerId);
  return direct.flatMap(i => [i, ...contentsOf(idOf(i), items)]);
}

/**
 * Whether the buyer's or seller's request line still matches what a fresh look says — the
 * bundle's sticker price only (see the module header): a quantity mismatch either still works
 * (nothing to flag) or is caught by `out-of-stock`, which is the more useful message.
 */
function staleLines(requested, fresh) {
  return requested.some((line, i) => line.expectedBundlePriceCp != null && line.expectedBundlePriceCp !== fresh[i].bundlePriceCp);
}

/**
 * Rejects a request whose own shape can't be trusted — untrusted client input, never thrown on.
 * A bad `tradeId`/`kind`/basket size is a request-level problem (no `line` to blame); a bad
 * `itemId` or `quantity` names the line that broke it.
 */
function validateRequest(request) {
  if (typeof request?.tradeId !== "string" || !request.tradeId) return { ok: false, reason: "invalid-request" };
  if (!VALID_KINDS.includes(request.kind)) return { ok: false, reason: "invalid-request" };
  if (!Array.isArray(request.lines) || request.lines.length === 0 || request.lines.length > MAX_LINES) {
    return { ok: false, reason: "invalid-request" };
  }
  for (const line of request.lines) {
    if (typeof line?.itemId !== "string" || !line.itemId) return { ok: false, reason: "invalid-request", line };
    if (!Number.isInteger(line.quantity) || line.quantity < 1) return { ok: false, reason: "invalid-request", line };
  }
  return { ok: true };
}

/** `request`, with lines naming the same item combined into one (quantities summed). */
function mergeLines(request) {
  const merged = new Map();
  for (const line of request.lines) {
    const existing = merged.get(line.itemId);
    if (existing) existing.quantity += line.quantity;
    else merged.set(line.itemId, { ...line });
  }
  return { ...request, lines: [...merged.values()] };
}

/**
 * Validates and prices a buy or sell request. Returns `{ok: true, plan}` or `{ok: false, reason,
 * line?}` — `line` is the request line that failed, except for `"stock-changed"`, which returns
 * `lines` instead: a fresh price for every requested line, so the caller can show the whole
 * basket as it now stands.
 *
 * @param {{tradeId: string, kind: "buy"|"sell",
 *   lines: {itemId: string, quantity: number, expectedBundlePriceCp?: number}[]}} request
 * @param {object} context  see the module header
 * @returns {{ok: true, plan: object} | {ok: false, reason: string, line?: object, lines?: object[]}}
 */
export function planTrade(request, context) {
  if (!context.now.isOpen) return { ok: false, reason: "closed" };
  const validity = validateRequest(request);
  if (!validity.ok) return validity;
  const merged = mergeLines(request);
  return merged.kind === "buy" ? planBuy(merged, context) : planSell(merged, context);
}

function planBuy(request, context) {
  const { shop, buyer, worldSettings, currencies, deal } = context;
  const shopConfig = safeShopOf(shop);
  if (!shopConfig) return { ok: false, reason: "shop-misconfigured" };
  const world = worldSettings.rates;

  const stockRemaining = new Map(shop.items.map(item => [idOf(item), item.system?.quantity ?? 0]));
  const fresh = [];
  const lines = [];
  let totalCp = 0;

  for (const requested of request.lines) {
    const item = findById(shop.items, requested.itemId);
    if (!item) return { ok: false, reason: "not-visible", line: requested };
    const stock = safeStockOf(item);
    if (!stock) return { ok: false, reason: "shop-misconfigured", line: requested };
    if (!isVisible(item, stock)) return { ok: false, reason: "not-visible", line: requested };
    // A container holding something the shop wouldn't hand over on its own (gear, hidden,
    // delisted) can't be bought at all — there's no way to ask for "everything but that".
    if (item.type === "container" && hasUngivableContents(idOf(item), shop.items)) {
      return { ok: false, reason: "not-visible", line: requested };
    }
    // Sold in whole bundles only, matching Item Piles' own quantityForPrice contract; the UI
    // steps a bundled good's quantity by its bundle size, so this is a malformed request, not a
    // normal refusal a player should see.
    if (requested.quantity % stock.bundle !== 0) return { ok: false, reason: "invalid-request", line: requested };

    const category = stock.category || null;
    const { sellsAt } = effectiveRates(world, shopConfig.terms, category, deal);
    let bundleCp, totalLineCp;
    try {
      bundleCp = bundlePriceCp(item, sellsAt.rate, currencies);
      totalLineCp = lineTotalCp(item, sellsAt.rate, stock.bundle, requested.quantity, currencies);
    } catch {
      return { ok: false, reason: "unpriced", line: requested };
    }
    fresh.push({ itemId: requested.itemId, quantity: requested.quantity, bundlePriceCp: bundleCp, lineTotalCp: totalLineCp, layer: sellsAt.layer });

    const infinite = stock.service || (stock.infinite ?? worldSettings.infiniteStock);
    const available = stockRemaining.get(requested.itemId) ?? 0;
    if (!infinite && available < requested.quantity) return { ok: false, reason: "out-of-stock", line: requested };
    if (!infinite) stockRemaining.set(requested.itemId, available - requested.quantity);

    totalCp += totalLineCp;
    lines.push({ item, stock, quantity: requested.quantity, bundlePriceCp: bundleCp, lineTotalCp: totalLineCp, category, layer: sellsAt.layer, infinite });
  }

  if (staleLines(request.lines, fresh)) return { ok: false, reason: "stock-changed", lines: fresh };

  const shopPurse = worldSettings.infinitePurse ? bottomlessTill(currencies) : shop.system.currency;
  const payment = pay(buyer.system.currency, totalCp, shopPurse, currencies);
  if (!payment.ok) return { ok: false, reason: payment.reason === "purse" ? "cant-afford" : "till-short" };

  const buyerLander = lander(buyer.items);
  const shopRemaining = new Map();   // real stock item id -> its new quantity, accumulated across lines
  const shopContentsRemoved = new Set();   // ids of shop items given away, free, as a bought container's contents

  for (const line of lines) {
    if (!line.stock.service) {
      if (line.item.type === "container") {
        for (let i = 0; i < line.quantity; i++) {
          landContainer(line.item, shop.items, shopContentsRemoved, context.newId, buyerLander);
        }
      } else {
        buyerLander.land(line.item, line.quantity);
      }
    }
    if (line.infinite) continue;
    const id = idOf(line.item);
    const current = shopRemaining.get(id) ?? line.item.system?.quantity ?? 0;
    shopRemaining.set(id, current - line.quantity);
  }
  const shopItemUpdates = [];
  const shopItemDeletes = [...shopContentsRemoved];
  for (const [id, remaining] of shopRemaining) {
    const keep = lines.find(l => idOf(l.item) === id).stock.keep;
    if (remaining > 0 || keep) shopItemUpdates.push({ _id: id, "system.quantity": Math.max(remaining, 0) });
    else shopItemDeletes.push(id);
  }

  const { itemUpdates: buyerItemUpdates, itemCreates: buyerItemCreates } = buyerLander.result();
  const updates = [
    { actorId: idOf(buyer), currency: payment.purse, itemUpdates: buyerItemUpdates, itemCreates: buyerItemCreates, itemDeletes: [] },
    { actorId: idOf(shop), currency: worldSettings.infinitePurse ? undefined : payment.till, itemUpdates: shopItemUpdates, itemCreates: [], itemDeletes: shopItemDeletes }
  ];

  return { ok: true, plan: buildPlan(request, "buy", shop, buyer, lines, totalCp, payment, updates) };
}

function planSell(request, context) {
  const { shop, buyer, worldSettings, currencies, deal } = context;
  const shopConfig = safeShopOf(shop);
  if (!shopConfig) return { ok: false, reason: "shop-misconfigured" };
  const world = worldSettings.rates;

  const fresh = [];
  const lines = [];
  let totalCp = 0;

  for (const requested of request.lines) {
    const item = findById(buyer.items, requested.itemId);
    if (!item) return { ok: false, reason: "not-found", line: requested };
    // Selling a container sells only what's in the seller's hands, not what's inside it — an
    // empty one first (checked recursively: contents of contents count too, since any of them
    // being there at all proves this one isn't empty).
    if (item.type === "container" && contentsOf(idOf(item), buyer.items).length) {
      return { ok: false, reason: "container-not-empty", line: requested };
    }
    if (!dealtIn(item, shopConfig)) return { ok: false, reason: "wont-buy", line: requested };

    // The item being sold no longer carries its own stock flags once bought (see `copyOf`), so
    // noBuyback/service/category come from a matching line on the shop's own shelf, if it has
    // one — otherwise this is unfamiliar goods to this shop, and STOCK_DEFAULTS apply.
    const matched = matchingStockLine(item, shop.items);
    const stock = safeStockOf(matched ?? {});
    if (!stock) return { ok: false, reason: "shop-misconfigured", line: requested };
    if (stock.noBuyback) return { ok: false, reason: "no-buyback", line: requested };
    if (item.system?.identified === false) return { ok: false, reason: "unidentified", line: requested };
    if (stock.service) return { ok: false, reason: "service", line: requested };

    // request.lines has already been merged (see mergeLines), so `owned` here is checked once
    // against this line's full combined quantity, not double-counted across duplicate lines.
    const owned = item.system?.quantity ?? 0;
    if (owned < requested.quantity) return { ok: false, reason: "out-of-stock", line: requested };

    // Bundle is the one field kept off the matched line: a matching shop listing's own bundle
    // wins (it's the shop's rate for this good), then the item's own carried-over bundle flag
    // (see copyOf's "Kept: bundle"), then context.bundleOf — for a good that never passed
    // through a shop at all (starting gear, say) and so never had either — rather than silently
    // assuming 1: a bundle of 20 arrows priced as 20 individual purchases would pay 20x too much.
    const bundle = matched ? stock.bundle : (item.flags?.[MODULE]?.bundle ?? context.bundleOf?.(item) ?? 1);
    const category = stock.category || null;
    const { buysAt } = effectiveRates(world, shopConfig.terms, category, deal);
    let bundleCp, totalLineCp;
    try {
      bundleCp = bundlePriceCp(item, buysAt.rate, currencies);
      totalLineCp = lineTotalCp(item, buysAt.rate, bundle, requested.quantity, currencies);
    } catch {
      return { ok: false, reason: "unpriced", line: requested };
    }
    // Unlike a buy, a sell quantity doesn't have to be a whole bundle (the shop is happy to take
    // fewer, at a proportionally floored price) — but flooring all the way to nothing isn't a
    // trade for an item that actually has a price, so refuse rather than pay 0 for something
    // real. A genuinely free item (system.price.value itself 0) is unaffected — that's a real,
    // if uninteresting, 0cp trade, the same as it always was.
    if (totalLineCp === 0 && item.system.price?.value > 0) return { ok: false, reason: "worthless", line: requested };
    fresh.push({ itemId: requested.itemId, quantity: requested.quantity, bundlePriceCp: bundleCp, lineTotalCp: totalLineCp, layer: buysAt.layer });

    totalCp += totalLineCp;
    lines.push({ item, stock, quantity: requested.quantity, bundlePriceCp: bundleCp, lineTotalCp: totalLineCp, category, layer: buysAt.layer, owned });
  }

  if (staleLines(request.lines, fresh)) return { ok: false, reason: "stock-changed", lines: fresh };

  // The shop pays exactly, breaking its own coins (#101's money-changer, applied to the payer
  // this time): the seller never gives change back, so "till-short" only ever means the shop's
  // own total came up short.
  const shopPurse = worldSettings.infinitePurse ? bottomlessTill(currencies) : shop.system.currency;
  const paid = payExact(shopPurse, totalCp, currencies);
  if (!paid.ok) return { ok: false, reason: "till-short" };
  const buyerCurrency = { ...buyer.system.currency };
  for (const [denomination, count] of Object.entries(paid.given)) {
    buyerCurrency[denomination] = (buyerCurrency[denomination] ?? 0) + count;
  }
  const payment = { purse: paid.remaining, till: buyerCurrency, changeCp: 0 };

  // Never stacks onto shopkeeper gear or a hidden/delisted line: a sold item lands on a real,
  // visible stock line or becomes a new one, never disappears into the merchant's own kit.
  const shopLander = lander(shop.items, candidate => isVisible(candidate, safeStockOf(candidate) ?? stockFrom({})));
  const buyerRemaining = new Map();   // real owned item id -> its new quantity, accumulated across lines

  for (const line of lines) {
    shopLander.land(line.item, line.quantity);
    const id = idOf(line.item);
    const current = buyerRemaining.get(id) ?? line.owned;
    buyerRemaining.set(id, current - line.quantity);
  }
  const buyerItemUpdates = [];
  const buyerItemDeletes = [];
  for (const [id, remaining] of buyerRemaining) {
    if (remaining > 0) buyerItemUpdates.push({ _id: id, "system.quantity": remaining });
    else buyerItemDeletes.push(id);
  }

  const { itemUpdates: shopItemUpdates, itemCreates: shopItemCreates } = shopLander.result();
  const updates = [
    { actorId: idOf(buyer), currency: payment.till, itemUpdates: buyerItemUpdates, itemCreates: [], itemDeletes: buyerItemDeletes },
    { actorId: idOf(shop), currency: worldSettings.infinitePurse ? undefined : payment.purse, itemUpdates: shopItemUpdates, itemCreates: shopItemCreates, itemDeletes: [] }
  ];

  return { ok: true, plan: buildPlan(request, "sell", shop, buyer, lines, totalCp, payment, updates) };
}

/** The plan's shared tail: the writes plus the hook payload and chat-card data both directions build the same way. */
function buildPlan(request, kind, shop, buyer, lines, totalCp, payment, updates) {
  const hookLines = lines.map(l => ({
    itemId: idOf(l.item), item: l.item, quantity: l.quantity,
    bundlePriceCp: l.bundlePriceCp, lineTotalCp: l.lineTotalCp, category: l.category, layer: l.layer
  }));
  return {
    tradeId: request.tradeId,
    kind,
    updates,
    hook: { tradeId: request.tradeId, kind, shopId: idOf(shop), buyerId: idOf(buyer), lines: hookLines, totalCp, changeCp: payment.changeCp },
    chatCard: {
      kind,
      shopName: shop.name,
      shopImg: shop.img,
      buyerName: buyer.name,
      lines: hookLines.map(l => ({ icon: l.item.img, label: l.item.name, quantity: l.quantity, lineTotalCp: l.lineTotalCp })),
      totalCp,
      direction: kind === "buy" ? "Paid" : "Received",
      footnote: { changeCp: payment.changeCp, exact: payment.changeCp === 0 }
    }
  };
}
