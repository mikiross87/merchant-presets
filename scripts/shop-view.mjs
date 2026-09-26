import { effectiveRates } from "./pricing.mjs";
import { bundleFor, bundlePriceCp, categoryFor, dealtIn, hasUngivableContents, isVisible, lineTotalCp } from "./trade-plan.mjs";

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

/** Coins a price is written in: gold, silver and copper, as the design writes "12 gp 5 sp" (never "1 pp 2 gp 1 ep"); a config with none of them keeps all its own. */
const EVERYDAY = ["gp", "sp", "cp"];

/** Every quantity a buy of a line accepts, smallest first, up to `most`: the part-bundle remainder, then whole bundles, each with the remainder on top. */
function* buyableQuantities(bundle, remainder, most) {
  for (let whole = 0; whole <= most; whole += bundle) {
    if (whole > 0) yield whole;
    if (remainder && whole + remainder <= most) yield whole + remainder;
  }
}

/**
 * A row's price when one bundle floors to nothing but `minQuantity` of it doesn't: "2 for 1 cp",
 * rather than a sticker that reads Free. `{priceFor: null, priceForCp: null}` otherwise.
 */
function cheapestLot(item, rate, bundle, bundleCp, minQuantity, currencies) {
  if (bundleCp !== 0 || !minQuantity) return { priceFor: null, priceForCp: null };
  const cp = lineTotalCp(item, rate, bundle, minQuantity, currencies);
  return cp > 0 ? { priceFor: minQuantity, priceForCp: cp } : { priceFor: null, priceForCp: null };
}

/** How many bundles a buy row counts up to while looking for the fewest worth a coin. */
const MAX_BUNDLES_TO_A_COIN = 1000;

/**
 * `amountCp` broken into coins for display — in everyday coin (`EVERYDAY`),
 * largest first, floored at each step, the remainder dropped once it can't
 * make a whole coin of the smallest. Not a real payment (see the module
 * header); a price of 12cp shows as one sp, two cp.
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
  const byValue = denominationsByValue(currencies);
  const everyday = byValue.filter(([denomination]) => EVERYDAY.includes(denomination));
  for (const [denomination, value] of everyday.length ? everyday : byValue) {
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
 * @typedef {{kind: "markup"|"discount"|"full"|"deal"|null, text: string|null}} RateTag
 */

/** A true minus sign (U+2212), as the design sets every negative figure; a hyphen is shorter and sits lower. */
export const MINUS = "\u2212";

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
  // The schema keeps a shop's sellsAt above 0; guarded anyway, so a bad rate can't read "+Infinity%".
  if (!(chipRate > 0)) return { kind: null, text: null };
  const diff = effective.rate - chipRate;
  if (Math.abs(diff) < 1e-9) return { kind: null, text: null };
  if (effective.layer === "category" && Math.abs(effective.rate - 1) < 1e-9) return { kind: "full", text: null };
  const pct = Math.round(Math.abs(diff / chipRate) * 100);
  return diff > 0 ? { kind: "markup", text: `+${pct}%` } : { kind: "discount", text: `${MINUS}${pct}%` };
}

/**
 * A deal's size as the window shows it: signed, to a hundredth of a percent ("−10%", "+12.5%").
 *
 * @param {number} factor  -0.1 is 10% off
 * @returns {string}
 */
export function signedPercent(factor) {
  const percent = Math.round(factor * 10_000) / 100;
  return `${percent < 0 ? MINUS : "+"}${Math.abs(percent)}%`;
}

/**
 * What a buyer's deal did to one row (#111): the price it would be at without the deal, struck
 * beside the real one, and a tag with the deal's real effect, so a deal the sell <= buy cap cut
 * short says what it gives, not what the GM asked for. Nothing when the deal left the shown price
 * alone: a small deal on cheap goods can floor to the same coins (#142 review).
 *
 * @param {number} listRate  the row's rate without the deal
 * @param {number} rate  the row's rate with it
 * @param {() => number} listPrice  the row's shown price at `listRate`
 * @param {number} shownCp  the row's shown price at `rate`
 * @returns {{listPriceCp: number, tag: RateTag}|null}
 */
function dealShown(listRate, rate, listPrice, shownCp) {
  if (!(listRate > 0) || Math.abs(rate - listRate) < 1e-9) return null;
  const listPriceCp = listPrice();
  if (listPriceCp === shownCp) return null;
  return { listPriceCp, tag: { kind: "deal", text: signedPercent(rate / listRate - 1) } };
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

/* -------------------------------------------------------------- shelf groups (#145) */

/**
 * The Buy list's groups when the GM named no category: the module's own kinds of goods (the inn's
 * meals, lodging, food and drink; design mRg3y), else a good's kind by item type (the smith's
 * weapons, armour, tools and gear; design y6iNf), each with its nav icon.
 */
export const SHELF_GROUP_ICONS = Object.freeze({
  weapons: "lucide:sword", armor: "lucide:shield", tools: "lucide:wrench", gear: "lucide:backpack",
  meal: "lucide:soup", lodging: "lucide:bed-double", "food-drink": "lucide:beer", service: "lucide:concierge-bell",
  spellcasting: "lucide:sparkles", component: "lucide:gem", mount: "lucide:fence", tack: "lucide:link",
  vehicle: "lucide:caravan", travel: "lucide:map"
});

/**
 * Where a good sits on the Buy list: under a category the GM named on its line, else its kind of
 * good. For display only; category rules still price by `categoryFor`.
 *
 * @param {object} item  an item's `toObject()`
 * @param {object} stock  its completed stock config
 * @param {Record<string, unknown>} armorTypes  CONFIG.DND5E.armorTypes: the equipment types that are armour (a shield too)
 * @returns {{id: string, named: string|null, icon: string}}  `named`: the GM's own name for it, if theirs
 */
export function shelfGroup(item, stock, armorTypes = {}) {
  if (stock?.category) return { id: `named:${stock.category}`, named: stock.category, icon: "lucide:tag" };
  const kind = item.flags?.["merchant-presets"]?.kind;
  if (kind && kind !== "gear" && kind in SHELF_GROUP_ICONS) return { id: kind, named: null, icon: SHELF_GROUP_ICONS[kind] };
  const id = item.type === "weapon" ? "weapons"
    : item.type === "equipment" && Object.hasOwn(armorTypes, item.system?.type?.value ?? "") ? "armor"
      : item.type === "tool" ? "tools" : "gear";
  return { id, named: null, icon: SHELF_GROUP_ICONS[id] };
}

/** "Martial Melee" as the design writes it in a row: "Martial melee". */
const sentenceCase = text => (text ? text.charAt(0) + text.slice(1).toLowerCase() : "");

/**
 * A good's line under its name (design y6iNf): what it is, then what matters about it.
 * "Martial melee · Versatile · 3 lb", "Medium armor · AC 14 + Dex (max 2)", "+2 AC · 6 lb",
 * "Artisan's tools · 8 lb"; anything else by its type, then its weight.
 *
 * @param {object} item  an item's `toObject()`
 * @param {{weaponTypes: object, armorTypes: object, toolTypes: object, consumableTypes: object,
 *   typeLabels: object, properties: object, weightUnits: object}} labels  CONFIG.DND5E's, localized
 * @param {(key: string, data?: object) => string} t  the window's localize, for the pieces in words
 * @returns {string}
 */
export function itemMeta(item, labels, t) {
  const sys = item.system ?? {};
  const label = entry => (typeof entry === "string" ? entry : entry?.label ?? "");
  const weight = sys.weight?.value > 0
    ? t("Weight", { weight: sys.weight.value, units: labels.weightUnits?.[sys.weight.units ?? "lb"]?.abbreviation ?? sys.weight.units ?? "lb" })
    : null;
  const parts = [];
  if (item.type === "weapon") {
    parts.push(sentenceCase(label(labels.weaponTypes?.[sys.type?.value])));
    const props = [...(sys.properties ?? [])].map(p => label(labels.properties?.[p])).filter(Boolean);
    if (props.length) parts.push(sentenceCase(props.join(", ")));
    parts.push(weight);
  } else if (item.type === "equipment" && sys.type?.value === "shield") {
    parts.push(t("ShieldAc", { ac: sys.armor?.value ?? 0 }), weight);
  } else if (item.type === "equipment" && Object.hasOwn(labels.armorTypes ?? {}, sys.type?.value ?? "")) {
    // Armour's weight goes unsaid: its AC and what wearing it asks are what a buyer weighs.
    const dex = sys.armor?.dex;
    const ac = t("Ac", { ac: sys.armor?.value ?? 0 })
      + (sys.type.value === "heavy" ? "" : dex ? t("DexMax", { max: dex }) : t("Dex"));
    parts.push(sentenceCase(label(labels.armorTypes[sys.type.value])), ac, sys.strength ? t("Str", { str: sys.strength }) : null);
  } else if (item.type === "tool") {
    parts.push(sentenceCase(label(labels.toolTypes?.[sys.type?.value])) || label(labels.typeLabels?.tool), weight);
  } else {
    parts.push(label(labels.consumableTypes?.[sys.type?.value]) || label(labels.typeLabels?.[item.type]), weight);
  }
  return parts.filter(Boolean).join(" · ");
}

/**
 * The part of the day an hour falls in, as the bill dates itself ("mid-morning"): a key under
 * MERCHANT_PRESETS.Shop.Day. On a calendar whose day isn't 24 hours, the hour is scaled to one.
 *
 * @param {number} hour
 * @param {number} [hoursPerDay]
 * @returns {"night"|"dawn"|"morning"|"midMorning"|"midday"|"afternoon"|"evening"}
 */
export function partOfDay(hour, hoursPerDay = 24) {
  const h = (hour * 24) / hoursPerDay;
  if (h < 5) return "night";
  if (h < 7) return "dawn";
  if (h < 9) return "morning";
  if (h < 12) return "midMorning";
  if (h < 14) return "midday";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "night";
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
 * exclusions, hidden, delisted, inside a container, a container holding any of those) or as
 * unidentified. `shopItems` is the shop's own items, for that container check.
 */
export const isVisibleStock = (item, stock, shopItems = []) => isVisible(item, stock)
  && item.system?.identified !== false
  && !(item.type === "container" && hasUngivableContents(item._id, shopItems));

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
 * @property {number|null} listPriceCp  the shown price without the buyer's deal, when the deal moved it (#111)
 * @property {RateTag} tag  the deal's effect when there is one, else the row against the chip
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
 * @param {(item: object) => number|undefined} [bundleOf]  the runtime's resolver (`api.bundleOf`), for a
 *   line with no stated bundle — the same one the trade prices by
 * @returns {BuyRow}
 */
export function buyRow(item, stock, rates, deal, currencies, worldInfiniteStock, bundleOf) {
  const category = categoryFor(item, stock);
  const { sellsAt } = effectiveRates(rates.world, rates.shopTerms, category, deal);
  let bundleCp = null, unpriced = false;
  try { bundleCp = bundlePriceCp(item, sellsAt.rate, currencies); }
  catch { unpriced = true; }
  // The planner refuses a line that floors to 0 at a real price and rate ("worthless"), so the
  // stepper starts at the fewest whole bundles worth a coin, and a shelf that never gets there
  // can't be bought at all.
  const bundle = bundleFor(item, item, bundleOf);
  const infinite = stock.service || (stock.infinite ?? worldInfiniteStock);
  const available = item.system?.quantity ?? 0;
  // 1 means no floor of its own: `stepQuantity` already lands only on quantities a buy accepts.
  let minQuantity = 1, worthless = false;
  // Nothing on a finite shelf (a sold-out line kept for restock) is out of stock, not worthless.
  if (!unpriced && sellsAt.rate > 0 && item.system.price?.value > 0 && (infinite || available > 0)) {
    // Capped: a vanishing rate on an endless line would otherwise count bundles for ever.
    const most = infinite ? bundle * MAX_BUNDLES_TO_A_COIN : available;
    const worth = [...buyableQuantities(bundle, infinite ? 0 : available % bundle, most)]
      .find(q => lineTotalCp(item, sellsAt.rate, bundle, q, currencies) > 0);
    if (worth) minQuantity = worth;
    else worthless = true;
  }
  const priceFor = cheapestLot(item, sellsAt.rate, bundle, bundleCp, worthless ? null : minQuantity, currencies);
  const list = effectiveRates(rates.world, rates.shopTerms, category).sellsAt;
  const listRate = list.rate;
  const dealt = unpriced ? null : dealShown(listRate, sellsAt.rate, () => (priceFor.priceFor
    ? lineTotalCp(item, listRate, bundle, priceFor.priceFor, currencies) : bundlePriceCp(item, listRate, currencies)),
  priceFor.priceForCp ?? bundleCp);
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
    worthless,
    minQuantity,
    ...priceFor,
    bundle,
    listPriceCp: dealt?.listPriceCp ?? null,
    // A deal that didn't move the coins leaves the row as it would be without it.
    tag: unpriced ? { kind: null, text: null } : dealt?.tag ?? rateTag(list, rates.chipSellsAt)
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
 * @property {number|null} [listPriceCp]  the shop's usual offer, when the seller's deal moved it (#111)
 * @property {RateTag|null} [tag]  the deal's effect, when there is one
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
 * @param {{hasContents?: boolean, bundle?: number}} [seller]  `hasContents`: whether `item`, a
 *   container, still holds anything on the seller (a sale refuses it as container-not-empty).
 *   `bundle`: trade-plan's `bundleFor` on the matched line — `matchedStock` alone has already
 *   defaulted a missing bundle to 1.
 * @returns {SellRow}
 */
export function sellRow(item, shopConfig, matchedStock, rates, deal, currencies, { hasContents = false, bundle } = {}) {
  const base = {
    id: item._id ?? item.id,
    img: item.img,
    name: item.name,
    equipped: !!item.system?.equipped,
    contained: item.system?.container != null,
    owned: item.system?.quantity ?? 0
  };
  if (hasContents) return { ...base, refusal: "NotEmpty", bundlePriceCp: null, ratio: null };
  if (item.system?.identified === false) return { ...base, refusal: "Unidentified", bundlePriceCp: null, ratio: null };
  if (!dealtIn(item, shopConfig)) return { ...base, refusal: "General", bundlePriceCp: null, ratio: null };
  if (matchedStock.noBuyback) return { ...base, refusal: "NoBuyback", bundlePriceCp: null, ratio: null };
  if (matchedStock.service) return { ...base, refusal: "General", bundlePriceCp: null, ratio: null };

  const category = categoryFor(item, matchedStock);
  const { buysAt } = effectiveRates(rates.world, rates.shopTerms, category, deal);
  let bundleCp, allCp;
  try {
    bundleCp = bundlePriceCp(item, buysAt.rate, currencies);
    allCp = lineTotalCp(item, buysAt.rate, bundle ?? (matchedStock.bundle || 1), Math.max(base.owned, 1), currencies);
  } catch {
    return { ...base, refusal: "Unpriced", bundlePriceCp: null, ratio: null };
  }
  // The planner's "worthless": even all of it floors to nothing at a rate that isn't 0.
  const priced = buysAt.rate > 0 && item.system.price?.value > 0;
  if (allCp === 0 && priced) {
    return { ...base, refusal: "Worthless", bundlePriceCp: null, ratio: null };
  }
  // The planner checks the quantity actually sold, so a sale starts at the fewest worth a coin.
  let minQuantity = 1;
  const lineBundle = bundle ?? (matchedStock.bundle || 1);
  while (priced && minQuantity < base.owned && lineTotalCp(item, buysAt.rate, lineBundle, minQuantity, currencies) === 0) minQuantity++;
  const lot = cheapestLot(item, buysAt.rate, lineBundle, bundleCp, minQuantity, currencies);
  const listRate = effectiveRates(rates.world, rates.shopTerms, category).buysAt.rate;
  const dealt = dealShown(listRate, buysAt.rate, () => (lot.priceFor
    ? lineTotalCp(item, listRate, lineBundle, lot.priceFor, currencies) : bundlePriceCp(item, listRate, currencies)),
  lot.priceForCp ?? bundleCp);
  return {
    ...base, refusal: null, bundlePriceCp: bundleCp, ratio: rateFraction(buysAt.rate), minQuantity, bundle: lineBundle,
    ...lot, listPriceCp: dealt?.listPriceCp ?? null, tag: dealt?.tag ?? null
  };
}

/* -------------------------------------------------------------- the buy stepper */

/**
 * A buy line's next quantity after one step (`delta` +1 or -1): whole bundles, plus the
 * part-bundle a sale left on a finite line (trade-plan.mjs, "bundled quantities"), so the
 * stepper only ever lands on a quantity a buy accepts. Stepping up where nothing more fits
 * stays put; stepping down off a part-bundle drops just the part.
 *
 * @param {number} current
 * @param {1|-1} delta
 * @param {{bundle: number, available: number, infinite: boolean}} shelf
 * @returns {number}
 */
export function stepQuantity(current, delta, { bundle, available, infinite }) {
  if (delta < 0) return Math.max(0, current - (current % bundle || bundle));
  const next = current + bundle;
  if (infinite || next <= available) return next;
  const rest = available - current;
  return rest > 0 && rest === available % bundle ? available : current;
}

/**
 * The largest quantity up to `quantity` that a buy of this line accepts right now: whole bundles,
 * plus the line's own odd remainder, within what's left. For a basket line the shelf changed
 * under (someone else bought or sold some).
 *
 * @param {number} quantity
 * @param {{bundle: number, available: number, infinite: boolean}} shelf
 * @returns {number}
 */
export function fitQuantity(quantity, { bundle, available, infinite }) {
  // An endless line has no remainder: only whole bundles (the engine refuses a part-bundle there).
  if (infinite) return quantity - (quantity % bundle);
  const most = Math.min(quantity, available);
  const whole = most - (most % bundle);
  const remainder = available % bundle;
  return remainder > 0 && most % bundle >= remainder ? whole + remainder : whole;
}

/* -------------------------------------------------------------- trade states */

/**
 * The seal button's label and whether it's disabled, for every state the
 * Trade States board draws (design/README.md). `state` covers "sealing" (a
 * request is in flight), "sealed" (the last request came back sealed),
 * "closed" (the shop isn't open) and every `planTrade`/#102 refusal reason
 * this window can reach from the client side — `cant-afford`, `no-gm`,
 * `till-short`, `stock-changed` render their own copy (`no-gm` and
 * `stock-changed` leave the seal live, to send the bill again); every other reason
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
    case "sealing": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Sealing", disabled: true, icon: "lucide:loader" };
    case "sealed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.KeepShopping", disabled: false, icon: "lucide:store" };
    case "cant-afford": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.CantAfford", disabled: true, icon: "lucide:circle-slash" };
    // Live, not waiting: nothing tells the window a GM has arrived, so the player sends it again.
    case "no-gm": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoGm", disabled: !hasLines, icon: "lucide:hourglass" };
    case "till-short": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.TillShort", disabled: true, icon: "lucide:circle-slash" };
    case "stock-changed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: !hasLines, icon: "lucide:stamp" };
    case "closed": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Closed", disabled: true, icon: "lucide:circle-slash" };
    case "idle": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Bargain", disabled: !hasLines, icon: "lucide:stamp" };
    case "out-of-stock": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.OutOfStock", disabled: true, icon: "lucide:circle-slash" };
    case "no-buyer": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.NoBuyer", disabled: true, icon: "lucide:user-x" };
    case "worthless": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Worthless", disabled: true, icon: "lucide:circle-slash" };
    case "container-not-empty": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.NotEmpty", disabled: true, icon: "lucide:package-open" };
    case "unpriced": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Unpriced", disabled: true, icon: "lucide:circle-slash" };
    case "invalid-request": return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Invalid", disabled: true, icon: "lucide:circle-slash" };
    // Any other refusal (not-visible, wont-buy, shop-misconfigured, ...) still reads as one: the
    // bill has to change before the same request could go through.
    default: return { labelKey: "MERCHANT_PRESETS.Shop.Seal.Invalid", disabled: true, icon: "lucide:circle-slash" };
  }
}
