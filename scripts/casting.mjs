/**
 * The chat message for a bought spellcasting service (#70), kept free of
 * Foundry so it can be tested with plain Node (tools/casting.test.mjs).
 *
 * A service moves gold and nothing else, so without this nothing in Foundry
 * says a spell was cast. Item Piles' own trade card already says what was
 * paid; this says what was cast and for whom, and hands the GM the spell and
 * any effects to put on whoever it was cast on. It applies nothing: the buyer
 * is often not the target, and a concentration spell would need the shopkeeper
 * to hold it.
 */

import { boughtWith, goodFlag } from "./trade.mjs";

const PREFIX = "Spellcasting: ";

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

/**
 * The spellcasting services a trade's buyer actually bought.
 *
 * @param {object|undefined} itemPrices  The item-piles-tradeItems hook's argument.
 * @returns {object[]}  Its `buyerReceive` entries, each with `item` and `quantity`.
 */
export function castsIn(itemPrices) {
  return boughtWith(itemPrices, "kind").filter(e => goodFlag(e.item, "kind") === "spellcasting");
}

/**
 * The effects of a spell that can go on a creature. dnd5e's enchantments
 * (Contingency's) change an item, not an actor.
 *
 * @param {Iterable<{uuid: string, name: string, type?: string}>|undefined} effects
 * @returns {{uuid: string, name: string}[]}
 */
export function actorEffects(effects) {
  return Array.from(effects ?? []).filter(e => e.type !== "enchantment").map(e => ({ uuid: e.uuid, name: e.name }));
}

const times = n => n === 1 ? "" : n === 2 ? " twice" : ` ${n} times`;

/**
 * @param {{shop: string, buyer: string, casts: {name: string, quantity: number,
 *   spell: string|null, effects: {uuid: string, name: string}[]}[]}} purchase
 *   One entry per service bought. `spell` is the uuid a named service carries
 *   (#55); a level service has none, and the buyer names the spell.
 * @returns {string} The message's HTML. No price: Item Piles' card has it.
 */
export function castingMessage({ shop, buyer, casts }) {
  const who = `<strong>${escape(shop)}</strong>`;
  const whom = `<strong>${escape(buyer)}</strong>`;
  return casts.map(({ name, quantity, spell, effects }) => {
    if (!spell) {
      const many = quantity > 1;
      return `<p>${who} casts ${many ? `${quantity} spells` : "a spell"} for ${whom}: `
        + `${escape(name)}${many ? ` × ${quantity}` : ""}. Tell the GM which ${many ? "spells" : "spell"}.</p>`;
    }
    const label = escape(name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);
    let html = `<p>${who} casts @UUID[${spell}]{${label}} for ${whom}${times(quantity)}.</p>`;
    if (effects.length) {
      html += "<p>Effects to drag onto the creature it was cast on: "
        + effects.map(e => `@UUID[${e.uuid}]{${escape(e.name)}}`).join(", ") + "</p>";
    }
    return html;
  }).join("");
}

/**
 * Who sees the message, following Item Piles' *Output to chat* setting as its
 * own trade card does: 0 off and 1 public are both public here (this module has
 * its own setting to turn the message off), 2 is the GMs and the user who
 * traded, 3 the GMs alone.
 *
 * @param {number} mode
 * @param {string[]} gmIds
 * @param {string} userId
 * @returns {string[]} whisper recipients; empty for a public message
 */
export function chatRecipients(mode, gmIds, userId) {
  if (mode < 2) return [];
  return Array.from(new Set(mode === 2 ? [...gmIds, userId] : gmIds));
}
