/**
 * Trading hours and the #105 restock schedule, kept free of Foundry so they
 * can be tested with plain Node (tools/schedule.test.mjs).
 *
 * Every function here takes the world clock's own numbers rather than
 * `game.time.calendar` itself, so the runtime can pass `game.time.calendar.days`
 * straight through: `{secondsPerMinute, minutesPerHour, hoursPerDay}`.
 * `worldTime` itself is treated as possibly fractional throughout — Foundry's
 * `game.time.advance` accepts fractions of a second — so nothing here assumes
 * a whole-second grid.
 *
 * Nothing here rolls dice, on purpose. Foundry's own dice are asynchronous
 * (`new Roll(formula).evaluate()`, exactly as `rollStock` already does for
 * the existing engine — `merchant-presets.mjs:72`); `Roll#evaluateSync`
 * refuses anything non-deterministic and throws. A pure, synchronous module
 * cannot call an async roller, so nothing here is handed one — callers roll
 * first and pass in an already-resolved number:
 * - {@link intervalOf} sorts a shop's `restock.every` into what still needs
 *   rolling.
 * - {@link dueRestock} hands back `nextEvery` unresolved; the caller rolls it
 *   (via `intervalOf`, if it turns out to be a formula) and calls
 *   {@link scheduleNext} with the result.
 * - {@link planRestock}'s `draws` carry their own already-rolled `quantity`.
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
 *   {@link lastOpeningAtOrBefore}).
 */
function openingOnDay(day, hours, calendar) {
  const offset = hours ? minutesOf(hours.open, calendar) * calendar.secondsPerMinute : 0;
  return day * secondsPerDay(calendar) + offset;
}

/** The latest of `hours`'s daily openings at or before `bound`. */
function lastOpeningAtOrBefore(bound, hours, calendar) {
  const day = secondsPerDay(calendar);
  const offset = hours ? minutesOf(hours.open, calendar) * calendar.secondsPerMinute : 0;
  return openingOnDay(Math.floor((bound - offset) / day), hours, calendar);
}

/**
 * The most recent instant a shop with `hours` opens in `(previous, now]`, on
 * or after `dueAt` — or null if there isn't one.
 *
 * Computed straight from the daily opening instant, not by sampling
 * `previous` and `now`'s own open/closed state: an interval under a day long
 * can open *and* close inside it, leaving both ends closed (or, for an
 * overnight shop, both ends open) with no opening visible at either sample
 * point. The single candidate — the latest opening at or before `now` — is
 * tested against `previous` with a strict `>`, not `previous + 1`: `worldTime`
 * may be fractional, so there is no smallest step to add.
 *
 * The *most recent* qualifying opening, not the first: a jump can cross
 * several due openings (a shop checked only once a session, say), and only
 * one restock ever fires for it — anchoring on an early one it has already
 * passed would leave the *next* due day in the past too, firing again on the
 * very next tick even though the shop had, in world time, just restocked.
 */
function nextOpening(hours, dueAt, previous, now, calendar) {
  const at = lastOpeningAtOrBefore(now, hours, calendar);
  return at > previous && at >= dueAt ? at : null;
}

/**
 * The `worldTime` a restock is next due: midnight, `days` after the start of
 * `from`'s own day. Midnight, not `from` itself, so a restock that happens to
 * run late in the day (a clock check that lands at 07:05, past a 07:00
 * opening) still falls due at the following due day's *opening*, not one
 * whole day later than that — #105 fires "on the due day", not at the
 * anchor's exact time of day. `days` is floored and given a minimum of 1: a
 * fractional roll (a formula like "1d6/2" landing on 1.5) still lands on a
 * whole due day, at midnight, not partway through one; a restock cannot be
 * due before it starts.
 *
 * @param {number} days  Already resolved — see the header on rolling
 *   `restock.every` first, via {@link intervalOf}.
 * @param {number} from
 * @param {CalendarDays} calendar
 * @returns {number}
 */
export function nextDue(days, from, calendar) {
  const whole = Math.max(1, Math.floor(days));
  const day = secondsPerDay(calendar);
  return Math.floor(from / day) * day + whole * day;
}

/**
 * Sorts a shop's `restock.every` into what the caller still needs to do with
 * it, since this module can't roll dice itself (see the header).
 *
 * @param {number|string} every  A whole number of days, a dice formula, or
 *   the literal "never".
 * @returns {{days: number}|{formula: string}|null}  `{days}` is ready for
 *   {@link nextDue}/{@link scheduleNext} as it is; `{formula}` needs rolling
 *   first; null means "never" — no schedule at all.
 */
export function intervalOf(every) {
  if (every === "never") return null;
  return typeof every === "number" ? { days: every } : { formula: every };
}

/**
 * The {@link ScheduleState} after a restock fires at `at`, given the number
 * of days until the next one is due — already resolved (rolled, if
 * `restock.every` is a dice formula; see {@link intervalOf}).
 *
 * @param {number} at  The `worldTime` {@link dueRestock} fired at.
 * @param {number} days
 * @param {CalendarDays} calendar
 * @returns {ScheduleState}
 */
export function scheduleNext(at, days, calendar) {
  return { lastRestock: at, dueAt: nextDue(days, at, calendar) };
}

/**
 * Whether a shop's scheduled restock fires between `previous` and `now`.
 *
 * It fires at the most recent instant the shop opens on or after
 * `state.dueAt` (see {@link nextOpening}) — so a gap that skips several due
 * openings still gives exactly one restock, anchored at the *last* of them
 * rather than the first (or at `now`), and the following due day counts from
 * there too — not from an opening already behind `now`, which would leave
 * the shop due again on the very next tick. Rewinding the clock (`now` at or
 * before `previous`) never fires, whatever `dueAt` says.
 * `restock.onOpen: false`, `restock.every: "never"`, or `restock.table: null`
 * (no stock table assigned — a fresh custom shop, say) never fire either;
 * those shops restock only by hand, if at all.
 *
 * Rolls nothing itself (see the header): on a fire, call {@link scheduleNext}
 * with `nextEvery` resolved to a whole number of days — rolling it first, via
 * {@link intervalOf}, if it's a dice formula — to get the state to store.
 *
 * @param {object} shop  The stored `flags.merchant-presets.shop`, complete or
 *   not — completed here via `shopFrom` before anything is read from it.
 * @param {ScheduleState} state  `state.dueAt` must already be set (by
 *   {@link nextDue}, at setup) for a restock to ever fire.
 * @param {number} previous
 * @param {number} now
 * @param {CalendarDays} calendar
 * @returns {{due: boolean, at: number|null, nextEvery: number|string|null}}
 *   `at` is the `worldTime` it fired at; `nextEvery` is `restock.every`,
 *   unresolved, for {@link scheduleNext}. Both null when `due` is false.
 */
export function dueRestock(shop, state, previous, now, calendar) {
  if (now <= previous) return { due: false, at: null, nextEvery: null };
  const { restock, hours } = shopFrom(shop);
  if (!restock.onOpen || restock.every === "never" || restock.table == null || state?.dueAt == null) {
    return { due: false, at: null, nextEvery: null };
  }
  const at = nextOpening(hours, state.dueAt, previous, now, calendar);
  if (at == null) return { due: false, at: null, nextEvery: null };
  return { due: true, at, nextEvery: restock.every };
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
 * @typedef {object} Draw  One of the shop's stock table results, resolved
 *   and pre-rolled by the caller — drawing the table, and rolling its
 *   quantity formula, are both Foundry operations (the second one async; see
 *   the header) this module has no part in.
 * @property {string} name  The compendium document's name — how a draw is
 *   matched to an existing shelf item, mirroring `itemFlags`/`containers`
 *   (#99), which are keyed by name for the same reason.
 * @property {object} data  The compendium document's own plain data (`type`,
 *   `system`, `img`, its own `flags`, …) to build the embedded copy from.
 * @property {number} quantity  This restock's already-rolled quantity for a
 *   fresh copy of this line — used as-is for a reroll, or for a topup line
 *   that turns out to need drawing. Unused for a container, whose count comes
 *   from `context.containers` instead of a roll.
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
/**
 * Something this shop's restocks drew, as opposed to something the GM added by hand, or a good
 * another shop drew that was sold here (Item Piles copies every flag). `drawn` holds the shelf
 * key of the shop that drew it (`context.drawnBy`); a bare `true` (from before it held one)
 * counts as this shop's.
 */
const isDrawn = (item, drawnBy) => {
  const by = item.flags?.["merchant-presets"]?.drawn;
  return by === true || (by != null && by === drawnBy);
};

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
    // The shop's record wins; a line it has none for keeps the config its good ships with.
    "merchant-presets": { ...data.flags?.["merchant-presets"], drawn: context.drawnBy ?? true,
      stock: context.stockFlags[draw.name] ?? data.flags?.["merchant-presets"]?.stock }
  };
  return data;
}

/**
 * The till's new gp — never below the shop's starting purse, but a surplus
 * (say, from a big trade-in) is left alone: "refills to the starting purse"
 * reads as a floor, not a reset back down. `null` when it's already there, or
 * when there's nothing to refill *to*: a missing or invalid `context.purse`
 * leaves the till untouched rather than writing `NaN`. A missing
 * `context.currentGp` reads as an empty till (0), not as "already full".
 */
function refilledPurse(context) {
  if (!Number.isFinite(context.purse)) return null;
  const current = Number.isFinite(context.currentGp) ? context.currentGp : 0;
  const gp = Math.max(current, context.purse);
  return gp === current ? null : gp;
}

/** Draws that share a name collapse to the first — one line, one item, even
 * if the table names it twice; the caller's own draw list decides which
 * copy that is. */
function dedupedByName(draws) {
  const seen = new Map();
  for (const draw of draws) if (!seen.has(draw.name)) seen.set(draw.name, draw);
  return [...seen.values()];
}

/**
 * What one restock changes on a shop's shelf — item deletes, creates and
 * updates, the till, and which lines it touched. The caller does what this
 * can't: draw the shop's stock table, roll each draw's quantity (see the
 * header), and apply the plan.
 *
 * A restock only ever touches what it (or an earlier restock, or the build)
 * drew itself — every created item is stamped {@link isDrawn}. Anything the
 * GM added by hand, and the shopkeeper's own gear ({@link isGear}), is never
 * deleted, updated, or counted as sold out (#105).
 *
 * `shop.restock.mode` decides the shape of the change:
 * - `"reroll"` (the default): everything this shop drew is replaced, a line
 *   since dropped from its table included — the shelf comes back exactly as
 *   if the shop had just been dragged in fresh. A good another shop drew
 *   stays (see {@link isDrawn}).
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
 * `restock.table: null` (no stock table assigned) is a no-op: an empty plan,
 * nothing deleted, refilled or drawn.
 *
 * A `draws` line with a name shared by an earlier line collapses to that
 * earlier one, in both modes: one line, one item.
 *
 * @param {object} shop  The stored `flags.merchant-presets.shop`, complete or
 *   not — completed here via `shopFrom` before anything is read from it.
 * @param {Item[]} items  The shop's current embedded items.
 * @param {Draw[]} draws  This restock's table draw, already rolled.
 * @param {RestockContext} context
 * @returns {RestockPlan}
 */
export function planRestock(shop, items, draws, context) {
  const { restock } = shopFrom(shop);
  if (restock.table == null) return { deletes: [], creates: [], updates: [], currency: null, restocked: [] };

  const uniqueDraws = dedupedByName(draws);
  const drawnNow = items.filter(i => !isGear(i) && isDrawn(i, context.drawnBy));
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
    for (const draw of uniqueDraws) {
      if (draw.data.type === "container") {
        const have = drawnNow.filter(i => i.name === draw.name).length;
        const want = context.containers?.[draw.name] ?? 1;
        for (let n = have; n < want; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
        if (want > have) restocked.push(draw.name);
        continue;
      }
      const existing = drawnNow.find(i => i.name === draw.name);
      if (existing && existing.system?.quantity !== 0) continue;   // still in stock: leave it
      const quantity = Math.max(0, draw.quantity ?? 0);
      if (quantity === 0) continue;   // drew empty again: leave it sold out (or absent)
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
  for (const draw of uniqueDraws) {
    if (draw.data.type === "container") {
      const count = context.containers?.[draw.name] ?? 1;
      for (let n = 0; n < count; n++) creates.push(drawnItem(draw, context, { quantity: 1, container: null }));
      continue;
    }
    const quantity = Math.max(0, draw.quantity ?? 0);
    if (quantity > 0) creates.push(drawnItem(draw, context, { quantity }));   // 0: not in stock today
  }
  // One mention per line: a container's several copies share its one name.
  const restocked = [...new Set(creates.map(c => c.name))];
  return { deletes: drawnNow.map(i => i._id), creates, updates: [], currency, restocked };
}

/* ------------------------------------------------------------------ the runtime's first restock (#105) */

/**
 * The item updates that stamp a shop's existing shelf as drawn, for its first
 * native restock. Nothing has stamped `drawn` before (the build doesn't, and
 * 1.x restocked through Item Piles), so without this a reroll would delete
 * nothing and add a second shelf. A non-gear item whose name is one of the
 * stock table's lines counts as drawn, just as a 1.x restock replaced it; a
 * good the GM added under any other name stays theirs.
 *
 * @param {Item[]} items  The shop's embedded items, plainly.
 * @param {string[]} tableNames  The names of its stock table's lines.
 * @param {string} drawnBy  The shop's shelf key, which `drawn` records.
 * @returns {object[]}  `{_id, "flags.merchant-presets.drawn": drawnBy}` updates. A good that
 *   already names a shop (another's, sold here) is left alone.
 */
export function adoptDrawn(items, tableNames, drawnBy) {
  const names = new Set(tableNames);
  return items
    .filter(i => !isGear(i) && i.flags?.["merchant-presets"]?.drawn == null && names.has(i.name))
    .map(i => ({ _id: i._id, "flags.merchant-presets.drawn": drawnBy }));
}

/**
 * What a shop remembers of each line it drew, `name -> {stock, piles}` (its #98 stock config and
 * Item Piles' own flags), refreshed from the shelf at every restock: a line that rolls 0 or sells
 * out and leaves the shelf comes back with the GM's settings rather than the defaults (#135
 * review). Lines no longer on the shelf keep what was remembered before.
 *
 * A list of `{name, stock?, piles?}`, not an object keyed by name: Foundry expands a key with a
 * dot in it into a path, and a GM's own line may well be called "Scroll (Lvl. 1)".
 *
 * @param {{name: string, stock?: object, piles?: object}[]|undefined} previous
 * @param {Item[]} items
 * @param {string} drawnBy
 * @returns {{name: string, stock?: object, piles?: object}[]}
 */
export function lineMemory(previous, items, drawnBy) {
  const memory = new Map((Array.isArray(previous) ? previous : []).filter(l => typeof l?.name === "string").map(l => [l.name, l]));
  for (const item of items) {
    if (isGear(item) || !isDrawn(item, drawnBy)) continue;
    const line = { name: item.name };
    if (item.flags?.["merchant-presets"]?.stock) line.stock = item.flags["merchant-presets"].stock;
    if (item.flags?.["item-piles"]) line.piles = item.flags["item-piles"];
    memory.set(item.name, line);
  }
  return [...memory.values()];
}

/**
 * {@link planRestock}'s `context.stockFlags` for this restock's `draws`: each
 * line's stock config as the shelf holds it now, so a GM's direct edit (hidden,
 * infinite, a category) survives a reroll that replaces the item (#119's
 * done-when on #105). A line not on the shelf at all (a `keep: false` good that
 * sold out) falls back to `fromRecord(name)`, the shop's recorded Item Piles
 * flags derived the way the migration does. A line neither knows is left out:
 * its copy then reads as the defaults.
 *
 * @param {Item[]} items
 * @param {{name: string}[]} draws
 * @param {(name: string) => object|undefined} fromRecord
 * @param {string} drawnBy  The shop's shelf key.
 * @returns {Record<string, object>}
 */
export function restockStockFlags(items, draws, fromRecord, drawnBy) {
  const flags = {};
  for (const { name } of draws) {
    // This shop's own copy only: a same-named good the GM added, or another shop drew, isn't the line.
    const live = items.find(i => !isGear(i) && isDrawn(i, drawnBy) && i.name === name && i.flags?.["merchant-presets"]?.stock);
    const stock = live?.flags["merchant-presets"].stock ?? fromRecord(name);
    if (stock) flags[name] = stock;
  }
  return flags;
}

/**
 * The {@link ScheduleState} for a shop the schedule sees for the first time:
 * due `days` whole days on (see {@link nextDue}), counting from `now`'s own
 * day, with nothing restocked yet. No restock fires on first sight, so a
 * world loaded after a long gap doesn't restock every shop at once.
 *
 * @param {number} now
 * @param {number} days  Already resolved (see {@link intervalOf}).
 * @param {CalendarDays} calendar
 * @returns {ScheduleState}
 */
export function initialSchedule(now, days, calendar) {
  return { lastRestock: now, dueAt: nextDue(days, now, calendar) };
}
