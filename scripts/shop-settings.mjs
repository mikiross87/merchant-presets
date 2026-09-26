/**
 * The GM's Settings tab (#110), kept free of Foundry so it can be tested with plain Node
 * (tools/shop-settings.test.mjs). Each edit the tab makes is one `change` applied to the shop's
 * #98 config: `applyChange` returns the whole new config, checked by `validateShop`, or refuses
 * it, and the window writes nothing. Rates are edited as percentages, the way the tab shows them,
 * and stored as the factors schema.mjs holds.
 */

import { endsAfterDays, nextCloseAt } from "./deals.mjs";
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

/** A deal side as the tab sends it, a percentage, as the factor schema.mjs holds; 0% is no change. */
const adjustmentOf = percent => (percent === 0 || percent === null ? null : rateOf(percent));

/** A deal from the tab's form: its sides as percentages (-10 is 10% off). */
const dealOf = ({ actor, name, buy, sell, note, ends }) =>
  ({ actor, name, buy: adjustmentOf(buy), sell: adjustmentOf(sell), note, ends });

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
  // A rule is named by its category, never its place in the list: edits queue, and a remove
  // ahead of this one would shift every place after it (#140 review).
  ruleRate(shop, { category, side, percent }) {
    const rule = shop.terms.categories.find(c => c.category === category);
    if (!rule || (side !== "sellsAt" && side !== "buysAt")) return "no such rule";
    rule[side] = rateOf(percent);
  },
  removeRule(shop, { category }) {
    // Already gone (a double click): nothing to do.
    shop.terms.categories = shop.terms.categories.filter(c => c.category !== category);
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
  },
  // Deals are named by their character, as rules are by category (see `ruleRate`).
  addDeal(shop, change) {
    if (shop.deals.some(d => d.actor === change.actor)) return `${change.name} already has a deal here`;
    shop.deals.push(dealOf(change));
  },
  editDeal(shop, change) {
    const at = shop.deals.findIndex(d => d.actor === change.actor);
    if (at < 0) return "no such deal";
    shop.deals[at] = dealOf(change);
  },
  removeDeal(shop, { actor }) {
    // Already gone (a double click): nothing to do.
    shop.deals = shop.deals.filter(d => d.actor !== actor);
  },
  reset(shop, { preset }) {
    const result = resetToPreset(shop, preset);
    if (!result.ok) return result.errors.join("; ");
    for (const key of Object.keys(shop)) delete shop[key];
    Object.assign(shop, result.shop);
  }
};

/**
 * One Settings-tab edit applied to `shop`, a full config (`shopFrom`'s), which is left as it was.
 *
 * @param {object} shop
 * @param {{op: string}} change  `{op: "rate", side, percent|null}`, `{op: "addRule", category,
 *   world}`, `{op: "ruleRate", category, side, percent}`, `{op: "removeRule", category}`, `{op:
 *   "wontBuy", list, value, on}`, `{op: "keepHours", on, fallback}`, `{op: "hour", end, time}`,
 *   `{op: "every", every}`, `{op: "mode", mode}`, `{op: "addDeal"|"editDeal", actor, name, buy, sell,
 *   note, ends}` (sides as percentages), `{op: "removeDeal", actor}` or `{op: "reset", preset}`
 *   (`resetToPreset`)
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

/** A form field as a percentage: blank is no change (null), anything else a number, NaN if it isn't one. */
const percentField = v => (v === null || v === undefined || String(v).trim() === "" ? null : Number(v));

/**
 * The deal form's answer (#111) as the fields of an `addDeal`/`editDeal` change, or `{error}` for
 * an end that can't be kept. Sides stay percentages, checked by `applyChange` like any other edit.
 *
 * @param {{actor: string, buy: unknown, sell: unknown, ends: "never"|"close"|"days"|"keep", days:
 *   unknown, note: unknown}} form  `ends`: no end, the shop's next closing, `days` whole days from
 *   now, or (editing) the end the deal already has
 * @param {{name: string, worldTime: number, hours: object|null, calendar: object, previous:
 *   object|null}} context  `hours` the shop's own (null: it never closes); `previous` the deal
 *   being edited
 * @returns {{actor: string, name: string, buy: number|null, sell: number|null, note: string,
 *   ends: object|null} | {error: string}}
 */
export function dealFields(form, { name, worldTime, hours, calendar, previous }) {
  let ends = null;
  if (form.ends === "close") {
    const at = nextCloseAt(hours, worldTime, calendar);
    if (at === null) return { error: "this shop never closes" };
    ends = { at, when: "close" };
  } else if (form.ends === "days") {
    const days = percentField(form.days);
    if (!Number.isInteger(days) || days < 1) return { error: "a deal lasts a whole number of days, 1 or more" };
    ends = { at: endsAfterDays(days, worldTime, calendar), when: "date" };
  } else if (form.ends === "keep") {
    if (!previous?.ends) return { error: "there's no end to keep" };
    ends = previous.ends;
  } else if (form.ends !== "never") return { error: "no such end" };
  return {
    actor: form.actor, name, buy: percentField(form.buy), sell: percentField(form.sell),
    note: String(form.note ?? "").trim(), ends
  };
}

/**
 * The config the shop was imported with: its preset's own (`sourceShop`, the merchant in the
 * pack), keeping the shop's own `source`, which names that preset, and its deals (#111).
 *
 * @param {object} shop
 * @param {unknown} sourceShop  the preset merchant's `flags.merchant-presets.shop`
 * @returns {{ok: true, shop: object} | {ok: false, errors: string[]}}
 */
export function resetToPreset(shop, sourceShop) {
  const { ok, errors } = validateShop(sourceShop);
  if (!ok) return { ok, errors };
  // Deals are with a character, not part of the preset: a reset keeps them.
  return { ok, shop: { ...shopFrom(sourceShop), source: shop.source, deals: shop.deals } };
}
