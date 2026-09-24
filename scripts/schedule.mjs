/**
 * Trading hours and the #105 restock schedule, kept free of Foundry so they
 * can be tested with plain Node (tools/schedule.test.mjs).
 *
 * Every function here takes the world clock's own numbers rather than
 * `game.time.calendar` itself, so the runtime can pass `game.time.calendar.days`
 * straight through: `{secondsPerMinute, minutesPerHour, hoursPerDay}`. A
 * minute-of-day is always a whole number in `[0, minutesPerHour*hoursPerDay)`.
 *
 * @typedef {{secondsPerMinute: number, minutesPerHour: number, hoursPerDay: number}} CalendarDays
 * @typedef {{hour: number, minute: number}} Time
 * @typedef {{open: Time, close: Time}|null} Hours  A #98 shop config's `hours`; null is always open.
 * @typedef {{every: number|string, onOpen: boolean}} Restock  A #98 shop config's `restock` (the parts this module reads).
 * @typedef {{lastRestock: number, dueAt: number|null}} ScheduleState  What a shop needs stored between checks.
 */

const minutesOf = (time, calendar) => time.hour * calendar.minutesPerHour + time.minute;

/**
 * Whether a shop with `hours` is open at `minute` (minutes since midnight).
 * `hours` of null means always open. Handles a window that runs past
 * midnight, like the Criminal & Illicit Store's 20:00-04:00.
 *
 * @param {Hours} hours
 * @param {number} minute
 * @param {CalendarDays} calendar
 * @returns {boolean}
 */
export function isOpen(hours, minute, calendar) {
  if (!hours) return true;
  const open = minutesOf(hours.open, calendar);
  const close = minutesOf(hours.close, calendar);
  return open > close ? (minute >= open || minute <= close) : (minute >= open && minute <= close);
}

/**
 * When a closed shop next opens, for the closed card ("opens at 7:00, in
 * about 3 hours"). Always open (`hours` null) opens right now, at minute 0.
 *
 * @param {Hours} hours
 * @param {number} minute  The current minute of day.
 * @param {CalendarDays} calendar
 * @returns {{opensAt: number, inMinutes: number}}  `opensAt` is a minute of
 *   day; `inMinutes` is 0 while already open.
 */
export function nextOpen(hours, minute, calendar) {
  if (!hours) return { opensAt: 0, inMinutes: 0 };
  const opensAt = minutesOf(hours.open, calendar);
  if (isOpen(hours, minute, calendar)) return { opensAt, inMinutes: 0 };
  const minutesPerDay = calendar.minutesPerHour * calendar.hoursPerDay;
  const inMinutes = opensAt > minute ? opensAt - minute : minutesPerDay - minute + opensAt;
  return { opensAt, inMinutes };
}

const secondsPerDay = calendar => calendar.secondsPerMinute * calendar.minutesPerHour * calendar.hoursPerDay;

/** `worldTime`'s minute of day, on this calendar. */
function minuteOfDayAt(worldTime, calendar) {
  const minutesPerDay = calendar.minutesPerHour * calendar.hoursPerDay;
  const minutes = Math.floor(worldTime / calendar.secondsPerMinute);
  // A floor-mod, not `%`: worldTime may be negative (before the epoch).
  return ((minutes % minutesPerDay) + minutesPerDay) % minutesPerDay;
}

/**
 * Whether a shop with `hours` opens at some point in `(previous, now]`.
 *
 * A span of a whole day or more is guaranteed to pass every shop's opening at
 * least once, so it counts without walking each day inside it — that walk is
 * what would turn a skipped week into seven restocks instead of one. Always
 * open (`hours` null) is treated as opening once, at the start of each day.
 */
function opensDuring(hours, previous, now, calendar) {
  if (now - previous >= secondsPerDay(calendar)) return true;
  const wasMinute = minuteOfDayAt(previous, calendar);
  const nowMinute = minuteOfDayAt(now, calendar);
  if (!hours) return nowMinute < wasMinute;
  return !isOpen(hours, wasMinute, calendar) && isOpen(hours, nowMinute, calendar);
}

/**
 * The next `worldTime` a restock is due, `every` days after `from`. A dice
 * formula is rolled once, here, rather than re-rolled on every check — so
 * call this only when actually setting the next due date: at setup, and again
 * each time {@link dueRestock} fires.
 *
 * @param {number|"never"} every
 * @param {number} from
 * @param {CalendarDays} calendar
 * @param {(formula: string) => number} roll  Only called for a dice `every`.
 * @returns {number|null}  null for "never".
 */
export function nextDue(every, from, calendar, roll) {
  if (every === "never") return null;
  const days = typeof every === "number" ? every : roll(every);
  return from + days * secondsPerDay(calendar);
}

/**
 * Whether a shop's scheduled restock fires between `previous` and `now`, and
 * the {@link ScheduleState} to store either way.
 *
 * It fires the first time the shop opens on or after `state.dueAt`. Rewinding
 * the clock (`now` at or before `previous`) never fires, whatever `dueAt`
 * says. `restock.onOpen: false` or `restock.every: "never"` never fires
 * either — those shops restock only by hand.
 *
 * @param {Restock} restock
 * @param {Hours} hours
 * @param {ScheduleState} state  `state.dueAt` must already be set (by
 *   {@link nextDue}, at setup) for a restock to ever fire.
 * @param {number} previous
 * @param {number} now
 * @param {CalendarDays} calendar
 * @param {(formula: string) => number} roll
 * @returns {{due: boolean, state: ScheduleState}}
 */
export function dueRestock(restock, hours, state, previous, now, calendar, roll) {
  if (now <= previous) return { due: false, state };
  if (!restock?.onOpen || restock.every === "never" || state?.dueAt == null) return { due: false, state };
  if (now < state.dueAt) return { due: false, state };
  if (!opensDuring(hours, previous, now, calendar)) return { due: false, state };
  return { due: true, state: { lastRestock: now, dueAt: nextDue(restock.every, now, calendar, roll) } };
}
