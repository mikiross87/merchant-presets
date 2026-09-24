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
 * The `worldTime` a restock is next due: midnight, `every` days after the
 * start of `from`'s own day. Midnight, not `from` itself, so a restock that
 * happens to run late in the day (a clock check that lands at 07:05, past a
 * 07:00 opening) still falls due at the following due day's *opening*, not
 * one whole day later than that — #105 fires "on the due day", not at the
 * anchor's exact time of day. A dice formula is rolled once, here, rather
 * than re-rolled on every check — so call this only when actually setting the
 * next due date: at setup, and again each time {@link dueRestock} fires. A
 * roll below 1 (e.g. "1d2-1") floors to 1 day: a restock cannot be due
 * before it starts.
 *
 * @param {number|"never"} every
 * @param {number} from
 * @param {CalendarDays} calendar
 * @param {(formula: string) => number} roll  Only called for a dice `every`.
 * @returns {number|null}  null for "never".
 */
export function nextDue(every, from, calendar, roll) {
  if (every === "never") return null;
  const days = Math.max(1, typeof every === "number" ? every : roll(every));
  const day = secondsPerDay(calendar);
  return Math.floor(from / day) * day + days * day;
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

/* ------------------------------------------------------------------ restock plan (#105) */

/**
 * @typedef {object} Item  A shop's embedded item, plainly — `actor.items.map(i => i.toObject())`.
 * @property {string} _id
 * @property {string} name
 * @property {string} type
 * @property {{quantity?: number, container?: string|null}} system
 * @property {{"merchant-presets"?: {kind?: string, drawn?: boolean}}} flags
 *
 * @typedef {object} Draw  One of the shop's stock table results, already
 *   resolved by the caller — drawing the table is a Foundry operation this
 *   module has no part in.
 * @property {string} resultId  The TableResult's id, to look up its quantity
 *   formula in `shop.restock.quantities`.
 * @property {string} name      The compendium document's name — how a draw is
 *   matched to an existing shelf item, mirroring `itemFlags`/`containers`
 *   (#99), which are keyed by name for the same reason.
 * @property {object} data      The compendium document's own plain data
 *   (`type`, `system`, `img`, its own `flags`, …) to build the embedded copy
 *   from.
 *
 * @typedef {object} RestockContext
 * @property {number} purse    `flags.merchant-presets.purse`: the shop's starting gp.
 * @property {number} currentGp  The shop's current `system.currency.gp`.
 * @property {Record<string, object>} stockFlags  Item name -> its full #98
 *   stock config, from the shop's own record — not the compendium good's own
 *   copy, which `sync_goods_stock` can leave stale once a recipe changes
 *   (#119 point 1). Stamped in full onto every item this plan creates.
 * @property {Record<string, number>} containers  Item name -> how many
 *   separate copies the shop should carry (`flags.merchant-presets.containers`,
 *   #63): a container can't hold a quantity, so a count of them is a count of
 *   documents, not a number on one.
 *
 * @typedef {object} RestockPlan
 * @property {string[]} deletes   Item ids to delete.
 * @property {object[]} creates   New embedded item data to create.
 * @property {object[]} updates   `{_id, ...}` partial updates (topup's refills).
 * @property {number|null} currency  The till's new `system.currency.gp`, or
 *   null if it's already right.
 * @property {string[]} restocked  Names of the lines this restock drew or
 *   topped up — the shop's own log line, and dnd5e's time-passed card (#88).
 */

/** The shopkeeper's own kit, never stock. */
const isGear = item => item.flags?.["merchant-presets"]?.kind === "gear";
/** Something an earlier restock (or the build) drew, as opposed to something the GM added by hand. */
const isDrawn = item => item.flags?.["merchant-presets"]?.drawn === true;

/**
 * One fresh embedded copy of `draw`, stamped drawn and carrying its full #98
 * stock config — `context.stockFlags[draw.name]`, the shop's own record, not
 * whatever the compendium good's own copy says (#119 point 1). `system`
 * overrides the copy's quantity (and, for a container, drops its `container`
 * pointer — #89).
 */
function drawnItem(draw, context, system) {
  const data = structuredClone(draw.data);
  delete data._id;
  data.system = { ...data.system, ...system };
  data.flags = {
    ...data.flags,
    "merchant-presets": { ...data.flags?.["merchant-presets"], drawn: true, stock: context.stockFlags[draw.name] }
  };
  return data;
}

/**
 * The till's new gp — never below the shop's starting purse, but a surplus
 * (say, from a big trade-in) is left alone: "refills to the starting purse"
 * reads as a floor, not a reset back down. `null` when it's already there.
 */
function refilledPurse(context) {
  const gp = Math.max(context.currentGp, context.purse);
  return gp === context.currentGp ? null : gp;
}

/**
 * What one restock changes on a shop's shelf — item deletes, creates and
 * updates, the till, and which lines it touched. The caller does the two
 * things this can't: draw the shop's stock table, and apply the plan.
 *
 * A restock only ever touches what it (or an earlier restock, or the build)
 * drew itself — every created item is stamped {@link isDrawn}. Anything the
 * GM added by hand, and the shopkeeper's own gear ({@link isGear}), is never
 * deleted, updated, or counted as sold out (#105).
 *
 * `shop.restock.mode` decides the shape of the change:
 * - `"reroll"` (the default): every drawn item is replaced — the shelf comes
 *   back exactly as if the shop had just been dragged in fresh.
 * - `"topup"`: only a drawn line the shop has actually sold through — an
 *   ordinary good sitting at `quantity: 0`, or a container short of its
 *   target count — is drawn again, in place; everything else on the shelf is
 *   untouched. A sold-out good is *updated* (same item, refilled), not
 *   replaced, since it is still there to update; a sold container is not —
 *   dnd5e pins its quantity to exactly 1, so one at zero doesn't exist to
 *   update, and a short container is always a create.
 *
 * @param {object} shop  The merchant's #98 `flags.merchant-presets.shop`.
 * @param {Item[]} items  The shop's current embedded items.
 * @param {Draw[]} draws  This restock's table draw.
 * @param {RestockContext} context
 * @param {(formula: string) => number} roll
 * @returns {RestockPlan}
 */
export function planRestock(shop, items, draws, context, roll) {
  const drawnNow = items.filter(i => !isGear(i) && isDrawn(i));
  const currency = refilledPurse(context);

  if (shop.restock.mode === "topup") {
    const byName = new Map(draws.map(d => [d.name, d]));
    const updates = [];
    const restocked = [];

    for (const item of drawnNow) {
      if (item.type === "container" || item.system?.quantity !== 0) continue;
      const draw = byName.get(item.name);
      if (!draw) continue;   // no longer on the stock table — nothing to refill it with
      const quantity = Math.max(0, roll(shop.restock.quantities[draw.resultId] ?? "1"));
      if (quantity === 0) continue;   // rolled empty again: leave it sold out
      updates.push({ _id: item._id, "system.quantity": quantity,
        "flags.merchant-presets.stock": context.stockFlags[item.name] });
      restocked.push(item.name);
    }

    const creates = [];
    for (const draw of draws.filter(d => d.data.type === "container")) {
      const have = drawnNow.filter(i => i.name === draw.name).length;
      const want = context.containers?.[draw.name] ?? 1;
      for (let n = have; n < want; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
      if (want > have) restocked.push(draw.name);
    }

    return { deletes: [], creates, updates, currency, restocked };
  }

  // reroll: the whole drawn shelf comes back fresh.
  const creates = [];
  for (const draw of draws) {
    if (draw.data.type === "container") {
      const count = context.containers?.[draw.name] ?? 1;
      for (let n = 0; n < count; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
      continue;
    }
    const quantity = Math.max(0, roll(shop.restock.quantities[draw.resultId] ?? "1"));
    if (quantity > 0) creates.push(drawnItem(draw, context, { quantity }));   // 0: not in stock today
  }
  return { deletes: drawnNow.map(i => i._id), creates, updates: [], currency, restocked: creates.map(c => c.name) };
}
