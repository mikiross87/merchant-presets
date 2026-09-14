/**
 * Recognising this module's merchants, kept free of Foundry so it can be
 * tested with plain Node (tools/shop.test.mjs).
 */

/** Where the shipped merchants' stock tables live before import repoints them. */
export const STOCK_PREFIX = "Compendium.merchant-presets.stock.RollTable.";

/**
 * Whether this is one of our merchants, sitting in the world rather than a pack.
 *
 * @param {object|undefined} actor  An Actor document or its data.
 * @returns {boolean}
 */
export function isPreset(actor) {
  if (!actor || actor.pack) return false;              // never touch compendium copies
  return (actor.flags?.["item-piles"]?.data?.tablesForPopulate ?? [])
    .some(t => t?.uuid?.startsWith(STOCK_PREFIX));
}
