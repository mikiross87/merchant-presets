/**
 * The approved frames of design/shop.pen that the shop window is checked against (#145), and for
 * each the fixture state that reproduces it: who is logged in, the theme, the window's size, and
 * `open`, an in-page function (run as that user, as a string) that opens the shop window in the
 * frame's state and returns its application id. A frame without `open` has no fixture yet and is
 * skipped by tools/design-check-run.mjs.
 *
 * Exports are regenerated from the canvas with the Pencil MCP:
 *   Export([id], "html-css", "design/export/<id>.html", {includeLayerIds: true, includeLayerNames: true})
 */
/* global game, Actor, CONFIG, foundry, setTimeout -- `setup` runs in the page */

/** The shop every frame draws but the Inn's, as the frames name it. */
export const SHOP = "Armourer & Blacksmith";
/** The Inn frames' shop. */
export const INN = "Inn & Tavern";
/** The service shops' frames (#151, band 15), by the names the frames give them. */
export const TEMPLE = "Temple & Faith Store";
export const STABLE = "Stable";

/**
 * Runs in the page as the GM (`design-check-run.mjs --setup`): puts the world into the frames'
 * shared state. It returns "reload" after switching the calendar, which only takes on a reload;
 * run it again then. Everything else it sets is idempotent, so it can run on any world it made.
 *
 * - the Harptos calendar, at 10:00 on the 14th of Mirtul ("mid-morning"); no automatic restock,
 *   so moving the clock never redraws the shelf;
 * - *Armourer & Blacksmith*: a fresh import of the Town smith, renamed, with the frames'
 *   description, 07:00-19:00, the world's list/half, a 212 gp till, and exactly the stock rows the
 *   Storefront draws (Longsword 7, Handaxe 11, Javelin 21 new, Longsword +1 1, Breastplate 1 new,
 *   Chain Mail 4, Shield sold out, Smith's Tools 4) beside the first GEAR lines of the drawn gear, so
 *   the nav counts are the frames' own (All goods 20, Weapons 4, Armor 3, Tools 1, Gear 12); the
 *   Longsword +1 is the pack's own line (#185), put on the shelf when the roll leaves it off;
 * - the Buyer Picker's cast, and no other actors but the shops (setup deletes the rest, strays
 *   from earlier checks included): Aria, P1's character, a Fighter 5 with 3 pp 47 gp 12 sp 30 cp;
 *   Tomas (a humanoid, 3 gp 4 sp) and Whisker (a beast, no purse), NPCs P1 owns; Brom (P2's
 *   character, Cleric 5, 212 gp) and Kess (a Rogue 5 no one plays, 41 gp 7 sp);
 * - on the active scene, the smith's token with Aria's, Tomas's and Whisker's beside it, so P1's
 *   frames open the shop and list all three as buyers in reach mode (#166);
 * - Aria's pack as the Sell frames draw it: a Longsword, a worn Chain Shirt and 2 Potions of Healing
 *   the smith buys, and Bread (loaf) and an unidentified ring it turns away; nothing else;
 * - *Inn & Tavern*: a fresh import of the Town inn, with the goods the Inn frames don't draw hidden
 *   (as a GM hides them): three meals, two rooms, and ale, bread and water, in the frame's order;
 * - no deals: the storefront frames draw Aria at list price. Only the Settings frames list deals,
 *   and their `open` sets them (`withDeals`).
 */
export async function setup() {
  const MP = "merchant-presets";
  const GEAR = 12;
  if (game.settings.get("dnd5e", "calendar") !== "harptos") {
    await game.settings.set("dnd5e", "calendar", "harptos");
    return "reload";
  }
  await game.settings.set(MP, "autoRestock", false);
  await game.settings.set(MP, "tradingHours", true);
  await game.settings.set(MP, "sellsAt", 100);
  await game.settings.set(MP, "buysAt", 50);

  // The 14th of Mirtul (month 4 of Harptos's twelve; days count from 0), 10:00. A time is built
  // from the day of the year, which Harptos's festival days offset: found, not counted.
  const cal = game.time.calendar;
  const now = cal.timeToComponents(game.time.worldTime);
  const perDay = cal.days.hoursPerDay * cal.days.minutesPerHour * cal.days.secondsPerMinute;
  const yearStart = cal.componentsToTime({ ...now, day: 0, hour: 0, minute: 0, second: 0 });
  let day = 0;
  while (day < 400) {
    const c = cal.timeToComponents(yearStart + day * perDay);
    if (c.month === 4 && c.dayOfMonth === 13) break;
    day++;
  }
  const at = cal.componentsToTime({ ...now, day, hour: 10, minute: 0, second: 0 });
  if (at !== game.time.worldTime) await game.time.advance(at - game.time.worldTime);

  const aria = game.actors.getName("Aria");
  await aria.update({ "system.currency": { pp: 3, gp: 47, ep: 0, sp: 12, cp: 30 } });
  const physical = ["weapon", "equipment", "consumable", "tool", "loot", "container"];
  await aria.deleteEmbeddedDocuments("Item", aria.items.filter(i => physical.includes(i.type)).map(i => i.id));
  const packed = async (packId, name, changes = {}) => {
    const pack = game.packs.get(packId);
    const entry = (await pack.getIndex()).getName(name);
    if (!entry) throw new Error(`${packId} has no ${name}`);
    return foundry.utils.mergeObject((await pack.getDocument(entry._id)).toObject(), changes);
  };
  await aria.createEmbeddedDocuments("Item", [
    await packed("dnd5e.equipment24", "Longsword", { sort: 100 }),
    // Worn: the Sell frames tag it Equipped (#170).
    await packed("dnd5e.equipment24", "Chain Shirt", { sort: 200, "system.equipped": true }),
    await packed("dnd5e.equipment24", "Potion of Healing", { sort: 300, "system.quantity": 2 }),
    await packed(`${MP}.goods`, "Bread (loaf)", { sort: 400 }),
    { name: "Ring of Protection", type: "equipment", img: "icons/equipment/finger/ring-band-copper.webp", sort: 500,
      system: { type: { value: "trinket" }, identified: false, unidentified: { name: "Unidentified Ring" }, price: { value: 3500, denomination: "gp" } } }
  ]);

  // The Buyer Picker's cast: every other actor goes, but the shops (remade below).
  const p1 = game.users.getName("P1");
  const p2 = game.users.getName("P2");
  const keep = new Set(["Aria", "Armourer & Blacksmith", "Inn & Tavern"]);
  await Actor.deleteDocuments(game.actors.filter(a => !keep.has(a.name) && p2?.character?.id !== a.id).map(a => a.id));
  const classPack = game.packs.find(p => p.documentName === "Item" && p.index.some(e => e.type === "class" && e.name === "Fighter"))
    ?? game.packs.get("dnd5e.classes24") ?? game.packs.get("dnd5e.classes");
  await classPack.getIndex({ fields: ["type"] });
  const withClass = async (actor, className, levels) => {
    await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => i.type === "class").map(i => i.id));
    const entry = classPack.index.find(e => e.type === "class" && e.name === className);
    const data = (await classPack.getDocument(entry._id)).toObject();
    data.system.levels = levels;
    await actor.createEmbeddedDocuments("Item", [data]);
  };
  await withClass(aria, "Fighter", 5);
  const brom = p2?.character ?? await Actor.create({ name: "Brom", type: "character" });
  await brom.update({ name: "Brom", "system.currency": { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 } });
  await withClass(brom, "Cleric", 5);
  const kess = await Actor.create({ name: "Kess", type: "character", "system.currency": { pp: 0, gp: 41, ep: 0, sp: 7, cp: 0 } });
  await withClass(kess, "Rogue", 5);
  const ownedBy = user => ({ default: 0, ...(user ? { [user.id]: 3 } : {}) });
  await Actor.create({ name: "Tomas", type: "npc", ownership: ownedBy(p1), "system.details.type.value": "humanoid",
    "system.currency": { pp: 0, gp: 3, ep: 0, sp: 4, cp: 0 } });
  await Actor.create({ name: "Whisker", type: "npc", ownership: ownedBy(p1), "system.details.type.value": "beast" });

  // A shop's arrival roll (#104) isn't a restock, so it notes no restockedAt (#152): wait for its shelf
  // to be drawn and to settle, or the edits below race the draw. The opens stamp the frames' restocks.
  const rolled = async (actor, what) => {
    const drawnHere = () => actor.items.filter(i => i.flags[MP]?.drawn != null && i.flags[MP].drawn === actor.flags[MP]?.shelf).length;
    let seen = -1, steady = 0;
    for (let t = 0; t < 60 && steady < 3; t++) {
      await new Promise(r => setTimeout(r, 500));
      const now = drawnHere();
      // Adoption stamps the goods already there before the roll replaces them: a steady count means
      // nothing until the roll's last write, lastRestockAt, has landed too (#199).
      steady = now > 0 && now === seen && actor.flags[MP]?.lastRestockAt != null ? steady + 1 : 0;
      seen = now;
    }
    if (steady < 3) throw new Error(`${what}'s arrival roll never finished`);
  };
  const name = "Armourer & Blacksmith";
  for (const a of game.actors.filter(a => a.name === name)) await a.delete();
  const pack = game.packs.get(`${MP}.merchants`);
  const entry = (await pack.getIndex()).getName("Armourer & Blacksmiths (Town)");
  const shop = await game.actors.importFromCompendium(pack, entry._id);
  await rolled(shop, "the shop");
  const magic = "Longsword +1";
  if (!shop.items.some(i => i.name === magic && i.flags[MP]?.drawn)) {
    const line = (await pack.getDocument(entry._id)).items.getName(magic)?.toObject();
    if (!line) throw new Error(`the Town smith has no ${magic} line`);
    delete line._id;
    await shop.createEmbeddedDocuments("Item", [foundry.utils.mergeObject(line, { [`flags.${MP}.drawn`]: shop.flags[MP].shelf })]);
  }

  const rows = { Longsword: [7], Handaxe: [11], Javelin: [21, true], "Longsword +1": [1], Breastplate: [1, true], "Chain Mail": [4], Shield: [0], "Smith's Tools": [4] };
  const drawn = shop.items.filter(i => i.flags[MP]?.drawn);
  const armsOrTools = i => i.type === "weapon" || i.type === "tool" || (i.type === "equipment" && i.system.type?.value in (CONFIG.DND5E.armorTypes ?? {}));
  const gear = drawn.filter(i => !armsOrTools(i)).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  if (gear.length < GEAR) throw new Error(`the shelf drew ${gear.length} gear lines; the frames count ${GEAR}`);
  await shop.deleteEmbeddedDocuments("Item", [...drawn.filter(i => armsOrTools(i) && !(i.name in rows)), ...gear.slice(GEAR)].map(i => i.id));
  // The frame's rows first, in its order (the window lists the shelf by sort), then the gear.
  const order = Object.keys(rows);
  await shop.updateEmbeddedDocuments("Item", shop.items.filter(i => i.flags[MP]?.drawn).map(i => (i.name in rows
    ? { _id: i.id, sort: (order.indexOf(i.name) + 1) * 100, "system.quantity": rows[i.name][0], [`flags.${MP}.newAt`]: null }
    : { _id: i.id, sort: 10_000 + i.sort })));

  await shop.update({
    name,
    img: "icons/environment/settlement/blacksmith.webp",
    "ownership.default": 1,
    "system.currency": { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 },
    [`flags.${MP}.visibility`]: true,
    [`flags.${MP}.shop.description`]: "Hot, loud, and busy from before dawn. Blades and plate made and mended, and the only place in a small settlement that can shoe a horse and hammer out a helm.",
    [`flags.${MP}.shop.hours`]: { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } },
    [`flags.${MP}.shop.terms`]: { sellsAt: null, buysAt: null, categories: [] },
    [`flags.${MP}.shop.deals`]: []
  });

  // The Inn frames' shop (INN; this runs in the page, which can't see this module's names).
  const innName = "Inn & Tavern";
  for (const a of game.actors.filter(a => a.name === innName)) await a.delete();
  const inn = await game.actors.importFromCompendium(pack, (await pack.getIndex()).getName("Inn & Tavern (Town)")._id);
  await rolled(inn, "the inn");
  const shown = { "Meal, Modest": [], "Meal, Comfortable": [], "Meal, Wealthy": [], "Inn Stay, Modest (per day)": [],
    "Inn Stay, Comfortable (per day)": [], "Ale (mug)": [17], "Bread (loaf)": [20], "Water (Pint)": [20] };
  const innOrder = Object.keys(shown);
  await inn.updateEmbeddedDocuments("Item", inn.items.filter(i => i.flags[MP]?.drawn).map(i => (i.name in shown
    ? { _id: i.id, sort: (innOrder.indexOf(i.name) + 1) * 100, [`flags.${MP}.stock.hidden`]: false,
      ...(shown[i.name].length ? { "system.quantity": shown[i.name][0] } : {}) }
    : { _id: i.id, [`flags.${MP}.stock.hidden`]: true })));
  await inn.update({
    name: innName,
    "ownership.default": 1,
    [`flags.${MP}.visibility`]: true,
    [`flags.${MP}.shop.description`]: "Beds upstairs, a fire downstairs, and a landlord who has heard every story twice. Rooms by the night at whatever standard you can stomach paying for.",
    [`flags.${MP}.shop.terms`]: { sellsAt: null, buysAt: null, categories: [] },
    [`flags.${MP}.shop.deals`]: []
  });

  // The service shops (band 15; TEMPLE, STABLE); each frame's `before` lays out their shelves.
  for (const [title, entryName] of [["Temple & Faith Store", "Temple & Faith Store (Town)"], ["Stable", "Stable (Town)"]]) {
    for (const a of game.actors.filter(a => a.name === title)) await a.delete();
    const made = await game.actors.importFromCompendium(pack, (await pack.getIndex()).getName(entryName)._id);
    await rolled(made, title);
    await made.update({ name: title, "ownership.default": 1, [`flags.${MP}.visibility`]: true,
      [`flags.${MP}.shop.terms`]: { sellsAt: null, buysAt: null, categories: [] }, [`flags.${MP}.shop.deals`]: [] });
  }

  // P1 at the counter (#166): in reach mode a player opens a shop, and trades as a character, only
  // with a token beside the shop's on the scene they view. So the smith stands on the active scene
  // with P1's three around it; the tokens earlier runs left (and the deleted shops') go first.
  const scene = game.scenes.active;
  if (!scene) throw new Error("the fixture world has no active scene for the player's tokens");
  const standing = [shop, aria, game.actors.getName("Tomas"), game.actors.getName("Whisker")];
  await scene.deleteEmbeddedDocuments("Token", scene.tokens.filter(t => !game.actors.has(t.actorId)
    || standing.some(a => a.id === t.actorId)).map(t => t.id));
  const { size, sceneX, sceneY } = scene.dimensions;
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1]];
  await scene.createEmbeddedDocuments("Token", await Promise.all(standing.map(async (actor, i) => (await actor.getTokenDocument({
    x: sceneX + cells[i][0] * size, y: sceneY + cells[i][1] * size, actorLink: true, hidden: false })).toObject())));
  return shop.id;
}

/** The frames' shelf rows and their stock (setup draws the same; it can't see this module's names). */
const ROWS = { Longsword: 7, Handaxe: 11, Javelin: 21, "Longsword +1": 1, Breastplate: 1, "Chain Mail": 4, Shield: 0, "Smith's Tools": 4 };

/**
 * An `open` for the shop window: the frame's theme on this client, `before` (an in-page statement,
 * `shop` in scope; the GM's frames only), Aria as the buyer, `basket` and `sellBasket` ([name,
 * quantity] pairs: the shop's goods, Aria's) on the Buy and Sell bills, the window at the frame's
 * size on `tab`, and `then` (an in-page statement, `app` in scope) run after it renders. `from`
 * (an in-page expression) is the shop, when it isn't the world actor called `name`.
 */
const openShop = ({ tab = "buy", before = "", basket = [], sellBasket = [], then = "", size = null, root = "app.id", hour = 10, autoRestock = false, clock = "auto", coin = "finite", name = SHOP, from = null } = {}) => `async ({ theme, width, height }) => {
  ${size ? `width = ${size.width}; height = ${size.height};` : ""}
  // The frame's hour on the 14th of Mirtul, and the world's restock switch (the GM's frames set them).
  if (game.user.isGM) {
    const perDay = game.time.calendar.days.hoursPerDay * game.time.calendar.days.minutesPerHour * game.time.calendar.days.secondsPerMinute;
    const at = Math.floor(game.time.worldTime / perDay) * perDay + ${hour} * 3600;
    if (at !== game.time.worldTime) await game.time.advance(at - game.time.worldTime);
    await game.settings.set("merchant-presets", "autoRestock", ${autoRestock});
    // Whether shops follow the world clock (#149): Auto keeps time here (the clock isn't at 0); band 13 sets Never.
    await game.settings.set("merchant-presets", "followClock", ${JSON.stringify(clock)});
    // Merchant coin (#147): Finite, but for the Till frame under unlimited coin (band 14, Yusa2).
    await game.settings.set("merchant-presets", "merchantPurse", ${JSON.stringify(coin)});
    // Every frame starts from the setup's purses and shelf: a Trade States frame trades, or sells
    // a line out, and the frames after it must not see that.
    const smith = game.actors.getName(${JSON.stringify(SHOP)});
    await smith.update({ "system.currency": { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 }, "flags.merchant-presets.purse": 800 });
    await smith.updateEmbeddedDocuments("Item", Object.entries(${JSON.stringify(ROWS)})
      .map(([n, q]) => ({ _id: smith.items.getName(n)?.id, "system.quantity": q })).filter(u => u._id));
    await game.actors.getName("Aria").update({ "system.currency": { pp: 3, gp: 47, ep: 0, sp: 12, cp: 30 } });
  }
  const ui = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
  // Writing the scheme redraws the canvas (even unchanged), and until it's back a player stands at
  // no counter (#166).
  const redrawn = canvas.scene ? new Promise(r => { Hooks.once("canvasReady", r); setTimeout(r, 5000); }) : null;
  ui.colorScheme = { applications: theme, interface: theme };
  await game.settings.set("core", "uiConfig", ui);
  await redrawn;
  const shop = ${from ?? `game.actors.getName(${JSON.stringify(name)})`};
  ${before}
  const app = shop.sheet;
  app._buyerUuid = game.actors.getName("Aria").uuid;
  for (const [name, quantity] of ${JSON.stringify(basket)}) app._baskets.buy.set(shop.items.getName(name).id, quantity);
  const aria = game.actors.getName("Aria");
  for (const [name, quantity] of ${JSON.stringify(sellBasket)}) app._baskets.sell.set(aria.items.getName(name).id, quantity);
  await app.render({ force: true, position: { left: 20, top: 20, width, height } });
  // Core refuses the render, quietly, to a user who can't see the shop (ShopSheet#isVisible).
  if (!app.rendered) throw new Error(\`\${game.user.name} can't open \${shop.name}: no token of theirs stands in its reach on \${canvas.scene?.name ?? "any scene"} (run --setup)\`);
  app.changeTab(${JSON.stringify(tab)}, "primary");
  ${then}
  await new Promise(r => setTimeout(r, 800));
  return ${root};
}`;

/**
 * The Settings frames' deals: Aria buying at −10% until the shop closes (19:00 today), Tomas
 * selling at +10% with no end. The storefront frames' `open` clears them.
 */
const withDeals = `
  const cal = game.time.calendar;
  const perDay = cal.days.hoursPerDay * cal.days.minutesPerHour * cal.days.secondsPerMinute;
  const closes = Math.floor(game.time.worldTime / perDay) * perDay + (19 * cal.days.minutesPerHour + 1) * cal.days.secondsPerMinute;
  await shop.update({ "flags.merchant-presets.shop.deals": [
    { actor: game.actors.getName("Aria").uuid, name: "Aria", buy: -0.1, sell: null, note: "Saved the smith's daughter", ends: { at: closes, when: "close" } },
    { actor: game.actors.getName("Tomas").uuid, name: "Tomas", buy: null, sell: 0.1, note: "Regular supplier of ore", ends: null }
  ] });`;
const withoutDeals = `if (shop.flags["merchant-presets"]?.shop?.deals?.length) await shop.update({ "flags.merchant-presets.shop.deals": [] });`;
/** 7:00, the smith's opening, `daysAgo` days back: when the frames' restocks ran (design aaJcp: "Last restocked 14 Mirtul at 7:00"). */
const opening = daysAgo => `(Math.floor(game.time.worldTime / 86400) - ${daysAgo}) * 86400 + 7 * 3600`;
/**
 * Whether Javelin and Breastplate wear "New": this morning's restock brought them back (#152). The
 * Storefront frames draw it; the Closed ones, before the day's opening, don't.
 */
const newBadges = on => `await shop.updateEmbeddedDocuments("Item", ["Javelin", "Breastplate"].map(name => ({ _id: shop.items.getName(name).id, "flags.merchant-presets.newAt": ${on ? opening(0) : "null"} })));`;
/** The Storefront frames draw "Fresh stock today": restocked at this morning's opening; the Settings frames the day before. */
const restocked = daysAgo => `await shop.update({ "flags.merchant-presets.restockedAt": ${opening(daysAgo)} });`;

const frame = (name, theme, width, height, user = "Gamemaster", open = null, board = {}) => ({ name, theme, width, height, user, open, ...board });
const settings = openShop({ tab: "settings", before: withDeals + restocked(1) + `shop.sheet._settingsSection = "terms";`,
  then: `app.element.querySelector('.mp-nav-link[data-section="terms"]').click();` });
/**
 * The Restock frames: Settings jumped to Restock at 10:00 on the 14th. This morning's 7:00 restock
 * brought Javelin and Breastplate back (New); it restocks every 7 days, next on the 21st at 7:00.
 */
const restockTab = openShop({ tab: "settings", autoRestock: true,
  before: withoutDeals + restocked(0) + newBadges(true) + `await shop.update({ "flags.merchant-presets.schedule": { lastRestock: ${opening(0)}, dueAt: ${opening(-7)}, every: 7 } });
  shop.sheet._settingsSection = "restock";`,
  then: `app.element.querySelector('.mp-nav-link[data-section="restock"]').click();` });
/** The Storefront's bill: the frames' three lines. The player's frame can't clear deals; a GM frame run first does. */
const BASKET = [["Longsword", 1], ["Handaxe", 2], ["Javelin", 10]];
const storefront = openShop({ before: withoutDeals + restocked(0) + newBadges(true), basket: BASKET });
const storefrontPlayer = openShop({ basket: BASKET });
/**
 * The Closed frames: 3:00 on the 14th, four hours before the smith opens, with scheduled restocks
 * on and the next one due on the 21st (every 7 days); a shop restocked the day before.
 */
const nextRestock = `await shop.update({ "flags.merchant-presets.schedule": { lastRestock: game.time.worldTime - 3 * 3600,
  dueAt: Math.floor(game.time.worldTime / 86400) * 86400 + 7 * 86400, every: 7 } });`;
const closed = openShop({ before: withoutDeals + restocked(1) + nextRestock + newBadges(false), hour: 3, autoRestock: true });
/** The Inn frames: evening, a meal, two nights and three ales on the bill, fresh stock today. */
const inn = openShop({ name: INN, before: restocked(0), hour: 19,
  basket: [["Meal, Comfortable", 1], ["Inn Stay, Comfortable (per day)", 2], ["Ale (mug)", 3]] });
/**
 * A service shop's shelf as its frame draws it (in the page, `shop` in scope): every good on show,
 * so the nav counts are the pack's; in the pack's order, which the arrival roll doesn't keep (it
 * can still be replacing lines after setup, so this runs as the frame opens); the Stable's stock.
 */
const shelfAsPacked = name => `{
  const pack = game.packs.get("merchant-presets.merchants");
  const entry = (await pack.getIndex()).find(e => e.name.startsWith(${JSON.stringify(name)} + " (Town)"));
  const order = new Map();
  (await pack.getDocument(entry._id)).toObject().items.forEach((it, n) => { if (!order.has(it.name)) order.set(it.name, n); });
  const counts = ${JSON.stringify(name === STABLE ? { "Saddle, Military": 8, "Saddle, Riding": 3, Camel: 4, "Horse, Draft": 4, "Horse, Riding": 4, Mastiff: 6 } : {})};
  await shop.updateEmbeddedDocuments("Item", shop.items.filter(i => i.flags["merchant-presets"]?.kind !== "gear").map(i => ({ _id: i.id,
    sort: ((order.get(i.name) ?? 999) + 1) * 100, "flags.merchant-presets.stock.hidden": false,
    "system.quantity": counts[i.name] ?? Math.max(1, i.system.quantity ?? 1) })));
}`;
/**
 * The service shops (#151), yesterday's restock so nothing is fresh, the list scrolled to `group`
 * as its frame draws it. At the temple Aria has saved 100 gp more, for a named spell and a cantrip.
 */
const serviceShop = (name, group, basket, before = "") => openShop({ name, basket, before: withoutDeals + restocked(1) + shelfAsPacked(name) + before,
  then: `const stock = app.element.querySelector(".buy-tab .mp-stock");
  const first = stock.querySelector('[data-pen^="Group "]'), to = stock.querySelector('[data-pen="Group ${group}"]');
  stock.scrollTop = to.getBoundingClientRect().top - first.getBoundingClientRect().top;` });
const temple = serviceShop(TEMPLE, "Spellcasting", [["Spellcasting: Protection from Evil and Good", 1], ["Spellcasting: Cantrip", 1]],
  `await game.actors.getName("Aria").update({ "system.currency": { pp: 3, gp: 147, ep: 0, sp: 12, cp: 30 } });`);
const stable = serviceShop(STABLE, "Tack", [["Horse, Riding", 1], ["Stabling (per day)", 2]]);
/** The Buyer Picker, open over the storefront; each menu on the board is measured on its own. */
const picker = openShop({ size: { width: 920, height: 680 },
  then: "app.element.querySelector('.buyer-picker').showPopover();", root: "`${app.id}-buyer-picker`" });
/** The Terms popover, open over the GM's storefront; the frame is the popover alone. */
const terms = openShop({ before: withoutDeals + restocked(0) + newBadges(true), basket: BASKET, size: { width: 920, height: 680 },
  then: "app.element.querySelector('.mp-terms-popover').showPopover();", root: "`${app.id}-terms-popover`" });
/** The Sell frames: Aria selling the Longsword and both potions, to a shop restocked the day before. */
const sell = openShop({ tab: "sell", before: withoutDeals + restocked(1), sellBasket: [["Longsword", 1], ["Potion of Healing", 2]] });

/**
 * A Trade Chat Card part (design z5RBkd): a real trade through the API at 10:00 on the 14th, the
 * receipt posted as the `tradeChat` setting says (`chat`), then Aria's and the shop's goods and
 * coins put back as they were, so the frames after it (and the next run) find the world unchanged.
 * `lines` are [name, quantity] pairs of the shop's goods (a purchase) or Aria's (a sale). The
 * frame is the posted message, in the sidebar's chat log.
 */
const receipt = ({ kind, lines, chat, clock = "auto" }) => `async ({ theme }) => {
  const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
  cfg.colorScheme = { applications: theme, interface: theme };
  await game.settings.set("core", "uiConfig", cfg);
  const perDay = game.time.calendar.days.hoursPerDay * game.time.calendar.days.minutesPerHour * game.time.calendar.days.secondsPerMinute;
  const at = Math.floor(game.time.worldTime / perDay) * perDay + 10 * 3600;
  if (at !== game.time.worldTime) await game.time.advance(at - game.time.worldTime);
  await game.settings.set("merchant-presets", "tradeChat", ${JSON.stringify(chat)});
  await game.settings.set("merchant-presets", "followClock", ${JSON.stringify(clock)});
  const shop = game.actors.getName(${JSON.stringify(SHOP)});
  const aria = game.actors.getName("Aria");
  ${withoutDeals}
  const snapshot = [shop, aria].map(actor => ({ actor, currency: { ...actor.system.currency }, items: actor.items.map(i => i.toObject()) }));
  const from = ${kind === "buy" ? "shop" : "aria"};
  const result = await game.modules.get("merchant-presets").api.trade({ tradeId: foundry.utils.randomID(16), kind: ${JSON.stringify(kind)},
    shopUuid: shop.uuid, buyerUuid: aria.uuid, lines: ${JSON.stringify(lines)}.map(([name, quantity]) => ({ itemId: from.items.getName(name).id, quantity })) });
  if (result?.status !== "sealed") throw new Error("the fixture's trade didn't seal: " + JSON.stringify(result));
  for (const { actor, currency, items } of snapshot) {
    const was = new Set(items.map(i => i._id));
    await actor.deleteEmbeddedDocuments("Item", actor.items.filter(i => !was.has(i.id)).map(i => i.id));
    const now = new Set(actor.items.map(i => i.id));
    await actor.createEmbeddedDocuments("Item", items.filter(i => !now.has(i._id)), { keepId: true });
    await actor.updateEmbeddedDocuments("Item", items.filter(i => now.has(i._id)).map(i => ({ _id: i._id, "system.quantity": i.system.quantity })));
    await actor.update({ "system.currency": currency });
  }
  await game.settings.set("merchant-presets", "tradeChat", "public");
  await game.settings.set("merchant-presets", "followClock", "auto");
  ui.sidebar.expand();
  ui.sidebar.changeTab("chat", "primary");
  await new Promise(r => setTimeout(r, 800));
  const message = game.messages.contents.filter(m => m.content.includes("mp-receipt")).at(-1);
  const li = document.querySelector('#sidebar [data-message-id="' + message.id + '"]');
  li.scrollIntoView({ block: "center" });
  li.id = "mp-receipt-under-check";
  return li.id;
}`;
const receiptBuy = receipt({ kind: "buy", lines: BASKET, chat: "public" });
const receiptSell = receipt({ kind: "sell", lines: [["Longsword", 1], ["Potion of Healing", 2]], chat: "gm" });

/**
 * A Trade States part (design WNYhA): the Buy tab's Bill of Sale (the Sell tab's for `tab: "sell"`)
 * in one state, reached as the window reaches it; `act` runs after it renders. The frame is the
 * slip, and the window's height is fitted so the slip is as tall as its contents, as the board draws
 * each one (the slip fills the column in a taller window).
 */
const tradeState = ({ tab = "buy", basket = BASKET, sellBasket = [], before = "", act = "", gm = true, clock = "auto", name = SHOP }) => openShop({
  tab, basket, sellBasket, clock, name, size: { width: 920, height: 680 },
  before: gm ? withoutDeals + restocked(0) + (name === SHOP ? newBadges(true) : "") + before : "",
  then: `${act}
  await new Promise(r => setTimeout(r, 500));
  const slipOf = () => app.element.querySelector(".tab.active .mp-basket .mp-slip");
  for (let pass = 0; pass < 3; pass++) {
    const fill = slipOf().querySelector(":scope > .mp-purse-after, :scope > .mp-slip-fill");
    const ledger = slipOf().querySelector(".mp-ledger");
    const kids = fill ? [...fill.children] : [];
    const natural = kids.reduce((sum, k) => sum + k.getBoundingClientRect().height, 0) + 5 * Math.max(0, kids.length - 1);
    // Room to spare in the fill, less any lines the ledger had to scroll out of view.
    const slack = (fill ? fill.getBoundingClientRect().height - natural : 0) - (ledger ? ledger.scrollHeight - ledger.clientHeight : 0);
    if (Math.abs(slack) < 0.5) break;
    app.setPosition({ height: app.position.height - slack });
    await new Promise(r => setTimeout(r, 400));
  }
  slipOf().id = app.id + "-slip";`,
  root: "`${app.id}-slip`"
});
const until = test => `for (let t = 0; t < 60 && !(${test}); t++) await new Promise(r => setTimeout(r, 250));`;
const sealIt = `app.element.querySelector('.mp-basket [data-action="seal"]').click();`;
/**
 * A real trade on the `tab` bill, then the goods put back: Aria's purse stays as the trade left it
 * ("purse now"), and the shelf and her pack are as they were for the frames after it.
 */
const sealThenPutBack = tab => `const kept = [shop, game.actors.getName("Aria")].map(a => ({ a, items: a.items.map(i => i.toObject()) }));
    ${sealIt.replace(".mp-basket", `.tab.active .mp-basket`)} ${until(`app._tradeState.${tab} === "sealed"`)}
    for (const { a, items } of kept) {
      const was = new Set(items.map(i => i._id));
      await a.deleteEmbeddedDocuments("Item", a.items.filter(i => !was.has(i.id)).map(i => i.id));
      const now = new Set(a.items.map(i => i.id));
      await a.createEmbeddedDocuments("Item", items.filter(i => !now.has(i._id)), { keepId: true });
      await a.updateEmbeddedDocuments("Item", items.filter(i => now.has(i._id)).map(i => ({ _id: i._id, "system.quantity": i.system.quantity })));
    }
    await app.render({ parts: ["body"] });`;
const states = {
  sealing: tradeState({ act: `app._tradeState.buy = "sealing"; await app.render({ parts: ["body"] });` }),
  // A real trade, then the goods put back: Aria's purse stays as the trade left it, "purse now".
  sealed: tradeState({ act: sealThenPutBack("buy") }),
  cantAfford: tradeState({ basket: [["Breastplate", 1], ["Handaxe", 2], ["Javelin", 10]] }),
  // A player with no GM at the table (the checker logs in no one else) sends the bill. A player
  // can't reset the shelf, so this frame counts on the GM frame run before it (FRAMES order).
  noGm: tradeState({ gm: false, act: `${sealIt} ${until('app._tradeState.buy === "no-gm"')} await app.render({ parts: ["body"] });` }),
  tillShort: tradeState({ tab: "sell", basket: [], sellBasket: [["Longsword", 1], ["Potion of Healing", 2]],
    before: `await shop.update({ "system.currency": { pp: 0, gp: 40, ep: 0, sp: 0, cp: 0 } });` }),
  // Someone else buys the last Longsword while the bill is open.
  stockChanged: tradeState({ act: `await shop.items.getName("Longsword").update({ "system.quantity": 0 });
    ${until('app._tradeState.buy === "stock-changed"')}` })
};
const PARTS = [["sealing", "y38HX"], ["sealed", "q1Q9B"], ["cantAfford", "wrhJy"], ["noGm", "ytVnE"], ["tillShort", "KcFV1"], ["stockChanged", "Aa3sm"]];
const stateFrames = Object.fromEntries(["light", "dark"].flatMap(theme => PARTS.map(([state, part]) => [
  `${theme === "light" ? "WNYhA" : "mWJYP"}:${state}`,
  frame(`08 Trade States — ${theme === "light" ? "Light" : "Dark"} · ${state}`, theme, 1900, 755, state === "noGm" ? "P1" : "Gamemaster", states[state],
    { export: theme === "light" ? "WNYhA" : "mWJYP", part })
])));


/** Settings jumped to `section` at 10:00 on the 14th, restocked the day before, with or without the Settings frames' deals (bands 09 and 11). */
const settingsAt = (section, deals = false, jump = true) => openShop({ tab: "settings", autoRestock: true, before: (deals ? withDeals : withoutDeals) + restocked(1) + `shop.sheet._settingsSection = "${section}";`,
  then: jump ? `app.element.querySelector('.mp-nav-link[data-section="${section}"]').click();` : "" });
/**
 * Band 13 (#149): shops that don't follow the world clock. Settings jumped to Hours, as S2swP; the
 * Buy tab's sealed Bill of Sale, as WNYhA's; a purchase receipt, as z5RBkd's. None of them has a date.
 */
/** Settings jumped to Till (#147, band 14): the smith's 212 gp, refilled to the Town preset's 800 gp; or under unlimited merchant coin. */
const tillSettings = coin => openShop({ tab: "settings", autoRestock: true, coin, before: withoutDeals + restocked(1) + `shop.sheet._settingsSection = "till";`,
  then: `app.element.querySelector('.mp-nav-link[data-section="till"]').click();` });
const noClockSettings = openShop({ tab: "settings", autoRestock: true, clock: "never", before: withoutDeals + restocked(1) + `shop.sheet._settingsSection = "hours";`,
  then: `app.element.querySelector('.mp-nav-link[data-section="hours"]').click();` });
const noClockSealed = tradeState({ act: sealThenPutBack("buy"), clock: "never" });
const noClockReceipt = receipt({ kind: "buy", lines: BASKET, chat: "public", clock: "never" });
const noClockFrames = Object.fromEntries(["light", "dark"].flatMap(theme => {
  const [board, suffix] = theme === "light" ? ["cPxfb", "Light"] : ["LoQo1", "Dark"];
  return [
    [`${board}:sealed`, frame(`13 No world clock · Bill and receipt — ${suffix} · sealed`, theme, 664, 503, "Gamemaster", noClockSealed, { export: board, part: "qoHBi" })],
    [`${board}:receipt`, frame(`13 No world clock · Bill and receipt — ${suffix} · receipt`, theme, 664, 503, "Gamemaster", noClockReceipt, { export: board, part: "Ea7Oy" })]
  ];
}));
/** Aria's −10% deal on buying, running (until the shop closes) or ended at yesterday's closing. */
const ariaDeal = ended => `
  const perDay = game.time.calendar.days.hoursPerDay * 3600;
  const close = Math.floor(game.time.worldTime / perDay) * perDay + 19 * 3600 + 60 - (${ended} ? perDay : 0);
  await shop.update({ "flags.merchant-presets.shop.deals": [
    { actor: game.actors.getName("Aria").uuid, name: "Aria", buy: -0.1, sell: null, note: "Saved the smith's daughter", ends: { at: close, when: "close" } },
    { actor: game.actors.getName("Tomas").uuid, name: "Tomas", buy: null, sell: 0.1, note: "Regular supplier of ore", ends: null }
  ] });`;
/** The Deals board (Q6UvA): the deal form filled for Aria, the Deals section with her deal ended, her bill at the deal's price. */
const dealForm = openShop({ tab: "settings", size: { width: 920, height: 760 }, before: withoutDeals + restocked(1),
  then: `app.element.querySelector('.mp-nav-link[data-section="deals"]').click();
  app.element.querySelector('[data-action="addDeal"]').click();
  const dealForm = () => document.querySelector(".mp-deal-form") ?? [...document.querySelectorAll(".application.dialog")].at(-1);
  ${until("dealForm()")}
  const form = dealForm();
  // Filled in as the frame draws it: Aria, 10% off, until the shop closes, and the note.
  const set = (name, value, event = "change") => { const el = form.querySelector('[name="' + name + '"]'); el.value = value; el.dispatchEvent(new Event(event, { bubbles: true })); };
  set("actor", game.actors.getName("Aria").uuid);
  set("buy", "\u221210", "input");
  set("ends", "close");
  set("note", "Saved the smith's daughter", "input");
  form.id = "mp-deal-form-under-check";`, root: '"mp-deal-form-under-check"' });
const dealEnded = openShop({ tab: "settings", size: { width: 920, height: 760 }, before: ariaDeal(true) + restocked(1),
  then: `app.element.querySelector('.mp-nav-link[data-section="deals"]').click();
  const section = app.element.querySelector('.settings-section[data-section="deals"]');
  section.id = app.id + "-deals";`, root: "`${app.id}-deals`" });
const dealBill = tradeState({ before: ariaDeal(false) });
/** Aria's deal on a name that wraps (#208): the Temple's bill of band 15, at her deal's price. */
const dealLongName = tradeState({ name: TEMPLE, basket: [["Spellcasting: Protection from Evil and Good", 1], ["Spellcasting: Cantrip", 1]],
  before: shelfAsPacked(TEMPLE) + ariaDeal(false) + `await game.actors.getName("Aria").update({ "system.currency": { pp: 3, gp: 147, ep: 0, sp: 12, cp: 30 } });` });
/** The narrow window's bill, opened from its dock (design mVjRf). */
const billOpen = openShop({ size: { width: 480, height: 780 }, before: withoutDeals + restocked(0) + newBadges(true), basket: BASKET,
  then: `app.element.querySelector('.tab.active [data-action="toggleBill"]').click();` });
const sellNarrow = openShop({ tab: "sell", before: withoutDeals + restocked(1), sellBasket: [["Longsword", 1], ["Potion of Healing", 2]] });
/** The Sell tab's receipt (design euA99): Aria's sale sealed, then the goods put back. */
const sellSealed = tradeState({ tab: "sell", basket: [], sellBasket: [["Longsword", 1], ["Potion of Healing", 2]], act: sealThenPutBack("sell") });
/** The compendium preview's shelf (#199, design L4tb2b): the frames' rows as a pack's roll holds them, nothing sold out. */
const PREVIEW_ROWS = { ...ROWS, Shield: 3 };
/**
 * The compendium preview frames' shop (#199, bands 16 and 17): the smith, deals cleared, copied
 * into a world compendium ("Design previews", made the first time) as a pack's merchant would sit
 * there: its shelf rolled once, never restocked or sold from, and no shelf key of its own, so it
 * reads as fresh pack data. `exported` keeps the key, as a shop a GM rolled in a world and exported
 * to a world compendium does (#214). Each open replaces the copy.
 */
const previewCopy = (exported = false) => `await (async () => {
  const smith = game.actors.getName(${JSON.stringify(SHOP)});
  const Packs = foundry.documents.collections.CompendiumCollection;
  const pack = game.packs.get("world.design-previews")
    ?? await Packs.createCompendium({ type: "Actor", label: "Design previews", name: "design-previews" });
  if (pack.locked) await pack.configure({ locked: false });
  const index = await pack.getIndex();
  if (index.size) await Actor.deleteDocuments([...index.keys()], { pack: pack.collection });
  const data = smith.toObject();
  delete data._id;
  data.flags["merchant-presets"].shop.deals = [];
  delete data.flags["merchant-presets"].restockedAt;
  if (!${exported}) delete data.flags["merchant-presets"].shelf;
  const rows = ${JSON.stringify(PREVIEW_ROWS)};
  for (const item of data.items) {
    if (item.name in rows) item.system.quantity = rows[item.name];
    if (item.flags["merchant-presets"]) delete item.flags["merchant-presets"].newAt;
  }
  const [copy] = await Actor.createDocuments([data], { pack: pack.collection });
  await pack.configure({ locked: true });
  return copy;
})()`;
const preview = openShop({ from: previewCopy() });
const previewSettings = openShop({ tab: "settings", from: previewCopy(), before: `shop.sheet._settingsSection = "terms";` });
/** The exported shop's board (#214, design W9SYUv): its card in the wide window, its dock in the narrow one. */
const exportedCard = openShop({ from: previewCopy(true), size: { width: 920, height: 680 },
  then: `app.element.querySelector('.tab.active [data-pen="Basket"]').id = app.id + "-basket";`, root: "`${app.id}-basket`" });
const exportedDock = openShop({ from: previewCopy(true), size: { width: 480, height: 780 },
  then: `app.element.querySelector('.tab.active [data-pen="Preview dock"]').id = app.id + "-dock";`, root: "`${app.id}-dock`" });
const exportedFrames = Object.fromEntries(["light", "dark"].flatMap(theme => [["card", "AvEBQ", exportedCard], ["dock", "TnVwq", exportedDock]].map(([part, node, open]) => [
  `${theme === "light" ? "W9SYUv" : "S7wWTs"}:${part}`,
  frame(`16 Compendium Preview · Exported shop — ${theme === "light" ? "Light" : "Dark"} · ${part}`, theme, 880, 713, "Gamemaster", open, { export: theme === "light" ? "W9SYUv" : "S7wWTs", part: node })
])));

const DEAL_PARTS = [["form", "ckj1c", dealForm], ["ended", "YPFms", dealEnded], ["bill", "uKlTo", dealBill], ["long", "X2JhqQ", dealLongName]];
const dealFrames = Object.fromEntries(["light", "dark"].flatMap(theme => DEAL_PARTS.map(([part, node, open]) => [
  `${theme === "light" ? "Q6UvA" : "pMFqj"}:${part}`,
  frame(`10 Deals — ${theme === "light" ? "Light" : "Dark"} · ${part}`, theme, 1484, 690, "Gamemaster", open, { export: theme === "light" ? "Q6UvA" : "pMFqj", part: node })
])));

export const FRAMES = {
  y6iNf: frame("01 Storefront — Light", "light", 920, 680, "Gamemaster", storefront),
  wvmqF: frame("01 Storefront — Dark", "dark", 920, 680, "Gamemaster", storefront),
  zie5W: frame("01 Storefront — Player (Light)", "light", 920, 680, "P1", storefrontPlayer),
  ChoNd: frame("01 Terms of Trade — Popover (Light)", "light", 340, 251, "Gamemaster", terms),
  S0ugn: frame("01 Terms of Trade — Popover (Dark)", "dark", 340, 251, "Gamemaster", terms),
  TGXBN: frame("02 Sell — Light", "light", 920, 680, "Gamemaster", sell),
  BZh1r: frame("02 Sell — Dark", "dark", 920, 680, "Gamemaster", sell),
  v8ap9: frame("03 Settings (GM) — Light", "light", 920, 760, "Gamemaster", settings),
  dpdpS: frame("03 Settings (GM) — Dark", "dark", 920, 760, "Gamemaster", settings),
  aaJcp: frame("03 Settings (GM) · Restock — Light", "light", 920, 760, "Gamemaster", restockTab),
  dVt0a: frame("03 Settings (GM) · Restock — Dark", "dark", 920, 760, "Gamemaster", restockTab),
  x9IX9: frame("04 Closed — Light", "light", 920, 680, "Gamemaster", closed),
  nnHdO: frame("04 Closed — Dark", "dark", 920, 680, "Gamemaster", closed),
  mRg3y: frame("05 Inn — Light", "light", 920, 680, "Gamemaster", inn),
  lvVv2: frame("05 Inn — Dark", "dark", 920, 680, "Gamemaster", inn),
  r7HIUl: frame("06 Storefront — Narrow (Light)", "light", 480, 780, "Gamemaster", storefront),
  grlFX: frame("06 Storefront — Narrow (Dark)", "dark", 480, 780, "Gamemaster", storefront),
  "n9I5aQ:gm": frame("07 Buyer Picker — Light · GM", "light", 656, 470, "Gamemaster", picker, { export: "n9I5aQ", part: "YA8h7" }),
  "n9I5aQ:player": frame("07 Buyer Picker — Light · Player", "light", 656, 470, "P1", picker, { export: "n9I5aQ", part: "V6UiM" }),
  "JNHkU:gm": frame("07 Buyer Picker — Dark · GM", "dark", 656, 470, "Gamemaster", picker, { export: "JNHkU", part: "YA8h7" }),
  "JNHkU:player": frame("07 Buyer Picker — Dark · Player", "dark", 656, 470, "P1", picker, { export: "JNHkU", part: "V6UiM" }),
  "z5RBkd:buy": frame("07 Trade Chat Card — Light · Purchase", "light", 672, 387, "Gamemaster", receiptBuy, { export: "z5RBkd", part: "h3s5G" }),
  "z5RBkd:sell": frame("07 Trade Chat Card — Light · Sale", "light", 672, 387, "Gamemaster", receiptSell, { export: "z5RBkd", part: "dZ2NI" }),
  "b4iPYc:buy": frame("07 Trade Chat Card — Dark · Purchase", "dark", 672, 387, "Gamemaster", receiptBuy, { export: "b4iPYc", part: "h3s5G" }),
  "b4iPYc:sell": frame("07 Trade Chat Card — Dark · Sale", "dark", 672, 387, "Gamemaster", receiptSell, { export: "b4iPYc", part: "dZ2NI" }),
  ...stateFrames,
  dYANz: frame("09 Settings (GM) · Won't buy — Light", "light", 920, 760, "Gamemaster", settingsAt("wontBuy")),
  c3RXO: frame("09 Settings (GM) · Won't buy — Dark", "dark", 920, 760, "Gamemaster", settingsAt("wontBuy")),
  S2swP: frame("09 Settings (GM) · Hours — Light", "light", 920, 760, "Gamemaster", settingsAt("hours")),
  tUujD: frame("09 Settings (GM) · Hours — Dark", "dark", 920, 760, "Gamemaster", settingsAt("hours")),
  mVjRf: frame("06 Storefront — Narrow · Bill open (Light)", "light", 480, 780, "Gamemaster", billOpen),
  x5BRLd: frame("06 Storefront — Narrow · Bill open (Dark)", "dark", 480, 780, "Gamemaster", billOpen),
  ...dealFrames,
  PV7Sf: frame("11 Sell — Narrow (Light)", "light", 480, 780, "Gamemaster", sellNarrow),
  NipLU: frame("11 Sell — Narrow (Dark)", "dark", 480, 780, "Gamemaster", sellNarrow),
  bXBEW: frame("11 Settings (GM) — Narrow (Light)", "light", 480, 780, "Gamemaster", settingsAt("terms", true, false)),
  G4W9Xw: frame("11 Settings (GM) — Narrow (Dark)", "dark", 480, 780, "Gamemaster", settingsAt("terms", true, false)),
  "euA99:sealed": frame("12 Sell Trade States — Light · sealed", "light", 694, 596, "Gamemaster", sellSealed, { export: "euA99", part: "o05Tqq" }),
  "kJkCg:sealed": frame("12 Sell Trade States — Dark · sealed", "dark", 694, 596, "Gamemaster", sellSealed, { export: "kJkCg", part: "o05Tqq" }),
  RRqQ7: frame("13 Settings (GM) · No world clock — Light", "light", 920, 760, "Gamemaster", noClockSettings),
  jajnz: frame("13 Settings (GM) · No world clock — Dark", "dark", 920, 760, "Gamemaster", noClockSettings),
  U0HcWc: frame("14 Settings (GM) · Till — Light", "light", 920, 760, "Gamemaster", tillSettings("finite")),
  SrMya: frame("14 Settings (GM) · Till — Dark", "dark", 920, 760, "Gamemaster", tillSettings("finite")),
  Yusa2: frame("14 Settings (GM) · Till, unlimited coin — Light", "light", 920, 760, "Gamemaster", tillSettings("unlimited")),
  VUNXW: frame("14 Settings (GM) · Till, unlimited coin — Dark", "dark", 920, 760, "Gamemaster", tillSettings("unlimited")),
  ...noClockFrames,
  IeGac: frame("15 Temple & Faith Store — Light", "light", 920, 760, "Gamemaster", temple),
  iczDO: frame("15 Temple & Faith Store — Dark", "dark", 920, 760, "Gamemaster", temple),
  pI7Yd: frame("15 Stable — Light", "light", 920, 760, "Gamemaster", stable),
  ldd9L: frame("15 Stable — Dark", "dark", 920, 760, "Gamemaster", stable),
  L4tb2b: frame("16 Compendium Preview — Light", "light", 920, 680, "Gamemaster", preview),
  ChCwP: frame("16 Compendium Preview — Dark", "dark", 920, 680, "Gamemaster", preview),
  Zm5HK: frame("16 Compendium Preview · Settings — Light", "light", 920, 760, "Gamemaster", previewSettings),
  SWg3z: frame("16 Compendium Preview · Settings — Dark", "dark", 920, 760, "Gamemaster", previewSettings),
  M9qII3: frame("17 Compendium Preview — Narrow (Light)", "light", 480, 780, "Gamemaster", preview),
  j7ja1: frame("17 Compendium Preview — Narrow (Dark)", "dark", 480, 780, "Gamemaster", preview),
  ...exportedFrames
};
