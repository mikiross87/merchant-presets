import { test } from "node:test";
import assert from "node:assert/strict";
import { dueRestock, isOpen, nextDue, nextOpen } from "../scripts/schedule.mjs";

// game.time.calendar.days, as the core calendar reports it. A day is exactly
// 24*60*60 seconds — one of #105's own fixed points, since it counts whole
// days, not calendar weeks (a tenday and a week disagree; a day never does).
const calendar = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const DAY = 24 * 60 * 60;
const at = (day, hour = 0, minute = 0) => day * DAY + hour * 3600 + minute * 60;
const minute = (hour, min = 0) => hour * 60 + min;

const noRoll = () => { throw new Error("roll() called for a non-dice interval"); };

/* -------------------------------------------------------------------- isOpen */

test("a shop's hours run past midnight (Criminal & Illicit: 20:00-04:00)", () => {
  const hours = { open: { hour: 20, minute: 0 }, close: { hour: 4, minute: 0 } };
  assert.equal(isOpen(hours, minute(21, 40), calendar), true);
  assert.equal(isOpen(hours, minute(1, 40), calendar), true);
  assert.equal(isOpen(hours, minute(20, 0), calendar), true);   // opens on the dot
  assert.equal(isOpen(hours, minute(4, 0), calendar), true);    // still open on the dot
  assert.equal(isOpen(hours, minute(4, 1), calendar), false);
  assert.equal(isOpen(hours, minute(8, 20), calendar), false);
});

test("ordinary hours don't wrap (General Store: 07:00-19:00)", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.equal(isOpen(hours, minute(6, 59), calendar), false);
  assert.equal(isOpen(hours, minute(7, 0), calendar), true);
  assert.equal(isOpen(hours, minute(19, 0), calendar), true);
  assert.equal(isOpen(hours, minute(19, 1), calendar), false);
});

test("null hours means always open", () => {
  assert.equal(isOpen(null, minute(0, 0), calendar), true);
  assert.equal(isOpen(null, minute(12, 0), calendar), true);
  assert.equal(isOpen(null, minute(23, 59), calendar), true);
});

/* ------------------------------------------------------------------ nextOpen */

test("nextOpen counts the wait while closed, and wraps past midnight", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.deepEqual(nextOpen(hours, minute(4, 0), calendar), { opensAt: minute(7), inMinutes: 180 });
  assert.deepEqual(nextOpen(hours, minute(20, 0), calendar), { opensAt: minute(7), inMinutes: 11 * 60 });
});

test("nextOpen is 0 minutes while already open, or always (hours null)", () => {
  const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
  assert.equal(nextOpen(hours, minute(12, 0), calendar).inMinutes, 0);
  assert.deepEqual(nextOpen(null, minute(3, 0), calendar), { opensAt: 0, inMinutes: 0 });
});

/* ------------------------------------------------------------------- nextDue */

test("nextDue adds a fixed number of days", () => {
  assert.equal(nextDue(7, at(0), calendar, noRoll), at(7));
  assert.equal(nextDue(1, at(3, 6, 30), calendar, noRoll), at(4, 6, 30));
});

test("nextDue rolls a dice formula through the injected roll", () => {
  const roll = formula => { assert.equal(formula, "1d4+2"); return 5; };
  assert.equal(nextDue("1d4+2", at(0), calendar, roll), at(5));
});

test("nextDue is null for \"never\", and never calls roll", () => {
  assert.equal(nextDue("never", at(0), calendar, noRoll), null);
});

/* ---------------------------------------------------------------- dueRestock */

const hours = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
const weekly = { every: 7, onOpen: true };

test("fires the first time the shop opens on or after the due day", () => {
  const state = { lastRestock: at(0), dueAt: at(7) };
  // Still short of the due day: no restock, whatever the doors are doing.
  const early = dueRestock(weekly, hours, state, at(6, 6, 0), at(6, 8, 0), calendar, noRoll);
  assert.equal(early.due, false);
  assert.deepEqual(early.state, state);

  // Due day has arrived, but the shop is shut until 07:00 — waits for it to open.
  const stillClosed = dueRestock(weekly, hours, state, at(7, 0, 0), at(7, 6, 0), calendar, noRoll);
  assert.equal(stillClosed.due, false);

  // The doors open on the due day: fires, and schedules the next one from now.
  const opens = dueRestock(weekly, hours, state, at(7, 6, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(opens.due, true);
  assert.deepEqual(opens.state, { lastRestock: at(7, 8, 0), dueAt: at(14, 8, 0) });
});

test("a dice interval is rolled again after each restock, not before", () => {
  const rolls = [4, 6];
  const roll = formula => { assert.equal(formula, "1d4+2"); return rolls.shift(); };
  const dice = { every: "1d4+2", onOpen: true };
  const initialDue = nextDue("1d4+2", at(0), calendar, roll);   // first roll: 4
  assert.equal(initialDue, at(4));

  const state = { lastRestock: at(0), dueAt: initialDue };
  const result = dueRestock(dice, hours, state, at(4, 6, 0), at(4, 8, 0), calendar, roll);
  assert.equal(result.due, true);
  // second roll: 6, from this restock's own time, not the first one's.
  assert.equal(result.state.dueAt, at(4, 8, 0) + 6 * DAY);
  assert.equal(rolls.length, 0);
});

test("a week skipped in one jump gives one restock, not seven", () => {
  const daily = { every: 1, onOpen: true };
  const state = { lastRestock: at(0, 8, 0), dueAt: at(1, 8, 0) };
  const result = dueRestock(daily, hours, state, at(0, 8, 0), at(7, 8, 0), calendar, noRoll);
  assert.equal(result.due, true);
  // Scheduled from the jump's landing time, not stacked up from the days it skipped.
  assert.deepEqual(result.state, { lastRestock: at(7, 8, 0), dueAt: at(8, 8, 0) });
});

test("rewinding the clock never fires, even past the due day", () => {
  const state = { lastRestock: at(0), dueAt: at(1) };
  const result = dueRestock(weekly, hours, state, at(10, 8, 0), at(3, 8, 0), calendar, noRoll);
  assert.equal(result.due, false);
  assert.deepEqual(result.state, state);
});

test("\"never\" never fires", () => {
  const never = { every: "never", onOpen: true };
  const state = { lastRestock: at(0), dueAt: null };
  const result = dueRestock(never, hours, state, at(0), at(30), calendar, noRoll);
  assert.equal(result.due, false);
});

test("onOpen: false never fires on its own", () => {
  const byHandOnly = { every: 1, onOpen: false };
  const state = { lastRestock: at(0), dueAt: at(1) };
  const result = dueRestock(byHandOnly, hours, state, at(1, 6, 0), at(1, 8, 0), calendar, noRoll);
  assert.equal(result.due, false);
  assert.deepEqual(result.state, state);
});

test("an always-open shop (hours null) restocks at the start of its due day", () => {
  const state = { lastRestock: at(0), dueAt: at(1) };
  // Still day 0, however late: not due yet.
  const late = dueRestock(weekly, null, state, at(0, 23, 0), at(0, 23, 59), calendar, noRoll);
  assert.equal(late.due, false);
  // Crosses midnight into day 1: opens, and the due day has arrived.
  const midnight = dueRestock(weekly, null, state, at(0, 23, 59), at(1, 0, 1), calendar, noRoll);
  assert.equal(midnight.due, true);
});
