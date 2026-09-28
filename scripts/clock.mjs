/**
 * Whether shops keep time (#149): trading hours, scheduled restocks, "Fresh stock today" and the
 * dates on a bill and a receipt all run on Foundry's world clock. dnd5e's calendar can be off (it
 * is, until a GM picks one), and then nothing may ever move the clock: a shop open 07:00–19:00
 * would sit closed at midnight for good. The world setting *Shops follow the world clock* decides,
 * and Auto reads the world. Foundry-free, so tools/clock.test.mjs runs it under plain Node.
 */

/** The world setting's choices; the first is the default. */
export const FOLLOW_CLOCK_MODES = Object.freeze(["auto", "always", "never"]);

/**
 * Whether shops follow the world clock. Auto follows it where anything keeps time: dnd5e's
 * calendar is on, a calendar module (Calendaria) has replaced dnd5e's calendar, or the clock has
 * moved at all (a world nobody keeps time in sits at 0; a GM moving it with another tool doesn't).
 * An unknown mode reads as Auto.
 *
 * @param {string} mode  the setting: "auto", "always" or "never"
 * @param {{calendarEnabled: boolean, calendarReplaced: boolean, worldTime: number}} world
 * @returns {boolean}
 */
export function followsClock(mode, { calendarEnabled, calendarReplaced, worldTime }) {
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !!calendarEnabled || !!calendarReplaced || (Number.isFinite(worldTime) && worldTime !== 0);
}

/**
 * `followsClock` for this world, read live (the clock moves, and Auto reads it): the module's
 * setting over dnd5e's calendar switch, whether a module replaced dnd5e's calendar (anything other
 * than its own `CalendarData5e`, which it also sets as the earth calendar, or one of its listed
 * calendars' classes), and the world time. Needs Foundry's `game` and `CONFIG`.
 */
export function worldFollowsClock(g = globalThis.game, config = globalThis.CONFIG) {
  const read = (scope, key) => { try { return g.settings.get(scope, key); } catch { return undefined; } };
  const own = [config?.time?.earthCalendarClass, ...(config?.DND5E?.calendar?.calendars ?? []).map(c => c.class)].filter(Boolean);
  const current = config?.time?.worldCalendarClass;
  return followsClock(read("merchant-presets", "followClock"), {
    calendarEnabled: !!read("dnd5e", "calendarConfig")?.enabled,
    calendarReplaced: !!current && own.length > 0 && !own.includes(current),
    worldTime: g?.time?.worldTime
  });
}
