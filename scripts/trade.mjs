/**
 * Reading Item Piles' `item-piles-tradeItems` hook, kept free of Foundry so it
 * can be tested with plain Node (tools/trade.test.mjs).
 *
 * The hook is documented as (sellerUuid, buyerUuid, itemPrices, userId), but
 * Item Piles 3.3 fires it through its own callHook, which swaps every argument
 * that looks like a UUID for the document it names, so the seller and buyer
 * usually arrive as actors. socketlib then runs it in place on the GM that
 * performed the trade, where each bought item is the seller's Item document,
 * and sends it as JSON to every other client, where each item is that
 * document's plain data with no getFlag. The buying player's client, which is
 * the one that asks "Eat now?", only ever sees the JSON (#48).
 */

const MODULE = "merchant-presets";

/**
 * The UUID of a hook argument that may be the UUID itself or its document.
 *
 * @param {string|{uuid?: string}|null|undefined} ref
 * @returns {string|null}
 */
export function uuidOf(ref) {
  if (typeof ref === "string") return ref;
  return typeof ref?.uuid === "string" ? ref.uuid : null;
}

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
 * The entries of a trade that the buyer actually received and that carry this
 * module's `key` flag.
 *
 * @param {object|undefined} itemPrices  The hook's itemPrices argument.
 * @param {string} key                   e.g. "nutrition" or "actor".
 * @returns {object[]}
 */
export function boughtWith(itemPrices, key) {
  return (itemPrices?.buyerReceive ?? []).filter(e => e.quantity > 0 && goodFlag(e.item, key) != null);
}
