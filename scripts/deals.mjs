/**
 * Deals (#111): one character's own price at one shop, kept free of Foundry so it can be tested
 * with plain Node (tools/deals.test.mjs).
 *
 * A deal lives in the shop config (`flags.merchant-presets.shop.deals`, schema.mjs) and is the
 * fourth pricing layer (pricing.mjs `effectiveRates`). The shop window and the GM's trade both read
 * it through `activeDeal`, at the same world time, so the bill a buyer seals is the price the
 * trade charges. Its note is never shown to players, but it travels with the shop actor to every
 * client that can see the shop: nothing Foundry stores is private from a player's console.
 *
 * Times are world seconds; the calendar is the world clock's own numbers, as in schedule.mjs.
 */

/** Seconds in one day of the world's calendar. */
const secondsPerDay = calendar => calendar.secondsPerMinute * calendar.minutesPerHour * calendar.hoursPerDay;

/**
 * The deal `actorUuid` has at `shop` at `worldTime`, as `effectiveRates` takes it, or null: none,
 * or one that has ended.
 *
 * @param {{deals: object[]}} shop  a full shop config (`shopFrom`'s)
 * @param {string|null} actorUuid
 * @param {number} worldTime
 * @returns {{buy: number|null, sell: number|null}|null}
 */
export function activeDeal(shop, actorUuid, worldTime) {
  const deal = actorUuid ? shop.deals.find(d => d.actor === actorUuid) : null;
  if (!deal || (deal.ends && deal.ends.at <= worldTime)) return null;
  return { buy: deal.buy, sell: deal.sell };
}

/**
 * When a shop keeping `hours` next closes, strictly after `worldTime`: the end of a deal made
 * "until the shop closes". A shop that's closed now closes next after it reopens. Null for a shop
 * with no hours, which never closes.
 *
 * @param {{open: {hour: number, minute: number}, close: {hour: number, minute: number}}|null} hours
 * @param {number} worldTime
 * @param {{secondsPerMinute: number, minutesPerHour: number, hoursPerDay: number}} calendar
 * @returns {number|null}
 */
export function nextCloseAt(hours, worldTime, calendar) {
  if (!hours) return null;
  const day = secondsPerDay(calendar);
  const offset = (hours.close.hour * calendar.minutesPerHour + hours.close.minute) * calendar.secondsPerMinute;
  const today = Math.floor(worldTime / day) * day + offset;
  return today > worldTime ? today : today + day;
}

/**
 * The end of a deal made "for `days` days": that many whole days of the world's calendar from now.
 *
 * @param {number} days
 * @param {number} worldTime
 * @param {{secondsPerMinute: number, minutesPerHour: number, hoursPerDay: number}} calendar
 * @returns {number}
 */
export function endsAfterDays(days, worldTime, calendar) {
  return worldTime + days * secondsPerDay(calendar);
}
