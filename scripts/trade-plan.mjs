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
 *   trade" idea, from the other side).
 */

import { effectiveRates, itemPriceCp, pay } from "./pricing.mjs";
import { shopFrom, stockFrom } from "./schema.mjs";

const MODULE = "merchant-presets";

/** Never traded, buy or sell, by any shop: not physical inventory (schema.mjs's header). */
const FIXED_EXCLUDED_TYPES = ["background", "class", "facility", "feat", "race", "spell", "subclass"];

const idOf = doc => doc._id ?? doc.id;
const findById = (docs, id) => docs.find(d => idOf(d) === id);

const stockOf = item => stockFrom(item.flags?.[MODULE]?.stock ?? {});
const shopOf = actor => shopFrom(actor.flags?.[MODULE]?.shop ?? {});
const kindOf = item => item.flags?.[MODULE]?.kind ?? null;
const isGear = item => kindOf(item) === "gear";
const sourceOf = item => item._stats?.compendiumSource ?? item.flags?.core?.sourceId ?? null;

/** Not a real stock line a player can see: shopkeeper gear, or the GM has hidden or delisted it. */
function isVisible(item, stock) {
  return !isGear(item) && !stock.hidden && !stock.notForSale;
}

/** Whether `shop` deals in `item` at all — the fixed exclusions, then its own `wontBuy`. */
function dealtIn(item, shop) {
  if (FIXED_EXCLUDED_TYPES.includes(item.type)) return false;
  if (item.system?.type?.value === "natural") return false;
  if (isGear(item)) return false;
  if (shop.wontBuy.types.includes(item.type)) return false;
  const kind = kindOf(item);
  return !(kind && shop.wontBuy.kinds.includes(kind));
}

/** dnd5e stacks only a dropped consumable onto an existing one sharing source, name and container. */
function stacksOnto(existing, incoming) {
  const source = sourceOf(incoming);
  return incoming.type === "consumable" && source != null
    && sourceOf(existing) === source
    && existing.name === incoming.name
    && (existing.system?.container ?? null) === (incoming.system?.container ?? null);
}

/**
 * The shop's own current stock line for `item`, if it has one — by source when `item` carries
 * one (the same signal `stacksOnto` uses), else by name. Gear is never a match: it isn't stock.
 * This is what a sale's `noBuyback`/`service`/bundle/category read, since the item being sold no
 * longer carries its own stock flags (see `copyOf`).
 */
function matchingStockLine(item, shopItems) {
  const source = sourceOf(item);
  return shopItems.find(i => !isGear(i) && (source != null ? sourceOf(i) === source : i.name === item.name));
}

/** A purse so large `pricing.pay` never refuses it: stands in for "this side's coin is infinite". */
function bottomlessTill(currencies) {
  return Object.fromEntries(Object.keys(currencies).map(d => [d, Number.MAX_SAFE_INTEGER]));
}

/** `item`'s price for one of the `quantity` being traded, at `rate`, floored once for the lot. */
function lineTotalCp(item, rate, bundle, quantity, currencies) {
  return itemPriceCp(item.system.price, rate, bundle / quantity, currencies);
}

/**
 * A copy of `item` fit to land on a new actor: `system.container` dropped, at `quantity`, and
 * with `flags.merchant-presets.stock` and `.drawn` stripped — shelf metadata (hidden, infinite,
 * ...) has no business following an item into a pack or another shop, and a drawn item (#105's
 * restock tag) landing anywhere else would otherwise be deleted by that shop's next restock, not
 * the one that actually drew it. The item then reads as `STOCK_DEFAULTS` until something (a GM,
 * or landing back on a shop with a matching line) says otherwise. `kind` and the behaviour flags
 * (nutrition/actor/spell) are untouched — the runtime still needs those.
 */
function copyOf(item, quantity) {
  const base = structuredClone(item);
  delete base._id;
  base.system = { ...base.system, container: null, quantity };
  if (base.flags?.[MODULE]) {
    base.flags[MODULE] = { ...base.flags[MODULE] };
    delete base.flags[MODULE].stock;
    delete base.flags[MODULE].drawn;
  }
  return base;
}

/**
 * Where a basket's items land on one destination actor (plain data, read but never mutated):
 * stacked onto an identical item already there, or created fresh — one call per line, in order,
 * so a later line can stack onto what an earlier one in the same basket just created. Containers
 * always create, one document per unit, per the quantity-1-each invariant.
 *
 * @param {object[]} existingItems  the destination actor's current items
 * @returns {{land(item: object, quantity: number): void, result(): {itemUpdates: object[], itemCreates: object[]}}}
 */
function lander(existingItems) {
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
      const existing = existingItems.find(d => stacksOnto(d, item));
      if (existing) {
        const id = idOf(existing);
        updateQuantities.set(id, (updateQuantities.get(id) ?? existing.system?.quantity ?? 0) + quantity);
        return;
      }
      pendingCreates.push(copyOf(item, quantity));
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
 * Whether the buyer's or seller's request line still matches what a fresh look says — the price
 * only, since a quantity mismatch either still works (nothing to flag) or is caught by
 * `out-of-stock`, which is the more useful message.
 */
function staleLines(requested, fresh) {
  return requested.some((line, i) => line.expectedUnitPriceCp != null && line.expectedUnitPriceCp !== fresh[i].unitPriceCp);
}

/**
 * Validates and prices a buy or sell request. Returns `{ok: true, plan}` or `{ok: false, reason,
 * line?}` — `line` is the request line that failed, except for `"stock-changed"`, which returns
 * `lines` instead: a fresh price for every requested line, so the caller can show the whole
 * basket as it now stands.
 *
 * @param {{tradeId: string, kind: "buy"|"sell",
 *   lines: {itemId: string, quantity: number, expectedUnitPriceCp?: number}[]}} request
 * @param {object} context  see the module header
 * @returns {{ok: true, plan: object} | {ok: false, reason: string, line?: object, lines?: object[]}}
 */
export function planTrade(request, context) {
  if (!context.now.isOpen) return { ok: false, reason: "closed" };
  return request.kind === "buy" ? planBuy(request, context) : planSell(request, context);
}

function planBuy(request, context) {
  const { shop, buyer, worldSettings, currencies, deal } = context;
  const shopConfig = shopOf(shop);
  const world = worldSettings.rates;

  const stockRemaining = new Map(shop.items.map(item => [idOf(item), item.system?.quantity ?? 0]));
  const fresh = [];
  const lines = [];
  let totalCp = 0;

  for (const requested of request.lines) {
    const item = findById(shop.items, requested.itemId);
    const stock = item ? stockOf(item) : null;
    if (!item || !isVisible(item, stock)) return { ok: false, reason: "not-visible", line: requested };

    const category = stock.category || null;
    const { sellsAt } = effectiveRates(world, shopConfig.terms, category, deal);
    const unitPriceCp = lineTotalCp(item, sellsAt.rate, stock.bundle, requested.quantity, currencies);
    fresh.push({ itemId: requested.itemId, quantity: requested.quantity, unitPriceCp, layer: sellsAt.layer });

    const infinite = stock.service || (stock.infinite ?? worldSettings.infiniteStock);
    const available = stockRemaining.get(requested.itemId) ?? 0;
    if (!infinite && available < requested.quantity) return { ok: false, reason: "out-of-stock", line: requested };
    if (!infinite) stockRemaining.set(requested.itemId, available - requested.quantity);

    totalCp += unitPriceCp;
    lines.push({ item, stock, quantity: requested.quantity, unitPriceCp, category, layer: sellsAt.layer, infinite });
  }

  if (staleLines(request.lines, fresh)) return { ok: false, reason: "stock-changed", lines: fresh };

  const shopPurse = worldSettings.infinitePurse ? bottomlessTill(currencies) : shop.system.currency;
  const payment = pay(buyer.system.currency, totalCp, shopPurse, currencies);
  if (!payment.ok) return { ok: false, reason: payment.reason === "purse" ? "cant-afford" : "till-short" };

  const buyerLander = lander(buyer.items);
  const shopRemaining = new Map();   // real stock item id -> its new quantity, accumulated across lines

  for (const line of lines) {
    if (!line.stock.service) buyerLander.land(line.item, line.quantity);
    if (line.infinite) continue;
    const id = idOf(line.item);
    const current = shopRemaining.get(id) ?? line.item.system?.quantity ?? 0;
    shopRemaining.set(id, current - line.quantity);
  }
  const shopItemUpdates = [];
  const shopItemDeletes = [];
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
  const shopConfig = shopOf(shop);
  const world = worldSettings.rates;

  const fresh = [];
  const lines = [];
  let totalCp = 0;

  for (const requested of request.lines) {
    const item = findById(buyer.items, requested.itemId);
    if (!item) return { ok: false, reason: "not-found", line: requested };
    if (!dealtIn(item, shopConfig)) return { ok: false, reason: "wont-buy", line: requested };

    // The item being sold no longer carries its own stock flags once bought (see `copyOf`), so
    // noBuyback/service/bundle/category come from a matching line on the shop's own shelf, if it
    // has one — otherwise this is unfamiliar goods to this shop, and STOCK_DEFAULTS apply.
    const stock = stockOf(matchingStockLine(item, shop.items) ?? {});
    if (stock.noBuyback) return { ok: false, reason: "no-buyback", line: requested };
    if (item.system?.identified === false) return { ok: false, reason: "unidentified", line: requested };
    if (stock.service) return { ok: false, reason: "service", line: requested };

    const owned = item.system?.quantity ?? 0;
    if (owned < requested.quantity) return { ok: false, reason: "out-of-stock", line: requested };

    const category = stock.category || null;
    const { buysAt } = effectiveRates(world, shopConfig.terms, category, deal);
    const unitPriceCp = lineTotalCp(item, buysAt.rate, stock.bundle, requested.quantity, currencies);
    fresh.push({ itemId: requested.itemId, quantity: requested.quantity, unitPriceCp, layer: buysAt.layer });

    totalCp += unitPriceCp;
    lines.push({ item, stock, quantity: requested.quantity, unitPriceCp, category, layer: buysAt.layer, owned });
  }

  if (staleLines(request.lines, fresh)) return { ok: false, reason: "stock-changed", lines: fresh };

  const shopPurse = worldSettings.infinitePurse ? bottomlessTill(currencies) : shop.system.currency;
  const payment = pay(shopPurse, totalCp, buyer.system.currency, currencies);
  if (!payment.ok) return { ok: false, reason: "till-short" };

  const shopLander = lander(shop.items);
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
    itemId: idOf(l.item), item: l.item, quantity: l.quantity, unitPriceCp: l.unitPriceCp, category: l.category, layer: l.layer
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
      lines: hookLines.map(l => ({ icon: l.item.img, label: l.item.name, quantity: l.quantity, lineTotalCp: l.unitPriceCp * l.quantity })),
      totalCp,
      direction: kind === "buy" ? "Paid" : "Received",
      footnote: { changeCp: payment.changeCp, exact: payment.changeCp === 0 }
    }
  };
}
