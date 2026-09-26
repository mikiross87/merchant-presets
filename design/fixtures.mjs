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
/* global game, Actor, CONFIG, setTimeout -- `setup` runs in the page */

/** The shop every frame draws, as the frames name it. */
export const SHOP = "Armourer & Blacksmith";

/**
 * Runs in the page as the GM (`design-check-run.mjs --setup`): puts the world into the frames'
 * shared state. It returns "reload" after switching the calendar, which only takes on a reload;
 * run it again then. Everything else it sets is idempotent, so it can run on any world it made.
 *
 * - the Harptos calendar, at 10:00 on the 14th of Mirtul ("mid-morning"); no automatic restock,
 *   so moving the clock never redraws the shelf;
 * - *Armourer & Blacksmith*: a fresh import of the Town smith, renamed, with the frames'
 *   description, 07:00-19:00, the world's list/half, a 212 gp till, and exactly the stock rows the
 *   Storefront draws (Longsword 7, Handaxe 11, Javelin 21 new, Breastplate 1 new, Chain Mail 4,
 *   Shield sold out, Smith's Tools 4) beside the drawn gear;
 * - Aria (P1's character) with 3 pp 47 gp 12 sp 30 cp, and Tomas, a character no one plays;
 * - the deals: Aria buying at −10% until the shop closes, Tomas selling at +10% with no end.
 */
export async function setup() {
  const MP = "merchant-presets";
  if (game.settings.get("dnd5e", "calendar") !== "harptos") {
    await game.settings.set("dnd5e", "calendar", "harptos");
    return "reload";
  }
  await game.settings.set(MP, "autoRestock", false);
  await game.settings.set(MP, "tradingHours", true);
  await game.settings.set(MP, "sellsAt", 100);
  await game.settings.set(MP, "buysAt", 50);

  // The 14th of Mirtul (month 4 of Harptos's twelve; days count from 0), 10:00.
  const cal = game.time.calendar;
  const now = cal.timeToComponents(game.time.worldTime);
  const at = cal.componentsToTime({ ...now, month: 4, dayOfMonth: 13, hour: 10, minute: 0, second: 0 });
  if (at !== game.time.worldTime) await game.time.advance(at - game.time.worldTime);

  const aria = game.actors.getName("Aria");
  await aria.update({ "system.currency": { pp: 3, gp: 47, ep: 0, sp: 12, cp: 30 } });
  const tomas = game.actors.getName("Tomas") ?? await Actor.create({ name: "Tomas", type: "character" });

  const name = "Armourer & Blacksmith";
  for (const a of game.actors.filter(a => a.name === name)) await a.delete();
  const pack = game.packs.get(`${MP}.merchants`);
  const entry = (await pack.getIndex()).getName("Armourer & Blacksmiths (Town)");
  const shop = await game.actors.importFromCompendium(pack, entry._id);
  for (let t = 0; t < 40 && !shop.flags[MP]?.shelf; t++) await new Promise(r => setTimeout(r, 500));

  const rows = { Longsword: [7], Handaxe: [11], Javelin: [21, true], Breastplate: [1, true], "Chain Mail": [4], Shield: [0], "Smith's Tools": [4] };
  const drawn = shop.items.filter(i => i.flags[MP]?.drawn);
  const armsOrTools = i => i.type === "weapon" || i.type === "tool" || (i.type === "equipment" && i.system.type?.value in (CONFIG.DND5E.armorTypes ?? {}));
  await shop.deleteEmbeddedDocuments("Item", drawn.filter(i => armsOrTools(i) && !(i.name in rows)).map(i => i.id));
  // The frame's rows first, in its order (the window lists the shelf by sort), then the gear.
  const order = Object.keys(rows);
  await shop.updateEmbeddedDocuments("Item", shop.items.filter(i => i.flags[MP]?.drawn).map(i => (i.name in rows
    ? { _id: i.id, sort: (order.indexOf(i.name) + 1) * 100, "system.quantity": rows[i.name][0], [`flags.${MP}.new`]: rows[i.name][1] === true }
    : { _id: i.id, sort: 10_000 + i.sort })));

  const day = cal.days.hoursPerDay * cal.days.minutesPerHour * cal.days.secondsPerMinute;
  const closes = Math.floor(game.time.worldTime / day) * day + (19 * cal.days.minutesPerHour + 1) * cal.days.secondsPerMinute;
  await shop.update({
    name,
    img: "icons/environment/settlement/blacksmith.webp",
    "ownership.default": 1,
    "system.currency": { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 },
    [`flags.${MP}.visibility`]: true,
    [`flags.${MP}.shop.description`]: "Hot, loud, and busy from before dawn. Blades and plate made and mended, and the only place in a small settlement that can shoe a horse and hammer out a helm.",
    [`flags.${MP}.shop.hours`]: { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } },
    [`flags.${MP}.shop.terms`]: { sellsAt: null, buysAt: null, categories: [] },
    [`flags.${MP}.shop.deals`]: [
      { actor: aria.uuid, name: "Aria", buy: -0.1, sell: null, note: "Saved the smith's daughter", ends: { at: closes, when: "close" } },
      { actor: tomas.uuid, name: "Tomas", buy: null, sell: 0.1, note: "Regular supplier of ore", ends: null }
    ]
  });
  return shop.id;
}

/**
 * An `open` for the shop window: the frame's theme on this client, Aria as the buyer, the window at
 * the frame's size on `tab`, and `then` (an in-page statement, `app` in scope) run after it renders.
 */
const openShop = ({ tab = "buy", then = "" } = {}) => `async ({ theme, width, height }) => {
  const ui = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
  ui.colorScheme = { applications: theme, interface: theme };
  await game.settings.set("core", "uiConfig", ui);
  const app = game.actors.getName(${JSON.stringify(SHOP)}).sheet;
  app._buyerUuid = game.actors.getName("Aria").uuid;
  await app.render({ force: true, position: { left: 20, top: 20, width, height } });
  app.changeTab(${JSON.stringify(tab)}, "primary");
  ${then}
  await new Promise(r => setTimeout(r, 800));
  return app.id;
}`;

const frame = (name, theme, width, height, user = "Gamemaster", open = null) => ({ name, theme, width, height, user, open });
const settings = openShop({ tab: "settings" });

export const FRAMES = {
  y6iNf: frame("01 Storefront — Light", "light", 920, 680),
  wvmqF: frame("01 Storefront — Dark", "dark", 920, 680),
  zie5W: frame("01 Storefront — Player (Light)", "light", 920, 680, "P1"),
  ChoNd: frame("01 Terms of Trade — Popover (Light)", "light", 340, 251),
  S0ugn: frame("01 Terms of Trade — Popover (Dark)", "dark", 340, 251),
  TGXBN: frame("02 Sell — Light", "light", 920, 680),
  BZh1r: frame("02 Sell — Dark", "dark", 920, 680),
  v8ap9: frame("03 Settings (GM) — Light", "light", 920, 760, "Gamemaster", settings),
  dpdpS: frame("03 Settings (GM) — Dark", "dark", 920, 760, "Gamemaster", settings),
  aaJcp: frame("03 Settings (GM) · Restock — Light", "light", 920, 760),
  dVt0a: frame("03 Settings (GM) · Restock — Dark", "dark", 920, 760),
  x9IX9: frame("04 Closed — Light", "light", 920, 680),
  nnHdO: frame("04 Closed — Dark", "dark", 920, 680),
  mRg3y: frame("05 Inn — Light", "light", 920, 680),
  lvVv2: frame("05 Inn — Dark", "dark", 920, 680),
  r7HIUl: frame("06 Storefront — Narrow (Light)", "light", 480, 780),
  grlFX: frame("06 Storefront — Narrow (Dark)", "dark", 480, 780),
  n9I5aQ: frame("07 Buyer Picker — Light", "light", 656, 430),
  JNHkU: frame("07 Buyer Picker — Dark", "dark", 656, 430),
  z5RBkd: frame("07 Trade Chat Card — Light", "light", 688, 387),
  b4iPYc: frame("07 Trade Chat Card — Dark", "dark", 688, 387),
  WNYhA: frame("08 Trade States — Light", "light", 1900, 755),
  mWJYP: frame("08 Trade States — Dark", "dark", 1900, 755)
};
