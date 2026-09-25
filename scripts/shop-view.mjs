import { effectiveRates } from "./pricing.mjs";
import { bundleFor, bundlePriceCp, categoryFor, dealtIn, isVisible } from "./trade-plan.mjs";

/**
 * The shop window's view-model (#103): plain data in, plain data out, so the
 * pricing and formatting choices behind every row, tag and coin string can be
 * tested with plain Node (tools/shop-view.test.mjs) the same way schema.mjs,
 * pricing.mjs and schedule.mjs already are. `scripts/shop-sheet.mjs` is the
 * only caller, and does the Foundry-side work this can't: walking `actor.items`,
 * reading `CONFIG.DND5E.currencies`, and rendering the result into the DOM.
 *
 * Every function here takes plain data — an item's own `toObject()`, a shop's
 * `flags.merchant-presets.shop` already completed via `schema.mjs`'s
 * `shopFrom`, `CONFIG.DND5E.currencies` untouched — and returns plain data
 * back, ready for a Handlebars template.
 *
 * **Design decisions, each made once:**
 *
 * - **The row's own tag compares against the shop's chip, not the world
 *   default.** design/README.md, "Terms of trade": "A shop-wide markup is not
 *   struck on every row. The chip carries it, so the list doesn't turn into a
 *   wall of strikethroughs. Rows are struck only when their price differs
 *   from what the chip says." So `rateTag` takes the row's own effective rate
 *   and the shop's chip rate (world/shop layers only, never category or
 *   deal) and tags only the gap between them.
 * - **`Full value` is its own tag**, not a percentage, whenever a category
 *   layer lands exactly on rate 1 — the Valuables override design calls out
 *   by name. A category layer at any other rate reads as an ordinary markup
 *   or discount against the chip.
 * - **Coin breakdowns are display-only.** `coinBreakdown` turns a cp amount
 *   into "how a price or a purse reads on screen" — largest denomination
 *   first, greedy, floored — which is not `pricing.mjs`'s `pay`/`makeChange`:
 *   those move real, held coins one at a time; this only ever describes a
 *   number. A price the shop has never seen a coin for still displays fine.
 * - **`rateFraction`** turns a handful of common trade ratios into the single
 *   glyph the Sell tab's row tag shows ("½", "¼", …); anything else falls
 *   back to a percentage, which is always exact.
 */

/* -------------------------------------------------------------- titles */

const TIER_SUFFIX = /^(.*) \((Village|Town|City)\)$/;

/**
 * An actor's name, split into the title the header shows and the settlement
 * chip beside it — design/README.md, "The merchant is the NPC": "a trailing
 * size tier such as '(Town)' moves out of the title into its own chip."
 * A name with no such suffix is the title as-is, with no chip from this.
 *
 * @param {string} name
 * @returns {{title: string, tierFromName: string|null}}
 */
export function titleParts(name) {
  const match = TIER_SUFFIX.exec(name ?? "");
  return match ? { title: match[1], tierFromName: match[2] } : { title: name ?? "", tierFromName: null };
}

/* -------------------------------------------------------------- coins */

/** `[denomination, cpValue]` pairs, largest coin first — mirrors pricing.mjs's own ordering. */
function denominationsByValue(currencies) {
  const base = Object.keys(currencies).reduce((b, k) =>
    b === null || currencies[k].conversion > currencies[b].conversion ? k : b, null);
  return Object.keys(currencies)
    .map(denomination => [denomination, currencies[base].conversion / currencies[denomination].conversion])
    .sort((a, b) => b[1] - a[1]);
}

/**
 * `amountCp` broken into coins for display — largest denomination first,
 * floored at each step, the remainder dropped once it can't make a whole coin
 * of the smallest denomination the config defines. Not a real payment (see
 * the module header); a price of 12cp with only gp/sp/cp configured shows as
 * one sp, two cp.
 *
 * @param {number} amountCp
 * @param {Record<string, {conversion: number, icon?: string, label?: string, abbreviation?: string}>} currencies
 * @returns {{denomination: string, count: number, icon: string, label: string, abbreviation: string}[]}
 *   Empty for a non-positive amount — the caller shows "Free" or "0" itself.
 */
export function coinBreakdown(amountCp, currencies) {
  if (!(amountCp > 0)) return [];
  const coins = [];
  let remaining = Math.floor(amountCp);
  for (const [denomination, value] of denominationsByValue(currencies)) {
    const count = Math.floor(remaining / value);
    if (count > 0) {
      const info = currencies[denomination] ?? {};
      coins.push({
        denomination, count,
        icon: info.icon ?? "",
        label: info.label ?? denomination,
        abbreviation: info.abbreviation ?? denomination
      });
      remaining -= count * value;
    }
  }
  return coins;
}

/** A coin's screen-reader text, e.g. "15 gold pieces" — design/README.md, "Coin icons get labels". */
export function coinAriaLabel(coin) {
  return `${coin.count} ${String(coin.label ?? coin.denomination).toLowerCase()}`;
}

const KNOWN_FRACTIONS = [
  [1, "1"], [1 / 2, "½"], [1 / 3, "⅓"], [1 / 4, "¼"], [2 / 3, "⅔"], [3 / 4, "¾"], [1 / 5, "⅕"]
];

/**
 * A trade rate as the short glyph the Sell tab's row tag shows, e.g. "½" for
 * a shop buying at half value. Falls back to a whole percentage — always
 * exact, unlike hunting for a fraction that isn't one of the common ones.
 *
 * @param {number} rate
 * @returns {string}
 */
export function rateFraction(rate) {
  const known = KNOWN_FRACTIONS.find(([value]) => Math.abs(value - rate) < 1e-9);
  return known ? known[1] : `${Math.round(rate * 100)}%`;
}

/* -------------------------------------------------------------- rate tags */

/**
 * @typedef {{kind: "markup"|"discount"|"full"|null, text: string|null}} RateTag
 */

/**
 * The tag a Buy-tab row shows beside its price, comparing the row's own
 * effective rate against the shop's chip (world/shop layers only — never a
 * category or deal, which are what would make a row differ from the chip in
 * the first place). See the module header for why the comparison is against
 * the chip and not the world default.
 *
 * @param {{rate: number, layer: "world"|"shop"|"category"|"deal"|"cap"}} effective  from pricing.mjs's `effectiveRates`
 * @param {number} chipRate  the shop's own sellsAt/buysAt, world or shop layer only
 * @returns {RateTag}
 */
export function rateTag(effective, chipRate) {
  if (effective.layer === "category" && Math.abs(effective.rate - 1) < 1e-9) return { kind: "full", text: null };
  const diff = effective.rate - chipRate;
  if (Math.abs(diff) < 1e-9) return { kind: null, text: null };
  const pct = Math.round(Math.abs(diff / chipRate) * 100);
  return diff > 0 ? { kind: "markup", text: `+${pct}%` } : { kind: "discount", text: `-${pct}%` };
}

/* -------------------------------------------------------------- categories */

/**
 * The Buy tab's category nav: one entry per distinct `row.category`, each
 * with a count, plus a leading "All goods" entry holding every row. Sorted
 * by first appearance, so a shop's own line order decides the nav order.
 *
 * @param {{category: string}[]} rows
 * @returns {{id: string, label: string, count: number}[]}
 */
export function groupCategories(rows) {
  const order = [];
  const counts = new Map();
  for (const row of rows) {
    if (!counts.has(row.category)) { order.push(row.category); counts.set(row.category, 0); }
    counts.set(row.category, counts.get(row.category) + 1);
  }
  return [
    { id: "all", label: "all", count: rows.length },
    ...order.map(category => ({ id: category, label: category, count: counts.get(category) }))
  ];
}

/* -------------------------------------------------------------- basket */

/**
 * The Bill of Sale's own arithmetic: the sum of every line, and the buyer's
 * purse total after paying it (or, on a sale, receiving it). Never negative —
 * a basket that can't be afforded is a trade-state concern (`sealState`), not
 * a display one; the raw shortfall is what "Aria is short by…" reads off.
 *
 * @param {{lineTotalCp: number}[]} lines
 * @param {number} purseCp  the buyer's current purse total, in the finest coin
 * @param {"buy"|"sell"} kind
 * @returns {{sumCp: number, afterCp: number, shortfallCp: number}}
 */
export function basketTotals(lines, purseCp, kind) {
  const sumCp = lines.reduce((total, line) => total + line.lineTotalCp, 0);
  const afterCp = kind === "buy" ? purseCp - sumCp : purseCp + sumCp;
  const shortfallCp = kind === "buy" ? Math.max(0, sumCp - purseCp) : 0;
  return { sumCp, afterCp: Math.max(0, afterCp), shortfallCp };
}

/* -------------------------------------------------------------- stock rules */

/*
 * The window only ever *displays* what the trade engine would allow, so these are trade-plan's
 * own rules, not copies: a drift would show a row the engine then refuses, or hide one it takes.
 */
export { dealtIn };
export { isGear as isGearItem, matchingStockLine, sourceOf } from "./trade-plan.mjs";

/**
 * A stock row the Buy tab can show: what a buy wouldn't refuse as not visible (gear, the fixed
 * exclusions, hidden, delisted, inside a container) or as unidentified.
 */
export const isVisibleStock = (item, stock) => isVisible(item, stock) && item.system?.identified !== false;

/* -------------------------------------------------------------- stock labels */

/**
 * @typedef {{state: "count"|"last"|"soldOut"|"always", text: string|null, count: number|null}} StockLabel
 */

/**
 * The row's stock count label — "N left", "Last one", "Sold out", or "Always" for a service or
 * an infinite line (#98's `stock.infinite`, following the world default when null; #110 hasn't
 * shipped that setting yet, so `worldInfiniteStock` is a placeholder the caller passes in,
 * clearly marked at the call site).
 *
 * @param {{service: boolean, infinite: boolean|null}} stock
 * @param {number} quantity
 * @param {boolean} worldInfiniteStock
 * @returns {StockLabel}
 */
export function stockLabel(stock, quantity, worldInfiniteStock) {
  if (stock.service || (stock.infinite ?? worldInfiniteStock)) return { state: "always", text: null, count: null };
  if (quantity <= 0) return { state: "soldOut", text: null, count: 0 };
  if (quantity === 1) return { state: "last", text: null, count: 1 };
  return { state: "count", text: null, count: quantity };
}

/* -------------------------------------------------------------- rows */

/**
 * @typedef {object} BuyRow
 * @property {string} id
 * @property {string} img
 * @property {string} name
 * @property {string} category
 * @property {StockLabel} stock
 * @property {boolean} isNew  placeholder for #105's restock badge (`flags.merchant-presets.new`);
 *   unset until the restock runtime sets that flag, per #103's scope.
 * @property {number|null} bundlePriceCp  null when the item can't be priced (see `unpriced`)
 * @property {boolean} unpriced  true for a missing price or a denomination `currencies` lacks —
 *   shown as "Worthless" per #98's decision (design/README.md is silent on a *shop* price of
 *   nothing; the issue #103 comment calls this "Worthless")
 * @property {number} bundle
 * @property {RateTag} tag
 */

/**
 * One Buy-tab row's view-model, for a visible stock line. `item` and `stock` are plain data
 * (`item.toObject()`, `stockFrom(item.flags["merchant-presets"].stock ?? {})`); `chipRate` is the
 * shop's own header-chip sellsAt (world/shop layer only — see `rateTag`).
 *
 * @param {object} item
 * @param {object} stock  completed via `schema.mjs`'s `stockFrom`
 * @param {{world: {sellsAt: number, buysAt: number}, shopTerms: object, chipSellsAt: number}} rates
 * @param {object|null} deal
 * @param {Record<string, object>} currencies
 * @param {boolean} worldInfiniteStock
 * @returns {BuyRow}
 */
export function buyRow(item, stock, rates, deal, currencies, worldInfiniteStock) {
  const category = categoryFor(item, stock);
  const { sellsAt } = effectiveRates(rates.world, rates.shopTerms, category, deal);
  let bundleCp = null, unpriced = false;
  try { bundleCp = bundlePriceCp(item, sellsAt.rate, currencies); }
  catch { unpriced = true; }
  return {
    id: item._id ?? item.id,
    img: item.img,
    name: item.name,
    category,
    stock: stockLabel(stock, item.system?.quantity ?? 0, worldInfiniteStock),
    isNew: item.flags?.["merchant-presets"]?.new === true,
    service: stock.service,
    bundlePriceCp: bundleCp,
    unpriced,
    bundle: bundleFor(item, item),
    tag: unpriced ? { kind: null, text: null } : rateTag(sellsAt, rates.chipSellsAt)
  };
}

/**
 * @typedef {object} SellRow
 * @property {string} id
 * @property {string} img
 * @property {string} name
 * @property {boolean} equipped
 * @property {boolean} contained
 * @property {number} owned
 * @property {string|null} refusal  a `MERCHANT_PRESETS.Shop.WontBuy.*` key, or null when the shop buys it
 * @property {number|null} bundlePriceCp  null when refused or unpriced
 * @property {string} ratio  `rateFraction`'s glyph for the row's own buysAt
 */

/**
 * One Sell-tab row for an item the buyer owns. `matchedStock` is the shop's own stock config for
 * a matching shelf line (`stockFrom` on a `matchingStockLine` result), or `stockFrom({})` when the
 * shop has never carried it — #102's own rule for a sale (see `trade-plan.mjs`'s header): bundle,
 * category, `noBuyback` and `service` come from the shop's shelf, never the item being sold.
 *
 * @param {object} item
 * @param {object} shopConfig  completed via `shopFrom`
 * @param {object} matchedStock  completed via `stockFrom`
 * @param {{world: object, shopTerms: object, chipBuysAt: number}} rates
 * @param {object|null} deal
 * @param {Record<string, object>} currencies
 * @returns {SellRow}
 */
export function sellRow(item, shopConfig, matchedStock, rates, deal, currencies) {
  const base = {
    id: item._id ?? item.id,
    img: item.img,
    name: item.name,
    equipped: !!item.system?.equipped,
    contained: item.system?.container != null,
    owned: item.system?.quantity ?? 0
  };
  if (item.system?.identified === false) return { ...base, refusal: "Unidentified", bundlePriceCp: null, ratio: null };
  if (!dealtIn(item, shopConfig)) return { ...base, refusal: "General", bundlePriceCp: null, ratio: null };
  if (matchedStock.noBuyback) return { ...base, refusal: "NoBuyback", bundlePriceCp: null, ratio: null };
  if (matchedStock.service) return { ...base, refusal: "General", bundlePriceCp: null, ratio: null };

  const { buysAt } = effectiveRates(rates.world, rates.shopTerms, categoryFor(item, matchedStock), deal);
  try {
    return { ...base, refusal: null, bundlePriceCp: bundlePriceCp(item, buysAt.rate, currencies), ratio: rateFraction(buysAt.rate) };
  } catch {
    return { ...base, refusal: "Unpriced", bundlePriceCp: null, ratio: null };
  }
}

/* -------------------------------------------------------------- trade states */

/**
 * The seal button's label and whether it's disabled, for every state the
 * Trade States board draws (design/README.md). `state` covers "sealing" (a
 * request is in flight), "sealed" (the last request came back sealed),
 * "closed" (the shop isn't open) and every `planTrade`/#102 refusal reason
 * this window can reach from the client side — `cant-afford`, `no-gm`,
 * `till-short`, `stock-changed` render their own copy; every other reason
 * (not-visible, out-of-stock, wont-buy, …) reads as a plain "Can't trade"
 * fallback, since those are refused per-line before a seal attempt, not
 * states the button itself needs to explain.
 *
 * @param {"idle"|"sealing"|"sealed"|string} state  "idle", "sealing", "sealed", or a `planTrade` refusal reason
 * @param {boolean} hasLines  whether the basket holds anything at all
 * @returns {{labelKey: string, disabled: boolean, icon: string}}
 */
export function sealState(state, hasLines) {
  switch (state) {
    case "sealing": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Sealing", disabled: true, icon: "fa-solid fa-spinner fa-spin" };
    case "sealed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.KeepShopping", disabled: false, icon: "fa-solid fa-store" };
    case "cant-afford": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.CantAfford", disabled: true, icon: "fa-solid fa-ban" };
    case "no-gm": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoGm", disabled: true, icon: "fa-solid fa-hourglass-half" };
    case "till-short": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.TillShort", disabled: true, icon: "fa-solid fa-ban" };
    case "stock-changed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: !hasLines, icon: "fa-solid fa-stamp" };
    case "closed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Closed", disabled: true, icon: "fa-solid fa-ban" };
    default: return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: !hasLines, icon: "fa-solid fa-stamp" };
  }
}
