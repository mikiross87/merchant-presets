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
 * A shop trade, the way this module's own listeners read it — the shape of the
 * `merchant-presets.trade` hook's payload (trade-desk.mjs `hookPayload`), so
 * the meal, animal and spellcasting listeners serve Item Piles' trades and
 * native ones alike while both exist (#102).
 *
 * @typedef {object} ShopTrade
 * @property {"buy"|"sell"} kind  "buy": the shop sold to the character.
 * @property {string} shopUuid
 * @property {string} buyerUuid   The character trading with the shop, either way round.
 * @property {string} userId      Who asked for the trade.
 * @property {{item: object, quantity: number}[]} lines
 */

/**
 * An `item-piles-tradeItems` call as a `ShopTrade`. Item Piles names the side
 * that pays the "buyer", so on a sale to a merchant the merchant is its buyer,
 * and `buyerReceive` holds what the merchant took. `null` when neither side is
 * a merchant.
 *
 * @param {object|null} seller  The seller, as an actor (or anything `uuidOf` reads).
 * @param {object|null} buyer
 * @param {object|undefined} itemPrices
 * @param {string} userId
 * @param {(actor: object|null) => boolean} isMerchant
 * @returns {ShopTrade|null}
 */
export function fromItemPiles(seller, buyer, itemPrices, userId, isMerchant) {
  const lines = (itemPrices?.buyerReceive ?? []).map(e => ({ item: e.item, quantity: e.quantity }));
  if (isMerchant(seller)) return { kind: "buy", shopUuid: uuidOf(seller), buyerUuid: uuidOf(buyer), userId, lines };
  if (isMerchant(buyer)) return { kind: "sell", shopUuid: uuidOf(buyer), buyerUuid: uuidOf(seller), userId, lines };
  return null;
}

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
