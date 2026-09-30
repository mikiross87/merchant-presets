import { activeDeal } from "./deals.mjs";
import { nextCloseAt, secondsPerDay } from "./schedule.mjs";

/**
 * Haggling (#112), kept free of Foundry so it runs under plain Node (tools/haggle.test.mjs).
 *
 * The GM calls for a haggle when the roleplay gets there: a chat card, whose flags hold the call,
 * lets the character's owner roll Persuasion through dnd5e on their own client. The GM's claiming
 * tab reads the roll back from the chat message it made (`checkRollMessage`), never from a number
 * the socket carries, and turns the result into an ordinary #111 deal that ends when the shop
 * closes. Known limits: a player who forges a chat roll from the console can cheat this as they
 * can any dnd5e roll, and the call's DC sits in the card's flags, which a player's console reads.
 *
 * Times are world seconds; the calendar is the world clock's own numbers, as in schedule.mjs.
 */

/** How long a roll message stays usable for a haggle, in real milliseconds. */
export const ROLL_FRESH_MS = 5 * 60_000;

const STEPS = { great: 0.2, success: 0.1, fail: null, botch: -0.1 };

/**
 * @param {number} total  the Persuasion roll's total
 * @param {number} dc
 * @returns {"great"|"success"|"fail"|"botch"}
 */
export function haggleOutcome(total, dc) {
  const margin = total - dc;
  if (margin >= 5) return "great";
  if (margin >= 0) return "success";
  if (margin > -5) return "fail";
  return "botch";
}

/**
 * The deal factor an outcome gives the chosen side, or null for none: buying gets cheaper on a
 * win (negative), selling pays more (positive), and a botch turns both the other way.
 *
 * @param {"buy"|"sell"} side
 * @param {"great"|"success"|"fail"|"botch"} outcome
 * @returns {number|null}
 */
export function haggleAdjustment(side, outcome) {
  const step = STEPS[outcome];
  if (step === null) return null;
  return side === "buy" ? -step : step;
}

/**
 * When a haggle made now ends, and when a call made now lapses: the shop's next closing, or the
 * start of the next day for a shop that never closes, or where shops don't follow the clock (#149).
 *
 * @returns {{at: number, when: "close"|"date"}}
 */
export function haggleEnds(hours, worldTime, calendar, clock) {
  const close = clock ? nextCloseAt(hours, worldTime, calendar) : null;
  if (close !== null) return { at: close, when: "close" };
  const day = secondsPerDay(calendar);
  return { at: (Math.floor(worldTime / day) + 1) * day, when: "date" };
}

/** The #111 deal a haggle writes, or null when the outcome changes nothing. */
export function haggleDeal({ actor, name, side, outcome, total, dc, ends }) {
  const adjustment = haggleAdjustment(side, outcome);
  if (adjustment === null) return null;
  return {
    actor, name,
    buy: side === "buy" ? adjustment : null,
    sell: side === "sell" ? adjustment : null,
    note: `Haggled: Persuasion ${total} vs DC ${dc}`,
    ends
  };
}

/**
 * The characters the GM may call for a haggle at `shop`: those with no deal in force there.
 *
 * @template {{uuid: string}} C
 * @param {object} shop  a full shop config
 * @param {C[]} characters
 * @param {number} worldTime
 * @returns {C[]}
 */
export function callable(shop, characters, worldTime) {
  return characters.filter(c => !activeDeal(shop, c.uuid, worldTime));
}

/** Whether a call (a card's `haggle` flag) can no longer be rolled on. */
export function callLapsed(call, shop, worldTime) {
  return call.state !== "open" || worldTime >= call.ends || !!activeDeal(shop, call.actor, worldTime);
}

/**
 * A roll of `total` on `call`: the outcome and the deal it writes (null on a fail), or a lapse.
 *
 * @param {{actor: string, name: string, side: "buy"|"sell", dc: number, ends: number, state: string}} call
 * @param {object} shop  a full shop config
 * @param {number} total
 * @param {{worldTime: number, calendar: object, hours: object|null, clock: boolean}} context
 * @returns {{state: "rolled", outcome: string, deal: object|null} | {state: "lapsed"}}
 */
export function resolveCall(call, shop, total, { worldTime, calendar, hours, clock }) {
  if (callLapsed(call, shop, worldTime)) return { state: "lapsed" };
  const outcome = haggleOutcome(total, call.dc);
  const deal = haggleDeal({ ...call, outcome, total, ends: haggleEnds(hours, worldTime, calendar, clock) });
  return { state: "rolled", outcome, deal };
}

/**
 * Why a roll message can't back a haggle, or null when it can. `message` is the chat message
 * as plain data: `author` and `speakerActor` are ids, `type` and `skill` dnd5e's own
 * (`type: "check"`, `system.skill`), `total` the first roll's, `timestamp` real milliseconds.
 *
 * @returns {null|"missing"|"author"|"speaker"|"not-persuasion"|"stale"|"used"}
 */
export function checkRollMessage(message, { userId, actorId, used, now }) {
  if (!message) return "missing";
  if (message.author !== userId) return "author";
  if (message.speakerActor !== actorId) return "speaker";
  if (message.type !== "check" || message.skill !== "per" || !Number.isFinite(message.total)) return "not-persuasion";
  const age = now - message.timestamp;
  if (!(age >= 0 && age <= ROLL_FRESH_MS)) return "stale";
  if (used.has(message.id)) return "used";
  return null;
}

/**
 * What the rolled card says to everyone: a `MERCHANT_PRESETS.Haggle.Result.<key>` string and the
 * percentage it names. Never the DC or the total.
 */
export function haggleCard({ side, outcome }) {
  const adjustment = haggleAdjustment(side, outcome);
  return { key: `${side}.${outcome}`, percent: adjustment === null ? null : Math.round(Math.abs(adjustment) * 100) };
}
