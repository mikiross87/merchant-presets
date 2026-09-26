/**
 * Merchant Presets — the runtime: the shops arriving in a world (migrated, made visitable, their
 * first shelf rolled), restocking on the world clock, the GM-side trade desk the shop window asks,
 * and the listeners that act on a trade (meals, animals, spellcasting).
 */

import { applyMeal, nutritionOfItem, oneAtATime, usageConsumes } from "./nutrition.mjs";
import { actorEffects, castingMessage, castsIn, chatRecipients } from "./casting.mjs";
import { isPreset, keepableItems, listShops, needsWiring, planShop, TIERS, tierOf } from "./shop.mjs";
import { boughtWith, goodFlag } from "./trade.mjs";
import { planTrade, safeShopOf } from "./trade-plan.mjs";
import {
  adoptDrawn, dueRestock, initialSchedule, intervalOf, isOpen, lineMemory, planRestock, restockStockFlags, scheduleNext
} from "./schedule.mjs";
import {
  bundleResolver, checkParties, CLAIM_HEARTBEAT_MS, claimsTrades, clientOutcome, hookPayload, outcomes, QUERY, QUERY_TIMEOUT_MS,
  receiptHtml, recipients, recordedOutcome, resultOf, serial, shouldReclaim, TRADE_HOOK, withRecord, WORLD_RATES
} from "./trade-desk.mjs";
import "./shop-sheet.mjs"; // #103: the shop window; self-registers as an actor sheet on import
import { derivedShop, hasCurrentShop, isMadeVisitable, isMigratable, isOwnershipChosen, needsMigration, packShopCandidates, planActorUpdate,
  planAutoRestockDefault, planItemUpdates, planTokenMigration, planTokenUpdates, shouldForceAutoRestockOff, stockFromRecord,
  tokenNeedsMigration,
  worldHasLegacyShops }
  from "./migrate.mjs";

const MODULE = "merchant-presets";

const NUTRITION_MODULE = "simple-nutrition-5e";
/** Simple Nutrition 1.0 keeps the day's tally in fractions of a day, which is what we write. */
const NUTRITION_MINIMUM = "1.0.0";
/** Identifiers on our drinks that should slake thirst rather than hunger. */
const DRINK_IDENTIFIERS = ["ale", "wine-common", "wine-fine"];

/** Ids of the shops `setUpShopNow` is building right now: `arrive` leaves them alone. */
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
 * embedded items. The helpers below walk `actor.items` directly and match on
 * name, so without this the mage's own Wand would be treated as merchandise.
 */
const isGear = item =>
  foundry.utils.getProperty(item, "flags.merchant-presets.kind") === "gear";

/* ------------------------------------------------------------------ helpers */

async function ensureFolder(name, type) {
  const existing = game.folders.find(f => f.type === type && f.name === name && !f.folder);
  return existing ?? Folder.implementation.create({ name, type, sorting: "a" });
}

/* ------------------------------------------------------------------ restock */

/** Minutes since midnight, using this calendar's own hour length. */
function minuteOfDay(components) {
  const { minutesPerHour } = game.time.calendar.days;
  return (components.hour * minutesPerHour) + components.minute;
}

/**
 * Keep the shop's own goods off the shopkeeper's back.
 *
 * A merchant's wares live in its inventory, so a shopkeeper is carrying every
 * barrel and anvil on the shelves —
 * 14,775 lb for a city stable, against a capacity of 240. dnd5e ignores this
 * until a world turns encumbrance on, and then the shopkeeper is Exceeding
 * Carrying Capacity for good, which in the 2024 rules means Speed 0.
 *
 * The stock is the shop, so it stays on the actor; cancel its weight instead: an effect raising the thresholds by exactly what
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
    description: "<p>The shop's goods and till sit in this actor's inventory. This cancels their "
      + "weight, so only the shopkeeper's own equipment counts against their carrying capacity.</p>",
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
 * Let go of goods that name a container the merchant does not hold.
 *
 * The SRD kits ship their contents as items of their own, each carrying the
 * kit's id in `system.container`, and earlier builds stocked Rope, Tinderbox
 * and nine more goods from those copies. dnd5e lists such an item as loose,
 * but the shop window counts it as contained and hides it (#89). Merchants
 * dragged in from those builds still hold the copies.
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

/** A restock interval as a whole number of days, rolling a dice formula; null for "never". */
async function daysOf(every) {
  const interval = intervalOf(every);
  if (!interval) return null;
  return interval.days ?? rollStock(interval.formula);
}

/**
 * Whether a stock table result can put an item on the shelf: one pointing at an Item. A text
 * line ("Nothing today") or one pointing at another document (a nested table, a journal) never
 * becomes stock, so it's neither drawn nor waited for (#135 review).
 */
const isItemLine = result => /(^|\.)Item\.[^.]+$/.test(result.documentUuid ?? "");

/** Shops already warned this session that their table doesn't resolve: once each, not every tick. */
const unresolvedWarned = new Set();

/**
 * The names of the items a stock table's lines point to: what adoption stamps
 * as drawn. The documents' own names, as the shelf carries them, not the
 * results' labels, which a GM's own table may word differently. Null while
 * any line's document can't be found: adopting by a guessed name could leave
 * that line's copy unstamped for good (#135 review).
 */
async function lineNames(table) {
  const names = [];
  for (const result of table.results ?? []) {
    if (!isItemLine(result)) continue;
    // The pack's index has the name, without loading the document: a world's first tick adopts
    // every shop at once, and loading each line made that take seconds per shop (#105 live run).
    let entry = null;
    try { entry = fromUuidSync(result.documentUuid, { strict: false }); } catch { /* not indexed */ }
    const doc = entry?.name ? entry : await fromUuid(result.documentUuid).catch(() => null);
    if (!doc) return null;
    names.push(doc.name);
  }
  return names;
}

/**
 * This restock's draw from a shop's stock table: each line's document, with
 * its compendium source recorded as an import would (stacking, the shelf match
 * and the bundle fallback all read it), and its quantity freshly rolled from
 * the shop's own `restock.quantities`. Null if any line's document can't be
 * found (the SRD pack not loaded, a world item deleted): a reroll would delete
 * that line's drawn copy and have nothing to replace it with, so the whole
 * restock waits for the table to resolve (#135 review).
 */
async function drawsFor(table, quantities) {
  const draws = [];
  for (const result of table.results ?? []) {
    if (!isItemLine(result)) continue;
    const doc = await fromUuid(result.documentUuid).catch(() => null);
    if (!doc) {
      console.warn(`${MODULE} | stock table "${table.name}": no document for "${result.name}"; restock skipped`);
      return null;
    }
    const data = doc.toObject();
    // A world item that already records where it came from keeps that source (#135 review).
    data._stats = { ...data._stats, compendiumSource: data._stats?.compendiumSource ?? doc.uuid ?? result.documentUuid };
    const formula = quantities?.[result.id ?? result._id] ?? "1";
    draws.push({ name: doc.name, data, quantity: await rollStock(formula) });
  }
  return draws;
}

/**
 * A shop's shelf key: what its restocks stamp as `drawn`, so a reroll knows its
 * own goods from ones another shop drew (schedule.mjs `isDrawn`). A random id
 * kept on the shop, not its actor id: a duplicated or re-imported shop carries
 * its items' stamps and this key together, and still knows its own shelf
 * (#135 review). Made once, when the shop is adopted.
 */
const shelfKeyOf = actor => actor.flags?.[MODULE]?.shelf ?? null;
/**
 * Whether user `id` is a player, for `isOwnershipChosen`: a level given to one, Owner included, is
 * the GM's choice; a GM's own entry, or one left for a user deleted since, lets nobody in.
 */
const isPlayer = id => { const user = game.users.get(id); return !!user && !user.isGM; };

/**
 * Adopt a shop's shelf, once, before its first native restock: give it a shelf
 * key, and stamp its current table goods with it (schedule.mjs `adoptDrawn`).
 * A shop with a key is adopted
 * already, so a good the GM adds by hand later, under a table line's name,
 * stays theirs.
 *
 * @returns {Promise<string|null>} the shop's shelf key; null if it can't be
 *   adopted yet (see `lineNames`)
 */
async function adoptOnce(actor, table) {
  const known = shelfKeyOf(actor);
  if (known) return known;
  const names = await lineNames(table);
  if (!names) {
    if (!unresolvedWarned.has(actor.uuid)) {
      unresolvedWarned.add(actor.uuid);
      console.warn(`${MODULE} | "${actor.name}": not every line of its stock table resolves; not restocking it yet`);
    }
    return null;
  }
  const key = foundry.utils.randomID();
  const updates = adoptDrawn(actor.items.map(i => i.toObject()), names, key);
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
  await actor.update({ [`flags.${MODULE}.shelf`]: key });
  return key;
}

/**
 * Restock one shop from its own stock table (#105), off the trade queue's
 * back: a restock and a trade on the same shelf never interleave (#134
 * review). What's replaced is only what a restock drew (`planRestock`); goods
 * the GM added by hand and the shopkeeper's gear stay, and each redrawn line
 * keeps the stock config its shelf item had.
 *
 * @param {Actor} actor
 * @returns {Promise<string[]|null>} the lines it drew or topped up; null if
 *   it couldn't restock at all (no shop config, or its table is gone)
 */
function restock(actor) {
  return runTrade(async () => {
    const restocked = await restockNow(actor);
    // A scheduled shop restocked by hand counts its next due day from today, as a scheduled
    // restock would, or the next opening would reroll the shelf just rolled (#135 review).
    const state = actor.flags?.[MODULE]?.schedule;
    const every = safeShopOf(actor)?.restock.every;
    const days = restocked !== null && state ? await daysOf(every) : null;
    if (days != null) {
      await actor.update({ [`flags.${MODULE}.schedule`]: { ...scheduleNext(game.time.worldTime, days, game.time.calendar.days), every } });
    }
    return restocked;
  });
}

async function restockNow(actor) {
  const raw = actor.flags?.[MODULE]?.shop;
  const shop = safeShopOf(actor);
  if (!shop?.restock.table) return null;
  const table = await fromUuid(shop.restock.table).catch(() => null);
  if (!table) {
    console.warn(`${MODULE} | "${actor.name}": its stock table ${shop.restock.table} is gone; nothing restocked`);
    return null;
  }
  const shelf = await adoptOnce(actor, table);
  if (!shelf) return null;

  const items = actor.items.map(i => i.toObject());
  const draws = await drawsFor(table, shop.restock.quantities);
  if (!draws) return null;
  const record = actor.flags?.[MODULE]?.itemFlags ?? {};
  // What the shelf says of each line now, over what it said at earlier restocks: a line that
  // left the shelf comes back with the GM's settings (schedule.mjs `lineMemory`).
  const memory = lineMemory(actor.flags?.[MODULE]?.lines, items, shelf);
  const remembered = new Map(memory.map(line => [line.name, line]));
  const plan = planRestock(raw, items, draws, {
    purse: actor.flags?.[MODULE]?.purse,
    currentGp: actor.system?.currency?.gp,
    stockFlags: restockStockFlags(items, draws, name => remembered.get(name)?.stock ?? stockFromRecord(record[name]), shelf),
    containers: actor.flags?.[MODULE]?.containers ?? {},
    drawnBy: shelf
  });
  // Noted before anything is deleted: a restock that fails part-way still has each line's settings.
  await actor.update({ [`flags.${MODULE}.lines`]: memory });
  if (plan.deletes.length) await actor.deleteEmbeddedDocuments("Item", plan.deletes);
  if (plan.updates.length) await actor.updateEmbeddedDocuments("Item", plan.updates);
  if (plan.creates.length) await actor.createEmbeddedDocuments("Item", plan.creates);
  if (plan.currency != null) await actor.update({ "system.currency.gp": plan.currency });
  await syncStockWeight(actor);        // last: the shelf and the till have both just moved
  return plan.restocked;
}

/**
 * One shop's turn on the clock: seen for the first time, it's adopted and
 * scheduled (no restock); due (`dueRestock`), it restocks and is scheduled
 * again from that opening.
 *
 * @returns {Promise<string[]|null>} the lines restocked, or null if it wasn't due
 */
async function scheduleShop(actor, now, previous, calendar) {
  const raw = actor.flags[MODULE].shop;
  let state = actor.flags[MODULE].schedule;
  if (!state) {
    const shop = safeShopOf(actor);
    const days = shop ? await daysOf(shop.restock.every) : null;
    if (days == null || !shop.restock.table) return null;
    // No table yet (repointed, or its pack not loaded): try again next tick. Scheduling it now
    // would skip the adoption, and its first restock would add a second shelf.
    const table = await fromUuid(shop.restock.table).catch(() => null);
    if (!table) return null;
    if (!await adoptOnce(actor, table)) return null;
    await actor.update({ [`flags.${MODULE}.schedule`]: { ...initialSchedule(now, days, calendar), every: shop.restock.every } });
    return null;
  }
  // The GM changed the interval since it was scheduled: count the new one from the last restock,
  // rather than waiting out the old due date (#135 review).
  const every = safeShopOf(actor)?.restock.every;
  if (every !== undefined && state.every !== undefined && state.every !== every) {
    const days = await daysOf(every);
    if (days != null) {
      state = { ...scheduleNext(state.lastRestock, days, calendar), every };
      await actor.update({ [`flags.${MODULE}.schedule`]: state });
    }
  }
  const due = dueRestock(raw, state, previous, now, calendar);
  if (!due.due) return null;
  const restocked = await restockNow(actor);
  // Couldn't run (its table or a line's document is missing): still due, so the next opening
  // tries again, rather than the shop skipping a whole cycle.
  if (restocked === null) return null;
  const days = await daysOf(due.nextEvery);
  await actor.update({ [`flags.${MODULE}.schedule`]: { ...scheduleNext(due.at, days ?? 1, calendar), every: due.nextEvery } });
  return restocked;
}

/**
 * Restock every shop whose due day's opening fell between `previous` and
 * `worldTime` (#105), one at a time on the trade queue.
 *
 * @param {number} worldTime  The new world time.
 * @param {number} previous   The world time last processed.
 * @returns {Promise<number>} how many shops were restocked
 */
async function scheduledRestocks(worldTime, previous) {
  const calendar = game.time.calendar.days;
  const restocked = [];
  for (const actor of game.actors) {
    if (!actor.flags?.[MODULE]?.shop || actor.pack) continue;
    try {
      const lines = await runTrade(() => scheduleShop(actor, worldTime, previous, calendar));
      if (lines?.length) restocked.push(actor.name);
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
 * Wire restocking to the world clock. Only the active GM acts, and of their
 * tabs only the one that claims trades (`registerTradeDesk`), so two GMs or
 * two tabs restock once. It picks up from the last world time it processed
 * (`lastRestockTime`, which only it writes), so a stretch of clock that passed
 * while no tab held the claim (a handoff) is still gone through, not skipped
 * (#135 review). The switch is read on every tick: the migration can turn it
 * off mid-session when a 1.x merchant arrives.
 */
function registerRestock() {
  // "Never run" (0) starts from now, or the first tick would see a jump of the
  // whole world time and restock every shop at once.
  const loadedAt = game.time.worldTime;

  Hooks.on("updateWorldTime", async worldTime => {
    if (!game.settings.get(MODULE, "autoRestock")) return;
    if (game.users.activeGM !== game.user || !claimsTrades(tradeClaim(), thisTab())) return;
    const from = game.settings.get(MODULE, "lastRestockTime") || loadedAt;
    if (worldTime === from) return;
    await game.settings.set(MODULE, "lastRestockTime", worldTime);
    // Rewinding the clock should not trigger a day's worth of restocks.
    if (worldTime > from) await scheduledRestocks(worldTime, from);
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
 * Meals are services: paying for one hands nothing over, because
 * the eating happens at the inn's table. Simple Nutrition 5e can only feed a
 * character from an item in their inventory, so without this the meal would
 * be money for nothing. Instead, when a preset merchant sells a good carrying
 * a `nutrition` flag, the buyer is asked whether to eat it now, and saying
 * yes credits today's food and water the way that module's own Eat dialog
 * would (see scripts/nutrition.mjs for the arithmetic, and the imports below
 * for its state helpers and condition ids). The flag is the whole contract, so
 * a meal copied onto a tavern of your own works the same way.
 *
 * Every client hears a trade (see `registerTradeListeners`); only the client
 * that asked for it acts, so one purchase gets one prompt. Players own their
 * own characters, so the flag write and the condition toggle need no GM. The
 * meal arrives as plain data (scripts/trade.mjs, #48).
 *
 * @param {import("./trade.mjs").ShopTrade} trade
 * @param {{askedHere: boolean}} where
 */
async function offerMeals(trade, { askedHere }) {
  if (!askedHere || trade.kind !== "buy") return;
  if (!nutritionFeeds()) return;
  if (!game.settings.get(MODULE, "mealsFeed")) return;
  const buyer = await fromUuid(trade.buyerUuid);
  if (buyer?.type !== "character") return;

  for (const entry of boughtWith(trade, "nutrition")) {
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
 * Every trade runs through a GM, so one is always online; the client that
 * carried the trade out does the creating, which players are not allowed to.
 * Nothing is placed on a scene: the GM drags the animal in from the sidebar.
 * Selling the deed back is money only — the animal stays for the GM to deal
 * with, since deleting actors unasked is not this module's business.
 *
 * @param {import("./trade.mjs").ShopTrade} trade
 * @param {{carriedOut: boolean}} where
 */
async function deliverAnimals(trade, { carriedOut }) {
  if (!carriedOut) return;
  if (!game.settings.get(MODULE, "animalsSpawn")) return;
  const bought = boughtWith(trade, "actor");
  if (!bought.length) return;

  const buyer = await fromUuid(trade.buyerUuid);
  const seller = await fromUuid(trade.shopUuid);
  if (!buyer) return;

  // Selling a deed to a merchant: the deed is the merchant's entry now.
  if (trade.kind === "sell") {
    const names = bought.map(e => e.item.name).join(", ");
    await ChatMessage.create({
      content: `<p><strong>${buyer.name}</strong> sold ${names} to ${seller?.name ?? "a merchant"}. `
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

/* ------------------------------------------------------------- spellcasting */

/**
 * Say in chat which spell a bought spellcasting service casts, and for whom
 * (#70). The message text, and why it carries no price, is scripts/casting.mjs.
 *
 * Posted by the client that asked for the trade, like the meal prompt, so one
 * trade makes one message and no GM has to be at the table. A named service
 * links its spell, fetched here for the effects the GM may drag onto the
 * target; a spell that cannot be fetched is still announced, linked, without
 * them.
 *
 * @param {import("./trade.mjs").ShopTrade} trade
 * @param {{askedHere: boolean, chatMode: number}} where  `chatMode` is Item
 *   Piles' *Output to chat* scale (casting.mjs `chatRecipients`).
 */
async function announceSpellcasting(trade, { askedHere, chatMode }) {
  if (!askedHere) return;
  if (!game.settings.get(MODULE, "spellcastingToChat")) return;
  const bought = castsIn(trade);
  if (!bought.length) return;
  const seller = await fromUuid(trade.shopUuid);
  const buyer = await fromUuid(trade.buyerUuid);
  if (!seller || !buyer) return;

  const casts = [];
  for (const { item, quantity } of bought) {
    const spell = goodFlag(item, "spell") ?? null;
    const doc = spell ? await fromUuid(spell).catch(() => null) : null;
    casts.push({ name: item.name, quantity, spell, effects: actorEffects(doc?.effects) });
  }

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: seller }),
    content: castingMessage({ shop: seller.name, buyer: buyer.name, casts }),
    whisper: chatRecipients(chatMode, game.users.filter(u => u.isGM).map(u => u.id), trade.userId)
  });
}

/* ------------------------------------------------------------ trade listeners */

/** The `tradeChat` setting as a chat mode (casting.mjs `chatRecipients`), for the messages beside the receipt: GM whisper is 3. */
const nativeChatMode = () => (game.settings.get(MODULE, "tradeChat") === "gm" ? 3 : 1);

/**
 * Run the meal, animal and spellcasting listeners for one trade. `askedHere`:
 * this is the client that asked for the trade (prompts and the casting message
 * go there, once). `carriedOut`: this is the client that made the writes
 * (documents are created there, once).
 */
function onTrade(trade, where) {
  for (const listener of [offerMeals, deliverAnimals, announceSpellcasting]) {
    listener(trade, where).catch(err => console.error(`${MODULE} |`, err));
  }
}

/** Hear every shop trade on every client: `merchant-presets.trade`, fired by `carryOutTrade`. */
function registerTradeListeners() {
  Hooks.on(TRADE_HOOK, (trade, { carriedOut } = {}) => {
    onTrade(trade, { askedHere: askedHere.delete(trade.tradeId), carriedOut: !!carriedOut, chatMode: nativeChatMode() });
  });
}

/* ---------------------------------------------------------------- trade desk */

/**
 * The GM-side trade (#102): the shop window asks, one GM tab carries it out.
 *
 * A player's `api.trade(request)` queries the active GM through
 * `CONFIG.queries`. Foundry sends a query to every tab that GM has open and
 * takes the first answer, so exactly one tab claims trades (the last one
 * opened, through a flag on the GM's user) and the rest never answer. That tab
 * runs trades one at a time, answers a repeated `tradeId` with its first
 * outcome, plans each with `planTrade` against fresh snapshots of the shop and
 * the character, and carries the plan out. Then it posts the receipt and fires
 * `merchant-presets.trade` on every client (trade-desk.mjs `hookPayload`).
 *
 * Known limit: when the claiming tab closes or crashes and its unload write
 * doesn't land, trades read as unconfirmed for up to about half a minute,
 * until another GM tab notices the silence and takes the claim
 * (`registerTradeDesk`). The window resends the same trade id, and a sealed
 * trade is recorded on the shop in the trade's last write, so whichever tab
 * answers the resend finds it there and nothing lands twice. The module
 * socket can't say who sent a message, so a player's client could forge a
 * trade hook or a claim heartbeat; neither moves goods or coin.
 */

const SOCKET = `module.${MODULE}`;
const runTrade = serial();
const tradeOutcomes = outcomes();
/** Trade ids this client asked for: the meal prompt and casting message belong to it. */
const askedHere = new Set();
/** This tab's id, for the trade claim. Made on first use: `foundry.utils` isn't there at import. */
let tabId = null;
const thisTab = () => (tabId ??= foundry.utils.randomID());
/** `planTrade`'s and the window's bundle resolver; empty until the dnd5e indexes load. */
let bundleOf = bundleResolver(new Map());

const tradeClaim = () => game.user.getFlag(MODULE, "tradeTab");
const claimTrades = () => game.user.setFlag(MODULE, "tradeTab", thisTab());

/**
 * Index every dnd5e Item pack by `system.quantity`, so `bundleOf` can read a
 * good's bundle off its compendium source without an async fetch: the SRD's
 * Arrows are 20 for 1 gp with no bundle flag of ours anywhere.
 */
async function loadBundles() {
  const quantities = new Map();
  for (const pack of game.packs ?? []) {
    if (pack.metadata?.packageName !== "dnd5e" || pack.documentName !== "Item") continue;
    const index = await pack.getIndex({ fields: ["system.quantity"] });
    for (const entry of index) if (entry.system?.quantity > 1) quantities.set(entry.uuid, entry.system.quantity);
  }
  bundleOf = bundleResolver(quantities);
}

/** An actor named by a request's uuid, or null: the request is untrusted, so anything else is nobody. */
async function actorAt(uuid) {
  if (typeof uuid !== "string") return null;
  const doc = await fromUuid(uuid).catch(() => null);
  return doc?.documentName === "Actor" ? doc : null;
}

/** Whether `shop` is open by its own hours on the world clock. Trading hours off: always. */
function shopIsOpen(shop) {
  if (!game.settings.get(MODULE, "tradingHours")) return true;
  const hours = safeShopOf(shop)?.hours ?? null;
  return isOpen(hours, minuteOfDay(game.time.calendar.timeToComponents(game.time.worldTime)), game.time.calendar.days);
}

/**
 * One actor's share of a plan: its items first, then its coin, with `also`
 * (the shop's trade record) in that same last update.
 */
async function applyUpdate(actor, update, also = {}) {
  if (update.itemUpdates.length) await actor.updateEmbeddedDocuments("Item", update.itemUpdates);
  if (update.itemCreates.length) await actor.createEmbeddedDocuments("Item", update.itemCreates, { keepId: true });
  if (update.itemDeletes.length) await actor.deleteEmbeddedDocuments("Item", update.itemDeletes);
  const changes = { ...(update.currency ? { "system.currency": update.currency } : {}), ...also };
  if (Object.keys(changes).length) await actor.update(changes);
}

/**
 * Validate, plan and carry out one trade, on the claiming GM tab. Never
 * throws: a write that fails reads as refused `error`, since the window must
 * not be told a half-made trade sealed.
 */
async function carryOutTrade(request, user) {
  const [shop, buyer] = await Promise.all([actorAt(request?.shopUuid), actorAt(request?.buyerUuid)]);
  const refused = checkParties({ user, shop, buyer });
  if (refused) return { status: "refused", reason: refused };
  // Carried out already, maybe by a tab that has since lost the claim: its first outcome.
  const done = recordedOutcome(shop.flags?.[MODULE]?.trades, user.id, request.tradeId);
  if (done) return done;

  const planned = planTrade(request, {
    shop: shop.toObject(),
    buyer: buyer.toObject(),
    worldSettings: {
      rates: WORLD_RATES,
      infiniteStock: game.settings.get(MODULE, "stockMode") === "unlimited",
      infinitePurse: game.settings.get(MODULE, "merchantPurse") === "unlimited"
    },
    currencies: CONFIG.DND5E.currencies,
    deal: null,
    now: { isOpen: shopIsOpen(shop) },
    newId: () => foundry.utils.randomID(),
    bundleOf
  });
  if (!planned.ok) return resultOf(planned);

  const { plan } = planned;
  const result = resultOf(planned);
  // The record goes on the shop, in the very last write, so it's there only once the whole
  // trade is: a tab that dies part-way leaves no record, and the resend plans again.
  const record = { [`flags.${MODULE}.trades`]: withRecord(shop.flags?.[MODULE]?.trades,
    { userId: user.id, tradeId: plan.tradeId, result }) };
  const toShop = plan.updates.find(u => u.actorId === shop.id);
  const toBuyer = plan.updates.find(u => u.actorId !== shop.id);
  try {
    await applyUpdate(buyer, toBuyer);
    await applyUpdate(shop, toShop, record);
  } catch (err) {
    console.error(`${MODULE} | trade ${plan.tradeId} failed part-way; check ${shop.name} and ${buyer.name}`, err);
    ui.notifications.error(`A trade between ${buyer.name} and ${shop.name} failed part-way. Check both inventories.`);
    return { status: "refused", reason: "error" };
  }

  const trade = hookPayload(plan, { shopUuid: shop.uuid, buyerUuid: buyer.uuid, userId: user.id });
  try {
    game.socket.emit(SOCKET, { type: "trade", trade });
    Hooks.callAll(TRADE_HOOK, trade, { carriedOut: true });
    const whisper = recipients(game.settings.get(MODULE, "tradeChat"), game.users.filter(u => u.isGM).map(u => u.id));
    if (whisper) {
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: shop }),
        content: receiptHtml(plan.chatCard, CONFIG.DND5E.currencies),
        whisper
      });
    }
  } catch (err) {
    console.error(`${MODULE} | trade ${plan.tradeId} landed, but telling the table failed`, err);
  }
  return result;
}

/**
 * The `CONFIG.queries` handler. A tab without the claim never answers, so the
 * server takes the claiming tab's answer; answering "no" from here would beat
 * it and refuse a trade that's about to go through.
 */
function handleTradeQuery(request, { user }) {
  if (!claimsTrades(tradeClaim(), thisTab())) return new Promise(() => {});
  if (typeof request?.tradeId !== "string" || !request.tradeId) return { status: "refused", reason: "invalid-request" };
  return tradeOutcomes.once(user.id, request.tradeId, () => runTrade(() => carryOutTrade(request, user)));
}

/**
 * Ask the GM to carry out a trade: `{tradeId, kind, shopUuid, buyerUuid,
 * lines: [{itemId, quantity, expectedBundlePriceCp?}]}` (the contract on
 * #102). Resolves `{status: "sealed"|"refused"|"no-gm"|"unconfirmed", ...}`,
 * never rejects.
 */
async function trade(request) {
  const gm = game.users.activeGM;
  if (!gm) return clientOutcome(false);
  // Core refuses to send a query without this permission (Player by default, but a GM can raise
  // it). Caught as a failed query it would read as unconfirmed for ever, with no one told why.
  if (!game.user.hasPermission("QUERY_USER")) {
    ui.notifications.warn("Your role doesn't have permission to query users, which trading in a shop needs. "
      + "Ask the GM to grant it in Configure Permissions.");
    return { status: "refused", reason: "no-permission" };
  }
  if (typeof request?.tradeId === "string") askedHere.add(request.tradeId);
  try {
    return await gm.query(QUERY, request, { timeout: QUERY_TIMEOUT_MS });
  } catch (err) {
    console.warn(`${MODULE} | trade ${request?.tradeId} unconfirmed:`, err.message);
    return clientOutcome(true);
  }
}

/**
 * Wire the trade desk on this client: the socket every client hears trades
 * on, the bundle index, and on a GM's tab the trade claim. It's taken on load,
 * given up on close, and kept alive by a heartbeat on the socket; another tab
 * takes it once it's given up or its claimer goes quiet (`shouldReclaim`).
 */
function registerTradeDesk() {
  // When this tab last heard the claiming tab, or noticed a new claim: the
  // grace period a claimer gets before its silence counts.
  let lastAliveAt = Date.now();
  game.socket.on(SOCKET, message => {
    if (message?.type === "trade") Hooks.callAll(TRADE_HOOK, message.trade, { carriedOut: false });
    // Only the tab named in the claim counts: a stray or stale heartbeat mustn't hold it for a dead tab.
    if (message?.type === "claim-alive" && message.userId === game.user.id && message.tabId === tradeClaim()) {
      lastAliveAt = Date.now();
    }
  });
  loadBundles().catch(err => console.error(`${MODULE} | could not index the dnd5e packs' bundles`, err));
  if (!game.user.isGM) return;

  const reclaim = () => claimTrades().catch(err => console.error(`${MODULE} | could not claim trades for this tab`, err));
  reclaim();
  globalThis.addEventListener?.("beforeunload", () => {
    if (claimsTrades(tradeClaim(), thisTab())) game.user.unsetFlag(MODULE, "tradeTab");
  });
  Hooks.on("updateUser", user => {
    if (user !== game.user) return;
    lastAliveAt = Date.now();
    if (tradeClaim() == null) reclaim();
  });
  const heartbeat = setInterval(() => {
    const claim = tradeClaim();
    if (claimsTrades(claim, thisTab())) {
      game.socket.emit(SOCKET, { type: "claim-alive", userId: game.user.id, tabId: thisTab() });
    } else if (shouldReclaim({ claim, tabId: thisTab(), lastAliveAt, now: Date.now() })) {
      lastAliveAt = Date.now();
      reclaim();
    }
  }, CLAIM_HEARTBEAT_MS);
  heartbeat.unref?.();   // plain Node (the tests): never keep the process alive for it
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
 * Bring one 1.x merchant into its 2.0 shop config (#100): the data half —
 * `flags.merchant-presets.shop` and each item's `.stock` — and the cut-over
 * half: Item Piles switched off everywhere it can still see the shop (#97) —
 * the actor, its prototype token, and every unlinked token, and its delta, on
 * every scene — plus the 2.0 sheet and the ownership default. Reads stored
 * flags directly, so it works with Item Piles inactive or uninstalled. Once
 * `flags.merchant-presets.shop` is current, a GM's own Item Piles retuning is
 * never read again: our schema is the source of truth from there on.
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

  // This shop's tokens, every scene's: an unlinked one keeps a delta of its
  // own (items it traded, Item Piles settings re-tuned on it) that the base
  // actor's migration never reaches (#124), so even a shop whose own config
  // is current may still have a token to migrate.
  const scenes = game.scenes.map(scene => ({ scene, docs: scene.tokens.filter(t => t.actorId === actor.id) }));
  for (const s of scenes) s.tokens = s.docs.map(t => t.toObject());
  const tokens = scenes.flatMap(s => s.tokens);
  const unlinked = scenes.flatMap(s => s.docs).filter(t => !t.actorLink && t.actor);
  if (!needsMigration(data, tokens)
    && !unlinked.some(t => tokenNeedsMigration(t.toObject(), t.actor.toObject(), data))) return false;

  const packShop = await resolvePackShop(data);
  const { update, shopError, warnings } = planActorUpdate(data,
    { packShop, hasTokenOnScene: tokens.length > 0, worldId: game.world?.id ?? null, isPlayer });
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

  // Each unlinked token's own half, through its synthetic actor so it lands in the delta, and
  // before Item Piles is switched off on it below: its own settings are read from there.
  for (const token of unlinked) {
    const plan = planTokenMigration(token.toObject(), token.actor.toObject(), actor.toObject());
    for (const w of plan.warnings) console.warn(`${MODULE} | ${w}`);
    for (const { item, errors } of plan.errors) {
      console.error(`${MODULE} | invalid migrated stock config for "${item}" on a token of "${actor.name}": ${errors.join("; ")}`);
    }
    // Known limit (#137 review): Foundry builds the token's actor by deep-merging the delta over
    // the base, so a key the token's config leaves out reads the base's. The one map where that
    // shows is `restock.quantities`: a token whose Item Piles table config omitted lines the
    // base lists keeps the base's formulas for them.
    if (plan.shop) { await token.actor.update({ [`flags.${MODULE}.shop`]: plan.shop }); changed = true; }
    if (plan.itemUpdates.length) { await token.actor.updateEmbeddedDocuments("Item", plan.itemUpdates); changed = true; }
  }

  for (const { scene, tokens: sceneTokens } of scenes) {
    const tokenUpdates = planTokenUpdates(sceneTokens);
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
 * scripts/shop.mjs's `planShop`; this carries them out, migrates the result
 * to the shop window, and rolls its first shelf from the chosen merchant's
 * stock table.
 *
 * @param {Actor} actor
 * @param {string} sourceUuid  The chosen merchant in this module's compendium.
 * @param {Iterable<string>} keepIds  Physical items to keep as the NPC's gear.
 * @returns {Promise<number>} how many stock lines the shop holds
 */
function setUpShop(actor, sourceUuid, keepIds) {
  // On the trade queue: a clock tick between clearing the shelf key and the new stock arriving
  // would adopt an empty shelf, and a trade would read a half-made shop (#135 review).
  return runTrade(() => setUpShopNow(actor, sourceUuid, keepIds));
}

async function setUpShopNow(actor, sourceUuid, keepIds) {
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
  // a compendium table, and the updateActor hook would otherwise take it for
  // a fresh arrival and roll a shelf the stock has not reached yet.
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
      // A new shelf from a new table: the next restock adopts it afresh (#135 review).
      [`flags.${MODULE}.shelf`]: null,
      [`flags.${MODULE}.schedule`]: null,
      [`flags.${MODULE}.lines`]: null,
      "system.currency": plan.currency
    });
    if (plan.creates.length) await actor.createEmbeddedDocuments("Item", plan.creates, { keepId: true });
    // Migrated to the shop window here (the plan copies the source's Item Piles data, still
    // switched on), then the chosen merchant's table draws this shop's first shelf. Still held:
    // this user's own updates fire updateActor, whose arrival hook would otherwise roll the shelf
    // a second time (#138 review). Already on the trade queue, so the restock is called directly.
    await migrateShop(actor);
    await restockNow(actor);
  } finally {
    rewiring.delete(actor.id);
  }
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
      visible: li => game.user.isGM && actorOf(li)?.type === "npc",
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
  (CONFIG.queries ??= {})[QUERY] = handleTradeQuery;
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
    name: "Shops restock on their schedule",
    hint: "Each shop restocks when its doors open on its due day, every few days by its kind "
      + "(an inn daily, a jeweler fortnightly), on Foundry's own calendar. A restock redraws only "
      + "what the shop's stock table put there; anything you added by hand stays, and a line you "
      + "hid or edited keeps your settings. Worlds upgrading from 1.x keep this off until you turn "
      + "it on.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
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
      + "a fence trades 20:00 to 04:00 — and closes to players outside them, on Foundry's own "
      + "world clock, so any calendar that advances time works. Turn it off and every shop stays "
      + "open around the clock.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE, "ignoreStockWeight", {
    name: "Shop stock is not carried",
    hint: "A merchant's wares and till sit in its own inventory, so dnd5e has the shopkeeper "
      + "carrying the whole shelf — a city "
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

  game.settings.register(MODULE, "tradeChat", {
    name: "Trades in chat",
    hint: "Each trade made in the shop window posts one receipt in chat: what changed hands and for how "
      + "much. Public, whispered to the GMs, or off. Whispered also whispers the spellcasting "
      + "announcement; to turn that off, use its own setting below.",
    scope: "world",
    config: true,
    type: String,
    choices: { public: "Public (default)", gm: "Whispered to the GMs", off: "Off" },
    default: "public"
  });

  game.settings.register(MODULE, "spellcastingToChat", {
    name: "Bought spellcasting is announced in chat",
    hint: "Buying a spellcasting service moves gold and nothing else. With this on, the shop says in "
      + "chat which spell it casts and for whom, linking the spell and any effects to drag onto the "
      + "creature it was cast on; for a service sold by level it asks the buyer to name the spell. "
      + "Nothing is applied automatically. Whispered to the GMs when trades are.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  registerShopSetup();
});

Hooks.once("ready", async () => {
  game.modules.get(MODULE).api = { registerDrinks, restock, scheduledRestocks, syncStockWeight, syncStockWeightAll,
    setUpShop, migrateShop, migrateAll, trade, bundleOf: item => bundleOf(item) };

  // Every client evaluates its own nutrition candidates, so this must run for
  // players too.
  registerDrinks();
  // The buyer's own client answers the meal prompt and posts the spellcasting
  // announcement, so trades are heard by players too.
  registerTradeListeners();
  registerActivityMeals();
  registerTradeDesk();

  if (!game.user.isGM) return;
  warnOutdatedNutrition();

  // The world's one-time autoRestock decision (#105), before any shop migrates. Awaited: a failed
  // write here must close migrationGateOpen before anything below can migrate a shop (#100 review).
  try { await applyAutoRestockDefault(); }
  catch (err) {
    migrationGateOpen = false;
    console.error(`${MODULE} | could not apply the autoRestock default; migration deferred to next load`, err);
  }

  Hooks.on("createActor", (actor, _options, userId) => {
    if (userId !== game.user.id) return;
    arrive(actor).catch(err => console.error(`${MODULE} |`, err));
  });

  // The shops restock on their own schedule (#105).
  registerRestock();
  // A shop arriving is new to this world, whatever its flags say: one exported after it was made
  // visitable comes back with its ownership cleared but its mark kept (#138 review, round 9).
  Hooks.on("preCreateActor", actor => {
    if (actor.flags?.[MODULE]?.madeVisitable != null) actor.updateSource({ [`flags.${MODULE}.madeVisitable`]: null });
  });
  Hooks.on("createToken", token => {
    if (game.users.activeGM !== game.user) return;   // one GM does the writing
    makeVisitable(token).catch(err => console.error(`${MODULE} |`, err));
  });
  // A scene arriving with tokens already on it (an Adventure or scene import) fires createScene
  // alone, never createToken for them (#138 review).
  Hooks.on("createScene", scene => {
    if (game.users.activeGM !== game.user || scene.pack) return;
    for (const token of scene.tokens ?? []) makeVisitable(token).catch(err => console.error(`${MODULE} |`, err));
  });

  // Dragging in a shop the world already holds offers Replace Actor, and that is the default:
  // Foundry keeps the compendium id on import, then writes the compendium data over the existing
  // actor as an update (#66). Fresh pack data, still on its compendium stock table with no shelf
  // key, rolls its own shelf (`arrive`); an ordinary edit never re-rolls a shop.
  Hooks.on("updateActor", (actor, _changes, _options, userId) => {
    if (userId !== game.user.id || !needsWiring(actor) || actor.flags?.[MODULE]?.shelf) return;
    arrive(actor).catch(err => console.error(`${MODULE} |`, err));
  });
  releaseStraysAll().then(n => { if (n) log(`let go of stray kit ids on ${n} merchant(s)`); });
  migrateAll()
    .then(n => { if (n) log(`migrated ${n} shop(s) to their 2.0 config`); })
    // Replaced from the pack while the world was closed (#66): fresh pack data, never rolled.
    // One GM does it, as for the migration: two would each adopt and draw a shelf (#138 review).
    .then(() => {
      if (game.users.activeGM !== game.user) return;
      return Promise.all(game.actors.filter(a => isPreset(a) && needsWiring(a) && !a.flags?.[MODULE]?.shelf).map(arrive));
    })
    .catch(err => console.error(`${MODULE} |`, err));

  log("ready");
});
/** Ids of the shops `arrive` is working on right now: a create and an update can come together. */
const arriving = new Set();

/**
 * A shop arriving: created in this world (dragged in from the pack, a world compendium or an
 * Adventure), or fresh pack data written over an existing actor by Replace Actor (#66). Migrated to
 * its shop window, let go of stray kit ids (#89, which would hide goods from the window), and, when
 * it's fresh pack data, given its own shelf by a first restock. Fresh pack data is still on its
 * compendium stock table with no shelf key; a shop that has either been rolled here or wired to a
 * world table by 1.x keeps the shelf it has.
 *
 * @param {Actor} actor
 */
async function arrive(actor) {
  // A shop being set up (`setUpShopNow`) is half built until it finishes, and migrates and rolls
  // its own shelf there (#138 review).
  if (actor.pack || arriving.has(actor.id) || rewiring.has(actor.id)) return;
  arriving.add(actor.id);
  try {
    await migrateShop(actor);
    if (!isPreset(actor)) return;
    await releaseStrays(actor);
    if (needsWiring(actor) && !actor.flags?.[MODULE]?.shelf) await restock(actor);
  } finally {
    arriving.delete(actor.id);
  }
}

/**
 * Make a hidden shop visitable when the GM places its token (#104, decided on the issue): shops
 * arrive hidden (ownership None) so an unplaced one stays out of players' Actors sidebar, and a
 * placed one opens for players on a double-click, which core gates on Limited. A GM's own choice
 * holds either way: any default ownership but None, or the "Players can visit" switch (#110,
 * `flags.merchant-presets.visibility`) once it's been set.
 *
 * @param {TokenDocument} token
 */
async function makeVisitable(token) {
  const LIMITED = 1;   // CONST.DOCUMENT_OWNERSHIP_LEVELS
  // A token in a compendium scene (an Adventure being built) is on no world scene, though its
  // baseActor still resolves to the world actor by id (#138 review).
  if (token.parent?.pack) return;
  const actor = token.baseActor ?? token.actor;
  // Any shop the migration takes, not only one it already has: a 1.x merchant dropped straight onto
  // the canvas lands before its migration writes the 2.0 config (#138 review).
  if (!actor || actor.pack || !isMigratable(actor)) return;
  if (actor.flags?.[MODULE]?.visibility != null) return;
  // Once per shop, in this world: a GM who sets it back to None afterwards has decided, and None
  // set by hand looks exactly like the untouched default. A GM's own ownership, a player's own
  // level included, holds (#138 review).
  const worldId = game.world?.id ?? null;
  if (isMadeVisitable(actor, worldId) || isOwnershipChosen(actor, isPlayer)) return;
  await actor.update({ "ownership.default": LIMITED, [`flags.${MODULE}.madeVisitable`]: worldId });
}
