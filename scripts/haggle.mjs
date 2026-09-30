import { activeDeal } from "./deals.mjs";
import { nextCloseAt, secondsPerDay } from "./schedule.mjs";

/**
 * Haggling (#112), kept free of Foundry so it runs under plain Node (tools/haggle.test.mjs).
 *
 * The GM calls for a haggle when the roleplay gets there: a chat card, whose flags hold the call,
 * lets the character's owner roll Persuasion, Deception or Intimidation (the GM's pick, or the
 * player's when the call names none) through dnd5e on their own client. The GM's claiming
 * tab reads the roll back from the chat message it made (`checkRollMessage`), never from a number
 * the socket carries, and turns the result into an ordinary #111 deal that ends when the shop
 * closes. Known limits: a player who forges a chat roll from the console can cheat this as they
 * can any dnd5e roll, and the call's DC sits in the card's flags, which a player's console reads.
 *
 * Times are world seconds; the calendar is the world clock's own numbers, as in schedule.mjs.
 */

/** How long a roll message stays usable for a haggle, in real milliseconds. */
export const ROLL_FRESH_MS = 5 * 60_000;

/** The dnd5e skill ids a haggle may be rolled with: Persuasion, Deception, Intimidation. */
export const HAGGLE_SKILLS = ["per", "dec", "itm"];

const STEPS = { great: 0.2, success: 0.1, fail: null, botch: -0.1 };

/**
 * The skills a call may be rolled with: the one the GM named, or all three when it's left to the player.
 *
 * @param {{skill?: string|null}} call
 * @returns {string[]}
 */
export function allowedSkills(call) {
  return call.skill ? [call.skill] : HAGGLE_SKILLS;
}

/**
 * @param {number} total  the skill roll's total
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

/** The #111 deal a haggle writes (its note names `skillName`, the rolled skill's label), or null when the outcome changes nothing. */
export function haggleDeal({ actor, name, side, outcome, skillName, total, dc, ends }) {
  const adjustment = haggleAdjustment(side, outcome);
  if (adjustment === null) return null;
  return {
    actor, name,
    buy: side === "buy" ? adjustment : null,
    sell: side === "sell" ? adjustment : null,
    note: `Haggled: ${skillName} ${total} vs DC ${dc}`,
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

/**
 * Whether a GM's call request can be posted: `side` one the shop trades on (`sell` only when it
 * `buys`), `dc` a whole number from 1 to 40, and `skill` a haggle skill or null (the player's choice).
 */
export function validCall({ side, dc, skill }, buys) {
  return (side === "buy" || (side === "sell" && buys)) && Number.isInteger(dc) && dc >= 1 && dc <= 40
    && (skill === null || HAGGLE_SKILLS.includes(skill));
}

/** Whether a card shows its Roll buttons: open, and before its end. A card without a numeric end has lapsed. */
export function rollable(call, worldTime) {
  return call.state === "open" && Number.isFinite(call.ends) && worldTime < call.ends;
}

/**
 * Whether this user's card shows the Roll buttons (design XAkJh): a player who owns the call's
 * character, while the call is rollable. Never a GM, who sees the GM line instead (TAgKK); the desk
 * still takes a roll from any owner.
 *
 * @param {object} call  a card's `haggle` flag
 * @param {number} worldTime
 * @param {{isGM: boolean, owner: boolean}} viewer
 */
export function showsRollButtons(call, worldTime, { isGM, owner }) {
  return !isGM && owner && rollable(call, worldTime);
}

/** Whether a call (a card's `haggle` flag) can no longer be rolled on: past `rollable`, or its character got a deal. */
export function callLapsed(call, shop, worldTime) {
  return !rollable(call, worldTime) || !!activeDeal(shop, call.actor, worldTime);
}

/**
 * A roll on `call`: the outcome and the deal it writes (null on a fail), a lapse, or a refusal when
 * `roll.skill` isn't one the call allows. `roll.skillName` is the skill's label, for the deal's note.
 *
 * @param {{actor: string, name: string, side: "buy"|"sell", skill?: string|null, dc: number, ends: number, state: string}} call
 * @param {object} shop  a full shop config
 * @param {{total: number, skill: string, skillName: string}} roll
 * @param {{worldTime: number, calendar: object, hours: object|null, clock: boolean}} context
 * @returns {{state: "rolled", outcome: string, deal: object|null} | {state: "lapsed"} | {state: "wrong-skill"}}
 */
export function resolveCall(call, shop, { total, skill, skillName }, { worldTime, calendar, hours, clock }) {
  if (callLapsed(call, shop, worldTime)) return { state: "lapsed" };
  if (!allowedSkills(call).includes(skill)) return { state: "wrong-skill" };
  const outcome = haggleOutcome(total, call.dc);
  const deal = haggleDeal({ ...call, outcome, skillName, total, ends: haggleEnds(hours, worldTime, calendar, clock) });
  return { state: "rolled", outcome, deal };
}

/**
 * Why a roll message can't back a haggle, or null when it can. `message` is the chat message
 * as plain data: `author` and `speakerActor` are ids, `type` and `skill` dnd5e's own
 * (`type: "check"`, `system.skill`), `total` the first roll's, `timestamp` real milliseconds. `skills` are the skill
 * ids the call allows (`allowedSkills`); `since` is the card's timestamp, so a roll made before the
 * card (the best of earlier rolls) is stale.
 *
 * @returns {null|"missing"|"author"|"speaker"|"wrong-skill"|"stale"|"used"}
 */
export function checkRollMessage(message, { userId, actorId, skills, used, now, since }) {
  if (!message) return "missing";
  if (message.author !== userId) return "author";
  if (message.speakerActor !== actorId) return "speaker";
  if (message.type !== "check" || !skills.includes(message.skill) || !Number.isFinite(message.total)) return "wrong-skill";
  const age = now - message.timestamp;
  if (!(age >= 0 && age <= ROLL_FRESH_MS && message.timestamp >= since)) return "stale";
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
