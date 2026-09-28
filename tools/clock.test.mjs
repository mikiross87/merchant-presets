import { test } from "node:test";
import assert from "node:assert/strict";
import { followsClock, FOLLOW_CLOCK_MODES, worldFollowsClock } from "../scripts/clock.mjs";

// #149: whether shops keep time — trading hours, scheduled restocks, fresh stock and dates.

const idle = { calendarEnabled: false, calendarReplaced: false, worldTime: 0 };

test("Always and Never override whatever the world's clock is doing (#149)", () => {
  assert.equal(followsClock("always", idle), true);
  assert.equal(followsClock("never", { calendarEnabled: true, calendarReplaced: true, worldTime: 86_400 }), false);
});

test("Auto follows the clock where dnd5e's calendar is on, a module drives the calendar, or time has moved (#149)", () => {
  assert.equal(followsClock("auto", { ...idle, calendarEnabled: true }), true);
  assert.equal(followsClock("auto", { ...idle, calendarReplaced: true }), true, "a calendar module (Calendaria) runs time");
  assert.equal(followsClock("auto", { ...idle, worldTime: 3600 }), true, "a GM moved the clock with another tool");
  assert.equal(followsClock("auto", idle), false, "a world nobody keeps time in");
});

test("an unknown mode reads as Auto, the default (#149)", () => {
  assert.deepEqual(FOLLOW_CLOCK_MODES, ["auto", "always", "never"]);
  assert.equal(followsClock(undefined, idle), false);
  assert.equal(followsClock("bogus", { ...idle, worldTime: 1 }), true);
});

/** Foundry as dnd5e leaves it: its own calendar class set as both the earth and the world calendar. */
function foundry({ mode, enabled = false, worldTime = 0, worldClass } = {}) {
  class CalendarData5e {}
  class Harptos extends CalendarData5e {}
  const settings = { "merchant-presets.followClock": mode, "dnd5e.calendarConfig": { enabled } };
  return {
    game: { settings: { get: (s, k) => settings[`${s}.${k}`] }, time: { worldTime } },
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
  assert.equal(read({ mode: "auto", worldTime: 60 }), true);
  assert.equal(read({ mode: "always" }), true);
});

test("a dnd5e without a calendar setting reads as calendar off, not an error (#149)", () => {
  const game = { settings: { get: (s) => { if (s === "dnd5e") throw new Error("not registered"); return "auto"; } }, time: { worldTime: 0 } };
  assert.equal(worldFollowsClock(game, {}), false);
});
