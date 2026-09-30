/**
 * Haggling (#112): the GM calls for a haggle, the character's owner rolls Persuasion from the chat
 * card, and the result becomes a #111 deal (haggle.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { shopFrom } from "../scripts/schema.mjs";
import {
  callable, callLapsed, checkRollMessage, haggleAdjustment, haggleCard, haggleDeal, haggleEnds, haggleOutcome,
  resolveCall, ROLL_FRESH_MS
} from "../scripts/haggle.mjs";

const CAL = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
const DAY = 86_400;
const ARIA = "Actor.aria000000000000";
const TOMAS = "Actor.tomas000000000000";
const HOURS = { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } };
const shop = (over = {}) => shopFrom({ version: 1, ...over });
const at = (day, hour, minute = 0) => day * DAY + hour * 3600 + minute * 60;
const deal = (over = {}) => ({ actor: ARIA, name: "Aria", buy: -0.1, sell: null, note: "", ends: null, ...over });

/* ---------------------------------------------------------------- outcome */

test("beating the DC by 5 or more is a great haggle; a tie is a success", () => {
  assert.equal(haggleOutcome(19, 14), "great");
  assert.equal(haggleOutcome(18, 14), "success");
  assert.equal(haggleOutcome(14, 14), "success");
  assert.equal(haggleOutcome(13, 14), "fail");
  assert.equal(haggleOutcome(10, 14), "fail");
  assert.equal(haggleOutcome(9, 14), "botch");
});

test("each outcome moves the chosen side by the table's amount", () => {
  assert.equal(haggleAdjustment("buy", "great"), -0.2);
  assert.equal(haggleAdjustment("buy", "success"), -0.1);
  assert.equal(haggleAdjustment("buy", "fail"), null);
  assert.equal(haggleAdjustment("buy", "botch"), 0.1);
  assert.equal(haggleAdjustment("sell", "great"), 0.2);
  assert.equal(haggleAdjustment("sell", "success"), 0.1);
  assert.equal(haggleAdjustment("sell", "fail"), null);
  assert.equal(haggleAdjustment("sell", "botch"), -0.1);
});

/* ---------------------------------------------------------------- ends */

test("a haggle ends when the shop next closes", () => {
  assert.deepEqual(haggleEnds(HOURS, at(2, 10), CAL, true), { at: at(2, 19, 1), when: "close" });
});

test("a shop that never closes, or no clock, ends it at the next day's start", () => {
  assert.deepEqual(haggleEnds(null, at(2, 10), CAL, true), { at: at(3, 0), when: "date" });
  assert.deepEqual(haggleEnds(HOURS, at(2, 10), CAL, false), { at: at(3, 0), when: "date" });
});

/* ---------------------------------------------------------------- the deal */

test("a haggle's deal moves only the chosen side and says how it was won", () => {
  const ends = { at: at(2, 19, 1), when: "close" };
  assert.deepEqual(haggleDeal({ actor: ARIA, name: "Aria", side: "buy", outcome: "great", total: 19, dc: 14, ends }),
    { actor: ARIA, name: "Aria", buy: -0.2, sell: null, note: "Haggled: Persuasion 19 vs DC 14", ends });
  assert.deepEqual(haggleDeal({ actor: ARIA, name: "Aria", side: "sell", outcome: "botch", total: 8, dc: 14, ends }),
    { actor: ARIA, name: "Aria", buy: null, sell: -0.1, note: "Haggled: Persuasion 8 vs DC 14", ends });
  assert.equal(haggleDeal({ actor: ARIA, name: "Aria", side: "buy", outcome: "fail", total: 12, dc: 14, ends }), null);
});

/* ---------------------------------------------------------------- who can be called */

test("the call form offers only characters without a live deal here", () => {
  const chars = [{ uuid: ARIA, name: "Aria" }, { uuid: TOMAS, name: "Tomas" }];
  assert.deepEqual(callable(shop({ deals: [deal()] }), chars, at(2, 10)).map(c => c.name), ["Tomas"]);
  const ended = deal({ ends: { at: at(2, 9), when: "close" } });
  assert.deepEqual(callable(shop({ deals: [ended] }), chars, at(2, 10)).map(c => c.name), ["Aria", "Tomas"]);
});

/* ---------------------------------------------------------------- the call */

const call = (over = {}) => ({ shopUuid: "Actor.shop", actor: ARIA, name: "Aria", side: "buy", dc: 14, ends: at(2, 19, 1), state: "open", ...over });
const ctx = { worldTime: at(2, 11), calendar: CAL, hours: HOURS, clock: true };

test("an open call lapses at its end, once used, or when its character got a deal", () => {
  assert.equal(callLapsed(call(), shop(), at(2, 11)), false);
  assert.equal(callLapsed(call(), shop(), at(2, 19, 1)), true);
  assert.equal(callLapsed(call({ state: "rolled" }), shop(), at(2, 11)), true);
  assert.equal(callLapsed(call(), shop({ deals: [deal()] }), at(2, 11)), true);
});

test("rolling on an open call gives the outcome and its deal, ending at the next close", () => {
  const { state, outcome, deal: d } = resolveCall(call(), shop(), 17, ctx);
  assert.equal(state, "rolled");
  assert.equal(outcome, "success");
  assert.deepEqual(d, { actor: ARIA, name: "Aria", buy: -0.1, sell: null, note: "Haggled: Persuasion 17 vs DC 14",
    ends: { at: at(2, 19, 1), when: "close" } });
});

test("a failed roll is rolled with no deal", () => {
  assert.deepEqual(resolveCall(call(), shop(), 12, ctx), { state: "rolled", outcome: "fail", deal: null });
});

test("rolling on a lapsed call does nothing", () => {
  assert.deepEqual(resolveCall(call(), shop(), 17, { ...ctx, worldTime: at(2, 20) }), { state: "lapsed" });
});

/* ---------------------------------------------------------------- the roll */

const NOW = 1_800_000_000_000;
const message = (over = {}) => ({ id: "msg1", author: "user1", speakerActor: "aria", type: "check", skill: "per",
  total: 17, timestamp: NOW - 1000, ...over });
const request = { userId: "user1", actorId: "aria", used: new Set(), now: NOW };

test("a fresh Persuasion check by the roller, for the called character, is accepted", () => {
  assert.equal(checkRollMessage(message(), request), null);
});

test("anything else about the roll message refuses it, in order", () => {
  assert.equal(checkRollMessage(null, request), "missing");
  assert.equal(checkRollMessage(message({ author: "user2", speakerActor: "tomas" }), request), "author");
  assert.equal(checkRollMessage(message({ speakerActor: "tomas", skill: "ins" }), request), "speaker");
  assert.equal(checkRollMessage(message({ skill: "ins" }), request), "not-persuasion");
  assert.equal(checkRollMessage(message({ type: "base" }), request), "not-persuasion");
  assert.equal(checkRollMessage(message({ total: undefined }), request), "not-persuasion");
  assert.equal(checkRollMessage(message({ timestamp: NOW - ROLL_FRESH_MS - 1 }), request), "stale");
  assert.equal(checkRollMessage(message({ timestamp: undefined }), request), "stale");
  assert.equal(checkRollMessage(message({ timestamp: NOW + 60_000 }), request), "stale");
  assert.equal(checkRollMessage(message(), { ...request, used: new Set(["msg1"]) }), "used");
});

/* ---------------------------------------------------------------- the card */

test("the card's public result names the side and outcome, never the DC", () => {
  assert.deepEqual(haggleCard({ side: "buy", outcome: "success" }), { key: "buy.success", percent: 10 });
  assert.deepEqual(haggleCard({ side: "sell", outcome: "great" }), { key: "sell.great", percent: 20 });
  assert.deepEqual(haggleCard({ side: "buy", outcome: "fail" }), { key: "buy.fail", percent: null });
  assert.deepEqual(haggleCard({ side: "buy", outcome: "botch" }), { key: "buy.botch", percent: 10 });
});
