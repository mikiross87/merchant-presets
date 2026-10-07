/**
 * Other customers (#226), the Foundry side the clock pass and the shop window share: which
 * busy-day table a shop rolls on, today's kind of day, and a result as the shop keeps it.
 */
import { dayOf, LEVELS, todayOf } from "./customers.mjs";
import { secondsPerDay } from "./schedule.mjs";
import { worldFollowsClock } from "./clock.mjs";

const MODULE = "merchant-presets";

/** The shipped busy-day tables in the stock pack, as `{uuid, name, tier}`. */
export async function shippedDayTables() {
  const pack = game.packs?.get(`${MODULE}.stock`);
  if (!pack) return [];
  const index = await pack.getIndex({ fields: [`flags.${MODULE}.tradeDays`] });
  return index.filter(e => e.flags?.[MODULE]?.tradeDays)
    .map(e => ({ uuid: e.uuid ?? `Compendium.${pack.collection}.RollTable.${e._id}`, name: e.name, tier: e.flags[MODULE].tradeDays }));
}

/**
 * The busy-day table a shop rolls on: its own (`customers.table`), or the shipped one for its
 * size. Null when neither can be found.
 */
export async function customersTable(shop) {
  if (shop.customers.table) return fromUuid(shop.customers.table).catch(() => null);
  const shipped = (await shippedDayTables()).find(t => t.tier === (shop.tier ?? "Town"));
  return shipped ? fromUuid(shipped.uuid).catch(() => null) : null;
}

/** A table result as the shop keeps it: what players read, and the multipliers behind it. */
export function daySnapshot(result) {
  const day = dayOf(result) ?? {};
  const text = String(result.description ?? "").replace(/<[^>]*>/g, "").trim();
  return { id: result.id ?? result._id, name: result.name ?? "", text, global: day.global ?? 1, boosts: day.boosts ?? {} };
}

/** Rolls the kind of day on `table`, quietly: no chat card, nothing marked drawn. */
export async function rollDay(table) {
  if (!table) return null;
  const { results } = await table.roll();
  return results?.[0] ? daySnapshot(results[0]) : null;
}

/** The world setting's multiplier: 0 while Off. */
export const customersLevel = () => LEVELS[game.settings.get(MODULE, "otherCustomers")] ?? 0;

/** The calendar day's number at `time`. */
export const dayIndex = (time = game.time.worldTime) => Math.floor(time / secondsPerDay(game.time.calendar.days));

/**
 * Today's kind of day for `actor`'s window, or null: none while other customers are off, where
 * shops don't follow the world clock, or before the day's first stretch of trade rolled one.
 */
export function shopToday(actor) {
  if (!customersLevel() || !worldFollowsClock()) return null;
  return todayOf(actor.flags?.[MODULE]?.customers, dayIndex());
}
