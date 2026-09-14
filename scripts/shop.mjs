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

/**
 * Whether one of our merchants still has to be brought into the world: its
 * populate table is the compendium's, which Item Piles cannot use and drops the
 * first time its Populate Items tab saves.
 *
 * @param {object|undefined} actor  An Actor document or its data.
 * @returns {boolean}
 */
export function needsWiring(actor) {
  const tables = actor?.flags?.["item-piles"]?.data?.tablesForPopulate;
  return isPreset(actor) && Array.isArray(tables)
    && tables.some(t => typeof t?.uuid === "string" && t.uuid.startsWith(STOCK_PREFIX));
}

/**
 * A stock list's identity: what its results point at, in any order. FNV-1a
 * over the sorted document UUIDs, short enough to keep on a flag.
 *
 * @param {Iterable<object>} results  A RollTable's results.
 * @returns {string}
 */
function stockSignature(results) {
  const text = Array.from(results, r => r.documentUuid ?? "").sort().join("\n");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Where importing a compendium stock table should land in the world.
 *
 * Every merchant of a shop shares one world copy of its stock table, but that
 * copy is only right for the list it was made from. Matched by name alone, a
 * merchant dragged in after an update that changed the shop's list rolled the
 * old list at its first restock, and lines for goods since removed quietly
 * rolled nothing (#63). So each copy is stamped with the compendium table and
 * list it came from, and reused only while that still describes the shop.
 * The stamp, not the copy's own results, is what matches: a GM who edits the
 * table keeps it. Copies made before the stamp existed match by name and by
 * their results, which is the best evidence they carry.
 *
 * A copy that no longer matches is left alone, along with the merchants using
 * it. The new one takes the version in its name when the shop's name is taken,
 * so the two can be told apart in the folder and on the Populate Items tab.
 *
 * @param {object[]} tables  The RollTables already in the Merchant Stock folder.
 * @param {object} src       The compendium stock table being imported.
 * @param {string} version   This module's version.
 * @returns {{existing: object|undefined, name: string, stamp: {source: string, signature: string}}}
 *   `existing` is the world table to reuse; otherwise create one named `name`.
 *   Either way the table should carry `stamp` at `flags.merchant-presets.stock`.
 */
export function planWorldTable(tables, src, version) {
  const stamp = { source: src.uuid, signature: stockSignature(src.results) };
  const stampOf = table => table.flags?.["merchant-presets"]?.stock;
  const existing =
    tables.find(t => stampOf(t)?.source === stamp.source && stampOf(t)?.signature === stamp.signature)
    ?? tables.find(t => !stampOf(t) && t.name === src.name && stockSignature(t.results) === stamp.signature);
  const taken = tables.some(t => t.name === src.name);
  return { existing, name: taken ? `${src.name} (v${version})` : src.name, stamp };
}
