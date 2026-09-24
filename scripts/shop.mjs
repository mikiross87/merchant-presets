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
 * afterwards. An NPC set up as a shop carries `shop` instead (#57).
 *
 * @param {object|undefined} actor  An Actor document or its data.
 * @returns {boolean}
 */
export function isPreset(actor) {
  if (!actor || actor.pack) return false;              // never touch compendium copies
  if (actor.flags?.["merchant-presets"]?.profile) return true;
  if (actor.flags?.["merchant-presets"]?.shop) return true;   // an NPC set up as a shop (#57)
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

/**
 * A per-result quantity map (`{resultId: formula}`, as both Item Piles'
 * `tablesForPopulate[0].items` and a shop's own `restock.quantities` (#98)
 * are shaped), re-keyed from `from`'s result ids to `to`'s — a fresh import
 * gives a RollTable's embedded results new ids, so a map keyed by the old
 * ones is stale the moment wiring repoints the table at its world copy.
 * Matched by what each result points at (`documentUuid`), not position or
 * order. A result `to` has that `from` doesn't (the table changed since,
 * say) gets the same "1" a stock roll defaults an unrecognised result to.
 *
 * @param {Iterable<{id: string, documentUuid: string}>} from
 * @param {Iterable<{id: string, documentUuid: string}>} to
 * @param {Record<string, string>} [quantities]  Keyed by `from`'s ids.
 * @returns {Record<string, string>} Keyed by `to`'s ids.
 */
export function remapQuantities(from, to, quantities) {
  const byTarget = new Map();
  for (const r of from) byTarget.set(r.documentUuid, quantities?.[r.id] ?? "1");
  const out = {};
  for (const r of to) out[r.id] = byTarget.get(r.documentUuid) ?? "1";
  return out;
}

/* -------------------------------------------------------- setting up a shop */

/** Settlement sizes, in stock-band order. */
export const TIERS = ["Village", "Town", "City"];

/** Item types a shopkeeper carries, as opposed to features and spells. */
export const PHYSICAL = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

const TIER_IN_NAME = /^(.*) \((Village|Town|City)\)$/;
/** Whether `item` is the shopkeeper's own kit rather than stock. Also used
 *  by the 1.x → 2.0 migration (#100) to keep gear out of `flags.merchant-presets.stock`. */
export const isGearItem = item => item.flags?.["merchant-presets"]?.kind === "gear";

/**
 * The shops a GM can choose from, read from the merchants compendium index.
 *
 * @param {Iterable<{name: string, uuid: string}>} index
 * @returns {{name: string, tiers: Record<string, string>}[]}  By shop name; `tiers` maps a size to its merchant's uuid.
 */
export function listShops(index) {
  const shops = new Map();
  for (const entry of index) {
    const [, name, tier] = entry.name?.match(TIER_IN_NAME) ?? [];
    if (!name) continue;
    if (!shops.has(name)) shops.set(name, { name, tiers: {} });
    shops.get(name).tiers[tier] = entry.uuid;
  }
  return [...shops.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The settlement size a shop's stock is rolled for. An NPC set up as a shop
 * keeps its own name, so the marker comes first.
 *
 * @param {object} actor
 * @returns {"Village"|"Town"|"City"}
 */
export function tierOf(actor) {
  const marked = actor?.flags?.["merchant-presets"]?.shop?.tier;
  if (TIERS.includes(marked)) return marked;
  return actor?.name?.match(/\((Village|Town|City)\)/)?.[1] ?? "Town";
}

/**
 * Whether an actor already carries a shop: a shipped merchant (`profile`) or
 * an NPC set up as one (`shop`). Narrower than `isPreset`, which also counts a
 * bare pointer at our stock table — such an actor has no gear tagged yet, and
 * treating it as a shop would offer nothing to keep and delete everything.
 * What the 1.x → 2.0 migration (#100) walks the world for, since `isPreset`'s
 * bare pointer has no Item Piles data yet to migrate.
 *
 * @param {object} actor
 * @returns {boolean}
 */
export function isShop(actor) {
  const flags = actor?.flags?.["merchant-presets"];
  return Boolean(flags?.profile || flags?.shop);
}

/**
 * The items the setup dialog offers to keep as the NPC's own gear: every
 * physical item, contents of containers included. On an actor that is already
 * a shop the rest is stock, so only its gear is offered.
 *
 * @param {object} actor  Actor data, items included.
 * @returns {object[]}
 */
export function keepableItems(actor) {
  const shop = isShop(actor);
  return (actor.items ?? []).filter(i => PHYSICAL.has(i.type) && (!shop || isGearItem(i)));
}

/**
 * What turning an NPC into one of the shops changes (#57).
 *
 * Everything the NPC does not keep goes: unticked physical items and, on an
 * actor that is already a shop, its old stock, which would otherwise double
 * the name-keyed limited-item flags and container counts. Everything it keeps
 * is tagged as gear, which keeps it out of the shop window, the stock roll and
 * a restock. The shop itself — Item Piles settings, purse, limited-item flags,
 * container counts, coin and stock — comes from the chosen merchant, never its
 * shopkeeper's gear or `profile`, which names the shipped stat block.
 *
 * @param {object} source          The chosen merchant's data, with its `uuid`.
 * @param {object} actor           The NPC's data, items included.
 * @param {Iterable<string>} keepIds  Ids of the physical items ticked to keep.
 * @returns {{deletes: string[], updates: object[], pileData: object, moduleFlags: object,
 *   currency: object, creates: object[]}}
 */
export function planShop(source, actor, keepIds) {
  const keep = new Set(keepIds);
  const shop = isShop(actor);
  const items = actor.items ?? [];

  const deletes = items
    .filter(i => (shop && !isGearItem(i)) || (PHYSICAL.has(i.type) && !keep.has(i._id)))
    .map(i => i._id);
  const gone = new Set(deletes);

  const updates = [];
  for (const item of items) {
    if (gone.has(item._id)) continue;
    const update = { _id: item._id };
    if (!isGearItem(item)) update["flags.merchant-presets.kind"] = "gear";
    if (item.system?.container && gone.has(item.system.container)) update["system.container"] = null;
    if (Object.keys(update).length > 1) updates.push(update);
  }

  const from = source.flags?.["merchant-presets"] ?? {};
  const pileData = { ...structuredClone(source.flags?.["item-piles"]?.data ?? {}), merchantImage: "" };
  const moduleFlags = {
    purse: from.purse ?? null,
    itemFlags: structuredClone(from.itemFlags ?? null),
    containers: structuredClone(from.containers ?? null),
    shop: { source: source.uuid, tier: tierOf(source) }
  };

  return {
    deletes,
    updates,
    pileData,
    moduleFlags,
    currency: structuredClone(source.system?.currency ?? {}),
    creates: (source.items ?? []).filter(i => !isGearItem(i)).map(i => structuredClone(i))
  };
}
