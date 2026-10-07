/**
 * Other customers (#226): what a shop sells to people other than the party between restocks,
 * kept free of Foundry so it can be tested with plain Node (tools/customers.test.mjs).
 *
 * Every drawn, finite line loses stock over the hours the shop is open, at a rate set by its
 * demand category, its price within that category, the settlement's size and the kind of day
 * the shop is having. What sells earns the shop coin at its own prices. All the numbers are the
 * issue's starting values, to tune in play.
 *
 * The draw is seeded by the shop's shelf key, the line, the day and where the stretch began, so
 * the same stored state always drains the same way: reloading never changes a result.
 */

import { isDrawn } from "./schedule.mjs";
import { isGear, safeStockOf } from "./trade-plan.mjs";

const MODULE = "merchant-presets";

/** Share of a Town shelf sold per open day, by demand category. */
export const RATES = {
  "Food & Drink": 0.30,
  "Ammunition": 0.05,
  "Potions": 0.04, "Spell Components": 0.04, "Adventuring Gear": 0.04,
  "Tools": 0.03, "Tack & Harness": 0.03,
  "Weapons": 0.025,
  "Holy Symbols": 0.02,
  "Poisons": 0.015, "Armor": 0.015,
  "Instruments": 0.01, "Mounts & Animals": 0.01, "Spell Scrolls": 0.01, "Valuables": 0.01,
  "Magic Items": 0.005, "Vehicles": 0.005
};

/** The world setting's levels, as a multiplier on every rate. */
export const LEVELS = { off: 0, quiet: 0.5, busy: 1 };

// Everyday goods and everything else share one scale; luxury and rare goods have their own.
const LUXURY = new Set(["Magic Items", "Spell Scrolls", "Instruments", "Vehicles", "Mounts & Animals", "Valuables"]);
const SETTLEMENT = { everyday: { Village: 0.5, Town: 1, City: 2 }, luxury: { Village: 0.25, Town: 1, City: 3 } };

const KINDS = { mount: "Mounts & Animals", vehicle: "Vehicles", tack: "Tack & Harness", component: "Spell Components", "food-drink": "Food & Drink" };
const CONSUMABLES = { ammo: "Ammunition", poison: "Poisons", food: "Food & Drink", potion: "Potions" };
const ARMOR = new Set(["light", "medium", "heavy", "shield"]);
const hasProperty = (properties, key) => (properties instanceof Set ? properties.has(key) : (properties ?? []).includes?.(key)) ?? false;

/**
 * The category a good sells in, for its rate. Shipped goods carry no recipe category at
 * runtime, so it is read off the item itself; a GM's own category wins when it names a rate.
 *
 * @param {object} item   Item data: `type`, `system`, `flags`.
 * @param {object} stock  Its completed stock config.
 * @returns {string}  A key of {@link RATES}.
 */
export function demandCategory(item, stock) {
  // Valuables is the module's own category for full-value buyback, not a GM's: a gem that is a spell
  // component sells as one.
  if (stock?.category in RATES && stock.category !== "Valuables") return stock.category;
  const system = item.system ?? {};
  const subtype = system.type?.value;
  if (item.type === "consumable" && subtype === "scroll") return "Spell Scrolls";
  if (/(^|-)potion-of-healing$/.test(system.identifier ?? "")) return "Potions";
  if (system.rarity || hasProperty(system.properties, "mgc")) return "Magic Items";
  const kind = KINDS[item.flags?.[MODULE]?.kind];
  if (kind) return kind;
  if (item.type === "consumable" && CONSUMABLES[subtype]) return CONSUMABLES[subtype];
  if (item.type === "weapon") return "Weapons";
  if (item.type === "equipment" && ARMOR.has(subtype)) return "Armor";
  if (item.type === "tool") return subtype === "music" ? "Instruments" : "Tools";
  return stock?.category === "Valuables" ? "Valuables" : "Adventuring Gear";
}

/** How a settlement's size scales a category's trade. A shop with no size trades as a town. */
export function settlementMultiplier(category, tier) {
  const table = LUXURY.has(category) ? SETTLEMENT.luxury : SETTLEMENT.everyday;
  return table[tier] ?? 1;
}

/** Within a category, the cheaper good sells faster: `(price / median)^-0.5`, clamped to ×0.25-×2. */
export function priceModifier(priceGp, medianGp) {
  if (!(medianGp > 0) || !(priceGp > 0)) return medianGp > 0 ? 2 : 1;
  return Math.min(2, Math.max(0.25, (priceGp / medianGp) ** -0.5));
}

/** A table result's day: `{global, boosts}` from its flags, or null when it carries none. */
export const dayOf = result => result?.flags?.[MODULE]?.day ?? null;

/**
 * A busy-day table's average global multiplier, weighted by its results (#226): the drain divides
 * the settlement multiplier by it, so a re-weighted table changes how often each kind of day comes
 * up but not the shop's average trade. A result with no day flags counts as an ordinary ×1 day.
 * Null when there is no weight to sum.
 */
export function tableAverage(results) {
  let weight = 0, sum = 0;
  for (const r of results ?? []) {
    const w = Number(r.weight) || 0;
    weight += w;
    sum += w * (dayOf(r)?.global ?? 1);
  }
  return weight > 0 ? sum / weight : null;
}

/** The day's multiplier for a category: its global one, times its boost for that category. */
const dayMultiplier = (day, category) => (day?.global ?? 1) * (day?.boosts?.[category] ?? 1);

/**
 * How many of one line other customers are expected to buy over a stretch of open time.
 *
 * @param {object} line
 * @param {number} line.quantity   On the shelf at the start of the stretch.
 * @param {string} line.category   Its {@link demandCategory}.
 * @param {number} line.priceGp    One unit's price, in gp.
 * @param {number} line.medianGp   The median unit price of the shop's drainable lines in that category.
 * @param {string|null} line.tier  The shop's size: Village, Town or City.
 * @param {{global: number, boosts?: object}|null} line.day  The kind of day.
 * @param {number|null} line.average  The day table's {@link tableAverage}.
 * @param {number} line.level      The world setting's {@link LEVELS} multiplier.
 * @param {number} line.fraction   The stretch's open time over the shop's open time per day.
 */
export function expectedSales({ quantity, category, priceGp, medianGp, tier, day, average, level, fraction }) {
  const settlement = settlementMultiplier(category, tier) / (average > 0 ? average : 1);
  return quantity * (RATES[category] ?? RATES["Adventuring Gear"]) * priceModifier(priceGp, medianGp)
    * settlement * dayMultiplier(day, category) * level * fraction;
}

/** A seeded uniform random number generator over [0, 1): a string hash feeding mulberry32. */
export function seededRandom(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A Poisson draw with mean `lambda`: Knuth's product method, a rounded normal for large means. */
export function poisson(lambda, random) {
  if (!(lambda > 0)) return 0;
  if (lambda >= 30) {
    const gauss = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss));
  }
  const limit = Math.exp(-lambda);
  let k = 0, p = random();
  while (p > limit) { k++; p *= random(); }
  return k;
}

/**
 * Whether other customers can buy `item` off the shelf: a good the shop's restock drew, still in
 * stock, physical and limited. Never gear, a service, a good the GM added by hand, or one of
 * unlimited stock: the same exclusions restock already applies.
 */
export function isDrainable(item, { drawnBy, infiniteStock }) {
  if (isGear(item) || !isDrawn(item, drawnBy) || !(item.system?.quantity > 0)) return false;
  const stock = safeStockOf(item);
  if (!stock || stock.service) return false;
  return !(stock.infinite ?? infiniteStock);
}

const COIN_GP = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };
/** One unit's price in gp: `system.price` prices a whole bundle (dnd5e's quantityForPrice). */
const unitPriceGp = (item, stock) => (item.system?.price?.value ?? 0) * (COIN_GP[item.system?.price?.denomination] ?? 1)
  / Math.max(1, stock?.bundle ?? 1);

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * What other customers bought between two checks of a shop.
 *
 * @param {object} input
 * @param {object[]} input.items  The shop's embedded items, as data.
 * @param {{day: number, seconds: number, result: object|null}[]} input.spans  Open seconds per
 *   calendar day (schedule.mjs `openSpansByDay`), each with that day's `{global, boosts}`.
 * @param {number} input.perDay   The shop's open seconds in a whole day.
 * @param {number} input.from     Where the stretch began, in world time: part of the seed.
 * @param {string|null} input.tier
 * @param {number|null} input.average  The day table's {@link tableAverage}.
 * @param {number} input.level    The world setting's multiplier; 0 drains nothing.
 * @param {string|true} input.drawnBy   The shop's shelf key.
 * @param {boolean} input.infiniteStock The world's stock setting.
 * @param {(item: object, stock: object) => number} input.unitPriceCpOf  What one unit earns, in cp.
 * @returns {{updates: object[], deletes: string[], sold: {name: string, quantity: number}[], earnedCp: number}}
 */
export function planDrain({ items, spans, perDay, from = 0, tier, average, level, drawnBy, infiniteStock, unitPriceCpOf }) {
  const none = { updates: [], deletes: [], sold: [], earnedCp: 0 };
  if (!(level > 0) || !(perDay > 0) || !spans?.length) return none;
  const lines = items.filter(i => isDrainable(i, { drawnBy, infiniteStock })).map(item => {
    const stock = safeStockOf(item);
    return { item, stock, category: demandCategory(item, stock), priceGp: unitPriceGp(item, stock), quantity: item.system.quantity };
  });
  const prices = new Map();
  for (const l of lines) prices.set(l.category, [...(prices.get(l.category) ?? []), l.priceGp]);
  const medians = new Map([...prices].map(([c, p]) => [c, median(p)]));

  for (const { day, seconds, result } of spans) {
    for (const l of lines) {
      if (l.quantity <= 0) continue;
      const lambda = expectedSales({ quantity: l.quantity, category: l.category, priceGp: l.priceGp, medianGp: medians.get(l.category),
        tier, day: result, average, level, fraction: seconds / perDay });
      l.quantity -= Math.min(l.quantity, poisson(lambda, seededRandom(`${drawnBy}|${l.item._id}|${day}|${from}`)));
    }
  }
  const changed = lines.filter(l => l.quantity !== l.item.system.quantity);
  if (!changed.length) return none;
  const sold = changed.map(l => ({ name: l.item.name, quantity: l.item.system.quantity - l.quantity }));
  // A good that sells out goes when its line says not to keep it, as at a trade.
  const goes = l => l.quantity === 0 && !l.stock.keep;
  return {
    updates: changed.filter(l => !goes(l)).map(l => ({ _id: l.item._id, "system.quantity": l.quantity })),
    deletes: changed.filter(goes).map(l => l.item._id),
    sold,
    earnedCp: changed.reduce((sum, l) => sum + (l.item.system.quantity - l.quantity) * unitPriceCpOf(l.item, l.stock), 0)
  };
}

/**
 * The setting's value to write on this world's first load with it (#226): Off where shops are
 * already trading, so an upgrade doesn't start emptying their shelves unasked; null leaves the
 * Busy default, or a value the GM already chose.
 *
 * @param {boolean} hasStoredValue  Whether the world's settings storage already holds one.
 * @param {boolean} worldHasShops   Whether the world already holds a shop.
 * @returns {"off"|null}
 */
export function planCustomersDefault(hasStoredValue, worldHasShops) {
  return !hasStoredValue && worldHasShops ? "off" : null;
}

/**
 * Today's kind of day as a shop keeps it (`flags.merchant-presets.customers`): the GM's pick over
 * the roll. Null when nothing is kept for `todayIndex`, the calendar day's number.
 *
 * @returns {{day: object|null, rolled: object|null, overridden: boolean}|null}
 */
export function todayOf(state, todayIndex) {
  const kept = state?.day;
  if (!kept || kept.index !== todayIndex) return null;
  return { day: kept.override ?? kept.rolled ?? null, rolled: kept.rolled ?? null, overridden: !!kept.override };
}

/** A day's category boosts, grouped by size, biggest first: `[{multiplier, categories}]`. */
export function boostGroups(day) {
  const groups = new Map();
  for (const [category, multiplier] of Object.entries(day?.boosts ?? {})) {
    if (multiplier === 1) continue;
    groups.set(multiplier, [...(groups.get(multiplier) ?? []), category]);
  }
  return [...groups].sort((a, b) => b[0] - a[0]).map(([multiplier, categories]) => ({ multiplier, categories }));
}
