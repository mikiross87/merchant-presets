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
 * the shop has one, and it sells out. Goods the guide calls out as limited
 * (poisons, scrolls, gunpowder, firearms) are always rolled; everything else is
 * rolled only when the world is set to finite stock. Anything that rolls zero
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
  if (actor?.pack) return false;                       // never touch compendium copies
  const isPreset = (foundry.utils.getProperty(actor, FLAG_PATH) ?? [])
    .some(t => t?.uuid?.startsWith(STOCK_PREFIX));
  if (!isPreset) return false;

  let changed = false;
  changed = await wireTables(actor) || changed;
  changed = await applyStockMode(actor) || changed;
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
      await game.itempiles.API.refreshMerchantInventory(actor);
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
    hint: "Each merchant carries trading hours and restocks when its doors open for the day, using "
      + "Foundry's own calendar. Item Piles has this built in but only fires it through Simple "
      + "Calendar, which it requires by module id — this does the same job off the world clock, so "
      + "it works with the built-in calendar and with Calendaria. Takes effect on reload.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  // Last world time a restock pass ran for, so a reload cannot re-fire one.
  game.settings.register(MODULE, "lastRestockTime", {
    scope: "world", config: false, type: Number, default: 0
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
});

Hooks.once("ready", () => {
  game.modules.get(MODULE).api = { rewire, rewireAll, registerDrinks, restockOnTimeChange };

  // Every client evaluates its own nutrition candidates, so this must run for
  // players too — and it does not depend on Item Piles.
  registerDrinks();

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

  log("ready");
});
