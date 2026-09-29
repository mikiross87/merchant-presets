import { test } from "node:test";
import assert from "node:assert/strict";
import { followsClock, FOLLOW_CLOCK_MODES, worldFollowsClock } from "../scripts/clock.mjs";

// #149: whether shops keep time — trading hours, scheduled restocks, fresh stock and dates.

const DAY = 86_400;
const idle = { calendarEnabled: false, calendarReplaced: false, worldTime: 0, daySeconds: DAY };

test("Always and Never override whatever the world's clock is doing (#149)", () => {
  assert.equal(followsClock("always", idle), true);
  assert.equal(followsClock("never", { calendarEnabled: true, calendarReplaced: true, worldTime: DAY, daySeconds: DAY }), false);
});

test("Auto follows the clock where dnd5e's calendar is on, a module drives the calendar, or a day has passed (#149)", () => {
  assert.equal(followsClock("auto", { ...idle, calendarEnabled: true }), true);
  assert.equal(followsClock("auto", { ...idle, calendarReplaced: true }), true, "a calendar module (Calendaria) runs time");
  assert.equal(followsClock("auto", { ...idle, worldTime: DAY + 3600 }), true, "a GM kept time with another tool");
  assert.equal(followsClock("auto", idle), false, "a world nobody keeps time in");
});

test("combat's rounds alone don't make Auto follow the clock: only a whole day does (#161 review)", () => {
  // Foundry moves the clock 6 s a round (dnd5e's CONFIG.time.roundTime) whatever the calendar says.
  assert.equal(followsClock("auto", { ...idle, worldTime: 6 * 500 }), false, "500 rounds of fighting");
  assert.equal(followsClock("auto", { ...idle, worldTime: DAY - 1 }), false);
  assert.equal(followsClock("auto", { ...idle, worldTime: DAY }), true);
  assert.equal(followsClock("auto", { ...idle, worldTime: 7200, daySeconds: 3600 }), true, "a calendar's own day length");
});

test("an unknown mode reads as Auto, the default (#149)", () => {
  assert.deepEqual(FOLLOW_CLOCK_MODES, ["auto", "always", "never"]);
  assert.equal(followsClock(undefined, idle), false);
  assert.equal(followsClock("bogus", { ...idle, worldTime: DAY }), true);
});

/** Foundry as dnd5e leaves it: its own calendar class set as both the earth and the world calendar. */
function foundry({ mode, enabled = false, worldTime = 0, worldClass } = {}) {
  class CalendarData5e {}
  class Harptos extends CalendarData5e {}
  const settings = { "merchant-presets.followClock": mode, "dnd5e.calendarConfig": { enabled } };
  return {
    game: { settings: { get: (s, k) => settings[`${s}.${k}`] }, time: { worldTime, calendar: { days: { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 } } } },
    config: { time: { earthCalendarClass: CalendarData5e, worldCalendarClass: worldClass === "module" ? class Calendaria {} : worldClass === "harptos" ? Harptos : CalendarData5e },
      DND5E: { calendar: { calendars: [{ value: "harptos", class: Harptos }] } } }
  };
}

test("the world's own answer reads dnd5e's switch, a replaced calendar and the clock (#149)", () => {
  const read = opts => { const f = foundry(opts); return worldFollowsClock(f.game, f.config); };
  assert.equal(read({ mode: "auto" }), false, "calendar off, dnd5e's own class, clock at 0");
  assert.equal(read({ mode: "auto", worldClass: "harptos" }), false, "a dnd5e calendar isn't a module's");
  assert.equal(read({ mode: "auto", worldClass: "module" }), true);
  assert.equal(read({ mode: "auto", enabled: true }), true);
  assert.equal(read({ mode: "auto", worldTime: 60 }), false, "a round or ten of combat");
  assert.equal(read({ mode: "auto", worldTime: DAY }), true);
  assert.equal(read({ mode: "always" }), true);
});

test("a dnd5e without a calendar setting reads as calendar off, not an error (#149)", () => {
  const game = { settings: { get: (s) => { if (s === "dnd5e") throw new Error("not registered"); return "auto"; } }, time: { worldTime: 0 } };
  assert.equal(worldFollowsClock(game, {}), false);
});
