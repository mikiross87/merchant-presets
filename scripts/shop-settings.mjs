/**
 * The GM's Settings tab (#110), kept free of Foundry so it can be tested with plain Node
 * (tools/shop-settings.test.mjs). Each edit the tab makes is one `change` applied to the shop's
 * #98 config: `applyChange` returns the whole new config, checked by `validateShop`, or refuses
 * it, and the window writes nothing. Rates are edited as percentages, the way the tab shows them,
 * and stored as the factors schema.mjs holds.
 */

import { effectiveRates } from "./pricing.mjs";
import { shopFrom, validateShop } from "./schema.mjs";

/** The item types a shop can refuse to buy: the physical ones, which are all a player can sell. */
export const WONT_BUY_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container"];

/**
 * The goods kinds a shop can refuse (tools/build_srd.py `GOODS_KINDS`), less "gear": the
 * shopkeeper's own kit is never bought whatever the shop says.
 */
export const WONT_BUY_KINDS = ["vehicle", "mount", "tack", "food-drink", "meal", "lodging", "service",
  "spellcasting", "component", "travel"];

/** The restock schedules offered as chips, in days; anything else is a dice formula. */
export const EVERY_CHOICES = [1, 3, 7, 14];

/** A rate as the percentage the tab shows: 0.57 is 57, rounded to a hundredth to drop float noise. */
export const percentOf = rate => Math.round(rate * 10_000) / 100;

/** A percentage as a rate, the same rounding: 57 is 0.57, not 0.5700000000000001. */
const rateOf = percent => (typeof percent === "number" ? Math.round(percent * 100) / 10_000 : percent);

/** `{hour, minute}` as a time input's value, "07:05". */
export const timeText = time => `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;

/** A time input's "HH:MM" as `{hour, minute}`, or null if it isn't a time of day. */
export function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(typeof text === "string" ? text.trim() : "");
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/**
 * Which schedule chip `restock` reads as: "1", "3", "7" or "14" days, "never" (never, or restocking
 * switched off), or "dice" with the formula (or an unlisted number of days) in `formula`.
 *
 * @param {{every: number|string, onOpen: boolean}} restock
 * @returns {{chip: string, formula: string}}
 */
export function everyChoice(restock) {
  if (!restock.onOpen || restock.every === "never") return { chip: "never", formula: "" };
  if (EVERY_CHOICES.includes(restock.every)) return { chip: String(restock.every), formula: "" };
  return { chip: "dice", formula: String(restock.every) };
}

/** A schedule as the tab sends it: "7" or 7 is seven days, "never" is never, anything else a formula. */
const everyOf = every => (typeof every === "string" && /^\d+$/.test(every.trim()) ? Number(every) : every);

/** The edits, each on a fresh copy of the config; an error message refuses the change outright. */
const CHANGES = {
  rate(shop, { side, percent }) {
    if (side !== "sellsAt" && side !== "buysAt") return "no such rate";
    shop.terms[side] = percent === null ? null : rateOf(percent);
  },
  addRule(shop, { category, world }) {
    if (typeof category !== "string" || !category) return "a rule needs a category";
    if (shop.terms.categories.some(c => c.category === category)) return `${category} already has a rule`;
    // It starts at what the shop charges now, so adding one changes no price until it's edited.
    const { sellsAt, buysAt } = effectiveRates(world, shop.terms);
    shop.terms.categories.push({ category, sellsAt: sellsAt.rate, buysAt: buysAt.rate });
  },
  ruleRate(shop, { index, side, percent }) {
    const rule = shop.terms.categories[index];
    if (!rule || (side !== "sellsAt" && side !== "buysAt")) return "no such rule";
    rule[side] = rateOf(percent);
  },
  removeRule(shop, { index }) {
    if (!shop.terms.categories[index]) return "no such rule";
    shop.terms.categories.splice(index, 1);
  },
  wontBuy(shop, { list, value, on }) {
    if (list !== "types" && list !== "kinds") return "no such list";
    const values = shop.wontBuy[list].filter(v => v !== value);
    shop.wontBuy[list] = on ? [...values, value] : values;
  },
  keepHours(shop, { on, fallback }) {
    if (!on) shop.hours = null;
    else shop.hours ??= structuredClone(fallback);
  },
  hour(shop, { end, time }) {
    if (!shop.hours) return "the shop keeps no hours";
    if (end !== "open" && end !== "close") return "no such time";
    const parsed = parseTime(time);
    if (!parsed) return "not a time of day";
    shop.hours[end] = parsed;
  },
  every(shop, { every }) {
    shop.restock.every = everyOf(every);
    // Picking a schedule is picking to restock: a shop that had restocking off starts again.
    if (shop.restock.every !== "never") shop.restock.onOpen = true;
  },
  mode(shop, { mode }) {
    shop.restock.mode = mode;
  }
};

/**
 * One Settings-tab edit applied to `shop`, a full config (`shopFrom`'s), which is left as it was.
 *
 * @param {object} shop
 * @param {{op: string}} change  `{op: "rate", side, percent|null}`, `{op: "addRule", category,
 *   world}`, `{op: "ruleRate", index, side, percent}`, `{op: "removeRule", index}`, `{op:
 *   "wontBuy", list, value, on}`, `{op: "keepHours", on, fallback}`, `{op: "hour", end, time}`,
 *   `{op: "every", every}` or `{op: "mode", mode}`
 * @returns {{ok: true, shop: object} | {ok: false, errors: string[]}}
 */
export function applyChange(shop, change) {
  const edit = Object.hasOwn(CHANGES, change?.op) ? CHANGES[change.op] : null;
  if (!edit) return { ok: false, errors: [`unknown change ${change?.op}`] };
  const next = structuredClone(shop);
  const refusal = edit(next, change);
  if (refusal) return { ok: false, errors: [refusal] };
  const { ok, errors } = validateShop(next);
  return ok ? { ok, shop: next } : { ok, errors };
}

/**
 * The config the shop was imported with: its preset's own (`sourceShop`, the merchant in the
 * pack), keeping the shop's own `source`, which names that preset.
 *
 * @param {object} shop
 * @param {unknown} sourceShop  the preset merchant's `flags.merchant-presets.shop`
 * @returns {{ok: true, shop: object} | {ok: false, errors: string[]}}
 */
export function resetToPreset(shop, sourceShop) {
  const { ok, errors } = validateShop(sourceShop);
  if (!ok) return { ok, errors };
  return { ok, shop: { ...shopFrom(sourceShop), source: shop.source } };
}
