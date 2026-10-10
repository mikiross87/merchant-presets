/**
 * The chat message for a bought spellcasting service (#70), kept free of
 * Foundry so it can be tested with plain Node (tools/casting.test.mjs).
 *
 * A service moves gold and nothing else, so without this nothing in Foundry
 * says a spell was cast. The trade's own receipt already says what was
 * paid; this says what was cast and for whom, and hands the GM the spell and
 * any effects to put on whoever it was cast on. It applies nothing: the buyer
 * is often not the target, and a concentration spell would need the shopkeeper
 * to hold it.
 */

import { boughtWith, goodFlag } from "./trade.mjs";

const PREFIX = "Spellcasting: ";

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

/**
 * The spellcasting services a trade's buyer actually bought. Selling one back
 * casts nothing.
 *
 * @param {import("./trade.mjs").ShopTrade|null|undefined} trade
 * @returns {{item: object, quantity: number}[]}
 */
export function castsIn(trade) {
  if (trade?.kind !== "buy") return [];
  return boughtWith(trade, "kind").filter(e => goodFlag(e.item, "kind") === "spellcasting");
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
 * @returns {string} The message's HTML. No price: the trade receipt has it.
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

/* ------------------------------------------- the spell's own card (#87, #237) */

/**
 * On dnd5e 6 a named service is announced as dnd5e's own usage card for the spell, spoken by the
 * shop (design band 21): the spell's description and pills, and, for a spell with effects, the
 * tray the GM applies them from. dnd5e 5.3 has the `usage` type but not the item card's face, so
 * it keeps `castingMessage`.
 *
 * @param {string|undefined} version  dnd5e's version
 * @param {(a: string, b: string) => boolean} isNewerVersion  foundry.utils.isNewerVersion
 */
export function spellCards(version, isNewerVersion) {
  return !!version && !isNewerVersion("6.0.0", version);
}

/** The card's flavor line, under the shop's name: "Cast twice for **Aria**". */
export function castFlavor(buyer, quantity) {
  return `Cast${times(quantity)} for <strong>${escape(buyer)}</strong>`;
}

/**
 * The uuids of the effects an activity can put on a creature: its tray. Enchantments change an
 * item, as in `actorEffects`.
 *
 * @param {{effects?: {effect?: {uuid: string, type?: string}}[]}|undefined} activity
 * @returns {string[]}
 */
export function activityEffects(activity) {
  return (activity?.effects ?? []).map(e => e.effect).filter(e => e && e.type !== "enchantment").map(e => e.uuid);
}

/** The activity the card shows: the one carrying effects, else the spell's first. */
export function castActivity(activities) {
  const all = Array.from(activities ?? []);
  return all.find(a => activityEffects(a).length) ?? all[0];
}

/**
 * The card as a chat message. It is built the way dnd5e keeps a scroll used up by casting: the
 * spell isn't on any actor, and a compendium link only resolves on a client that has the spell
 * loaded, so `system.item.uuid` is null and dnd5e rebuilds the spell from `flags.dnd5e.item.data`
 * on the speaker, the shop, on every client. No buttons (Raise Dead's healing roll, Symbol's
 * save): nothing is cast. No content either, since dnd5e shows content instead of the card.
 *
 * @param {object} input
 * @param {{system: object, title: string, type: string}} input.card  dnd5e's card data for the
 *   activity (`getCardData`), on a copy of the spell owned by the shop
 * @param {object} input.data      That copy's data; its `_id` is the card's `system.item.id`.
 * @param {string[]} input.effects The tray (`activityEffects`).
 * @param {string} input.flavor    `castFlavor`
 * @param {object} input.speaker
 * @param {string[]} input.whisper `chatRecipients`
 */
export function spellCard({ card, data, effects, flavor, speaker, whisper }) {
  const { system, ...rest } = card;
  return {
    ...rest, speaker, whisper, flavor,
    system: { ...system, buttons: [], effects, item: { ...system.item, uuid: null } },
    flags: { dnd5e: { item: { data } } }
  };
}

/**
 * Who sees the message, on the 0-3 scale 1.x took from Item Piles' *Output to
 * chat* (merchant-presets.mjs `nativeChatMode` maps *Trades in chat* onto it):
 * 0 off and 1 public are both public here (this module has its own setting to
 * turn the message off), 2 is the GMs and the user who traded, 3 the GMs alone.
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
