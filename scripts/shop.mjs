/**
 * Recognising this module's merchants, kept free of Foundry so it can be
 * tested with plain Node (tools/shop.test.mjs).
 */

/** Where the shipped merchants' stock tables live before import repoints them. */
export const STOCK_PREFIX = "Compendium.merchant-presets.stock.RollTable.";

/**
 * Whether this is one of our merchants, sitting in the world rather than a pack.
 *
 * The compendium stock table only identifies a merchant until import: wiring
 * repoints it at the world copy, and every merchant already in the world then
 * looked like someone else's (#56). `profile` — the SRD stat block the
 * generator built the shopkeeper from — ships on every merchant, survives the
 * import, and is never written by the runtime, so it is what identifies one
 * afterwards.
 *
 * @param {object|undefined} actor  An Actor document or its data.
 * @returns {boolean}
 */
export function isPreset(actor) {
  if (!actor || actor.pack) return false;              // never touch compendium copies
  if (actor.flags?.["merchant-presets"]?.profile) return true;
  return (actor.flags?.["item-piles"]?.data?.tablesForPopulate ?? [])
    .some(t => t?.uuid?.startsWith(STOCK_PREFIX));
}
