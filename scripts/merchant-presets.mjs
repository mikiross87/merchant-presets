/**
 * Merchant Presets — world wiring.
 *
 * The module ships 51 merchants prebuilt from SRD 5.2 (CC-BY-4.0) plus its own
 * goods, so nothing here has to resolve anything at runtime. Two things still
 * have to happen when a merchant is dragged into the world, and both can only
 * be done on the world copy:
 *
 * 1. STOCK TABLES. The shipped merchants point their Item Piles "Populate
 *    Items" tab at stock RollTables in this module's compendium. That tab
 *    rebuilds its list from `Array.from(game.tables)` — world tables only — and
 *    discards anything it cannot find there, silently wiping the merchant's
 *    populate configuration. So import the stock table into the world and
 *    repoint the merchant at it.
 *
 * 2. STOCK COUNTS. The packs ship canonical quantities; how many are actually
 *    on the shelf is rolled per import, from the item's price and the
 *    settlement size, so two copies of the same shop differ.
 */

import { applyMeal, nutritionOfItem, oneAtATime, usageConsumes } from "./nutrition.mjs";
import { actorEffects, castingMessage, castsIn, chatRecipients } from "./casting.mjs";
import { isPreset, keepableItems, listShops, needsWiring, planShop, planWorldTable, remapQuantities,
  STOCK_PREFIX, TIERS, tierOf } from "./shop.mjs";
import { boughtWith, goodFlag, uuidOf } from "./trade.mjs";
import "./shop-sheet.mjs"; // #103: the shop window; self-registers as an actor sheet on import
import { derivedShop, hasCurrentShop, isMigratable, NATIVE_SHOP, needsMigration, packShopCandidates, planActorUpdate,
  planAutoRestockDefault, planItemUpdates, planRestockStock, planTokenUpdates, shouldForceAutoRestockOff,
  worldHasLegacyShops }
  from "./migrate.mjs";

const MODULE = "merchant-presets";
const TABLE_FOLDER = "Merchant Stock";
const FLAG_PATH = "flags.item-piles.data.tablesForPopulate";

/**
 * Stock is rolled, not flat: how many a shop has on the shelf depends on what
 * the thing costs and how big the settlement is. A village chandler has piles
 * of candles; a city armourer may or may not have a suit of plate today.
 * Bands are the item's price in gp; each entry is [Village, Town, City].
 */
const STOCK_BANDS = [
  { under: 1, formulas: ["2d6+4", "3d6+8", "4d10+20"] },     // candles, chalk, rations
  { under: 10, formulas: ["1d6+2", "2d6+4", "3d8+8"] },      // rope, torches, daggers
  { under: 50, formulas: ["1d4+1", "1d6+2", "2d6+4"] },      // shortswords, tools
  { under: 250, formulas: ["1d2", "1d3+1", "1d4+2"] },       // breastplates, potions
  { under: 1000, formulas: ["1d2-1", "1d2", "1d3"] },        // half plate, fine goods
  { under: Infinity, formulas: ["1d3-2", "1d2-1", "1d2-1"] } // plate, ships, warhorses
];
const TIER_INDEX = { Village: 0, Town: 1, City: 2 };
const COIN_IN_GP = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };

const NUTRITION_MODULE = "simple-nutrition-5e";
/** Simple Nutrition 1.0 keeps the day's tally in fractions of a day, which is what we write. */
const NUTRITION_MINIMUM = "1.0.0";
/** Identifiers on our drinks that should slake thirst rather than hunger. */
const DRINK_IDENTIFIERS = ["ale", "wine-common", "wine-fine"];

/** Serialises table imports so dragging several merchants at once cannot duplicate them. */
const inFlight = new Map();

/** Ids of the merchants `rewire` is working on right now. */
const rewiring = new Set();

/** Closed for the rest of the session if the autoRestock-default write
 *  (`applyAutoRestockDefault`, #105) fails: a migration completing while
 *  that write is unconfirmed would erase the "world holds 1.x merchants"
 *  signal before a retry on the next load could read it (#100 review). */
let migrationGateOpen = true;
let autoRestockNoticeShown = false;

const log = (...args) => console.log(`${MODULE} |`, ...args);

/* -------------------------------------------------------------------- rolls */

/**
 * Roll one stock count.
 *
 * Must be async: `Roll#evaluateSync` refuses anything non-deterministic and a
 * DiceTerm reports `isDeterministic === false`, so it throws on every formula
 * here. `allowInteractive: false` keeps a GM who has configured manual dice
 * fulfillment from being asked to physically roll a thousand stock counts.
 */
const rollStock = async formula =>
  Math.max(0, (await new Roll(formula).evaluate({ allowInteractive: false })).total);

/**
 * Whether an item is the shopkeeper's own kit rather than stock.
 *
 * Merchants carry an SRD stat block, and its gear rides along as ordinary
 * embedded items. `overrideItemFilters` keeps it out of the shop window, but
 * the restock helpers below walk `actor.items` directly and match on name — so
 * without this the mage's own Wand would be treated as merchandise.
 */
const isGear = item =>
  foundry.utils.getProperty(item, "flags.merchant-presets.kind") === "gear";

/** An item's price expressed in gold pieces. */
function priceInGp(item) {
  const p = item.system?.price ?? {};
  return (Number(p.value) || 0) * (COIN_IN_GP[p.denomination] ?? 1);
}

function stockFormula(item, tierIndex) {
  const gp = priceInGp(item);
  return (STOCK_BANDS.find(b => gp < b.under) ?? STOCK_BANDS.at(-1)).formulas[tierIndex];
}

/* ------------------------------------------------------------------ helpers */

async function ensureFolder(name, type) {
  const existing = game.folders.find(f => f.type === type && f.name === name && !f.folder);
  return existing ?? Folder.implementation.create({ name, type, sorting: "a" });
}

async function ensureWorldTable(src) {
  if (inFlight.has(src.uuid)) return inFlight.get(src.uuid);
  const promise = (async () => {
    const folder = await ensureFolder(TABLE_FOLDER, "RollTable");
    const inFolder = game.tables.filter(t => t.folder?.id === folder.id);
    const plan = planWorldTable(inFolder, src, game.modules.get(MODULE).version);
    if (plan.existing) {
      // A copy made before copies were stamped matched on its own results.
      // Stamp it now, so edits the GM makes to it later don't stop it matching.
      if (!plan.existing.getFlag(MODULE, "stock")) await plan.existing.setFlag(MODULE, "stock", plan.stamp);
      return plan.existing;
    }
    const data = game.tables.fromCompendium(src, { clearFolder: true, clearOwnership: true });
    data.folder = folder.id;
    data.name = plan.name;
    foundry.utils.setProperty(data, `flags.${MODULE}.stock`, plan.stamp);
    return RollTable.implementation.create(data);
  })();
  inFlight.set(src.uuid, promise);
  try { return await promise; } finally { inFlight.delete(src.uuid); }
}

/* -------------------------------------------------------------------------- */

/**
 * Repoint the merchant's populate tables at world copies, and its own
 * `flags.merchant-presets.shop.restock` (#98) along with them: the pack
 * ships that config pointed at the same compendium table, keyed by the same
 * result ids, and Item Piles' own populate tab is not the only thing that
 * would otherwise be left reading a table nothing repoints again (#100
 * review). Only touched when the shop's `restock.table` still names the
 * exact compendium table being wired here — a GM who has already repointed
 * it elsewhere is left alone.
 */
async function wireTables(actor) {
  if (!needsWiring(actor)) return false;
  const tables = foundry.utils.getProperty(actor, FLAG_PATH);
  const restock = foundry.utils.getProperty(actor, "flags.merchant-presets.shop.restock");

  const next = [];
  const update = {};
  for (const entry of tables) {
    if (!entry?.uuid?.startsWith(STOCK_PREFIX)) { next.push(entry); continue; }
    const src = await foundry.utils.fromUuid(entry.uuid);
    if (!src) { console.warn(`${MODULE} | missing stock table ${entry.uuid}`); continue; }
    const world = await ensureWorldTable(src);

    next.push({ ...entry, uuid: world.uuid, items: remapQuantities(src.results, world.results, entry.items) });

    if (restock?.table === entry.uuid) {
      update["flags.merchant-presets.shop.restock.table"] = world.uuid;
      // A plain object merges into what's already stored, so the stale
      // compendium result ids would survive alongside the new world ones
      // (and again on every later Replace Actor); _replace overwrites the
      // whole map instead, the same way setUpShop already has to (#100
      // review).
      update["flags.merchant-presets.shop.restock.quantities"] =
        _replace(remapQuantities(src.results, world.results, restock.quantities));
    }
  }
  if (!next.length) return false;
  await actor.update({ [FLAG_PATH]: next, ...update });
  return true;
}

/**
 * Roll this shop's stock.
 *
 * Services never run out. Containers are left alone: dnd5e pins a container's
 * quantity to exactly 1 (`ContainerData` declares
 * `quantity: new NumberField({min: 1, max: 1})`) because each one is a distinct
 * object holding its own contents, so a count of them cannot be represented —
 * the shop has one, and it sells out. Stock flagged as limited — poisons, spell
 * scrolls, and anything else a shop would not hold in depth — is always rolled;
 * everything else is rolled only when the world is set to finite stock. Anything that rolls zero
 * is simply not in stock today — "Roll All Tables" on the Populate Items tab
 * brings it back.
 */
async function applyStockMode(actor) {
  const finite = game.settings.get(MODULE, "stockMode") === "finite";
  const tierIndex = TIER_INDEX[tierOf(actor)];
  const quantityPath = game.itempiles.API.ITEM_QUANTITY_ATTRIBUTE;
  const flagPath = "flags.item-piles.item.infiniteQuantity";

  const updates = [];
  const soldOut = [];
  for (const item of actor.items) {
    // The shopkeeper's own kit is not stock: rolling it would put the smith's
    // armour on a stock band and, on a zero, delete it off the stat block.
    if (isGear(item)) continue;
    if (foundry.utils.getProperty(item, "flags.item-piles.item.isService")) continue;
    if (item.type === "container") continue;

    const alwaysLimited = foundry.utils.getProperty(item, flagPath) === "no";
    if (!finite && !alwaysLimited) continue;

    // The bundle size, so 3 "Arrows" means 3 bundles of 20 rather than 3 arrows.
    const bundle = Number(foundry.utils.getProperty(item, "flags.item-piles.system.quantityForPrice")) || 1;
    const count = await rollStock(stockFormula(item, tierIndex));
    if (count === 0) { soldOut.push(item.id); continue; }
    updates.push({ _id: item.id, [quantityPath]: count * bundle, [flagPath]: "no" });
  }

  // Keep the pile's own switches in step with the world's settings. The purse
  // only bites when infiniteCurrencies is off: Item Piles short-circuits the
  // whole affordability check when it is on, which makes the coin decorative.
  const pileUpdate = {};
  const infiniteCoin = game.settings.get(MODULE, "merchantPurse") === "unlimited";
  if (!!foundry.utils.getProperty(actor, "flags.item-piles.data.infiniteQuantity") === finite) {
    pileUpdate["flags.item-piles.data.infiniteQuantity"] = !finite;
  }
  if (!!foundry.utils.getProperty(actor, "flags.item-piles.data.infiniteCurrencies") !== infiniteCoin) {
    pileUpdate["flags.item-piles.data.infiniteCurrencies"] = infiniteCoin;
  }
  if (!foundry.utils.isEmpty(pileUpdate)) await actor.update(pileUpdate);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  if (soldOut.length) {
    await actor.deleteEmbeddedDocuments("Item", soldOut);
    log(`"${actor.name}" is out of ${soldOut.length} line(s) today`);
  }
  return !!(updates.length || soldOut.length);
}

/**
 * Bring one imported preset merchant fully into the world.
 * @param {Actor} actor
 * @returns {Promise<boolean>} whether anything changed
 */
async function rewire(actor) {
  if (!isPreset(actor)) return false;
  // One pass per merchant at a time. A merchant can arrive through createActor
  // and updateActor together, and both would see the compendium table and
  // roll its stock.
  if (rewiring.has(actor.id)) return false;
  rewiring.add(actor.id);
  try {
    // Stock is rolled once, in the call that wires the compendium table. A shop
    // already wired keeps the shelf it has: rewireAll and a duplicated merchant
    // reach here too, and must not re-roll it.
    const wired = await wireTables(actor);
    let changed = wired;
    if (wired) changed = await applyStockMode(actor) || changed;
    changed = await releaseStrays(actor) > 0 || changed;
    changed = await syncStockWeight(actor) || changed;
    changed = await syncOpenState(actor) || changed;
    if (changed) log(`prepared "${actor.name}"`);
    return changed;
  } finally {
    rewiring.delete(actor.id);
  }
}

/**
 * Wire every merchant of ours still on its compendium stock table.
 *
 * Catches merchants replaced from the compendium while nothing was listening
 * for it (#66), before anyone opens their Populate Items tab and Item Piles
 * drops the table. Unlike rewireAll it leaves wired merchants alone.
 *
 * @returns {Promise<number>} how many merchants were wired
 */
async function wireReplacedAll() {
  if (game.users.activeGM !== game.user) return 0;     // one GM does the writing
  let n = 0;
  for (const actor of game.actors) {
    if (!needsWiring(actor)) continue;
    try { if (await rewire(actor)) n++; }
    catch (err) { console.error(`${MODULE} | failed on "${actor.name}"`, err); }
  }
  return n;
}

/**
 * Fix every preset merchant already sitting in the world.
 * @returns {Promise<number>} how many actors were changed
 */
async function rewireAll() {
  let n = 0;
  for (const actor of game.actors) {
    try { if (await rewire(actor)) n++; }
    catch (err) { console.error(`${MODULE} | failed on "${actor.name}"`, err); }
  }
  ui.notifications.info(`Merchant Presets: prepared ${n} merchant(s).`);
  return n;
}

/* ------------------------------------------------------------------ restock */

/**
 * Calendar-driven restocking, on Foundry's own clock.
 *
 * Item Piles has all of this built in — `openTimes`, `refreshItemsOnOpen`,
 * `refreshItemsDays` — but every trigger runs through its Simple Calendar
 * plugin, and `BasePlugin.initialize()` gates on that module being active by id:
 *
 *   if (!game.modules.get("foundryvtt-simple-calendar")?.active) return;
 *
 * So no API shim can switch it on, and neither Foundry's built-in calendar nor
 * Calendaria can drive it. Everything needed is native in V14 though —
 * `game.time.components` and `game.time.calendar` — and
 * `game.itempiles.API.refreshMerchantInventory()` is public, so this reads the
 * same flags Item Piles would and calls the same refresh. Works with the core
 * calendar and with any module that advances `game.time.worldTime`.
 *
 * Holiday closures and holiday restocks are not supported: they are built on
 * Simple Calendar notes, which core has no equivalent for.
 */

/** Minutes since midnight, using this calendar's own hour length. */
function minuteOfDay(components) {
  const { minutesPerHour } = game.time.calendar.days;
  return (components.hour * minutesPerHour) + components.minute;
}

/** Whether `minute` falls inside a merchant's trading hours, wrapping midnight. */
function isOpenAt(pileData, minute) {
  const { minutesPerHour } = game.time.calendar.days;
  const open = (pileData.openTimes?.open?.hour ?? 0) * minutesPerHour + (pileData.openTimes?.open?.minute ?? 0);
  const close = (pileData.openTimes?.close?.hour ?? 0) * minutesPerHour + (pileData.openTimes?.close?.minute ?? 0);
  return open > close ? (minute >= open || minute <= close) : (minute >= open && minute <= close);
}

/**
 * Put back what a restock cannot know.
 *
 * Item Piles rebuilds a restocked shelf from the source compendium, and SRD
 * items carry no Item Piles flags — so a poison or a spell scroll would come
 * back as ordinary unlimited stock, quietly undoing the limited-items rule.
 * Each merchant carries the intended flags keyed by item name; re-apply them.
 *
 * @param {Actor} actor
 * @returns {Promise<number>} how many items were corrected
 */
async function reapplyItemFlags(actor) {
  const wanted = foundry.utils.getProperty(actor, "flags.merchant-presets.itemFlags");
  if (!wanted) return 0;
  const updates = [];
  for (const item of actor.items) {
    if (isGear(item)) continue;
    const want = wanted[item.name];
    if (!want) continue;
    const { quantityForPrice, ...itemFlags } = want;
    const have = foundry.utils.getProperty(item, "flags.item-piles.item") ?? {};
    const update = { _id: item.id };
    let changed = false;
    for (const [k, v] of Object.entries(itemFlags)) {
      if (have[k] !== v) { update[`flags.item-piles.item.${k}`] = v; changed = true; }
    }
    if (quantityForPrice
      && foundry.utils.getProperty(item, "flags.item-piles.system.quantityForPrice") !== quantityForPrice) {
      update["flags.item-piles.system.quantityForPrice"] = quantityForPrice;
      changed = true;
    }
    if (changed) updates.push(update);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return updates.length;
}

/**
 * Put back each recorded line's stock config (#119): the restock rebuilt it
 * from the compendium, which carries none (an SRD item) or only a good's own
 * goods-level stamp. `planRestockStock` derives it exactly as the migration does.
 *
 * @param {Actor} actor
 * @returns {Promise<number>} how many items were corrected
 */
async function reapplyStock(actor) {
  const { updates, errors } = planRestockStock(actor);
  for (const { item, errors: why } of errors) {
    console.warn(`${MODULE} | "${actor.name}": could not restore the stock config of "${item}"`, why);
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return updates.length;
}

/**
 * Put the shop's containers back to their proper number.
 *
 * A container cannot carry a quantity — dnd5e's ContainerData declares
 * `quantity: new NumberField({min: 1, max: 1})`, because each one is a distinct
 * object with its own contents, exactly as two pouches on a character sheet are
 * two items. So the shop stocks them as separate documents. A restock cannot
 * reproduce that on its own: Item Piles' Transaction appends one document per
 * table result and calls setItemQuantity on it, which dnd5e clamps straight
 * back to 1. Each merchant records how many of each it should carry.
 *
 * @param {Actor} actor
 * @returns {Promise<number>} how many container documents were created
 */
async function reconcileContainers(actor) {
  const wanted = foundry.utils.getProperty(actor, "flags.merchant-presets.containers");
  if (!wanted) return 0;
  const have = actor.items.filter(i => i.type === "container" && !isGear(i));
  const creates = [];
  for (const [name, target] of Object.entries(wanted)) {
    const existing = have.filter(i => i.name === name);
    if (!existing.length || existing.length >= target) continue;
    const template = existing[0].toObject();
    for (let n = existing.length; n < target; n++) {
      const copy = foundry.utils.deepClone(template);
      delete copy._id;
      creates.push(copy);
    }
  }
  if (creates.length) await actor.createEmbeddedDocuments("Item", creates);
  return creates.length;
}

/**
 * Keep the shop's own goods off the shopkeeper's back.
 *
 * A merchant's wares live in its inventory because that is what Item Piles
 * reads, so a shopkeeper is carrying every barrel and anvil on the shelves —
 * 14,775 lb for a city stable, against a capacity of 240. dnd5e ignores this
 * until a world turns encumbrance on, and then the shopkeeper is Exceeding
 * Carrying Capacity for good, which in the 2024 rules means Speed 0.
 *
 * The stock cannot be moved off the actor without hiding it from Item Piles, so
 * cancel its weight instead: an effect raising the thresholds by exactly what
 * the shop holds, leaving the shopkeeper's own kit to count normally. Off by
 * default, because dnd5e ships encumbrance off and then none of this bites.
 *
 * `encumbrance.value` is the system's own total, currency included, so the
 * shop's till is cancelled along with its goods — both belong to the shop
 * rather than to whoever minds it.
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>} whether the effect was added, changed or removed
 */
async function syncStockWeight(actor) {
  const existing = actor.effects.find(e => e.getFlag(MODULE, "stockWeight"));

  if (!game.settings.get(MODULE, "ignoreStockWeight")) {
    if (!existing) return false;
    await existing.delete();
    return true;
  }

  const base = CONFIG.DND5E.encumbrance.baseUnits;
  const units = (base[actor.type] ?? base.default)[
    game.settings.get("dnd5e", "metricWeightUnits") ? "metric" : "imperial"];
  const carried = actor.system.attributes?.encumbrance?.value ?? 0;
  // Contained items are already outside the system's own sum; skipping them
  // here too keeps this the exact complement of what it measured.
  const personal = actor.items
    .filter(i => !i.container && isGear(i))
    .reduce((w, i) => w + (i.system.totalWeightIn?.(units) ?? 0), 0);
  const shop = Math.max(0, Math.ceil(carried - personal));

  // These bonuses are roll formulas, so ADD appends rather than replaces and a
  // leading "+" keeps the result a valid formula — "10" from another module
  // becomes "10+700", which simplifyBonus evaluates to 710 rather than losing
  // one of them.
  const changes = [{
    key: "system.attributes.encumbrance.bonuses.overall",
    mode: CONST.ACTIVE_EFFECT_MODES.ADD,
    value: `+${shop}`
  }];

  if (existing) {
    if (existing.changes[0]?.value === changes[0].value && !existing.disabled) return false;
    await existing.update({ changes, disabled: false });
    return true;
  }

  await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: "Shop stock (not carried)",
    img: "icons/commodities/currency/coins-assorted-mix-copper-silver-gold.webp",
    description: "<p>The shop's goods and till sit in this actor's inventory because that is how "
      + "Item Piles stocks a merchant. This cancels their weight, so only the shopkeeper's own "
      + "equipment counts against their carrying capacity.</p>",
    changes,
    flags: { [MODULE]: { stockWeight: true } }
  }]);
  return true;
}

/**
 * Apply the stock-weight setting across every merchant already in the world.
 * @returns {Promise<number>} how many actors changed
 */
async function syncStockWeightAll() {
  if (!game.user.isGM) return 0;
  let n = 0;
  for (const actor of game.actors) {
    if (!isPreset(actor)) continue;
    try { if (await syncStockWeight(actor)) n++; }
    catch (err) { console.error(`${MODULE} | could not set stock weight on "${actor.name}"`, err); }
  }
  return n;
}

/**
 * Refill the till. Coin is finite, and buying from the party drains it, so
 * without this a shop that once bought a hoard is poor for the rest of the
 * campaign. A new day's trading starts from the shop's own purse.
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>} whether the purse changed
 */
async function replenishPurse(actor) {
  const purse = foundry.utils.getProperty(actor, "flags.merchant-presets.purse");
  if (!Number.isFinite(purse)) return false;
  if (actor.system?.currency?.gp === purse) return false;
  await actor.update({ "system.currency.gp": purse });
  return true;
}

/**
 * Let go of goods that name a container the merchant does not hold.
 *
 * The SRD kits ship their contents as items of their own, each carrying the
 * kit's id in `system.container`, and earlier builds stocked Rope, Tinderbox
 * and nine more goods from those copies. dnd5e lists such an item as loose,
 * but Item Piles counts it as contained and hides it from the shop window
 * (#89). Merchants dragged in from those builds still hold the copies. A
 * restock or Roll All Tables needs no repair: Item Piles drops
 * `system.container` whenever it adds items from a table.
 *
 * @param {Actor} actor
 * @returns {Promise<number>} how many items were let go
 */
async function releaseStrays(actor) {
  const held = new Set(actor.items.map(i => i.id));
  const updates = actor.items
    .filter(i => i.system?.container && !held.has(i.system.container))
    .map(i => ({ _id: i.id, "system.container": null }));
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  return updates.length;
}

/**
 * Let go of stray kit ids across every merchant already in the world.
 * @returns {Promise<number>} how many merchants changed
 */
async function releaseStraysAll() {
  if (game.users.activeGM !== game.user) return 0;     // one GM does the writing
  let n = 0;
  for (const actor of game.actors) {
    if (!isPreset(actor)) continue;
    try { if (await releaseStrays(actor)) n++; }
    catch (err) { console.error(`${MODULE} | could not release strays on "${actor.name}"`, err); }
  }
  return n;
}

/**
 * Restock one merchant: rebuild the shelf, then put back what the rebuild lost.
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>}
 */
async function restock(actor) {
  await game.itempiles.API.refreshMerchantInventory(actor);
  await reapplyItemFlags(actor);
  await reapplyStock(actor);
  await reconcileContainers(actor);
  await replenishPurse(actor);
  await syncStockWeight(actor);        // last: the shelf and the till have both just moved
  return true;
}

/**
 * Restock every merchant whose doors just opened.
 *
 * @param {number} worldTime  The new world time.
 * @param {number} previous   The world time last processed.
 * @returns {Promise<number>} how many merchants were restocked
 */
async function restockOnTimeChange(worldTime, previous) {
  const calendar = game.time.calendar;
  const { secondsPerMinute, minutesPerHour, hoursPerDay } = calendar.days;
  const secondsPerDay = secondsPerMinute * minutesPerHour * hoursPerDay;

  const wasMinute = minuteOfDay(calendar.timeToComponents(previous));
  const nowMinute = minuteOfDay(calendar.timeToComponents(worldTime));
  if (wasMinute === nowMinute && worldTime - previous < secondsPerDay) return 0;

  // A jump of a full day or more passes every opening time on the way.
  const dayPassed = (worldTime - previous) >= secondsPerDay;

  const restocked = [];
  for (const actor of game.actors) {
    const pileData = foundry.utils.getProperty(actor, "flags.item-piles.data");
    if (pileData?.type !== "merchant" || !pileData.refreshItemsOnOpen) continue;
    if (!pileData.openTimes?.enabled) continue;
    if (!(foundry.utils.getProperty(actor, FLAG_PATH) ?? []).length) continue;
    if (!dayPassed && (isOpenAt(pileData, wasMinute) || !isOpenAt(pileData, nowMinute))) continue;

    try {
      await restock(actor);
      restocked.push(actor.name);
    } catch (err) {
      console.error(`${MODULE} | could not restock "${actor.name}"`, err);
    }
  }

  if (restocked.length) {
    log(`restocked ${restocked.length}: ${restocked.join(", ")}`);
    ui.notifications.info(`Merchant Presets: ${restocked.length} shop(s) restocked for the new day.`);
  }
  return restocked.length;
}

/**
 * Open and close the shops on the world clock.
 *
 * Every merchant ships with trading hours, and Item Piles can act on them —
 * but only through Simple Calendar, which it requires by name. Worse, its
 * `updateOpenCloseStatus` rewrites `status: "auto"` back to `"open"` and saves
 * it when that module is absent, so the hours cannot even be left armed for
 * later. Simple Calendar is unmaintained and does not support v14, which this
 * module requires, so that path is closed for good rather than merely absent.
 *
 * Item Piles documents `open` and `closed` as first-class manual statuses,
 * though, so drive those from Foundry's own clock — the same trick this module
 * already plays for restocking, and using the same `isOpenAt` it reads the
 * hours with. No patching, and any calendar that advances world time works.
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>} whether the status changed
 */
async function syncOpenState(actor) {
  const pileData = foundry.utils.getProperty(actor, "flags.item-piles.data");
  if (!pileData?.openTimes?.enabled) return false;

  let wanted = "open";
  if (game.settings.get(MODULE, "tradingHours")) {
    const now = minuteOfDay(game.time.calendar.timeToComponents(game.time.worldTime));
    wanted = isOpenAt(pileData, now) ? "open" : "closed";
  }
  // Turning the setting off hands the shops back always-open, rather than
  // leaving whichever ones happened to be shut stuck that way.
  if (pileData.openTimes.status === wanted) return false;
  await actor.update({ "flags.item-piles.data.openTimes.status": wanted });
  return true;
}

/**
 * Put every merchant in the world on the right side of its own door.
 * @returns {Promise<number>} how many changed
 */
async function syncOpenStateAll() {
  if (game.users.activeGM !== game.user) return 0;     // one GM does the writing
  let n = 0;
  for (const actor of game.actors) {
    if (!isPreset(actor)) continue;
    try { if (await syncOpenState(actor)) n++; }
    catch (err) { console.error(`${MODULE} | could not set open state on "${actor.name}"`, err); }
  }
  return n;
}

/** Wire trading hours to the world clock. Separate from restocking, which is off by default. */
function registerTradingHours() {
  if (!game.settings.get(MODULE, "tradingHours")) return;
  Hooks.on("updateWorldTime", async () => {
    if (game.users.activeGM !== game.user) return;
    await syncOpenStateAll();
  });
  log(`trading hours active on the ${game.time.calendar.name ?? "world"} calendar`);
}

/** Wire restocking to the world clock. Only the designated GM acts. */
function registerRestock() {
  if (!game.settings.get(MODULE, "autoRestock")) return;
  // 0 means "never run": start from now, or the first tick would see a jump of
  // the whole world time and restock every shop at once.
  let previous = game.settings.get(MODULE, "lastRestockTime") || game.time.worldTime;

  Hooks.on("updateWorldTime", async worldTime => {
    if (game.users.activeGM !== game.user) return;      // one GM does the work
    if (worldTime === previous) return;
    const from = previous;
    previous = worldTime;
    await game.settings.set(MODULE, "lastRestockTime", worldTime);
    // Rewinding the clock should not trigger a day's worth of restocks.
    if (worldTime > from) await restockOnTimeChange(worldTime, from);
  });
  log(`automatic restocking active on the ${game.time.calendar.name ?? "world"} calendar`);
}

/* ---------------------------------------------------------------- nutrition */

/**
 * Teach Simple Nutrition 5e that ale and wine are drinks.
 *
 * Its water check is `WATER_IDENTIFIERS.has(item.system.identifier)`, read from
 * a live Set at call time, so adding our identifiers is enough — no patching.
 * The trade-off is forced by that module's own design: `getFoodCandidates`
 * rejects anything in the same Set, so a drink counts as water *instead of*
 * food, never both. Each is worth WATER_ITEM_AMOUNT (a pint); a Medium creature
 * needs a gallon a day, so eight mugs.
 */
async function registerDrinks() {
  if (!game.modules.get(NUTRITION_MODULE)?.active) return;
  if (!game.settings.get(MODULE, "drinksHydrate")) return;
  try {
    const url = foundry.utils.getRoute(`modules/${NUTRITION_MODULE}/scripts/config.mjs`);
    const cfg = await import(url);
    if (!(cfg?.WATER_IDENTIFIERS instanceof Set)) {
      throw new Error("WATER_IDENTIFIERS is not a Set — Simple Nutrition's config has changed shape");
    }
    for (const id of DRINK_IDENTIFIERS) cfg.WATER_IDENTIFIERS.add(id);
    log(`ale and wine now count as hydration (${DRINK_IDENTIFIERS.join(", ")})`);
  } catch (err) {
    console.warn(`${MODULE} | could not register drinks with ${NUTRITION_MODULE};`
      + " ale and wine will count as food instead", err);
  }
}

/**
 * Can we feed characters through the active Simple Nutrition?
 *
 * Meals and sheet consumption write straight into its daily tally, and the
 * unit of that tally changed in 1.0: before it, the same flag held pounds and
 * gallons. Writing fractions of a day into 0.5 would credit every creature
 * that is not Medium wrongly, and still pass the export checks below, so an
 * older version gets no meals rather than wrong ones. Drinks are unaffected —
 * WATER_IDENTIFIERS means the same in both.
 */
function nutritionFeeds() {
  const sn = game.modules.get(NUTRITION_MODULE);
  return !!sn?.active && !foundry.utils.isNewerVersion(NUTRITION_MINIMUM, sn.version);
}

/** Tell the GM once, at load, when a Simple Nutrition too old to feed is why meals do nothing. */
function warnOutdatedNutrition() {
  const sn = game.modules.get(NUTRITION_MODULE);
  if (!sn?.active || nutritionFeeds()) return;
  if (!game.settings.get(MODULE, "mealsFeed") && !game.settings.get(MODULE, "activityFeeds")) return;
  ui.notifications.warn(`Merchant Presets feeds characters through Simple Nutrition 5e ${NUTRITION_MINIMUM} `
    + `or later, but ${sn.version} is installed. Update it; until then meals and food eaten from the sheet `
    + "are not recorded.", { permanent: true });
}

/* -------------------------------------------------------------------- meals */

/**
 * Offer to eat a meal the moment it is bought.
 *
 * Meals are Item Piles services: paying for one hands nothing over, because
 * the eating happens at the inn's table. Simple Nutrition 5e can only feed a
 * character from an item in their inventory, so without this the meal would
 * be money for nothing. Instead, when a preset merchant sells a good carrying
 * a `nutrition` flag, the buyer is asked whether to eat it now, and saying
 * yes credits today's food and water the way that module's own Eat dialog
 * would (see scripts/nutrition.mjs for the arithmetic, and the imports below
 * for its state helpers and condition ids). The flag is the whole contract, so
 * a meal copied onto a tavern of your own works the same way.
 *
 * Item Piles fires `item-piles-tradeItems` on every client; only the buying
 * user's client acts, so one purchase gets one prompt. Players own their own
 * characters, so the flag write and the condition toggle need no GM. That
 * client gets the buyer as an actor and the meal as plain data, not the UUID
 * and Item document the hook is documented with (scripts/trade.mjs, #48).
 */
async function offerMeals(_seller, buyerRef, itemPrices, userId) {
  if (userId !== game.user.id) return;
  if (!nutritionFeeds()) return;
  if (!game.settings.get(MODULE, "mealsFeed")) return;
  const buyer = await fromUuid(uuidOf(buyerRef));
  if (buyer?.type !== "character") return;

  for (const entry of boughtWith(itemPrices, "nutrition")) {
    await eatMeal(buyer, entry.item, entry.quantity)
      .catch(err => console.error(`${MODULE} | could not apply ${entry.item?.name}`, err));
  }
}

async function eatMeal(actor, item, quantity) {
  const base = `modules/${NUTRITION_MODULE}/scripts`;
  const [cfg, sn] = await Promise.all([
    import(foundry.utils.getRoute(`${base}/config.mjs`)),
    import(foundry.utils.getRoute(`${base}/nutrition/actor.mjs`))
  ]);
  for (const fn of ["getNutritionState", "setNutritionState", "getNutritionNeeds", "formatNutritionAmount"]) {
    if (typeof sn[fn] !== "function") throw new Error(`Simple Nutrition no longer exports ${fn}`);
  }

  const nutrition = goodFlag(item, "nutrition");
  const needs = sn.getNutritionNeeds(actor);
  const food = nutrition.food * quantity;
  const water = nutrition.water * quantity;
  const parts = [];
  if (food) parts.push(`Food ${sn.formatNutritionAmount("food", food)}${food >= needs.food ? " (a full day)" : ""}`);
  if (water) parts.push(`Drink ${sn.formatNutritionAmount("water", water)}${water >= needs.water ? " (a full day)" : ""}`);
  const label = quantity > 1 ? `${quantity} × ${item.name}` : item.name;

  const eat = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Eat now?" },
    content: `<p>${actor.name} bought <strong>${label}</strong>. Eat it here?</p><p>${parts.join(" · ")}</p>`,
    yes: { label: "Eat", icon: "fa-solid fa-utensils" },
    no: { label: "Not now" },
    rejectClose: false
  });
  if (!eat) return;

  const result = await creditMeal(actor, cfg, sn, nutrition, quantity);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${actor.name}</strong> eats: ${label}.</p><p>${parts.join(" · ")}</p>`
  });
  log(`${actor.name} ate ${label}: today's tally food ${result.state.food}, water ${result.state.water} (days)`);
}

/**
 * Add what was eaten to the actor's day in Simple Nutrition, clearing any
 * condition it now satisfies. Queued per actor (see oneAtATime): the tally is
 * read only once an earlier credit's write has landed, so two quick uses
 * cannot erase each other (#44). The condition check sits inside the queue
 * too, so a credit that clears Malnourished is seen by the next.
 */
function creditMeal(actor, cfg, sn, nutrition, quantity) {
  return oneAtATime(actor.uuid, async () => {
    const has = {
      malnourished: actor.hasConditionEffect(cfg.CONDITION_EFFECT_MALNOURISHED),
      dehydrated: actor.hasConditionEffect(cfg.CONDITION_EFFECT_DEHYDRATED)
    };
    const result = applyMeal(sn.getNutritionState(actor), sn.getNutritionNeeds(actor), nutrition, quantity, has);
    await sn.setNutritionState(actor, result.state);
    if (result.clearMalnutrition) await actor.toggleStatusEffect(cfg.CONDITION_MALNUTRITION, { active: false });
    if (result.clearDehydration) await actor.toggleStatusEffect(cfg.CONDITION_DEHYDRATION, { active: false });
    return result;
  });
}

function registerMeals() {
  Hooks.on("item-piles-tradeItems", (...args) => {
    offerMeals(...args).catch(err => console.error(`${MODULE} |`, err));
  });
}

/* ------------------------------------------------------- eating by activity */

/**
 * Count a good eaten or drunk through its own Consume activity.
 *
 * Simple Nutrition 5e only records nutrition from its own dialog; it watches
 * no item-use hook, so using the activity on a bottle of wine from the sheet
 * empties the bottle and feeds nobody (#19). This listens to
 * `dnd5e.postUseActivity`, which fires only on the using client — the one
 * that owns the character — and records what Simple Nutrition would have for
 * the same item, by its own rules. Scoped to this module's goods: every other
 * item is Simple Nutrition's business (Kapuzenjoe/simple-nutrition-5e#4).
 *
 * dnd5e has already consumed the use and reduced the quantity by the time
 * this fires; a use with consumption unticked is not a meal.
 */
async function countActivityMeal(activity, usageConfig) {
  const item = activity?.item;
  const actor = item?.actor;
  if (!actor || actor.type !== "character") return;
  if (!item.getFlag(MODULE, "kind")) return;                // our goods only
  if (!nutritionFeeds()) return;
  if (!game.settings.get(MODULE, "activityFeeds")) return;
  if (!usageConsumes(usageConfig)) return;

  const base = `modules/${NUTRITION_MODULE}/scripts`;
  const [cfg, sn] = await Promise.all([
    import(foundry.utils.getRoute(`${base}/config.mjs`)),
    import(foundry.utils.getRoute(`${base}/nutrition/actor.mjs`))
  ]);
  const nutrition = nutritionOfItem({
    type: item.type,
    consumableType: item.system.type?.value,
    identifier: item.system.identifier,
    weightLb: game.dnd5e.utils.convertWeight(item.system.weight?.value ?? 0, item.system.weight?.units ?? "lb", "lb")
  }, cfg.WATER_IDENTIFIERS, cfg.WATER_ITEM_AMOUNT);
  if (!nutrition) return;

  const result = await creditMeal(actor, cfg, sn, nutrition, 1);
  const what = nutrition.water
    ? `Drink ${sn.formatNutritionAmount("water", nutrition.water)}`
    : `Food ${sn.formatNutritionAmount("food", nutrition.food)}`;
  ui.notifications.info(`${actor.name}: ${item.name} — ${what}`);
  log(`${actor.name} consumed ${item.name} by activity: today's tally food ${result.state.food}, `
    + `water ${result.state.water} (days)`);
}

function registerActivityMeals() {
  Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => {
    countActivityMeal(activity, usageConfig).catch(err => console.error(`${MODULE} |`, err));
  });
}

/* ------------------------------------------------------------------ animals */

const ANIMAL_FOLDER = "Purchased Animals";

/**
 * Put a bought animal in the world.
 *
 * The SRD has no animal items: a riding horse is a stat block in
 * dnd5e.actors24, the pack the shopkeepers are statted from. The goods the
 * stables sell are therefore loot placeholders at the SRD price, each carrying
 * an `actor` flag naming its stat block. When one is bought, the stat block is
 * copied into the world — one actor per animal, in a "Purchased Animals"
 * folder, owned by whoever owns the buying character — and the loot item
 * becomes the bill of sale, linking to the creatures it stands for.
 *
 * Item Piles runs every trade through a GM, so one is always online; the
 * active GM's client does the creating, which players are not allowed to.
 * Nothing is placed on a scene: the GM drags the animal in from the sidebar.
 * Selling the deed back is money only — the animal stays for the GM to deal
 * with, since deleting actors unasked is not this module's business.
 */
async function deliverAnimals(sellerRef, buyerRef, itemPrices, _userId) {
  if (game.users.activeGM !== game.user) return;
  if (!game.settings.get(MODULE, "animalsSpawn")) return;
  const bought = boughtWith(itemPrices, "actor");
  if (!bought.length) return;

  // Actors rather than UUIDs, despite the hook's documentation (#48).
  const buyer = await fromUuid(uuidOf(buyerRef));
  const seller = await fromUuid(uuidOf(sellerRef));
  if (!buyer) return;

  // Selling a deed to a merchant: the deed is the merchant's entry now.
  if (game.itempiles?.API?.isItemPileMerchant?.(buyer)) {
    const names = bought.map(e => e.item.name).join(", ");
    await ChatMessage.create({
      content: `<p><strong>${seller?.name ?? "Someone"}</strong> sold ${names} to ${buyer.name}. `
        + `The animal is still in the <em>${ANIMAL_FOLDER}</em> folder for the GM to remove or keep.</p>`,
      whisper: game.users.filter(u => u.isGM).map(u => u.id)
    });
    return;
  }

  const folder = await ensureFolder(ANIMAL_FOLDER, "Actor");
  for (const entry of bought) {
    try {
      const uuids = await spawnAnimals(buyer, entry.item, entry.quantity, folder);
      await recordDeed(buyer, entry.item, uuids);
      const links = uuids.map(u => `@UUID[${u}]`).join(", ");
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: buyer }),
        content: `<p><strong>${buyer.name}</strong> bought ${entry.quantity > 1 ? `${entry.quantity} × ` : ""}`
          + `${entry.item.name} from ${seller?.name ?? "a merchant"}: ${links}</p>`
      });
    } catch (err) {
      console.error(`${MODULE} | could not deliver ${entry.item.name}`, err);
    }
  }
}

async function spawnAnimals(buyer, good, quantity, folder) {
  const src = await fromUuid(goodFlag(good, "actor"));
  if (!src) throw new Error(`stat block ${goodFlag(good, "actor")} not found — is the dnd5e system's SRD installed?`);
  const data = game.actors.fromCompendium(src, { clearFolder: true, clearOwnership: true });
  data.folder = folder.id;
  data.ownership = { ...buyer.ownership };
  if (good.img) {
    data.img = good.img;
    foundry.utils.setProperty(data, "prototypeToken.texture.src", good.img);
  }
  foundry.utils.setProperty(data, "prototypeToken.actorLink", true);
  foundry.utils.setProperty(data, "prototypeToken.disposition", CONST.TOKEN_DISPOSITIONS.FRIENDLY);
  foundry.utils.setProperty(data, `flags.${MODULE}.boughtBy`, buyer.uuid);

  const created = await Actor.implementation.createDocuments(
    Array.from({ length: quantity }, () => foundry.utils.deepClone(data)));
  return created.map(a => a.uuid);
}

/** Mark the buyer's copy of the good as the deed for these animals. */
async function recordDeed(buyer, good, uuids) {
  const source = good._stats?.compendiumSource ?? good.uuid;
  const deed = buyer.items.find(i => i.name === good.name
    && (i._stats?.compendiumSource === source || i.getFlag(MODULE, "actor") === goodFlag(good, "actor")));
  if (!deed) return;
  const all = [...(deed.getFlag(MODULE, "animals") ?? []), ...uuids];
  const links = all.map(u => `@UUID[${u}]`).join(", ");
  const desc = deed.system.description?.value ?? "";
  const body = desc.replace(/<p class="mp-animals">.*?<\/p>/s, "");
  await deed.update({
    [`flags.${MODULE}.animals`]: all,
    "system.description.value": `${body}<p class="mp-animals">Your ${all.length > 1 ? "animals" : "animal"}: ${links}</p>`
  });
}

function registerAnimals() {
  Hooks.on("item-piles-tradeItems", (...args) => {
    deliverAnimals(...args).catch(err => console.error(`${MODULE} |`, err));
  });
}

/* ------------------------------------------------------------- spellcasting */

/**
 * Say in chat which spell a bought spellcasting service casts, and for whom
 * (#70). The message text, and why it carries no price, is scripts/casting.mjs.
 *
 * Posted by the client of the user who traded, like the meal prompt, so one
 * trade makes one message and no GM has to be at the table. A named service
 * links its spell, fetched here for the effects the GM may drag onto the
 * target; a spell that cannot be fetched is still announced, linked, without
 * them.
 */
async function announceSpellcasting(sellerRef, buyerRef, itemPrices, userId) {
  if (userId !== game.user.id) return;
  if (!game.settings.get(MODULE, "spellcastingToChat")) return;
  const bought = castsIn(itemPrices);
  if (!bought.length) return;
  const seller = await fromUuid(uuidOf(sellerRef));
  const buyer = await fromUuid(uuidOf(buyerRef));
  if (!seller || !buyer || !game.itempiles?.API?.isItemPileMerchant?.(seller)) return;

  const casts = [];
  for (const { item, quantity } of bought) {
    const spell = goodFlag(item, "spell") ?? null;
    const doc = spell ? await fromUuid(spell).catch(() => null) : null;
    casts.push({ name: item.name, quantity, spell, effects: actorEffects(doc?.effects) });
  }

  let mode = 1;
  try { mode = Number(game.settings.get("item-piles", "outputToChat")) || 0; } catch { /* Item Piles' setting is not registered */ }
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: seller }),
    content: castingMessage({ shop: seller.name, buyer: buyer.name, casts }),
    whisper: chatRecipients(mode, game.users.filter(u => u.isGM).map(u => u.id), userId)
  });
}

function registerSpellcasting() {
  Hooks.on("item-piles-tradeItems", (...args) => {
    announceSpellcasting(...args).catch(err => console.error(`${MODULE} |`, err));
  });
}

/* ----------------------------------------------------------- 1.x migration */

/**
 * The shipped merchant's own `flags.merchant-presets.shop` (#99), for
 * `restock.every` — the one field Item Piles never had. Resolved from
 * `packShopCandidates`, in preference order, returning the first that
 * actually names a shop (a #57 NPC's own compendium provenance points at
 * the SRD stat block it was instantiated from, not a shop, so that
 * candidate must be skipped rather than trusted outright — #100 review).
 * `undefined` when nothing resolves (a #57 source since deleted, say), so
 * the migration falls back to the schema default.
 *
 * @param {object} actorData  `actor.toObject()`.
 * @returns {Promise<object|undefined>}
 */
async function resolvePackShop(actorData) {
  for (const uuid of packShopCandidates(actorData)) {
    const doc = await foundry.utils.fromUuid(uuid).catch(() => null);
    const shop = doc?.flags?.["merchant-presets"]?.shop;
    if (shop) return shop;
  }
  return undefined;
}

/**
 * Bring one 1.x merchant into its 2.0 shop config (#100): always the data
 * half — `flags.merchant-presets.shop` and each item's `.stock` — and, once
 * `NATIVE_SHOP` is `true`, the cut-over half too: Item Piles switched off
 * everywhere it can still see the shop (#97) — the actor, its prototype
 * token, and every unlinked token, and its delta, on every scene — plus the
 * 2.0 sheet and the ownership default. Until then `next` keeps trading,
 * opening and restocking every shop through Item Piles, unchanged (the #97
 * decision, "Order on next"). Reads stored flags directly, so it works with
 * Item Piles inactive or uninstalled. Once `flags.merchant-presets.shop` is
 * current, a GM's own Item Piles retuning is never read again — our schema
 * is the source of truth from there on, same as everything else the runtime
 * rebuilds from a stored record rather than Item Piles' live state (see
 * `reapplyItemFlags`).
 *
 * Does nothing while `migrationGateOpen` is closed (#100 review). The shop
 * and item halves are independent writes: a shop config still invalid after
 * repair (`planActorUpdate`'s `shopError`) is logged but doesn't stop the
 * item half, which has nothing to do with it (#100 review).
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>} whether anything was actually written
 */
async function migrateShop(actor) {
  // Never a compendium copy (same rule as isPreset): it proves nothing about
  // this world until it's imported, and createActor fires inside packs too.
  if (!migrationGateOpen || actor.pack || !isMigratable(actor)) return false;
  const data = actor.toObject();

  // needsMigration can usually decide without scanning every scene's
  // tokens — the expensive part across a whole world's actors — so check
  // without them first. Only once the cut-over (NATIVE_SHOP) is live and
  // this shop would otherwise look fully done can a stray token still
  // change the answer, the one case tokens have to be gathered just to
  // find out (#100 review).
  const definitelyNeedsMigration = needsMigration(data, NATIVE_SHOP);
  if (!definitelyNeedsMigration && !NATIVE_SHOP) return false;

  const scenes = game.scenes.map(scene => ({
    scene, tokens: scene.tokens.filter(t => t.actorId === actor.id).map(t => t.toObject())
  }));
  const tokens = scenes.flatMap(s => s.tokens);
  if (!definitelyNeedsMigration && !needsMigration(data, NATIVE_SHOP, tokens)) return false;

  const packShop = await resolvePackShop(data);
  const { update, shopError, warnings } = planActorUpdate(data, { packShop, hasTokenOnScene: tokens.length > 0, nativeShop: NATIVE_SHOP });
  if (shopError) console.error(`${MODULE} | ${shopError}`);
  for (const w of warnings) console.warn(`${MODULE} | ${w}`);

  // A 1.x merchant sitting in a world compendium or an Adventure only
  // proves "this world is upgrading from 1.x" once it's actually migrated,
  // which can be well after applyAutoRestockDefault's own first-load check
  // already found nothing (#100 review). Written before the actor's own
  // update below: if it fails, nothing is written for this actor at all —
  // the world's only evidence of it stays exactly as unmigrated as it was,
  // for a retry on the next load, rather than the actor's own write erasing
  // it a moment before the setting that depended on it could land.
  //
  // A fresh 2.0 world importing old 1.x content lands here too, and there's
  // no telling it from an upgrade (#120 review). Off is the safe guess: on
  // would reroll a GM's curated stock, off only leaves shops unrestocked.
  // So the GM is told, since they may want it back on.
  if (shouldForceAutoRestockOff(update, hasStoredAutoRestock())) {
    try { await game.settings.set(MODULE, "autoRestock", false); }
    catch (err) {
      migrationGateOpen = false;
      console.error(`${MODULE} | could not force the autoRestock default off; migration deferred to next load`, err);
      return false;
    }
    // Several merchants imported together each see no stored value before the
    // first write returns; the setting lands the same, but tell the GM once.
    if (!autoRestockNoticeShown) {
      autoRestockNoticeShown = true;
      ui.notifications.warn(`Merchant Presets: "${actor.name}" is a 1.x merchant, so automatic restocking `
        + "has been turned off to keep 1.x behaviour. Turn it back on in the module settings if you want it.");
    }
  }

  let changed = false;
  if (update) { await actor.update(update); changed = true; }

  const { updates: itemUpdates, errors: itemErrors } = planItemUpdates(data);
  if (itemUpdates.length) { await actor.updateEmbeddedDocuments("Item", itemUpdates); changed = true; }
  for (const { item, errors } of itemErrors) {
    console.error(`${MODULE} | invalid migrated stock config for "${item}" on "${actor.name}": ${errors.join("; ")}`);
  }

  for (const { scene, tokens: sceneTokens } of scenes) {
    const tokenUpdates = planTokenUpdates(sceneTokens, NATIVE_SHOP);
    if (tokenUpdates.length) { await scene.updateEmbeddedDocuments("Token", tokenUpdates); changed = true; }
  }

  if (changed) log(`migrated "${actor.name}" to its 2.0 shop config`);
  return changed;
}

/**
 * Migrate every one of our shops still on a pre-2.0 config, or still Item
 * Piles' own merchant. Runs on `ready` and on `createActor`, not only once
 * per version, so a shop arriving later from a world compendium or an
 * Adventure — or a re-upgrade after a rollback — is caught too (#97).
 *
 * @returns {Promise<number>} how many shops changed
 */
async function migrateAll() {
  if (game.users.activeGM !== game.user) return 0;   // one GM does the writing
  let n = 0;
  for (const actor of game.actors) {
    try { if (await migrateShop(actor)) n++; }
    catch (err) { console.error(`${MODULE} | could not migrate "${actor.name}"`, err); }
  }
  return n;
}

/** Whether the world's settings storage already holds a value for
 *  `autoRestock` — a GM's own choice, on 1.x or 2.0, never overwritten by
 *  either the first-load default decision or `migrateShop`'s own (#100
 *  review). */
function hasStoredAutoRestock() {
  const key = `${MODULE}.autoRestock`;
  return !!game.settings.storage.get("world").find(s => s.key === key);
}

/**
 * Force `autoRestock` off on this world's first 2.0 load, if it's upgrading
 * from 1.x and the GM never touched the setting (#105): the setting's
 * default flips from off to on in 2.0, and leaving that unhandled would
 * silently turn restocking on under every world that left it unset.
 *
 * Decided once, on the first load where `autoRestockDecided` is unset, then
 * never re-evaluated: `worldHasLegacyShops` reads `game.actors` fresh every
 * call, and a #57 setup done on 2.0 (its own marker carries no version
 * until #119) would otherwise look like one more 1.x merchant on a later
 * reload and wrongly flip a fresh 2.0 world's default off. Awaited by the
 * caller, which closes `migrationGateOpen` if this throws: a migration that
 * ran anyway would erase the very signal this reads, before a retry on the
 * next load could capture it.
 */
async function applyAutoRestockDefault() {
  if (game.settings.get(MODULE, "autoRestockDecided")) return;
  const value = planAutoRestockDefault(hasStoredAutoRestock(), worldHasLegacyShops(game.actors));
  if (value !== null) await game.settings.set(MODULE, "autoRestock", value);
  await game.settings.set(MODULE, "autoRestockDecided", true);
}

/* -------------------------------------------------------- setting up a shop */

/**
 * Turn any NPC into one of the shops (#57).
 *
 * A GM's own shopkeeper — Sister Garaele in Phandelver, say — keeps its name,
 * portrait, stat block and token and becomes the chosen merchant: stock,
 * buying rules, prices, purse and trading hours. The decisions are
 * scripts/shop.mjs's `planShop`; this carries them out, then runs the same
 * import path a merchant dragged out of the compendium does. The source's
 * stock table is still the compendium's at that point, so it is wired and
 * stock is rolled once, for the settlement size on the marker.
 *
 * @param {Actor} actor
 * @param {string} sourceUuid  The chosen merchant in this module's compendium.
 * @param {Iterable<string>} keepIds  Physical items to keep as the NPC's gear.
 * @returns {Promise<number>} how many stock lines the shop holds
 */
async function setUpShop(actor, sourceUuid, keepIds) {
  const source = await foundry.utils.fromUuid(sourceUuid);
  if (!source) throw new Error(`merchant ${sourceUuid} not found`);
  const sourceData = source.toObject();
  // Every 2.0 pack merchant carries its own current flags.merchant-presets.shop
  // (#99); copy it wholesale rather than writing a bare {source, tier}
  // marker, which used to wipe the chosen merchant's terms, hours, restock
  // and won't-buy outright (#119 fix 3). Deriving it from the source's own
  // Item Piles data is a defensive fallback for a source that somehow still
  // lacks one.
  let sourceShop = sourceData.flags["merchant-presets"]?.shop;
  if (!hasCurrentShop(sourceData)) {
    const derived = derivedShop(sourceData);
    if (!derived.ok) throw new Error(`merchant ${sourceUuid} has no valid shop config: ${derived.errors.join("; ")}`);
    sourceShop = derived.shop;
  }
  const plan = planShop({ ...sourceData, uuid: source.uuid }, actor.toObject(), keepIds, sourceShop);

  // Hold the merchant while it is half built: the flag update below puts it on
  // a compendium table, and the updateActor hook would otherwise wire it and
  // roll a shelf the stock has not reached yet.
  rewiring.add(actor.id);
  try {
    // Out of their containers before the containers go, since dnd5e may take
    // a container's contents with it.
    if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates);
    if (plan.deletes.length) await actor.deleteEmbeddedDocuments("Item", plan.deletes);
    await actor.update({
      "flags.item-piles.data": _replace(plan.pileData),
      [`flags.${MODULE}.purse`]: plan.moduleFlags.purse,
      [`flags.${MODULE}.itemFlags`]: plan.moduleFlags.itemFlags ? _replace(plan.moduleFlags.itemFlags) : null,
      [`flags.${MODULE}.containers`]: plan.moduleFlags.containers ? _replace(plan.moduleFlags.containers) : null,
      [`flags.${MODULE}.shop`]: _replace(plan.moduleFlags.shop),
      "system.currency": plan.currency
    });
    if (plan.creates.length) await actor.createEmbeddedDocuments("Item", plan.creates, { keepId: true });
  } finally {
    rewiring.delete(actor.id);
  }
  await rewire(actor);
  return actor.items.filter(i => !isGear(i)).length;
}

/** Ask which shop an NPC should become, then make it so. */
async function shopDialog(actor) {
  const pack = game.packs.get(`${MODULE}.merchants`);
  const shops = listShops(await pack.getIndex());
  const marker = actor.getFlag(MODULE, "shop");
  // A shipped merchant's own name preselects it, so an NPC that was never set
  // up as a shop before still opens on a sensible guess.
  const strippedName = actor.name.match(/^(.*) \((?:Village|Town|City)\)$/)?.[1];
  const current = shops.find(s => Object.values(s.tiers).includes(marker?.source))?.name
    ?? shops.find(s => s.name === strippedName)?.name;
  const tier = tierOf(actor);
  const esc = foundry.utils.escapeHTML;
  const name = esc(actor.name);

  const option = (value, label, selected) =>
    `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const gear = keepableItems(actor.toObject()).map(i =>
    `<label class="checkbox"><input type="checkbox" name="keep.${i._id}" checked> ${esc(i.name)}</label>`).join("");

  const content = `
    <div class="form-group"><label>Shop</label>
      <select name="shop">${shops.map(s => option(s.name, s.name, s.name === current)).join("")}</select></div>
    <div class="form-group"><label>Settlement</label>
      <select name="tier">${TIERS.map(t => option(t, t, t === tier)).join("")}</select></div>
    ${gear ? `<fieldset><legend>Keep as ${name}'s own gear</legend>${gear}</fieldset>` : ""}
    <p class="notes">Replaces ${name}'s merchant settings, coin and stock. ${name}'s portrait, name,
      stat block and token are unchanged. Unticked items are deleted and can't be restored.</p>`;

  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: `Set up ${actor.name} as a shop` },
    content,
    buttons: [
      { action: "apply", label: "Set up shop", icon: "fa-solid fa-store", default: true,
        callback: (_event, button) => foundry.utils.expandObject(
          new foundry.applications.ux.FormDataExtended(button.form).object) },
      { action: "cancel", label: "Cancel" }
    ],
    rejectClose: false
  });
  if (!result || result === "cancel") return;

  const shop = shops.find(s => s.name === result.shop);
  const uuid = shop?.tiers[result.tier];
  if (!uuid) {
    ui.notifications.error(`There is no ${result.shop} (${result.tier}) in the Merchants compendium.`);
    return;
  }
  const keepIds = Object.entries(result.keep ?? {}).filter(([, on]) => on).map(([id]) => id);
  const lines = await setUpShop(actor, uuid, keepIds);
  ui.notifications.info(`${actor.name} is now a ${shop.name} (${result.tier}): ${lines} stock lines.`);
}

/** The Actors sidebar entry. Registered at init, before the sidebar first renders. */
function registerShopSetup() {
  Hooks.on("getActorContextOptions", (app, options) => {
    // Compendium extends DocumentDirectory too, so an Actor compendium fires
    // this hook as well — and an imported actor keeps its compendium id, so
    // resolving it against game.actors would act on the world copy from a
    // right-click in the pack. World directory only.
    if (app.collection !== game.actors) return;
    const actorOf = li => game.actors.get(li.closest("[data-entry-id]")?.dataset.entryId);
    options.push({
      label: "Set up as shop…",
      icon: "fa-solid fa-store",
      visible: li => game.user.isGM && !!game.modules.get("item-piles")?.active && actorOf(li)?.type === "npc",
      onClick: (_event, li) => {
        const actor = actorOf(li);
        if (actor) shopDialog(actor).catch(err => {
          console.error(`${MODULE} | could not set up "${actor.name}" as a shop`, err);
          ui.notifications.error(`Could not set up ${actor.name} as a shop: ${err.message}`);
        });
      }
    });
  });
}

/* ----------------------------------------------------------------- settings */

Hooks.once("init", () => {
  game.settings.register(MODULE, "stockMode", {
    name: "Shop stock",
    hint: "Unlimited: shops never run out of ordinary goods (poisons, scrolls, gunpowder and "
      + "firearms are always limited, and containers are always one-of). Finite: every good gets "
      + "a rolled stock count scaled to its price and the settlement size, and can sell out — an "
      + "expensive item may not be in stock at all. Applies to merchants imported after the change.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      unlimited: "Unlimited — shops never run out",
      finite: "Finite — rolled stock, can sell out (default)"
    },
    default: "finite"
  });

  game.settings.register(MODULE, "merchantPurse", {
    name: "Merchant coin",
    hint: "Finite: each shop has a purse scaled to its trade and settlement size (40 gp for a "
      + "village innkeeper, 12,500 for a city dock) and cannot buy beyond it, so a party with "
      + "3,000 gp of loot has to find a buyer who can afford it. Unlimited: any merchant can buy "
      + "anything, and the purse is decorative. Applies to merchants imported after the change.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      finite: "Finite — shops can run out of coin (default)",
      unlimited: "Unlimited — shops can always pay"
    },
    default: "finite"
  });

  game.settings.register(MODULE, "autoRestock", {
    name: "Restock shops when they open",
    hint: "Each merchant carries trading hours and can restock when its doors open for the day, "
      + "using Foundry's own calendar rather than Simple Calendar. OFF BY DEFAULT: a restock "
      + "rebuilds the shelf from the shop's stock table, which discards anything you added to that "
      + "merchant by hand. Turn it on once your shops hold nothing you would miss. Takes effect on "
      + "reload.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  // Last world time a restock pass ran for, so a reload cannot re-fire one.
  game.settings.register(MODULE, "lastRestockTime", {
    scope: "world", config: false, type: Number, default: 0
  });

  // Whether the autoRestock default (#105) has already been decided.
  // Decided once, at this world's first 2.0 load, and never again: a 2.0
  // #57 setup (#57's own marker carries no version until #119 rebuilds it)
  // would otherwise read as one more 1.x merchant on a later reload, and
  // flip a genuinely fresh 2.0 world's default off (#100 review).
  game.settings.register(MODULE, "autoRestockDecided", {
    scope: "world", config: false, type: Boolean, default: false
  });

  game.settings.register(MODULE, "tradingHours", {
    name: "Shops keep their trading hours",
    hint: "Every merchant ships with hours — a jeweler keeps 09:00-17:00, a dock opens at 05:00, "
      + "a fence trades 20:00 to 04:00 — and closes to players outside them. Item Piles can do "
      + "this itself, but only through Simple Calendar, which it requires by name and which is "
      + "unmaintained and does not support v14; this module drives the same hours off Foundry's "
      + "own world clock instead, so any calendar that advances time works. Turn it off and every "
      + "shop stays open around the clock. Takes effect on reload.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => syncOpenStateAll()
  });

  game.settings.register(MODULE, "ignoreStockWeight", {
    name: "Shop stock is not carried",
    hint: "A merchant's wares and till sit in its own inventory, because that is what Item Piles "
      + "reads as the shop. dnd5e therefore has the shopkeeper carrying the whole shelf — a city "
      + "stable holds 14,775 lb against a capacity of 240 — which does nothing until you turn on "
      + "dnd5e's Encumbrance variant, and then leaves every shopkeeper permanently Exceeding "
      + "Carrying Capacity. Turn this on to cancel the weight of the stock and the purse, leaving "
      + "the shopkeeper's own equipment to count normally. Off by default, because encumbrance is.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => syncStockWeightAll()
  });

  game.settings.register(MODULE, "drinksHydrate", {
    name: "Ale and wine slake thirst",
    hint: "With Simple Nutrition 5e installed, count ale and wine towards a character's water "
      + "instead of their food (that module treats an item as one or the other, never both). "
      + "One drink is worth a pint; a Medium creature needs a gallon a day. Takes effect on reload.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE, "mealsFeed", {
    name: "Meals feed the buyer",
    hint: "With Simple Nutrition 5e 1.0 or later installed, buying a meal at an inn asks the buyer whether to "
      + "eat it there and then, and credits today's food and drink by the meal's quality — a "
      + "squalid meal is a quarter of a Medium creature's day with nothing to drink, a modest one "
      + "a full day's food and a pint, an aristocratic one a feast. Meals are services, so no item "
      + "changes hands either way.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE, "activityFeeds", {
    name: "Eating from the sheet counts",
    hint: "With Simple Nutrition 5e 1.0 or later installed, using the Consume activity on ale, wine, bread or cheese "
      + "from a character sheet records the food or water, as if it had been consumed through Simple "
      + "Nutrition's own dialog. Off: only that dialog counts.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE, "animalsSpawn", {
    name: "Bought animals are added to the world",
    hint: "The SRD has no animal items — a riding horse is a stat block — so the goods a stable "
      + "sells are placeholders at the SRD price. With this on, buying one copies the SRD stat "
      + "block into the world as an actor in a \"Purchased Animals\" folder, owned by whoever owns "
      + "the buying character, and the item in their pack becomes the bill of sale linking to it. "
      + "Nothing is placed on a scene; drag the animal in from the sidebar.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE, "spellcastingToChat", {
    name: "Bought spellcasting is announced in chat",
    hint: "Buying a spellcasting service moves gold and nothing else. With this on, the shop says in "
      + "chat which spell it casts and for whom, linking the spell and any effects to drag onto the "
      + "creature it was cast on; for a service sold by level it asks the buyer to name the spell. "
      + "Nothing is applied automatically. The message follows Item Piles' own chat visibility.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  registerShopSetup();
});

Hooks.once("ready", async () => {
  game.modules.get(MODULE).api = { rewire, rewireAll, registerDrinks, restock, restockOnTimeChange, reapplyItemFlags,
    reconcileContainers, replenishPurse, syncStockWeight, syncStockWeightAll,
    syncOpenState, syncOpenStateAll, setUpShop, migrateShop, migrateAll };

  // Every client evaluates its own nutrition candidates, so this must run for
  // players too — and it does not depend on Item Piles.
  registerDrinks();
  // The buyer's own client answers the meal prompt, so this is for players too.
  registerMeals();
  registerActivityMeals();
  // So is the spellcasting announcement: whoever traded posts it.
  registerSpellcasting();

  if (!game.user.isGM) return;
  warnOutdatedNutrition();

  // The 1.x → 2.0 migration (#100) and the world's one-time autoRestock
  // decision (#105) read stored flags directly, so both run whether or not
  // Item Piles is active or even installed — unlike everything below, which
  // needs it. Awaited: a failed write here must close migrationGateOpen
  // before anything below can migrate a shop (#100 review).
  try { await applyAutoRestockDefault(); }
  catch (err) {
    migrationGateOpen = false;
    console.error(`${MODULE} | could not apply the autoRestock default; migration deferred to next load`, err);
  }

  // One handler, not two: wiring a fresh merchant to a world stock table
  // has to finish before the migration reads restock.table/.quantities off
  // it, or it captures the compendium table's ids, which don't survive the
  // import (#100 review). `onCreateActor` sequences the two.
  Hooks.on("createActor", (actor, _options, userId) => {
    if (userId !== game.user.id) return;
    onCreateActor(actor).catch(err => console.error(`${MODULE} |`, err));
  });

  if (!game.modules.get("item-piles")?.active) {
    ui.notifications.warn("Merchant Presets requires the Item Piles module, which is not active.");
    migrateAll().then(n => { if (n) log(`migrated ${n} shop(s) to their 2.0 config`); });
    return;
  }

  // Dragging in a shop the world already holds offers Replace Actor, and that
  // is the default: Foundry keeps the compendium id on import, then writes the
  // compendium data over the existing actor as an update (#66). Only a
  // merchant left on its compendium table is touched, so an ordinary edit
  // never re-rolls a shop or overrides its open/closed status.
  Hooks.on("updateActor", (actor, _changes, _options, userId) => {
    if (userId !== game.user.id || !needsWiring(actor)) return;
    rewire(actor).catch(err => console.error(`${MODULE} |`, err));
  });

  registerRestock();
  registerTradingHours();
  registerAnimals();
  // Time moves while a world is closed, so put the shops on the right side of
  // their doors now rather than at the next tick of the clock.
  syncOpenStateAll().then(n => { if (n) log(`${n} shop(s) opened or closed for the hour`); });
  // wireReplacedAll before migrateAll, same reason as onCreateActor: a
  // merchant still on its compendium stock table from earlier in the
  // world's life must be repointed at the world copy before the migration
  // reads it (#100 review).
  wireReplacedAll()
    .then(n => { if (n) log(`wired ${n} merchant(s) replaced from the compendium`); })
    .then(() => migrateAll())
    .then(n => { if (n) log(`migrated ${n} shop(s) to their 2.0 config`); });
  releaseStraysAll().then(n => { if (n) log(`let go of stray kit ids on ${n} merchant(s)`); });

  log("ready");
});

/**
 * One merchant just created — dragged from the compendium, or set up as one
 * via #57. Wired to a world stock table first, while Item Piles can still do
 * that, so the migration that follows sees the table it will actually
 * keep — reading `restock.table`/`.quantities` off the actor before wiring
 * repoints it would capture the compendium table's ids, which the import
 * doesn't carry over (#100 review).
 *
 * @param {Actor} actor
 */
async function onCreateActor(actor) {
  if (game.modules.get("item-piles")?.active) await rewire(actor);
  await migrateShop(actor);
}
