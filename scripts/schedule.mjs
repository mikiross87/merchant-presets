/**
 * Trading hours and the #105 restock schedule, kept free of Foundry so they
 * can be tested with plain Node (tools/schedule.test.mjs).
 *
 * Every function here takes the world clock's own numbers rather than
 * `game.time.calendar` itself, so the runtime can pass `game.time.calendar.days`
 * straight through: `{secondsPerMinute, minutesPerHour, hoursPerDay}`. A
 * minute-of-day is always a whole number in `[0, minutesPerHour*hoursPerDay)`.
 *
 * `dueRestock` and `planRestock` take the *raw* stored `flags.merchant-presets.shop`
 * — whatever partial shape a GM's world flag happens to be in, straight off
 * the actor — and complete it themselves through schema.mjs's `shopFrom`
 * before reading anything out of it. The #98 schema allows every key but
 * `version` to be missing, defaults filled in on read; reading `restock.mode`
 * or `.onOpen` straight off an incomplete flag would throw on a shop with no
 * `restock` at all, or misread a missing `onOpen` as `false` rather than its
 * default `true`. `shopFrom` also throws on a genuinely invalid flag, which
 * is exactly the point: better a loud error than a half-guessed schedule.
 *
 * @typedef {{secondsPerMinute: number, minutesPerHour: number, hoursPerDay: number}} CalendarDays
 * @typedef {{hour: number, minute: number}} Time
 * @typedef {{open: Time, close: Time}|null} Hours  A completed #98 shop config's `hours`; null is always open.
 * @typedef {{lastRestock: number, dueAt: number|null}} ScheduleState  What a shop needs stored between checks.
 */

import { shopFrom } from "./schema.mjs";

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

/**
 * A shop with `hours` opens exactly once a day: at `hours.open`, or at
 * midnight when always open. An overnight window (20:00-04:00) still opens
 * once, in the evening — the small hours it also covers are the same open
 * stretch carrying over from the day before, not a second opening.
 *
 * @returns {number}  The `worldTime` of `day`'s own opening (`day` counts
 *   whole days from the calendar's epoch, and may be fractional; see
 *   {@link firstOpeningAtOrAfter}).
 */
function openingOnDay(day, hours, calendar) {
  const offset = hours ? minutesOf(hours.open, calendar) * calendar.secondsPerMinute : 0;
  return day * secondsPerDay(calendar) + offset;
}

/** The earliest of `hours`'s daily openings at or after `bound`. */
function firstOpeningAtOrAfter(bound, hours, calendar) {
  const day = secondsPerDay(calendar);
  const offset = hours ? minutesOf(hours.open, calendar) * calendar.secondsPerMinute : 0;
  return openingOnDay(Math.ceil((bound - offset) / day), hours, calendar);
}

/**
 * The first instant a shop with `hours` opens in `(previous, now]`, on or
 * after `dueAt` — or null if there isn't one.
 *
 * Computed straight from the daily opening instant, not by sampling
 * `previous` and `now`'s own open/closed state: an interval under a day long
 * can open *and* close inside it, leaving both ends closed (or, for an
 * overnight shop, both ends open) with no opening visible at either sample
 * point, and a jump of a day or more can carry an opening that arrives
 * before `dueAt` and so doesn't count. `worldTime` is always a whole number
 * of seconds, so `previous + 1` is the first instant strictly after it.
 */
function nextOpening(hours, dueAt, previous, now, calendar) {
  const at = firstOpeningAtOrAfter(Math.max(previous + 1, dueAt), hours, calendar);
  return at <= now ? at : null;
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
 * It fires at the first instant the shop opens on or after `state.dueAt` (see
 * {@link nextOpening}) — so a skipped week still gives exactly one restock,
 * anchored at that first opening rather than at `now`, and `nextDue`'s next
 * due day counts from there too. Rewinding the clock (`now` at or before
 * `previous`) never fires, whatever `dueAt` says. `restock.onOpen: false` or
 * `restock.every: "never"` never fires either — those shops restock only by
 * hand.
 *
 * @param {object} shop  The stored `flags.merchant-presets.shop`, complete or
 *   not — completed here via `shopFrom` before anything is read from it.
 * @param {ScheduleState} state  `state.dueAt` must already be set (by
 *   {@link nextDue}, at setup) for a restock to ever fire.
 * @param {number} previous
 * @param {number} now
 * @param {CalendarDays} calendar
 * @param {(formula: string) => number} roll
 * @returns {{due: boolean, at: number|null, state: ScheduleState}}  `at` is
 *   the `worldTime` it fired at — the same value stamped into `state` as the
 *   new `lastRestock` — or null when `due` is false.
 */
export function dueRestock(shop, state, previous, now, calendar, roll) {
  if (now <= previous) return { due: false, at: null, state };
  const { restock, hours } = shopFrom(shop);
  if (!restock.onOpen || restock.every === "never" || state?.dueAt == null) return { due: false, at: null, state };
  const at = nextOpening(hours, state.dueAt, previous, now, calendar);
  if (at == null) return { due: false, at: null, state };
  return { due: true, at, state: { lastRestock: at, dueAt: nextDue(restock.every, at, calendar, roll) } };
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
 * - `"topup"`: only a drawn line the shop has actually sold through is drawn
 *   again; everything still genuinely in stock is untouched. This is driven
 *   by `draws` — the table's own lines — not by what is sitting on the
 *   shelf: a sold-out line may still be there at `quantity: 0` (`keep: true`
 *   goods sit at zero rather than vanish) or may already be gone entirely
 *   (a `keep: false` good is deleted outright the moment it sells out, and so
 *   is any good that simply rolled 0 last time). Either way counts as sold
 *   out. One still on the shelf is *updated* (same item, refilled); one
 *   that's gone is a fresh *create*. A container is always a create when
 *   short of its target count — dnd5e pins its quantity to exactly 1, so a
 *   sold one is gone outright, never sitting at zero to update.
 *
 * @param {object} shop  The stored `flags.merchant-presets.shop`, complete or
 *   not — completed here via `shopFrom` before anything is read from it.
 * @param {Item[]} items  The shop's current embedded items.
 * @param {Draw[]} draws  This restock's table draw.
 * @param {RestockContext} context
 * @param {(formula: string) => number} roll
 * @returns {RestockPlan}
 */
export function planRestock(shop, items, draws, context, roll) {
  const { restock } = shopFrom(shop);
  const drawnNow = items.filter(i => !isGear(i) && isDrawn(i));
  const currency = refilledPurse(context);

  if (restock.mode === "topup") {
    const updates = [];
    const creates = [];
    const restocked = [];

    // Driven by the table's own lines, not shelf presence: a sold-out line
    // may still be sitting there at quantity 0 (keep: true), or may already
    // be gone entirely (keep: false deletes it outright when it sells out —
    // and so does a line that simply rolled 0 last time). Either way it's
    // due; only a line still genuinely in stock is skipped.
    for (const draw of draws) {
      if (draw.data.type === "container") {
        const have = drawnNow.filter(i => i.name === draw.name).length;
        const want = context.containers?.[draw.name] ?? 1;
        for (let n = have; n < want; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
        if (want > have) restocked.push(draw.name);
        continue;
      }
      const existing = drawnNow.find(i => i.name === draw.name);
      if (existing && existing.system?.quantity !== 0) continue;   // still in stock: leave it
      const quantity = Math.max(0, roll(restock.quantities[draw.resultId] ?? "1"));
      if (quantity === 0) continue;   // rolled empty again: leave it sold out (or absent)
      if (existing) {
        updates.push({ _id: existing._id, "system.quantity": quantity,
          "flags.merchant-presets.stock": context.stockFlags[draw.name] });
      } else {
        creates.push(drawnItem(draw, context, { quantity }));
      }
      restocked.push(draw.name);
    }

    // A container can push its own name once per copy created; every other
    // line pushes at most once already. Same rule either way: one mention
    // per line, in the order it was first touched.
    return { deletes: [], creates, updates, currency, restocked: [...new Set(restocked)] };
  }

  // reroll: the whole drawn shelf comes back fresh.
  const creates = [];
  for (const draw of draws) {
    if (draw.data.type === "container") {
      const count = context.containers?.[draw.name] ?? 1;
      for (let n = 0; n < count; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
      continue;
    }
    const quantity = Math.max(0, roll(restock.quantities[draw.resultId] ?? "1"));
    if (quantity > 0) creates.push(drawnItem(draw, context, { quantity }));   // 0: not in stock today
  }
  // One mention per line: a container's several copies share its one name.
  const restocked = [...new Set(creates.map(c => c.name))];
  return { deletes: drawnNow.map(i => i._id), creates, updates: [], currency, restocked };
}
