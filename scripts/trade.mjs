/**
 * Reading a shop trade's lines for the listeners that act on it (meals,
 * animals, spellcasting), kept free of Foundry so it can be tested with plain
 * Node (tools/trade.test.mjs). On the client that made the writes each line's
 * item is the shop's Item document; every other client gets it over the socket
 * as plain data with no getFlag, so flags are read off the data alike.
 */

const MODULE = "merchant-presets";

/**
 * This module's flag on a bought good, read from an Item document or from its
 * plain data alike.
 *
 * @param {object|undefined} item
 * @param {string} key
 * @returns {*}
 */
export function goodFlag(item, key) {
  return item?.flags?.[MODULE]?.[key];
}

/**
 * A shop trade, the way this module's own listeners read it: the
 * `merchant-presets.trade` hook's payload (trade-desk.mjs `hookPayload`).
 *
 * @typedef {object} ShopTrade
 * @property {"buy"|"sell"} kind  "buy": the shop sold to the character.
 * @property {string} shopUuid
 * @property {string} buyerUuid   The character trading with the shop, either way round.
 * @property {string} userId      Who asked for the trade.
 * @property {{item: object, quantity: number}[]} lines
 */

/**
 * The lines of a trade that actually moved goods and carry this module's
 * `key` flag.
 *
 * @param {ShopTrade|null|undefined} trade
 * @param {string} key  e.g. "nutrition" or "actor".
 * @returns {{item: object, quantity: number}[]}
 */
export function boughtWith(trade, key) {
  return (trade?.lines ?? []).filter(e => e.quantity > 0 && goodFlag(e.item, key) != null);
}
