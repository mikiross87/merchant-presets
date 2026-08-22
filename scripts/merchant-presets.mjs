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

import { applyMeal } from "./nutrition.mjs";

const MODULE = "merchant-presets";
const STOCK_PREFIX = `Compendium.${MODULE}.stock.RollTable.`;
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
/** Identifiers on our drinks that should slake thirst rather than hunger. */
const DRINK_IDENTIFIERS = ["ale", "wine-common", "wine-fine"];

/** Serialises table imports so dragging several merchants at once cannot duplicate them. */
const inFlight = new Map();

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

/** Whether this is one of our merchants, sitting in the world rather than a pack. */
function isPreset(actor) {
  if (!actor || actor.pack) return false;              // never touch compendium copies
  return (foundry.utils.getProperty(actor, FLAG_PATH) ?? [])
    .some(t => t?.uuid?.startsWith(STOCK_PREFIX));
}

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
    const existing = game.tables.find(t => t.folder?.id === folder.id && t.name === src.name);
    if (existing) return existing;
    const data = game.tables.fromCompendium(src, { clearFolder: true, clearOwnership: true });
    data.folder = folder.id;
    return RollTable.implementation.create(data);
  })();
  inFlight.set(src.uuid, promise);
  try { return await promise; } finally { inFlight.delete(src.uuid); }
}

/* -------------------------------------------------------------------------- */

/** Repoint the merchant's populate tables at world copies. */
async function wireTables(actor) {
  const tables = foundry.utils.getProperty(actor, FLAG_PATH);
  if (!Array.isArray(tables) || !tables.length) return false;
  if (!tables.some(t => typeof t?.uuid === "string" && t.uuid.startsWith(STOCK_PREFIX))) return false;

  const next = [];
  for (const entry of tables) {
    if (!entry?.uuid?.startsWith(STOCK_PREFIX)) { next.push(entry); continue; }
    const src = await foundry.utils.fromUuid(entry.uuid);
    if (!src) { console.warn(`${MODULE} | missing stock table ${entry.uuid}`); continue; }
    const world = await ensureWorldTable(src);

    // Re-key the per-result quantity formulas by what each result points at,
    // so this holds even if the import reassigns TableResult ids.
    const byTarget = new Map();
    for (const r of src.results) byTarget.set(r.documentUuid, entry.items?.[r.id] ?? "1");
    const items = {};
    for (const r of world.results) items[r.id] = byTarget.get(r.documentUuid) ?? "1";

    next.push({ ...entry, uuid: world.uuid, items });
  }
  if (!next.length) return false;
  await actor.update({ [FLAG_PATH]: next });
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
  const tierIndex = TIER_INDEX[actor.name.match(/\((Village|Town|City)\)/)?.[1]] ?? 1;
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

  let changed = false;
  changed = await wireTables(actor) || changed;
  changed = await applyStockMode(actor) || changed;
  changed = await syncStockWeight(actor) || changed;
  changed = await syncOpenState(actor) || changed;
  if (changed) log(`prepared "${actor.name}"`);
  return changed;
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
 * Restock one merchant: rebuild the shelf, then put back what the rebuild lost.
 *
 * @param {Actor} actor
 * @returns {Promise<boolean>}
 */
async function restock(actor) {
  await game.itempiles.API.refreshMerchantInventory(actor);
  await reapplyItemFlags(actor);
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
 * characters, so the flag write and the condition toggle need no GM.
 */
async function offerMeals(_sellerUuid, buyerUuid, itemPrices, userId) {
  if (userId !== game.user.id) return;
  if (!game.modules.get(NUTRITION_MODULE)?.active) return;
  if (!game.settings.get(MODULE, "mealsFeed")) return;
  const buyer = await fromUuid(buyerUuid);
  if (buyer?.type !== "character") return;

  const meals = (itemPrices?.buyerReceive ?? []).filter(e =>
    e.quantity > 0 && e.item?.getFlag?.(MODULE, "nutrition"));
  for (const entry of meals) {
    await eatMeal(buyer, entry.item, entry.quantity)
      .catch(err => console.error(`${MODULE} | could not apply ${entry.item.name}`, err));
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

  const nutrition = item.getFlag(MODULE, "nutrition");
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

  const has = {
    malnourished: actor.hasConditionEffect(cfg.CONDITION_EFFECT_MALNOURISHED),
    dehydrated: actor.hasConditionEffect(cfg.CONDITION_EFFECT_DEHYDRATED)
  };
  const result = applyMeal(sn.getNutritionState(actor), needs, nutrition, quantity, has);
  await sn.setNutritionState(actor, result.state);
  if (result.clearMalnutrition) await actor.toggleStatusEffect(cfg.CONDITION_MALNUTRITION, { active: false });
  if (result.clearDehydration) await actor.toggleStatusEffect(cfg.CONDITION_DEHYDRATION, { active: false });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<p><strong>${actor.name}</strong> eats: ${label}.</p><p>${parts.join(" · ")}</p>`
  });
  log(`${actor.name} ate ${label}: food ${result.state.food}, water ${result.state.water}`);
}

function registerMeals() {
  Hooks.on("item-piles-tradeItems", (...args) => {
    offerMeals(...args).catch(err => console.error(`${MODULE} |`, err));
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
async function deliverAnimals(sellerUuid, buyerUuid, itemPrices, userId) {
  if (game.users.activeGM !== game.user) return;
  if (!game.settings.get(MODULE, "animalsSpawn")) return;
  const bought = (itemPrices?.buyerReceive ?? []).filter(e =>
    e.quantity > 0 && e.item?.getFlag?.(MODULE, "actor"));
  if (!bought.length) return;

  const buyer = await fromUuid(buyerUuid);
  const seller = await fromUuid(sellerUuid);
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
  const src = await fromUuid(good.getFlag(MODULE, "actor"));
  if (!src) throw new Error(`stat block ${good.getFlag(MODULE, "actor")} not found — is the dnd5e system's SRD installed?`);
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
    && (i._stats?.compendiumSource === source || i.getFlag(MODULE, "actor") === good.getFlag(MODULE, "actor")));
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
    hint: "With Simple Nutrition 5e installed, buying a meal at an inn asks the buyer whether to "
      + "eat it there and then, and credits today's food and drink by the meal's quality — a "
      + "squalid meal is a quarter of a Medium creature's day with nothing to drink, a modest one "
      + "a full day's food and a pint, an aristocratic one a feast. Meals are services, so no item "
      + "changes hands either way.",
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
});

Hooks.once("ready", () => {
  game.modules.get(MODULE).api = { rewire, rewireAll, registerDrinks, restock, restockOnTimeChange, reapplyItemFlags,
    reconcileContainers, replenishPurse, syncStockWeight, syncStockWeightAll,
    syncOpenState, syncOpenStateAll };

  // Every client evaluates its own nutrition candidates, so this must run for
  // players too — and it does not depend on Item Piles.
  registerDrinks();
  // The buyer's own client answers the meal prompt, so this is for players too.
  registerMeals();

  if (!game.user.isGM) return;
  if (!game.modules.get("item-piles")?.active) {
    ui.notifications.warn("Merchant Presets requires the Item Piles module, which is not active.");
    return;
  }

  Hooks.on("createActor", (actor, _options, userId) => {
    if (userId !== game.user.id) return;
    rewire(actor).catch(err => console.error(`${MODULE} |`, err));
  });

  registerRestock();
  registerTradingHours();
  registerAnimals();
  // Time moves while a world is closed, so put the shops on the right side of
  // their doors now rather than at the next tick of the clock.
  syncOpenStateAll().then(n => { if (n) log(`${n} shop(s) opened or closed for the hour`); });

  log("ready");
});
