/**
 * The shop window's own behaviour (#103), driven through its registered actions under plain Node.
 * The base class stands in for V14's ActorSheetV2 only where the window relies on it: the
 * `isEditable` gate `DocumentSheetV2#_onRender` applies (document-sheet.mjs: a user below
 * `editPermission` gets every form control disabled), `tabGroups` and `render`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SHOP_DEFAULTS } from "../scripts/schema.mjs";

const OWNERSHIP = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };

class ActorSheetV2 {
  static DEFAULT_OPTIONS = { viewPermission: OWNERSHIP.LIMITED, editPermission: OWNERSHIP.OWNER };
  constructor(options = {}) {
    this.options = { ...ActorSheetV2.DEFAULT_OPTIONS, ...this.constructor.DEFAULT_OPTIONS, ...options };
    this.document = options.document;
    this.tabGroups = { primary: "buy" };
    this.renders = 0;
    this.disabled = false;
    globalThis.foundry.applications.instances.set(Symbol("app"), this);
  }
  get isEditable() { return this.document.testUserPermission(globalThis.game.user, this.options.editPermission); }
  _toggleDisabled(disabled) { this.disabled = disabled; }
  async _onRender() { if (!this.isEditable) this._toggleDisabled(true); }
  render() { this.renders++; }
  async _prepareContext() { return {}; }
}

const CURRENCIES = {
  pp: { conversion: 0.1, abbreviation: "pp" }, gp: { conversion: 1, abbreviation: "gp" },
  ep: { conversion: 2, abbreviation: "ep" }, sp: { conversion: 10, abbreviation: "sp" },
  cp: { conversion: 100, abbreviation: "cp" }
};

globalThis.Actor = class {};
globalThis.CONFIG = { DND5E: { currencies: CURRENCIES }, Item: { typeLabels: {} }, Actor: {} };
/** How the stubbed confirmation dialog answers. */
const dialog = { answer: true, asked: 0 };

/** The world clock's hour; noon unless a test moves it. */
const clock = { hour: 12 };
/** Hook handlers the window registers, by event name. */
const hooks = {};
globalThis.Hooks = { on: (name, fn) => { (hooks[name] ??= []).push(fn); } };
const fire = (name, ...args) => (hooks[name] ?? []).forEach(fn => fn(...args));
/** Template helpers the window registers, by name. */
const helpers = {};
globalThis.Handlebars = {
  registerHelper: (name, fn) => { helpers[name] = fn; },
  SafeString: class { constructor(text) { this.text = text; } toString() { return this.text; } }
};

globalThis.foundry = {
  applications: {
    sheets: { ActorSheetV2 },
    api: {
      HandlebarsApplicationMixin: Base => Base,
      // Answers every confirmation with `dialog.answer`, and counts the asks.
      DialogV2: { confirm: async () => { dialog.asked++; return dialog.answer; } }
    },
    apps: { DocumentSheetConfig: { registerSheet() {} } },
    instances: new Map()
  },
  utils: { randomID: () => "trade00000000001", cleanHTML: html => `clean:${html}` }
};
globalThis.ui = { notifications: { warn() {} } };
// A GM's window looks up the shop's preset and stock table (#110); nothing resolves unless a test says so.
globalThis.fromUuid = async () => null;
const api = {};
globalThis.game = {
  user: { isGM: false, character: null },
  // A GM is at the table unless a test says otherwise.
  users: { activeGM: { id: "gm", isGM: true } },
  modules: { get: () => ({ api }) },
  settings: { values: { merchantPurse: "finite", tradingHours: true, stockMode: "finite", followClock: "always" }, get(_module, key) { return this.values[key]; } },
  actors: [],
  i18n: { localize: key => key },
  // Noon on a 24-hour day: inside the shop's default 07:00-19:00.
  time: {
    worldTime: 0,
    calendar: {
      days: { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 },
      timeToComponents: () => ({ hour: clock.hour, minute: 0 }),
      format: time => `t${time}`
    }
  }
};

const { default: ShopSheet } = await import("../scripts/shop-sheet.mjs");
const actions = ShopSheet.DEFAULT_OPTIONS.actions;

/** An embedded collection: an array that also answers `get(id)`, like Foundry's. */
function collection(docs) {
  return Object.assign(docs, { get: id => docs.find(d => d.id === id) });
}

function item(id, { quantity = 1, price = { value: 1, denomination: "gp" }, flags = {}, type = "loot" } = {}) {
  const data = { _id: id, name: id, type, img: "", system: { quantity, price }, flags };
  // Like Document#toObject: the item's current data, so a test's later edits show through.
  return {
    id, ...data,
    toObject() {
      return structuredClone(Object.fromEntries(Object.entries(this).filter(([k, v]) => k !== "id" && typeof v !== "function")));
    }
  };
}

/** A stub actor; only a shop (`shop: true`, the default for the id "shop") carries a shop config. */
function actor(id, items, { permission = OWNERSHIP.OWNER, currency = { gp: 100 }, shop = id === "shop" } = {}) {
  return {
    id, uuid: `Actor.${id}`, name: id, type: "npc", flags: shop ? { "merchant-presets": { shop: structuredClone(SHOP_DEFAULTS) } } : {},
    system: { currency },
    items: collection(items),
    // Foundry takes a level's number or its name ("OWNER").
    testUserPermission: (_user, level) => permission >= (OWNERSHIP[level] ?? level)
  };
}

/** The Sell tab's rows, across its category sections. */
const packRows = sell => sell.sections.flatMap(s => s.rows);

/** A buyer's purse, as the bill reads it: [denomination, count] pairs. */
const coins = list => list.map(c => [c.denomination, c.count]);

/** A window on a shop selling `shopItems`, opened by a player who owns `buyer` and has `permission` on the shop. */

function openShop({ shopItems = [item("rope")], buyerItems = [], permission = OWNERSHIP.LIMITED } = {}) {
  const shop = actor("shop", shopItems, { permission });
  const buyer = actor("hero", buyerItems);
  globalThis.game.actors = [shop, buyer];
  globalThis.game.user.character = buyer;
  const sheet = new ShopSheet({ document: shop });
  return { sheet, shop, buyer };
}

/** Calls a registered action the way ApplicationV2 does: `this` is the sheet. */
const act = (sheet, name, dataset = {}) => actions[name].call(sheet, {}, { dataset });

test("a player with only Limited on the shop keeps live trade controls", async () => {
  const { sheet } = openShop({ permission: OWNERSHIP.LIMITED });
  await sheet._onRender({}, {});
  assert.equal(sheet.disabled, false);
});

test("a sale can't put more on the bill than the seller owns", () => {
  const { sheet } = openShop({ buyerItems: [item("gem", { quantity: 2 })] });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  act(sheet, "stepLine", { itemId: "gem", delta: "1" });
  act(sheet, "stepLine", { itemId: "gem", delta: "1" });
  assert.equal(sheet._baskets.sell.get("gem"), 2);
});

test("the request names the shop and the buyer, and the bundle price each line was shown at", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5, price: { value: 1, denomination: "gp" } })] });
  act(sheet, "addLine", { itemId: "rope" });
  let sent;
  api.trade = async request => { sent = request; return { status: "sealed" }; };
  await act(sheet, "seal");
  assert.deepEqual(sent, {
    tradeId: "trade00000000001", kind: "buy", shopUuid: "Actor.shop", buyerUuid: "Actor.hero",
    lines: [{ itemId: "rope", quantity: 1, expectedBundlePriceCp: 100 }]
  });
});

test("a line whose item has gone is dropped before sealing, not sent", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("lamp", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  act(sheet, "addLine", { itemId: "lamp" });
  shop.items.splice(shop.items.findIndex(i => i.id === "lamp"), 1);
  let sent;
  api.trade = async request => { sent = request; return { status: "sealed" }; };
  await act(sheet, "seal");
  assert.deepEqual(sent.lines.map(l => l.itemId), ["rope"]);
  assert.equal(sheet._baskets.buy.has("lamp"), false);
});

test("a second seal while one is in flight sends nothing", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  const pending = [];
  api.trade = () => new Promise(resolve => pending.push(resolve));
  const seals = [act(sheet, "seal"), act(sheet, "seal")];
  await new Promise(setImmediate);
  const calls = pending.length;
  for (const resolve of pending) resolve({ status: "sealed" });
  await Promise.all(seals);
  assert.equal(calls, 1);
});

test("stock-changed strikes the lines whose price moved", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("lamp", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  act(sheet, "addLine", { itemId: "lamp" });
  api.trade = async () => ({
    status: "refused", reason: "stock-changed",
    lines: [{ itemId: "rope", quantity: 1, bundlePriceCp: 100 }, { itemId: "lamp", quantity: 1, bundlePriceCp: 150 }]
  });
  await act(sheet, "seal");
  assert.equal(sheet._tradeState.buy, "stock-changed");
  assert.deepEqual([...sheet._struck.buy], ["lamp"]);
});

test("an unanswered trade keeps its tradeId until it's answered, edits included, so it can't land twice", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  const ids = [];
  let n = 0;
  globalThis.foundry.utils.randomID = () => `trade${String(++n).padStart(11, "0")}`;
  api.trade = async request => { ids.push(request.tradeId); return { status: "unconfirmed" }; };
  await act(sheet, "seal");
  await act(sheet, "seal");
  act(sheet, "stepLine", { itemId: "rope", delta: "1" });
  api.trade = async request => { ids.push(request.tradeId); return { status: "refused", reason: "wont-buy" }; };
  await act(sheet, "seal");
  act(sheet, "stepLine", { itemId: "rope", delta: "-1" });
  await act(sheet, "seal");
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.notEqual(ids[2], ids[3]);
});

test("the Sell bill's purse-after is the seller's purse plus the sale, not the till's", async () => {
  const { sheet } = openShop({ buyerItems: [item("gem", { price: { value: 14, denomination: "gp" } })] });
  sheet.document.system.currency = { gp: 200 };
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(coins(sell.basket.afterCoins), [["gp", 107]]);
});

test("adding to a sealed bill starts a new one, so the sealed lines aren't traded again", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("lamp", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed" });
  await act(sheet, "seal");
  act(sheet, "addLine", { itemId: "lamp" });
  assert.deepEqual([...sheet._baskets.buy.keys()], ["lamp"]);
});

test("changing the buyer drops the last buyer's unanswered trade id", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const other = actor("borin", []);
  globalThis.game.actors.push(other);
  act(sheet, "addLine", { itemId: "rope" });
  const ids = [];
  let n = 100;
  globalThis.foundry.utils.randomID = () => `trade${String(++n).padStart(11, "0")}`;
  api.trade = async request => { ids.push(request.tradeId); return { status: "unconfirmed" }; };
  await act(sheet, "seal");
  act(sheet, "pickBuyer", { actorUuid: other.uuid });
  await act(sheet, "seal");
  assert.notEqual(ids[0], ids[1]);
});

test("a sealed buy stays sealed on the bill after the purse it emptied is re-read", async () => {
  const { sheet, buyer } = openShop({ shopItems: [item("sword", { quantity: 5, price: { value: 15, denomination: "gp" } })] });
  buyer.system.currency = { gp: 20 };
  act(sheet, "addLine", { itemId: "sword" });
  api.trade = async () => { buyer.system.currency = { gp: 5 }; return { status: "sealed" }; };
  await act(sheet, "seal");
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "sealed");
  assert.deepEqual(buy.basket.lines.map(l => [l.itemId, l.quantity]), [["sword", 1]]);
});

test("a sealed sale of a whole stack keeps its bill once the item has left the seller", async () => {
  const { sheet, buyer } = openShop({ buyerItems: [item("gem", { quantity: 2 })] });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  act(sheet, "stepLine", { itemId: "gem", delta: "1" });
  api.trade = async () => { buyer.items.splice(0); return { status: "sealed" }; };
  await act(sheet, "seal");
  const { sell } = await sheet._prepareContext({});
  assert.equal(sell.seal.state, "sealed");
  assert.deepEqual(sell.basket.lines.map(l => [l.itemId, l.quantity]), [["gem", 2]]);
});

test("the basket can't change while a seal is waiting for its answer", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("lamp", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  let finish;
  api.trade = () => new Promise(resolve => { finish = resolve; });
  const sealing = act(sheet, "seal");
  await new Promise(setImmediate);
  const id = sheet._tradeId.buy;
  act(sheet, "addLine", { itemId: "lamp" });
  act(sheet, "stepLine", { itemId: "rope", delta: "1" });
  assert.deepEqual([...sheet._baskets.buy], [["rope", 1]]);
  assert.equal(sheet._tradeId.buy, id);
  finish({ status: "sealed" });
  await sealing;
});

test("changing the buyer after a sealed buy doesn't bring its lines back as a new bill", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const other = actor("borin", []);
  globalThis.game.actors.push(other);
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed" });
  await act(sheet, "seal");
  act(sheet, "pickBuyer", { actorUuid: other.uuid });
  assert.equal(sheet._baskets.buy.size, 0);
});

test("with unlimited merchant coin an empty till still buys", async () => {
  globalThis.game.settings.values.merchantPurse = "unlimited";
  try {
    const { sheet } = openShop({ buyerItems: [item("gem", { price: { value: 7, denomination: "gp" } })] });
    sheet.document.system.currency = {};
    sheet.tabGroups.primary = "sell";
    act(sheet, "addLine", { itemId: "gem" });
    const { sell } = await sheet._prepareContext({});
    assert.notEqual(sell.seal.state, "till-short");
    assert.equal(sell.seal.disabled, false);
  } finally {
    globalThis.game.settings.values.merchantPurse = "finite";
  }
});

test("a buy refused till-short names what the till holds (#154 review)", async () => {
  await withLabels(async () => {
    const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
    sheet.document.system.currency = { gp: 3 };
    act(sheet, "addLine", { itemId: "rope" });
    api.trade = async () => ({ status: "refused", reason: "till-short" });
    await act(sheet, "seal");
    const { buy } = await sheet._prepareContext({});
    assert.equal(buy.slip.notice.text, "TillShortBuyNotice(3 gp)");
  });
});

test("a refusal on live data stays on the bill until that data changes", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "refused", reason: "till-short" });
  await act(sheet, "seal");
  assert.equal((await sheet._prepareContext({})).buy.seal.state, "till-short");
  fire("updateActor", sheet.document);
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "idle");
  assert.equal(buy.seal.disabled, false);
});

test("with trading hours off the shop is open around the clock", async () => {
  globalThis.game.settings.values.tradingHours = false;
  clock.hour = 22;
  try {
    const { sheet } = openShop();
    const context = await sheet._prepareContext({});
    assert.equal(context.open, true);
  } finally {
    globalThis.game.settings.values.tradingHours = true;
    clock.hour = 12;
  }
});

test("where shops don't follow the world clock the window keeps no time: open at 22:00, no hours chip, fresh chip, New or bill date (#149)", async () => {
  globalThis.game.settings.values.followClock = "never";
  clock.hour = 22;
  const before = globalThis.game.time.worldTime;
  try {
    const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5, flags: { "merchant-presets": { newAt: 8 * 3600, drawn: true } } })] });
    shop.flags["merchant-presets"].restockedAt = 8 * 3600;
    globalThis.game.time.worldTime = 12 * 3600;
    const { open, header, buy } = await sheet._prepareContext({});
    assert.equal(open, true);
    assert.equal(header.hoursChip, false);
    assert.equal(header.fresh, false);
    assert.equal(buy.sections[0].rows[0].isNew, false);
    assert.equal(buy.basket.dateLabel, "");
  } finally {
    globalThis.game.settings.values.followClock = "always";
    globalThis.game.time.worldTime = before;
    clock.hour = 12;
  }
});

test("the window re-renders when the clock moves or its buyer's purse changes, not for other actors", () => {
  const { sheet, buyer } = openShop();
  const stranger = actor("stranger", []);
  const before = sheet.renders;
  fire("updateWorldTime", 3600);
  fire("updateActor", buyer);
  fire("updateActor", stranger);
  assert.equal(sheet.renders - before, 2);
});

test("the window re-renders when its buyer's items change, not another actor's", () => {
  const { sheet, buyer } = openShop();
  const stranger = actor("stranger", []);
  const before = sheet.renders;
  fire("createItem", { parent: buyer });
  fire("updateItem", { parent: buyer });
  fire("deleteItem", { parent: buyer });
  fire("createItem", { parent: stranger });
  assert.equal(sheet.renders - before, 3);
});

test("a shelf line with broken stock flags is left off the Buy tab instead of breaking the window", async () => {
  const broken = item("broken", { flags: { "merchant-presets": { stock: { bundle: 0 } } } });
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 }), broken] });
  const { buy } = await sheet._prepareContext({});
  assert.deepEqual(buy.sections.flatMap(s => s.rows.map(r => r.id)), ["rope"]);
});

test("a shop whose own config is broken still opens", async () => {
  const { sheet } = openShop();
  sheet.document.flags["merchant-presets"].shop = { version: "nope" };
  await assert.doesNotReject(sheet._prepareContext({}));
});

test("the Buy tab can say what the till holds, for a buy the till can't make change for", async () => {
  const { sheet } = openShop();
  sheet.document.system.currency = { gp: 3 };
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.tillText, "3 gp");
});

test("with no character to trade as, the seal says so instead of blaming the purse", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  globalThis.game.user.character = null;
  globalThis.game.actors = [sheet.document];
  sheet._buyerUuid = null;
  act(sheet, "addLine", { itemId: "rope" });
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "no-buyer");
  assert.equal(buy.seal.disabled, true);
});

test("under the world's unlimited stock mode a line without its own setting never runs out", () => {
  globalThis.game.settings.values.stockMode = "unlimited";
  try {
    const { sheet } = openShop({ shopItems: [item("rope", { quantity: 1 })] });
    act(sheet, "addLine", { itemId: "rope" });
    act(sheet, "addLine", { itemId: "rope" });
    assert.equal(sheet._baskets.buy.get("rope"), 2);
  } finally {
    globalThis.game.settings.values.stockMode = "finite";
  }
});

test("the NPC sheet button brings an open dnd5e sheet forward rather than opening a second", () => {
  const { sheet, shop } = openShop();
  shop.apps = {};
  let built = 0, rendered = 0;
  class NPCSheet {
    constructor({ document }) { built++; this.id = "npc-sheet"; document.apps[this.id] = this; }
    render() { rendered++; }
  }
  globalThis.CONFIG.Actor.sheetClasses = { npc: { "dnd5e.NPCActorSheet": { id: "dnd5e.NPCActorSheet", cls: NPCSheet } } };
  act(sheet, "npcSheet");
  act(sheet, "npcSheet");
  assert.equal(built, 1);
  assert.equal(rendered, 2);
});

test("with trading hours off the header reads always open, not the shop's hours", async () => {
  globalThis.game.settings.values.tradingHours = false;
  try {
    const { sheet } = openShop();
    const { header } = await sheet._prepareContext({});
    assert.equal(header.openLabel, "MERCHANT_PRESETS.Shop.AlwaysOpen");
  } finally {
    globalThis.game.settings.values.tradingHours = true;
  }
});

test("a category that empties falls back to all goods rather than an empty tab", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  sheet._activeCategory = "potion";
  const { buy } = await sheet._prepareContext({});
  assert.deepEqual(buy.sections.flatMap(s => s.rows.map(r => r.id)), ["rope"]);
  assert.equal(sheet._activeCategory, "all");
});

test("a buyer that drops out of reach clears the last buyer's unanswered trade", async () => {
  const { sheet, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const other = actor("borin", []);
  globalThis.game.actors.push(other);
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "unconfirmed" });
  await act(sheet, "seal");
  assert.notEqual(sheet._tradeId.buy, null);
  globalThis.game.actors.splice(globalThis.game.actors.indexOf(buyer), 1);
  globalThis.game.user.character = null;
  await sheet._prepareContext({});
  assert.equal(sheet._buyerUuid, other.uuid);
  assert.equal(sheet._tradeId.buy, null);
});

test("a basket asking for more than is left is cut to what's left", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("torch", { quantity: 6 })] });
  for (let i = 0; i < 5; i++) act(sheet, "addLine", { itemId: "torch" });
  shop.items.get("torch").system.quantity = 1;
  await sheet._prepareContext({});
  assert.equal(sheet._baskets.buy.get("torch"), 1);
});

test("the Sell tab lists goods, not the seller's spells and features", async () => {
  const { sheet } = openShop({ buyerItems: [item("gem"), item("fireball", { type: "spell" }), item("rage", { type: "feat" })] });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(packRows(sell).map(r => r.id), ["gem"]);
});

test("a basket the shelf changed under is reset like any other edit", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("torch", { quantity: 6 })] });
  for (let i = 0; i < 5; i++) act(sheet, "addLine", { itemId: "torch" });
  api.trade = async () => ({ status: "refused", reason: "out-of-stock" });
  await act(sheet, "seal");
  shop.items.get("torch").system.quantity = 2;
  const { buy } = await sheet._prepareContext({});
  assert.equal(sheet._baskets.buy.get("torch"), 2);
  assert.equal(buy.seal.state, "idle");
});

test("a sale starts at the fewest that are worth a coin", () => {
  const { sheet } = openShop({ buyerItems: [item("chalk", { quantity: 5, price: { value: 1, denomination: "cp" } })] });
  sheet.tabGroups.primary = "sell";
  return sheet._prepareContext({}).then(() => {
    act(sheet, "addLine", { itemId: "chalk" });
    assert.equal(sheet._baskets.sell.get("chalk"), 2);
    act(sheet, "stepLine", { itemId: "chalk", delta: "-1" });
    assert.equal(sheet._baskets.sell.has("chalk"), false);
  });
});

test("an empty purse reads as no coin, not as worthless", async () => {
  const { sheet, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  buyer.system.currency = { gp: 1 };
  act(sheet, "addLine", { itemId: "rope" });
  const { buyerPurse, buy } = await sheet._prepareContext({});
  assert.deepEqual(coins(buyerPurse), [["gp", 1]]);
  assert.deepEqual(coins(buy.basket.afterCoins), [["gp", 0]]);
});

test("an unanswered trade that landed and moved the shelf keeps its id through the prune", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("lantern", { quantity: 1 }), item("ration", { quantity: 20 })] });
  act(sheet, "addLine", { itemId: "lantern" });
  act(sheet, "addLine", { itemId: "ration" });
  api.trade = async () => {
    shop.items.splice(shop.items.findIndex(i => i.id === "lantern"), 1);
    return { status: "unconfirmed" };
  };
  await act(sheet, "seal");
  const id = sheet._tradeId.buy;
  const { buy } = await sheet._prepareContext({});
  assert.equal(sheet._tradeId.buy, id);
  assert.equal(buy.seal.state, "no-gm");
});

test("a sealed answer to a resent trade stamps what the GM carried out, not the edited bill", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("arrows", { quantity: 10 }), item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "arrows" });
  api.trade = async () => {
    shop.items.splice(shop.items.findIndex(i => i.id === "arrows"), 1);
    return { status: "unconfirmed" };
  };
  await act(sheet, "seal");
  await sheet._prepareContext({});
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed", lines: [{ itemId: "arrows", quantity: 1, lineTotalCp: 100 }] });
  await act(sheet, "seal");
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "sealed");
  assert.deepEqual(buy.basket.lines.map(l => [l.itemId, l.name, l.quantity]), [["arrows", "arrows", 1]]);
  assert.deepEqual([...sheet._baskets.buy.keys()], ["rope"]);
});

test("a buyer lost while a seal is out leaves the bill alone until the answer", async () => {
  const { sheet, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  globalThis.game.actors.push(actor("borin", []));
  act(sheet, "addLine", { itemId: "rope" });
  let finish;
  api.trade = () => new Promise(resolve => { finish = resolve; });
  const sealing = act(sheet, "seal");
  await new Promise(setImmediate);
  globalThis.game.actors.splice(globalThis.game.actors.indexOf(buyer), 1);
  globalThis.game.user.character = null;
  await sheet._prepareContext({});
  assert.equal(sheet._tradeState.buy, "sealing");
  finish({ status: "sealed" });
  await sealing;
});

test("keep shopping leaves lines the sealed trade never carried on the bill", async () => {
  const { sheet } = openShop({ shopItems: [item("arrows", { quantity: 10 }), item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "arrows" });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed", lines: [{ itemId: "arrows", quantity: 1, lineTotalCp: 100 }] });
  await act(sheet, "seal");
  act(sheet, "keepShopping");
  assert.deepEqual([...sheet._baskets.buy], [["rope", 1]]);
});

test("a step that changes nothing leaves the stamped bill alone", async () => {
  const { sheet } = openShop({ shopItems: [item("lamp", { quantity: 1 }), item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed" });
  await act(sheet, "seal");
  act(sheet, "addLine", { itemId: "lamp" });
  act(sheet, "addLine", { itemId: "lamp" });
  assert.deepEqual([...sheet._baskets.buy], [["lamp", 1]]);
  sheet._tradeState.buy = "stock-changed";
  sheet._struck.buy.add("lamp");
  act(sheet, "addLine", { itemId: "lamp" });
  assert.equal(sheet._tradeState.buy, "stock-changed");
  assert.deepEqual([...sheet._struck.buy], ["lamp"]);
});

test("a GM with no character of their own buys as a player character, not the first actor", () => {
  const monster = actor("goblin", []);
  const pc = Object.assign(actor("aria", []), { type: "character" });
  const shop = actor("shop", [item("rope")]);
  globalThis.game.actors = [monster, shop, pc];
  globalThis.game.user.character = null;
  const sheet = new ShopSheet({ document: shop });
  sheet._buyerUuid = null;
  return sheet._prepareContext({}).then(() => assert.equal(sheet._buyerUuid, pc.uuid));
});

test("a line the GM hides after it went on the bill leaves the bill too", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("lamp", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  act(sheet, "addLine", { itemId: "lamp" });
  shop.items.get("lamp").flags = { "merchant-presets": { stock: { hidden: true } } };
  const { buy } = await sheet._prepareContext({});
  assert.deepEqual([...sheet._baskets.buy.keys()], ["rope"]);
  assert.deepEqual(buy.basket.lines.map(l => l.itemId), ["rope"]);
});

test("a sale the shop has stopped taking leaves the bill", async () => {
  const { sheet } = openShop({ buyerItems: [item("gem"), item("bread", { type: "consumable" })] });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  act(sheet, "addLine", { itemId: "bread" });
  sheet.document.flags["merchant-presets"].shop.wontBuy.types = ["consumable"];
  await sheet._prepareContext({});
  assert.deepEqual([...sheet._baskets.sell.keys()], ["gem"]);
});

test("a sale matching a broken shelf line reads as refused, as the engine refuses it", async () => {
  const broken = item("gem", { flags: { "merchant-presets": { stock: { bundle: 0 } } } });
  const { sheet } = openShop({ shopItems: [broken], buyerItems: [item("gem")] });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(packRows(sell).filter(r => !r.refusal).map(r => r.id), []);
  assert.deepEqual(packRows(sell).filter(r => r.refusal).map(r => r.id), ["gem"]);
});

test("selling an equipped or packed item asks first, and a no leaves it off the bill", async () => {
  const worn = item("armour");
  worn.system.equipped = true;
  const packed = item("potion");
  packed.system.container = "bag";
  const { sheet } = openShop({ buyerItems: [worn, packed, item("gem")] });
  sheet.tabGroups.primary = "sell";
  dialog.asked = 0;
  dialog.answer = false;
  await act(sheet, "addLine", { itemId: "armour" });
  await act(sheet, "addLine", { itemId: "potion" });
  await act(sheet, "addLine", { itemId: "gem" });
  assert.equal(dialog.asked, 2);
  assert.deepEqual([...sheet._baskets.sell.keys()], ["gem"]);
  dialog.answer = true;
  await act(sheet, "addLine", { itemId: "armour" });
  await act(sheet, "addLine", { itemId: "armour" });
  assert.equal(dialog.asked, 3, "asked once, not again for the next step");
  assert.equal(sheet._baskets.sell.has("armour"), true);
});

test("the header purse shows the coins the character holds, not a re-split", async () => {
  const { sheet, buyer } = openShop();
  buyer.system.currency = { pp: 0, gp: 150, ep: 0, sp: 30, cp: 0 };
  const { buyerPurse } = await sheet._prepareContext({});
  assert.deepEqual(coins(buyerPurse), [["gp", 150], ["sp", 30]]);
});

test("the basket can't change once a seal went out while the sale question was open", async () => {
  const worn = item("armour");
  worn.system.equipped = true;
  const { sheet } = openShop({ buyerItems: [worn, item("gem")] });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  let answer;
  const original = globalThis.foundry.applications.api.DialogV2.confirm;
  globalThis.foundry.applications.api.DialogV2.confirm = () => new Promise(resolve => { answer = resolve; });
  try {
    const asking = act(sheet, "addLine", { itemId: "armour" });
    let finish;
    api.trade = () => new Promise(resolve => { finish = resolve; });
    const sealing = act(sheet, "seal");
    await new Promise(setImmediate);
    answer(true);
    await asking;
    assert.equal(sheet._tradeState.sell, "sealing");
    assert.equal(sheet._baskets.sell.has("armour"), false);
    finish({ status: "sealed" });
    await sealing;
  } finally {
    globalThis.foundry.applications.api.DialogV2.confirm = original;
  }
});

test("a sealed answer takes off only the quantity it carried", async () => {
  const { sheet } = openShop({ shopItems: [item("arrows", { quantity: 40 })] });
  act(sheet, "addLine", { itemId: "arrows" });
  act(sheet, "addLine", { itemId: "arrows" });
  api.trade = async () => ({ status: "sealed", lines: [{ itemId: "arrows", quantity: 1, lineTotalCp: 100 }] });
  await act(sheet, "seal");
  assert.deepEqual([...sheet._baskets.buy], [["arrows", 1]]);
});

test("an assigned character the player doesn't own isn't who they trade as", async () => {
  const { sheet, buyer } = openShop();
  const observed = Object.assign(actor("ward", [], { permission: OWNERSHIP.OBSERVER }), { type: "character" });
  globalThis.game.actors.push(observed);
  globalThis.game.user.character = observed;
  sheet._buyerUuid = null;
  await sheet._prepareContext({});
  assert.equal(sheet._buyerUuid, buyer.uuid);
});

test("a container holding shopkeeper gear can't be sold, as the engine refuses it", async () => {
  const bag = item("bag", { type: "container" });
  const tongs = item("tongs", { flags: { "merchant-presets": { kind: "gear" } } });
  tongs.system.container = "bag";
  const { sheet } = openShop({ buyerItems: [bag, tongs] });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(packRows(sell).filter(r => !r.refusal).map(r => r.id), []);
});

test("picking a buyer closes the picker before the re-render could restore it", () => {
  const { sheet } = openShop();
  const other = actor("borin", []);
  globalThis.game.actors.push(other);
  const picker = { open: true, hidePopover() { this.open = false; } };
  sheet.element = { querySelector: selector => (selector === ".buyer-picker" ? picker : null) };
  act(sheet, "pickBuyer", { actorUuid: other.uuid });
  assert.equal(picker.open, false);
});

test("the search box's focus is read from its own window's document, popped out or not", async () => {
  const { sheet } = openShop();
  const popout = { activeElement: null };
  const search = { value: "ar", selectionStart: 2, ownerDocument: popout };
  popout.activeElement = search;
  sheet.element = { querySelector: selector => (selector === ".buyer-search" ? search : null) };
  await sheet._preRender({}, {});
  assert.equal(sheet._searchFocus, 2);
});

test("the buyer search hides a group's heading once it filters out everyone under it", async () => {
  const { sheet } = openShop();
  const node = (cls, name) => ({
    classList: { contains: c => c === cls }, hidden: false,
    querySelector: selector => (selector === ".buyer-entry-name" ? { textContent: name } : null)
  });
  // The GM's picker as the template lays it out: each heading, then its entries, as siblings.
  const picker = [
    node("mp-picker-group"), node("buyer-entry", "Aria"), node("buyer-entry", "Borin"),
    node("mp-picker-group"), node("buyer-entry", "Goblin"), node("buyer-entry", "Wolf")
  ];
  picker.forEach((n, i) => { n.nextElementSibling = picker[i + 1] ?? null; });
  const listeners = {};
  const search = { value: "", addEventListener: (type, fn) => { listeners[type] = fn; }, focus() {}, setSelectionRange() {} };
  sheet.element = {
    querySelector: selector => (selector === ".buyer-search" ? search : null),
    querySelectorAll: selector => ({
      ".buyer-picker .buyer-entry": picker.filter(n => n.classList.contains("buyer-entry")),
      ".buyer-picker .mp-picker-group": picker.filter(n => n.classList.contains("mp-picker-group"))
    })[selector] ?? []
  };
  await sheet._onRender({}, {});
  search.value = "ar";
  listeners.input();
  assert.deepEqual(picker.map(n => n.hidden), [false, false, true, true, true, true]);
  search.value = "";
  listeners.input();
  assert.deepEqual(picker.map(n => n.hidden), [false, false, false, false, false, false]);
});

test("the shop description is cleaned before it's put in the page", async () => {
  const { sheet } = openShop();
  sheet.document.flags["merchant-presets"].shop.description = "<img src=x onerror=alert(1)>";
  const { header } = await sheet._prepareContext({});
  assert.equal(header.description, "clean:<img src=x onerror=alert(1)>");
});

test("on an endless line, a buy starts at the fewest worth a coin rather than dropping", async () => {
  const candle = item("candle", { quantity: 0, price: { value: 1, denomination: "cp" }, flags: { "merchant-presets": { stock: { infinite: true, category: "cheap" } } } });
  const { sheet } = openShop({ shopItems: [candle] });
  sheet.document.flags["merchant-presets"].shop.terms.categories = [{ category: "cheap", sellsAt: 0.5, buysAt: 0.25 }];
  await sheet._prepareContext({});
  act(sheet, "addLine", { itemId: "candle" });
  assert.equal(sheet._baskets.buy.get("candle"), 2);
});

test("a bundled line's bill shows the bundle's price, not a unit price floored to nothing", async () => {
  const bullets = item("bullets", { quantity: 40, price: { value: 4, denomination: "cp" }, flags: { "merchant-presets": { stock: { bundle: 20 } } } });
  const { sheet } = openShop({ shopItems: [bullets] });
  act(sheet, "addLine", { itemId: "bullets" });
  const { buy } = await sheet._prepareContext({});
  const [line] = buy.basket.lines;
  assert.deepEqual(coins(line.unitCoins), [["cp", 4]]);
  assert.equal(line.bundle, 20);
});

test("under unlimited merchant coin the Sell tab doesn't say the till caps a sale", async () => {
  globalThis.game.settings.values.merchantPurse = "unlimited";
  try {
    const { sheet } = openShop();
    const { sell } = await sheet._prepareContext({});
    assert.equal(sell.tillCapsSales, false);
  } finally {
    globalThis.game.settings.values.merchantPurse = "finite";
  }
});

test("a seal that lands after closing still shows its stamp, not the closed card", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed" });
  await act(sheet, "seal");
  clock.hour = 22;
  try {
    const { buy } = await sheet._prepareContext({});
    assert.equal(buy.showClosed, false);
    assert.equal(buy.seal.state, "sealed");
  } finally {
    clock.hour = 12;
  }
});

test("the stamp keeps the date the trade sealed, not the clock's latest", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "sealed" });
  globalThis.game.time.worldTime = 0;
  await act(sheet, "seal");
  globalThis.game.time.worldTime = 3600;
  try {
    const { buy } = await sheet._prepareContext({});
    assert.equal(buy.basket.dateLabel, "t0");
  } finally {
    globalThis.game.time.worldTime = 0;
  }
});

test("the stamp stays when a shelf change trims a line the sealed trade didn't carry", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5 }), item("shield", { quantity: 3 })] });
  act(sheet, "addLine", { itemId: "rope" });
  for (let i = 0; i < 3; i++) act(sheet, "addLine", { itemId: "shield" });
  api.trade = async () => ({ status: "sealed", lines: [{ itemId: "rope", quantity: 1, lineTotalCp: 100 }] });
  await act(sheet, "seal");
  shop.items.get("shield").system.quantity = 1;
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "sealed");
  assert.deepEqual(buy.basket.lines.map(l => l.itemId), ["rope"]);
});

test("a used-up item (quantity 0) isn't offered for sale", async () => {
  const { sheet } = openShop({ buyerItems: [item("potion", { quantity: 0 }), item("gem")] });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(packRows(sell).map(r => r.id), ["gem"]);
});

test("a basket the shelf emptied drops the unanswered trade id, so a new bill isn't taken for it", async () => {
  const { sheet, buyer } = openShop({ buyerItems: [item("gem"), item("ring")] });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  api.trade = async () => {
    buyer.items.splice(buyer.items.findIndex(i => i.id === "gem"), 1);
    return { status: "unconfirmed" };
  };
  await act(sheet, "seal");
  await sheet._prepareContext({});
  assert.equal(sheet._baskets.sell.size, 0);
  assert.equal(sheet._tradeId.sell, null);
  assert.equal(sheet._tradeState.sell, "idle");
});

test("a basket the player empties by hand keeps the unanswered trade id", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  api.trade = async () => ({ status: "unconfirmed" });
  await act(sheet, "seal");
  const id = sheet._tradeId.buy;
  act(sheet, "stepLine", { itemId: "rope", delta: "-1" });
  await sheet._prepareContext({});
  assert.equal(sheet._tradeId.buy, id);
});

test("a line trimmed below the fewest worth a coin leaves the bill", async () => {
  const cheap = item("pins", { quantity: 25, price: { value: 1, denomination: "cp" }, flags: { "merchant-presets": { stock: { bundle: 20 } } } });
  const { sheet, shop } = openShop({ shopItems: [cheap] });
  await sheet._prepareContext({});
  act(sheet, "addLine", { itemId: "pins" });
  act(sheet, "addLine", { itemId: "pins" });
  assert.equal(sheet._baskets.buy.get("pins"), 25);
  shop.items.get("pins").system.quantity = 5;
  await sheet._prepareContext({});
  assert.equal(sheet._baskets.buy.has("pins"), false);
});

test("a bill line whose one-bundle price floors to nothing shows no unit price, not Free each", async () => {
  const { sheet } = openShop({ buyerItems: [item("chalk", { quantity: 5, price: { value: 1, denomination: "cp" } })] });
  sheet.tabGroups.primary = "sell";
  await sheet._prepareContext({});
  act(sheet, "addLine", { itemId: "chalk" });
  const { sell } = await sheet._prepareContext({});
  const [line] = sell.basket.lines;
  assert.equal(line.quantity, 2);
  assert.equal(line.showUnit, false);
});

/* ------------------------------------------------------------ settings tab (#110) */

/** The config writes a GM's Settings tab made, as `actor.update` got them. */
const PRESET_UUID = "Compendium.merchant-presets.merchants.Actor.smith";

/**
 * A shop window opened by the GM (or a player, with `gm: false`), whose shop records its updates
 * and came from a preset merchant selling at 125%. Restores the player user and the world
 * settings when the test ends.
 */
function openSettings(t, { gm = true, shopConfig = {}, ownership = 0 } = {}) {
  const opened = openShop({ permission: OWNERSHIP.OWNER });
  const { shop } = opened;
  shop.ownership = { default: ownership };
  shop.flags["merchant-presets"].shop = { ...structuredClone(SHOP_DEFAULTS), source: PRESET_UUID, ...shopConfig };
  shop.updates = [];
  // Like a real update: it lands a moment later, and then the document holds it.
  shop.update = async changes => {
    shop.updates.push(changes);
    await new Promise(resolve => setImmediate(resolve));
    const written = changes["flags.merchant-presets.shop"];
    if (written) shop.flags["merchant-presets"].shop = structuredClone(written.replaced);
  };
  const preset = { ...structuredClone(SHOP_DEFAULTS), tier: "City", terms: { sellsAt: 1.25, buysAt: null, categories: [] } };
  const warnings = [];
  const saved = { isGM: globalThis.game.user.isGM, values: { ...globalThis.game.settings.values }, warn: globalThis.ui.notifications.warn };
  globalThis.game.user.isGM = gm;
  globalThis.ui.notifications.warn = message => warnings.push(message);
  globalThis._replace = value => ({ replaced: value });
  globalThis.fromUuid = async uuid => (uuid === PRESET_UUID ? { flags: { "merchant-presets": { shop: preset, purse: 800 } } } : null);
  t.after(() => {
    globalThis.game.user.isGM = saved.isGM;
    globalThis.game.settings.values = saved.values;
    globalThis.ui.notifications.warn = saved.warn;
  });
  return { ...opened, preset, warnings };
}

/** The shop config the last update wrote, unwrapped from `_replace`. */
const writtenShop = shop => shop.updates.at(-1)["flags.merchant-presets.shop"].replaced;

/** A change event on a Settings-tab control, as the window hears it. */
const change = (sheet, dataset, { value = "", checked = false } = {}) => sheet._onSettingChange({ dataset, value, checked });

test("a player's window never gets the Settings tab's context", async t => {
  const { sheet } = openSettings(t, { gm: false });
  assert.equal((await sheet._prepareContext({})).settings, null);
});

test("the GM's Settings tab shows the shop's rates, following the world's own where it has none", async t => {
  const { sheet } = openSettings(t, { shopConfig: { terms: { sellsAt: null, buysAt: 0.4, categories: [] } } });
  globalThis.game.settings.values.sellsAt = 110;
  const { settings } = await sheet._prepareContext({});
  assert.deepEqual(
    [settings.terms.sells.percent, settings.terms.sells.worldDefault, settings.terms.buys.percent, settings.terms.buys.worldDefault],
    [110, true, 40, false]);
});

test("the window prices from the world's own rate setting, as the trade does", async t => {
  const { sheet } = openSettings(t);
  globalThis.game.settings.values.sellsAt = 200;
  const { buy } = await sheet._prepareContext({});
  // A 1 gp rope at 200%.
  assert.equal(buy.sections[0].rows[0].bundlePriceCp, 200);
});

test("a rate the GM types is written as the whole shop config, replacing the old one", async t => {
  const { sheet, shop } = openSettings(t);
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "120" });
  assert.equal(shop.updates.length, 1);
  const written = writtenShop(shop);
  assert.equal(written.terms.sellsAt, 1.2);
  assert.equal(written.source, PRESET_UUID);
});

test("ticking World default hands the rate back to the world, and unticking keeps the world's figure", async t => {
  const { sheet, shop } = openSettings(t, { shopConfig: { terms: { sellsAt: 1.3, buysAt: null, categories: [] } } });
  globalThis.game.settings.values.buysAt = 45;
  await change(sheet, { op: "rateDefault", side: "sellsAt" }, { checked: true });
  assert.equal(writtenShop(shop).terms.sellsAt, null);
  await change(sheet, { op: "rateDefault", side: "buysAt" }, { checked: false });
  assert.equal(writtenShop(shop).terms.buysAt, 0.45);
});

test("an edit the config can't hold is refused with a warning, and nothing is written", async t => {
  const { sheet, shop, warnings } = openSettings(t);
  const renders = sheet.renders;
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "0" });
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "" });
  assert.equal(shop.updates.length, 0);
  assert.equal(warnings.length, 2);
  // Re-rendered, so the field shows the value the shop still has.
  assert.equal(sheet.renders, renders + 2);
});

test("a player can't write the shop's config, whatever reaches the window", async t => {
  const { sheet, shop } = openSettings(t, { gm: false });
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "120" });
  await act(sheet, "setEvery", { every: "3" });
  assert.equal(shop.updates.length, 0);
});

test("each Settings-tab control makes its own edit", async t => {
  const { sheet, shop } = openSettings(t);
  const last = () => writtenShop(shop);
  await act(sheet, "addRule", { category: "weapon" });
  assert.deepEqual(last().terms.categories, [{ category: "weapon", sellsAt: 1, buysAt: 0.5 }]);
  shop.flags["merchant-presets"].shop = last();
  await change(sheet, { op: "ruleRate", category: "weapon", side: "buysAt" }, { value: "75" });
  assert.equal(last().terms.categories[0].buysAt, 0.75);
  await act(sheet, "removeRule", { category: "weapon" });
  assert.deepEqual(last().terms.categories, []);
  await change(sheet, { op: "wontBuy", list: "kinds", value: "meal" }, { checked: true });
  assert.deepEqual(last().wontBuy.kinds, ["meal"]);
  await change(sheet, { op: "hour", end: "open" }, { value: "09:15" });
  assert.deepEqual(last().hours.open, { hour: 9, minute: 15 });
  await change(sheet, { op: "keepHours" }, { checked: false });
  assert.equal(last().hours, null);
  await act(sheet, "setEvery", { every: "14" });
  assert.equal(last().restock.every, 14);
  await change(sheet, { op: "every" }, { value: "2d6" });
  assert.equal(last().restock.every, "2d6");
  await change(sheet, { op: "mode" }, { value: "topup" });
  assert.equal(last().restock.mode, "topup");
});

test("keeping hours again starts from the preset's hours", async t => {
  const { sheet, shop, preset } = openSettings(t, { shopConfig: { hours: null } });
  preset.hours = { open: { hour: 5, minute: 0 }, close: { hour: 13, minute: 0 } };
  await sheet._prepareContext({});
  await change(sheet, { op: "keepHours" }, { checked: true });
  assert.deepEqual(writtenShop(shop).hours, preset.hours);
});

test("Players can visit sets the shop's default ownership and marks the GM's choice", async t => {
  const { sheet, shop } = openSettings(t);
  await change(sheet, { op: "visit" }, { checked: true });
  assert.deepEqual(shop.updates.at(-1), { "ownership.default": 1, "flags.merchant-presets.visibility": true });
  await change(sheet, { op: "visit" }, { checked: false });
  assert.deepEqual(shop.updates.at(-1), { "ownership.default": 0, "flags.merchant-presets.visibility": false });
  assert.equal((await sheet._prepareContext({})).settings.visit, false);
});

test("Reset to preset asks first, then puts back the preset's config", async t => {
  const { sheet, shop, preset } = openSettings(t, { shopConfig: { hours: null, description: "mine" } });
  dialog.answer = false;
  await act(sheet, "resetToPreset");
  assert.equal(shop.updates.length, 0);
  dialog.answer = true;
  await act(sheet, "resetToPreset");
  assert.deepEqual(writtenShop(shop), { ...preset, source: PRESET_UUID });
});

test("a shop whose preset can't be found offers no reset", async t => {
  const { sheet, shop } = openSettings(t, { shopConfig: { source: null } });
  assert.equal((await sheet._prepareContext({})).settings.canReset, false);
  await act(sheet, "resetToPreset");
  assert.equal(shop.updates.length, 0);
});

test("Restock now restocks the shop through the runtime", async t => {
  const { sheet, shop } = openSettings(t);
  const restocked = [];
  api.requestRestock = async actor => { restocked.push(actor); return { status: "restocked", restocked: [] }; };
  t.after(() => { delete api.requestRestock; });
  await act(sheet, "restockNow");
  assert.deepEqual(restocked, [shop]);
});

test("a change to the module's world settings re-renders every open shop window", async t => {
  const { sheet } = openSettings(t);
  const renders = sheet.renders;
  fire("updateSetting", { key: "merchant-presets.sellsAt" });
  fire("updateSetting", { key: "core.fontSize" });
  fire("createSetting", { key: "merchant-presets.buysAt" });
  assert.equal(sheet.renders, renders + 2);
});

test("a shop imported from the pack resets to the merchant it was imported from", async t => {
  // Live data: a pack import leaves `shop.source` null; core records the pack entry in `_stats`.
  const { sheet, shop, preset } = openSettings(t, { shopConfig: { source: null, hours: null } });
  shop._stats = { compendiumSource: PRESET_UUID };
  assert.equal((await sheet._prepareContext({})).settings.canReset, true);
  await act(sheet, "resetToPreset");
  assert.deepEqual(writtenShop(shop), { ...preset, source: null });
});

/* ------------------------------------------------------------ #140 review, round 1 */

test("two quick edits both land: the second reads the config the first wrote", async t => {
  const { sheet, shop } = openSettings(t);
  // Not awaited in between: the GM leaves Sells at and ticks a box before the first save lands.
  const first = change(sheet, { op: "rate", side: "sellsAt" }, { value: "120" });
  const second = change(sheet, { op: "rateDefault", side: "buysAt" }, { checked: true });
  const third = change(sheet, { op: "keepHours" }, { checked: false });
  await Promise.all([first, second, third]);
  const written = shop.flags["merchant-presets"].shop;
  assert.equal(written.terms.sellsAt, 1.2);
  assert.equal(written.terms.buysAt, null);
  assert.equal(written.hours, null);
});

test("only the world settings a shop window shows re-render it, not the restock clock", async t => {
  const { sheet } = openSettings(t);
  const renders = sheet.renders;
  for (const key of ["lastRestockTime", "autoRestockDecided", "spellcastingToChat"]) fire("updateSetting", { key: `merchant-presets.${key}` });
  assert.equal(sheet.renders, renders);
  for (const key of ["sellsAt", "buysAt", "stockMode", "merchantPurse", "tradingHours", "autoRestock", "followClock"]) {
    fire("updateSetting", { key: `merchant-presets.${key}` });
  }
  // dnd5e's calendar switch too: Auto reads it (#149, #161 review).
  fire("updateSetting", { key: "dnd5e.calendarConfig" });
  assert.equal(sheet.renders, renders + 8);
});

test("a shop whose config can't be read is never overwritten with the defaults", async t => {
  const { sheet, shop, warnings } = openSettings(t);
  shop.flags["merchant-presets"].shop = { version: 1, tier: "Hamlet", restock: { table: "RollTable.keep" } };
  assert.equal((await sheet._prepareContext({})).settings.broken, true);
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "120" });
  await act(sheet, "setEvery", { every: "3" });
  await act(sheet, "removeRule", { category: "weapon" });
  await act(sheet, "resetToPreset");
  assert.equal(shop.updates.length, 0);
  assert.ok(warnings.length >= 3);
});

test("a double click on a rule's trash removes that rule only (#140 review, round 2)", async t => {
  const rules = ["weapon", "armor", "loot"].map(category => ({ category, sellsAt: 1, buysAt: 0.5 }));
  const { sheet, shop } = openSettings(t, { shopConfig: { terms: { sellsAt: null, buysAt: null, categories: rules } } });
  // Both clicks land on the same button before the window re-renders.
  await Promise.all([act(sheet, "removeRule", { category: "weapon" }), act(sheet, "removeRule", { category: "weapon" })]);
  assert.deepEqual(shop.flags["merchant-presets"].shop.terms.categories.map(r => r.category), ["armor", "loot"]);
});

test("the Terms section words a rate as the shop charges it, capped (#140 review, round 3)", async t => {
  await withLabels(async () => {
    const { sheet } = openSettings(t, { shopConfig: { terms: { sellsAt: 0.4, buysAt: null, categories: [] } } });
    const { settings } = await sheet._prepareContext({});
    // Never buys above what it sells at: the world's half is capped to 40%, as the chip and trades say.
    assert.equal(settings.terms.buys.word, "OfValue(40%)");
  });
});

test("a save the server refuses is said, and the field put back (#140 review, round 4)", async t => {
  const { sheet, shop, warnings } = openSettings(t);
  shop.update = async () => { throw new Error("server says no"); };
  const renders = sheet.renders;
  const errors = [];
  const logged = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = logged; });
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "120" });   // resolves: nothing left unhandled
  assert.deepEqual(warnings, ["MERCHANT_PRESETS.Shop.Settings.SaveFailed"]);
  assert.equal(sheet.renders, renders + 1);
  assert.equal(errors.length, 1);
  // The next edit still runs.
  shop.update = async changes => { shop.updates.push(changes); };
  await change(sheet, { op: "rate", side: "sellsAt" }, { value: "130" });
  assert.equal(writtenShop(shop).terms.sellsAt, 1.3);
});

test("the next restock date shows only while it's the one the shop will keep (#140 review, round 4)", async t => {
  const { sheet, shop } = openSettings(t, { shopConfig: { restock: { ...SHOP_DEFAULTS.restock, table: "RollTable.t", every: 1 } } });
  // Scheduled at 14 days; the GM has just made it daily. The clock recounts it at its next tick.
  shop.flags["merchant-presets"].schedule = { lastRestock: 0, dueAt: 14 * 86400, every: 14 };
  assert.equal((await sheet._prepareContext({})).settings.restock.next, null);
  shop.flags["merchant-presets"].schedule.every = 1;
  // "Next: <date> at <time>, in 14 days" (design aaJcp), on the date the schedule keeps.
  const next = await withLabels(async () => (await sheet._prepareContext({})).settings.restock.next);
  assert.equal(next, `Next(At(t${14 * 86400},12:00),InDays(14))`);
  // No table: it never restocks, so there's no next date.
  shop.flags["merchant-presets"].shop.restock.table = null;
  assert.equal((await sheet._prepareContext({})).settings.restock.next, null);
});

test("a render that fails doesn't leave the window deaf to typed fields (#140 review, round 4)", async t => {
  const { sheet } = openSettings(t);
  await sheet._preRender({}, {});
  const base = Object.getPrototypeOf(Object.getPrototypeOf(sheet));
  const render = base.render;
  base.render = () => { throw new Error("template broke"); };
  t.after(() => { base.render = render; });
  await assert.rejects(Promise.resolve().then(() => sheet.render()));
  assert.equal(sheet._settingsRendering, false);
});

test("a Players can visit write the server refuses is said, and the box put back (#140 review, round 5)", async t => {
  const { sheet, shop, warnings } = openSettings(t);
  shop.update = async () => { throw new Error("server says no"); };
  const logged = console.error;
  console.error = () => {};
  t.after(() => { console.error = logged; });
  const renders = sheet.renders;
  await change(sheet, { op: "visit" }, { checked: true });   // resolves: nothing left unhandled
  assert.deepEqual(warnings, ["MERCHANT_PRESETS.Shop.Settings.SaveFailed"]);
  assert.equal(sheet.renders, renders + 1);
});

test("choosing a category in Add rule adds nothing until Add is pressed (#140 review, round 5)", async t => {
  const { sheet, shop } = openSettings(t);
  // Arrowing through a closed select fires change for each option on Windows and Linux.
  await change(sheet, { op: "addRule" }, { value: "weapon" });
  assert.equal(shop.updates.length, 0);
  await act(sheet, "addRule", { category: "weapon" });
  assert.deepEqual(writtenShop(shop).terms.categories.map(r => r.category), ["weapon"]);
});

test("Add rule asks which category in a form, and rules the one picked (#145: the design has only the button)", async t => {
  const { sheet, shop } = openSettings(t);
  const DialogV2 = globalThis.foundry.applications.api.DialogV2;
  const input = DialogV2.input;
  const asked = [];
  DialogV2.input = async options => { asked.push(options); return { category: "tool" }; };
  t.after(() => { DialogV2.input = input; });
  await act(sheet, "addRule");
  assert.match(asked[0].content, /<option value="tool">/);
  assert.deepEqual(writtenShop(shop).terms.categories.map(c => c.category), ["tool"]);
  // Dismissed, it adds nothing.
  DialogV2.input = async () => null;
  const writes = shop.updates.length;
  await act(sheet, "addRule");
  assert.equal(shop.updates.length, writes);
});

test("the Settings tab keeps its scroll position across re-renders (#140 review, round 7)", () => {
  assert.ok(ShopSheet.PARTS.body.scrollable.includes(".settings-body"));
});

test("Restock now tells a failed restock from one the GM's tab hasn't answered yet (#140 review, round 9)", async t => {
  const { sheet, warnings } = openSettings(t);
  t.after(() => { delete api.requestRestock; });
  api.requestRestock = async () => ({ status: "no-answer", restocked: null });
  await act(sheet, "restockNow");
  api.requestRestock = async () => ({ status: "restocked", restocked: [] });
  await act(sheet, "restockNow");
  assert.deepEqual(warnings, ["MERCHANT_PRESETS.Shop.Settings.Restock.NoAnswer"]);
});

test("the Settings tab says when players keep their own access to a shop hidden by default (#140 review, round 9)", async t => {
  const { sheet, shop } = openSettings(t);
  globalThis.game.users = Object.assign([{ id: "gm1", isGM: true }, { id: "rogue", isGM: false }],
    { get(id) { return this.find(u => u.id === id); } });
  t.after(() => { delete globalThis.game.users; });
  shop.ownership = { default: 0, gm1: 3, rogue: 1, gone: 2 };
  assert.equal((await sheet._prepareContext({})).settings.visitOthers, 1);
});

test("a restock that can't run says so without blaming a missing table", async t => {
  const { sheet, warnings } = openSettings(t);
  api.requestRestock = async () => ({ status: "failed", restocked: null });
  t.after(() => { delete api.requestRestock; });
  await act(sheet, "restockNow");
  assert.deepEqual(warnings, ["MERCHANT_PRESETS.Shop.Settings.Restock.Failed"]);
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url)));
  assert.doesNotMatch(lang.MERCHANT_PRESETS.Shop.Settings.Restock.Failed, /table is missing/);
});

test("a buyer's deal prices the bill as the trade will, so the seal matches (#111)", async () => {
  const { sheet, shop, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })], buyerItems: [item("gem", { quantity: 2 })] });
  shop.flags["merchant-presets"].shop.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.1, sell: 0.2, note: "", ends: null }];
  act(sheet, "addLine", { itemId: "rope" });
  let sent;
  api.trade = async request => { sent = request; return { status: "sealed" }; };
  await act(sheet, "seal");
  assert.deepEqual(sent.lines, [{ itemId: "rope", quantity: 1, expectedBundlePriceCp: 90 }]);
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  await act(sheet, "seal");
  assert.deepEqual(sent.lines, [{ itemId: "gem", quantity: 1, expectedBundlePriceCp: 60 }]);
});

test("another buyer's deal, or an ended one, leaves the price at list (#111)", async () => {
  const { sheet, shop, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const config = shop.flags["merchant-presets"].shop;
  config.deals = [{ actor: "Actor.someoneElse", name: "x", buy: -0.5, sell: null, note: "", ends: null }];
  act(sheet, "addLine", { itemId: "rope" });
  let sent;
  api.trade = async request => { sent = request; return { status: "sealed" }; };
  await act(sheet, "seal");
  assert.equal(sent.lines[0].expectedBundlePriceCp, 100);
  config.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.5, sell: null, note: "", ends: { at: 0, when: "close" } }];
  act(sheet, "addLine", { itemId: "rope" });
  await act(sheet, "seal");
  assert.equal(sent.lines[0].expectedBundlePriceCp, 100);
});

/** Runs `fn` with localize filling in its data, so a test can read what a label says. */
async function withLabels(fn) {
  const { localize } = globalThis.game.i18n;
  globalThis.game.i18n.localize = (key, data) => (data ? `${key.split(".").pop()}(${Object.values(data).join(",")})` : key);
  try { return await fn(); }
  finally { globalThis.game.i18n.localize = localize; }
}

test("the header chip tells the buyer their deal, and only them (#111)", async () => {
  await withLabels(async () => {
    const { sheet, shop, buyer } = openShop();
    const config = shop.flags["merchant-presets"].shop;
    config.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.1, sell: 0.2, note: "secret", ends: null }];
    let { header } = await sheet._prepareContext({});
    // The design's "Sells at list · Your price −10%": the selling rate, then what the deal changes.
    assert.equal(header.termsChip, "TermsChipSells(MERCHANT_PRESETS.Shop.Terms.List) · YourPrice(−10%) · YourOffers(+20%)");
    config.deals = [{ actor: "Actor.someoneElse", name: "x", buy: -0.1, sell: null, note: "", ends: null }];
    ({ header } = await sheet._prepareContext({}));
    assert.equal(header.termsChip, "TermsChip(MERCHANT_PRESETS.Shop.Terms.List,½)");
  });
});

test("a bill line the deal priced is marked as the buyer's deal (#111)", async () => {
  const { sheet, shop, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const config = shop.flags["merchant-presets"].shop;
  config.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.1, sell: null, note: "", ends: null }];
  act(sheet, "addLine", { itemId: "rope" });
  let context = await sheet._prepareContext({});
  assert.equal(context.buy.basket.lines[0].dealt, true);
  assert.equal(context.buy.sections[0].rows[0].listText, "1 gp");
  config.deals = [{ actor: buyer.uuid, name: "hero", buy: null, sell: 0.1, note: "", ends: null }];
  context = await sheet._prepareContext({});
  assert.equal(context.buy.basket.lines[0].dealt, false);
  assert.equal(context.buy.sections[0].rows[0].listText, "");
});

test("the GM's note on a deal never reaches the player's window (#111)", async () => {
  const { sheet, shop, buyer } = openShop();
  shop.flags["merchant-presets"].shop.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.1, sell: null, note: "SECRET-NOTE", ends: null }];
  // The shop's own documents are in the context whole, as they're on the client anyway; nothing
  // built for display may carry the note.
  const context = await sheet._prepareContext({});
  const shown = Object.fromEntries(Object.entries(context).filter(([key]) => key !== "actor" && key !== "config"));
  assert.ok(!JSON.stringify(shown).includes("SECRET-NOTE"));
});

/* ------------------------------------------------------------ deals section (#111) */

/** The GM's window, with the buyer made a player's character a deal can be for. */
function openDeals(t, deals = []) {
  const opened = openSettings(t, { shopConfig: { deals } });
  opened.buyer.type = "character";
  opened.buyer.name = "Aria";
  const Sheet = opened.sheet.constructor;
  const ask = Sheet.askDeal;
  opened.asked = [];
  // The form the GM fills in (DealForm): set `opened.answer` before the action.
  Sheet.askDeal = async context => { opened.asked.push(context); return opened.answer; };
  t.after(() => { Sheet.askDeal = ask; });
  return opened;
}

const ARIA_DEAL = uuid => ({ actor: uuid, name: "Aria", buy: -0.1, sell: null, note: "Saved the smith's daughter", ends: null });

test("the Deals section lists each deal with what it changes and when it ends", async t => {
  await withLabels(async () => {
    const { sheet, buyer } = openDeals(t);
    const config = sheet.document.flags["merchant-presets"].shop;
    config.deals = [ARIA_DEAL(buyer.uuid),
      { actor: "Actor.tomas", name: "Tomas", buy: null, sell: 0.1, note: "", ends: { at: 50, when: "close" } },
      { actor: "Actor.old", name: "Old", buy: -0.2, sell: 0.2, note: "", ends: { at: -1, when: "date" } },
      { actor: "Actor.bram", name: "Bram", buy: -0.1, sell: null, note: "", ends: { at: -1, when: "close" } }];
    const { settings } = await sheet._prepareContext({});
    assert.deepEqual(settings.deals.list.map(d => [d.name, d.initial, d.badges, d.ended]), [
      ["Aria", "A", ["Buying(−10%)"], false],
      ["Tomas", "T", ["Selling(+10%)"], false],
      ["Old", "O", ["Buying(−20%)", "Selling(+20%)"], true],
      ["Bram", "B", ["Buying(−10%)"], true]
    ]);
    const [aria, tomas, old, bram] = settings.deals.list.map(d => d.line);
    assert.equal(aria, "Saved the smith's daughter · MERCHANT_PRESETS.Shop.Settings.Deals.NoEnd");
    assert.equal(tomas, "MERCHANT_PRESETS.Shop.Settings.Deals.UntilClose");
    // An ended deal says when it ended: on its date, or at that day's closing (design Q6UvA).
    assert.match(old, /^EndedOn\(.+\)$/);
    assert.match(bram, /^EndedClose\(.+\)$/);
    // Players see: only the deals in force that move a Buy-list price, each for its own character.
    assert.deepEqual(settings.preview.deals.map(d => d.name), ["Aria"]);
    assert.match(settings.preview.deals[0].chip, /YourPrice\(−10%\)/);
  });
});

test("adding a deal writes it from the form, for the character picked", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer } = opened;
  opened.answer = { actor: buyer.uuid, buy: -10, sell: null, ends: "never", days: null, note: "Saved the smith's daughter" };
  await act(sheet, "addDeal");
  assert.deepEqual(writtenShop(shop).deals, [ARIA_DEAL(buyer.uuid)]);
  assert.ok(opened.asked[0].characters.some(c => c.uuid === buyer.uuid), "the character is offered");
});

test("the deal form offers player characters, not the mounts and shops players own (#111 live run)", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer } = opened;
  const camel = { uuid: "Actor.camel", name: "Camel", type: "npc", hasPlayerOwner: true };
  globalThis.game.actors = [shop, buyer, camel];
  opened.answer = null;
  await act(sheet, "addDeal");
  const offered = opened.asked[0].characters.map(c => c.uuid);
  assert.ok(offered.includes(buyer.uuid));
  assert.ok(!offered.includes("Actor.camel"));
});

test("a character with a deal isn't offered for another", async t => {
  const opened = openDeals(t);
  const { sheet, buyer } = opened;
  sheet.document.flags["merchant-presets"].shop.deals = [ARIA_DEAL(buyer.uuid)];
  opened.answer = null;
  await act(sheet, "addDeal");
  assert.ok(!(opened.asked[0]?.characters ?? []).some(c => c.uuid === buyer.uuid));
});

test("a deal is edited in the same form, for the same character, and removed by its button", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer } = opened;
  sheet.document.flags["merchant-presets"].shop.deals = [{ ...ARIA_DEAL(buyer.uuid), ends: { at: 999, when: "date" } }];
  // A form can't swap the character: the edit is for the deal it opened on.
  opened.answer = { actor: "Actor.someoneElse", buy: -15, sell: 5, ends: "keep", days: null, note: "Paid in advance" };
  await act(sheet, "editDeal", { actor: buyer.uuid });
  assert.deepEqual(writtenShop(shop).deals,
    [{ actor: buyer.uuid, name: "Aria", buy: -0.15, sell: 0.05, note: "Paid in advance", ends: { at: 999, when: "date" } }]);
  await act(sheet, "removeDeal", { actor: buyer.uuid });
  assert.deepEqual(writtenShop(shop).deals, []);
});

test("a cancelled deal form writes nothing, and a bad one warns and writes nothing", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer, warnings } = opened;
  opened.answer = null;
  await act(sheet, "addDeal");
  opened.answer = { actor: buyer.uuid, buy: -100, sell: null, ends: "never", days: null, note: "" };
  await act(sheet, "addDeal");
  opened.answer = { actor: buyer.uuid, buy: -10, sell: null, ends: "days", days: 0, note: "" };
  await act(sheet, "addDeal");
  assert.equal(shop.updates.length, 0);
  assert.equal(warnings.length, 2);
});

test("a player's window can't make, edit or remove a deal", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer } = opened;
  globalThis.game.user.isGM = false;
  opened.answer = { actor: buyer.uuid, buy: -10, sell: null, ends: "never", days: null, note: "" };
  await act(sheet, "addDeal");
  await act(sheet, "removeDeal", { actor: buyer.uuid });
  assert.equal(shop.updates.length, 0);
  assert.equal(opened.asked.length, 0);
});

test("without a world clock no deal can end after some days: nothing would ever move it on (#149, #161 review)", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer, warnings } = opened;
  globalThis.game.settings.values.followClock = "never";
  opened.answer = { actor: buyer.uuid, buy: -10, sell: null, ends: "days", days: 3, note: "" };
  await act(sheet, "addDeal");
  const ends = opened.asked[0].ends;
  assert.equal(ends.find(e => e.value === "days").disabled, true);
  assert.equal(ends.find(e => e.value === "close").disabled, true);
  assert.equal(shop.updates.length, 0);
  assert.equal(warnings.length, 1);
});

test("with trading hours off a shop never closes, so no deal can last until it does (#142 review)", async t => {
  const opened = openDeals(t);
  const { sheet, shop, buyer, warnings } = opened;
  globalThis.game.settings.values.tradingHours = false;
  opened.answer = { actor: buyer.uuid, buy: -10, sell: null, ends: "close", days: null, note: "" };
  await act(sheet, "addDeal");
  assert.equal(opened.asked[0].ends.find(e => e.value === "close").disabled, true);
  assert.equal(shop.updates.length, 0);
  assert.equal(warnings.length, 1);
});

test("the chip promises what the deal really gives once the cap has cut it (#142 review)", async t => {
  await withLabels(async () => {
    const { sheet, buyer } = openDeals(t);
    // Sells at list, buys at half: +150% on offers would pay 125% of list, capped at 100% (+100%).
    sheet.document.flags["merchant-presets"].shop.deals = [{ actor: buyer.uuid, name: "Aria", buy: null, sell: 1.5, note: "", ends: null }];
    const { header, settings } = await sheet._prepareContext({});
    assert.match(header.termsChip, /YourOffers\(\+100%\)$/);
    // Offers aren't a Buy-list price, so Players see has no row for it.
    assert.deepEqual(settings.preview.deals, []);
  });
});

test("a bill at a deal's price tags each line with the deal and says what it saved (design Q6UvA)", async () => {
  await withLabels(async () => {
    const { sheet, shop, buyer } = openShop({ shopItems: [item("rope", { quantity: 5 })], buyerItems: [item("gem", { quantity: 2 })] });
    const config = shop.flags["merchant-presets"].shop;
    config.deals = [{ actor: buyer.uuid, name: "hero", buy: -0.1, sell: 0.2, note: "", ends: null }];
    act(sheet, "addLine", { itemId: "rope" });
    act(sheet, "addLine", { itemId: "rope" });
    sheet.tabGroups.primary = "sell";
    act(sheet, "addLine", { itemId: "gem" });
    const { buy, sell } = await sheet._prepareContext({});
    // Two ropes at 90 cp instead of 100: the line wears −10%, and the bill says 20 cp saved.
    assert.equal(buy.basket.lines[0].dealTag, "−10%");
    assert.equal(buy.basket.dealText, "Saves(2 sp)");
    // A sale at the deal's +20%: what the deal added.
    assert.equal(sell.basket.lines[0].dealTag, "+20%");
    assert.match(sell.basket.dealText, /^Adds\(/);
    config.deals = [];
    const plain = await sheet._prepareContext({});
    assert.equal(plain.buy.basket.lines[0].dealTag, null);
    assert.equal(plain.buy.basket.dealText, null);
  });
});

test("a bill line whose total the deal didn't move isn't marked as the deal's (#142 review)", async () => {
  const { sheet, shop, buyer } = openShop({ shopItems: [item("twine", { quantity: 5, price: { value: 1, denomination: "sp" } })] });
  shop.flags["merchant-presets"].shop.deals = [{ actor: buyer.uuid, name: "hero", buy: 0.02, sell: null, note: "", ends: null }];
  act(sheet, "addLine", { itemId: "twine" });
  const context = await sheet._prepareContext({});
  assert.equal(context.buy.basket.lines[0].lineTotalCp, 10);
  assert.equal(context.buy.basket.lines[0].dealt, false);
  assert.equal(context.buy.sections[0].rows[0].listText, "");
});

/** The Terms popover's category rule lines, as the rates they state. */
const ruleTerms = header => header.terms.rows.filter(r => r.rule).map(r => r.rule);

test("a rule side left blank follows the shop's rate, shown as its placeholder (#143 review)", async t => {
  const { sheet, shop } = openSettings(t, { shopConfig: { terms: { sellsAt: 1.2, buysAt: null, categories: [{ category: "Valuables", sellsAt: 1.2, buysAt: 1 }] } } });
  await change(sheet, { op: "ruleRate", category: "Valuables", side: "sellsAt" }, { value: "" });
  assert.deepEqual(writtenShop(shop).terms.categories[0], { category: "Valuables", sellsAt: null, buysAt: 1 });
  const { settings, header } = await sheet._prepareContext({});
  const rule = settings.terms.rules[0];
  assert.equal(rule.sellsPercent, "");
  assert.equal(rule.sellsFollows, 120);
  // The Terms popover says what the rule charges, the shop's rate on its unset side.
  assert.deepEqual(ruleTerms(header)[0], { category: "Valuables", sellsAt: 1.2, buysAt: 1 });
});

test("the Terms popover and a rule's placeholders show what trades pay, capped (#143 review)", async t => {
  const { sheet } = openSettings(t, { shopConfig: { terms: { sellsAt: null, buysAt: null, categories: [
    { category: "Valuables", sellsAt: null, buysAt: 1 },
    { category: "weapon", sellsAt: 0.3, buysAt: null }
  ] } } });
  // The world sells at 80%: Valuables can't be bought back at full value above what they sell for.
  globalThis.game.settings.values.sellsAt = 80;
  globalThis.game.settings.values.buysAt = 50;
  const { header, settings } = await sheet._prepareContext({});
  assert.deepEqual(ruleTerms(header), [
    { category: "Valuables", sellsAt: 0.8, buysAt: 0.8 },
    { category: "weapon", sellsAt: 0.3, buysAt: 0.3 }
  ]);
  assert.deepEqual(settings.terms.rules.map(r => [r.sellsFollows, r.buysFollows]), [[80, 80], [30, 30]]);
});

/* ------------------------------------------------------------ design names (#145) */

test("a coin is named as the design names it where it shows: by metal, metal and count, or place", () => {
  const gold = { denomination: "gp", label: "Gold Pieces", count: 15 };
  assert.equal(helpers.mpCoinPen("metal", gold, 0), "gold");
  assert.equal(helpers.mpCoinPen("count", gold, 0), "gold 15");
  assert.equal(helpers.mpCoinPen("price", gold, 0), "Price");
  assert.equal(helpers.mpCoinPen("price", { denomination: "sp", count: 5 }, 1), "Price Minor");
  assert.equal(helpers.mpCoinPen("metal", { denomination: "shell", label: "Cowrie" }, 0), "cowrie");
});

test("an icon helper call gives the inline Lucide icon, named for the checker, from a script's \"lucide:\" name too", () => {
  const html = String(helpers.mpIcon("lucide:scale", { hash: { pen: "Terms icon" } }));
  assert.match(html, /^<svg class="mp-icon" data-icon="scale" data-pen="Terms icon"/);
  assert.doesNotMatch(String(helpers.mpIcon("scale", { hash: {} })), /data-pen/);
});

test("the Buy list keeps the shelf's own order, the one a GM drags on the NPC sheet (#145)", async () => {
  const anvil = Object.assign(item("anvil"), { sort: 200 }), bellows = Object.assign(item("bellows"), { sort: 100 });
  const { sheet } = openShop({ shopItems: [anvil, bellows] });
  const { buy } = await sheet._prepareContext({});
  assert.deepEqual(buy.sections.flatMap(s => s.rows.map(r => r.name)), ["bellows", "anvil"]);
});

test("Players see and the Terms example show the first good on the Buy list, by name and value (#145)", async t => {
  await withLabels(async () => {
    const { sheet, buyer } = openDeals(t, []);
    sheet.document.flags["merchant-presets"].shop.deals = [ARIA_DEAL(buyer.uuid)];
    const { settings } = await sheet._prepareContext({});
    const coins = list => list.map(c => `${c.count} ${c.denomination}`);
    // The shelf's one good, a 1 gp rope: sold at list, bought back at half.
    assert.equal(settings.terms.example.text, "ExampleItem(rope,1 gp)");
    assert.deepEqual(coins(settings.terms.example.sell), ["1 gp"]);
    assert.deepEqual(coins(settings.terms.example.buy), ["5 sp"]);
    assert.equal(settings.preview.item.name, "rope");
    assert.deepEqual(coins(settings.preview.item.priceCoins), ["1 gp"]);
    // As Aria sees it: her price, list struck above, and what her deal takes off.
    const aria = settings.preview.deals[0].item;
    assert.deepEqual(coins(aria.priceCoins), ["9 sp"]);
    assert.equal(aria.listText, "1 gp");
    assert.equal(aria.tag.text, "−10%");
  });
});

test("an empty shelf keeps the fixed 15 gp example and shows no preview row (#145)", async t => {
  const opened = openSettings(t);
  opened.shop.items = [];
  const { settings } = await opened.sheet._prepareContext({});
  assert.equal(settings.terms.example.text, "MERCHANT_PRESETS.Shop.Settings.Terms.ExampleSells");
  assert.equal(settings.preview.item, null);
});

test("the fixed 15 gp example is priced at the shop's own rates (#154 review)", async t => {
  const opened = openSettings(t);
  opened.shop.items = [];
  const { settings } = await opened.sheet._prepareContext({});
  const coins = list => list.map(c => `${c.count} ${c.denomination}`);
  // The defaults: sold at list, bought back at half.
  assert.deepEqual(coins(settings.terms.example.sell), ["15 gp"]);
  assert.deepEqual(coins(settings.terms.example.buy), ["7 gp", "5 sp"]);
});

test("Settings' last restock is the last one that ran, fresh stock or not (#154 review)", async t => {
  await withLabels(async () => {
    const { sheet, shop } = openSettings(t);
    // Fresh stock came back on day 5; a top-up on day 12 brought nothing back but still ran.
    shop.flags["merchant-presets"].restockedAt = 5 * 86400;
    shop.flags["merchant-presets"].lastRestockAt = 12 * 86400;
    shop.flags["merchant-presets"].schedule = { lastRestock: 12 * 86400, dueAt: null };
    const { settings } = await sheet._prepareContext({});
    assert.match(settings.restock.last, new RegExp(`t${12 * 86400}\\b`));
  });
});

test("the visit hint says \"entirely\" only while no player has access of their own (#145)", async t => {
  const { sheet, shop } = openSettings(t);
  assert.equal((await sheet._prepareContext({})).settings.visitHint, "MERCHANT_PRESETS.Shop.Settings.Visit.HintAll");
  globalThis.game.users = Object.assign([{ id: "rogue", isGM: false }], { get(id) { return this.find(u => u.id === id); } });
  t.after(() => { delete globalThis.game.users; });
  shop.ownership = { default: 0, rogue: 1 };
  assert.equal((await sheet._prepareContext({})).settings.visitHint, "MERCHANT_PRESETS.Shop.Settings.Visit.Hint");
});

test("the window is titled with the shop's name alone, and its kind chip wears its trade (#145)", async () => {
  const { sheet, shop } = openShop();
  shop.name = "Armourer & Blacksmiths (Town)";
  assert.equal(sheet.title, "Armourer & Blacksmiths");
  // Its preset, as an imported shop records it: the pack's own entry names its kind.
  const lookup = globalThis.fromUuidSync;
  globalThis.fromUuidSync = uuid => (uuid === "Compendium.merchant-presets.merchants.Actor.smith" ? { name: "Armourer & Blacksmiths (Town)" } : null);
  try {
    shop._stats = { compendiumSource: "Compendium.merchant-presets.merchants.Actor.smith" };
    assert.equal((await sheet._prepareContext({})).header.kindIcon, "lucide:hammer");
    shop._stats = {};
    assert.equal((await sheet._prepareContext({})).header.kindIcon, "lucide:store");
  } finally { globalThis.fromUuidSync = lookup; }
});

test("the hours read as the frames write them, without a leading zero (#145)", async () => {
  await withLabels(async () => {
    const { sheet } = openShop();
    assert.equal((await sheet._prepareContext({})).header.openLabel, "OpenUntil(19:00)");
    clock.hour = 3;
    try { assert.equal((await sheet._prepareContext({})).header.openLabel, "ClosedOpensAt(7:00)"); }
    finally { clock.hour = 12; }
  });
});

test("an unidentified good shows the name dnd5e gives it, never its true one, on the rows and the bill", async () => {
  // dnd5e prepares an unidentified item's name as its unidentified one; its source data keeps the true name.
  const unidentified = id => Object.assign(item(id, { price: { value: 20, denomination: "gp" } }), { name: "Unidentified Ring" });
  const secret = obj => { const toObject = obj.toObject; obj.toObject = function () { return { ...toObject.call(this), name: "Ring of Protection" }; }; return obj; };
  const { sheet } = openShop({ shopItems: [secret(unidentified("shelfRing"))], buyerItems: [secret(unidentified("packRing"))] });
  act(sheet, "addLine", { itemId: "shelfRing" });
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "packRing" });
  const { buy, sell } = await sheet._prepareContext({});
  const shown = JSON.stringify({ buy: buy.sections, bill: buy.basket.lines, sell: packRows(sell), sellBill: sell.basket.lines });
  assert.ok(!shown.includes("Ring of Protection"), "the true name never reaches the window");
  assert.equal(buy.sections[0].rows[0].name, "Unidentified Ring");
  assert.equal(buy.basket.lines[0].name, "Unidentified Ring");
});

test("the Sell tab groups the pack by kind of good, and its category narrows only the Sell list", async () => {
  const { sheet } = openShop({
    shopItems: [item("rope"), item("sword", { type: "weapon" })],
    buyerItems: [item("axe", { type: "weapon" }), item("gem"), item("dagger", { type: "weapon" })]
  });
  const { sell: before } = await sheet._prepareContext({});
  assert.deepEqual(before.sections.map(s => [s.group, s.rows.map(r => r.id)]), [["weapons", ["axe", "dagger"]], ["gear", ["gem"]]]);
  assert.deepEqual(before.categories.map(c => [c.id, c.count]), [["all", 3], ["weapons", 2], ["gear", 1]]);

  act(sheet, "selectCategory", { kind: "sell", category: "gear" });
  const { buy, sell } = await sheet._prepareContext({});
  assert.deepEqual(sell.sections.map(s => s.group), ["gear"]);
  assert.equal(sell.categories.find(c => c.active).id, "gear");
  assert.equal(buy.categories.find(c => c.active).id, "all", "the Buy tab keeps its own category");
});

test("the Buyer Picker lists no merchants, and each group alphabetically (design n9I5aQ)", async () => {
  const { sheet, buyer } = openShop();
  const pc = name => Object.assign(actor(name, []), { type: "character" });
  const inn = actor("inn", [], { shop: true });
  const [kess, brom] = [pc("kess"), pc("brom")];
  const tomas = actor("tomas", []);
  globalThis.game.actors.push(inn, kess, brom, tomas);
  globalThis.game.user.isGM = true;
  try {
    const { buyerPicker } = await sheet._prepareContext({});
    assert.deepEqual(buyerPicker.characters.map(e => e.name), ["brom", "kess"]);
    assert.deepEqual(buyerPicker.others.map(e => e.name), ["hero", "tomas"], "no shop, the inn included");
  } finally { globalThis.game.user.isGM = false; }
  // A player sees their own, their assigned character first.
  const { buyerPicker } = await sheet._prepareContext({});
  assert.equal(buyerPicker.actors[0].uuid, buyer.uuid);
});

test("the Fresh chip and New badges show until the shop closes, then clear (#152)", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5, flags: { "merchant-presets": { newAt: 8 * 3600, drawn: true } } })] });
  shop.flags["merchant-presets"].restockedAt = 8 * 3600;      // restocked at 8:00; the shop keeps 7:00-19:00
  const before = globalThis.game.time.worldTime;
  const seen = async () => {
    const { header, buy } = await sheet._prepareContext({});
    return [header.fresh, buy.sections[0].rows[0].isNew];
  };
  try {
    globalThis.game.time.worldTime = 12 * 3600;
    assert.deepEqual(await seen(), [true, true]);
    globalThis.game.time.worldTime = 19 * 3600 + 60;
    assert.deepEqual(await seen(), [false, false]);
  } finally {
    globalThis.game.time.worldTime = before;
  }
});

test("a New good that sells out again loses its badge: New is for goods back in stock (#152 review)", async () => {
  const flags = { "merchant-presets": { newAt: 8 * 3600, drawn: true, stock: { keep: true } } };
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 0, flags })] });
  shop.flags["merchant-presets"].restockedAt = 8 * 3600;
  const before = globalThis.game.time.worldTime;
  try {
    globalThis.game.time.worldTime = 12 * 3600;
    const { buy } = await sheet._prepareContext({});
    const row = buy.sections.flatMap(s => s.rows).find(r => r.id === "rope");
    assert.ok(row, "the sold-out line is still listed");
    assert.equal(row.isNew, false);
  } finally {
    globalThis.game.time.worldTime = before;
  }
});

test("with trading hours off a restock's New lasts a whole day, not until closing or midnight (#152 review)", async () => {
  const { sheet, shop } = openShop({ shopItems: [item("rope", { quantity: 5, flags: { "merchant-presets": { newAt: 18 * 3600, drawn: true } } })] });
  shop.flags["merchant-presets"].shop.hours = { open: { hour: 20, minute: 0 }, close: { hour: 4, minute: 0 } };
  shop.flags["merchant-presets"].restockedAt = 18 * 3600;   // before its 20:00 opening
  globalThis.game.settings.values.tradingHours = false;
  const before = globalThis.game.time.worldTime;
  const seen = async () => {
    const { header, buy } = await sheet._prepareContext({});
    return [header.fresh, buy.sections[0].rows[0].isNew];
  };
  try {
    globalThis.game.time.worldTime = 24 * 3600 + 17 * 3600 + 59 * 60;   // 17:59 the next day: past its closing, midnight and opening
    assert.deepEqual(await seen(), [true, true]);
    globalThis.game.time.worldTime = 24 * 3600 + 18 * 3600;             // a day on
    assert.deepEqual(await seen(), [false, false]);
  } finally {
    globalThis.game.time.worldTime = before;
    globalThis.game.settings.values.tradingHours = true;
  }
});

/* ------------------------------------------------------------- trade states (design WNYhA) */

test("a line that sells out while on the bill is struck off as sold out, and the bill says so (design WNYhA, state 6)", async () => {
  const sword = item("sword", { quantity: 1, price: { value: 15, denomination: "gp" } });
  const { sheet } = openShop({ shopItems: [sword, item("axe", { quantity: 5, price: { value: 5, denomination: "gp" } })] });
  act(sheet, "addLine", { itemId: "sword" });
  act(sheet, "addLine", { itemId: "axe" });
  await sheet._prepareContext({});
  sword.system.quantity = 0;      // someone else bought the last one
  const { buy } = await sheet._prepareContext({});
  assert.equal(buy.seal.state, "stock-changed");
  assert.deepEqual(buy.basket.gone, [{ name: "sword", quantity: 1, pen: "gold 15" }]);
  assert.deepEqual(buy.basket.lines.map(l => l.itemId), ["axe"], "struck off, it isn't on the sum");
  assert.equal(buy.slip.notice.text, "MERCHANT_PRESETS.Shop.Seal.SoldOutNotice");
  assert.equal(buy.slip.notice.first, true, "the notice sits under the slip's head");
  act(sheet, "stepLine", { itemId: "axe", delta: "1" });
  assert.deepEqual((await sheet._prepareContext({})).buy.basket.gone, [], "the next edit is a new bill");
});

test("with no GM at the table a sent bill waits for one, and says so (design WNYhA, state 4)", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  const users = globalThis.game.users;
  globalThis.game.users = { activeGM: null };
  api.trade = async () => ({ status: "no-gm" });
  try {
    act(sheet, "addLine", { itemId: "rope" });
    await act(sheet, "seal");
    const { buy } = await sheet._prepareContext({});
    assert.equal(buy.seal.labelKey, "MERCHANT_PRESETS.Shop.Seal.NoGmWaiting");
    assert.equal(buy.seal.disabled, true);
    assert.equal(buy.slip.notice.text, "MERCHANT_PRESETS.Shop.Seal.NoGmNotice");
    assert.equal(buy.slip.purse, "after", "the purse after still shows while it waits");
  } finally {
    globalThis.game.users = users;
  }
});

test("a sealed bill shows the purse now and what was delivered (design WNYhA, state 2)", async () => {
  const { sheet, buyer } = openShop({ shopItems: [item("rope", { quantity: 5, price: { value: 1, denomination: "gp" } })] });
  act(sheet, "addLine", { itemId: "rope" });
  act(sheet, "stepLine", { itemId: "rope", delta: "1" });
  api.trade = async () => { buyer.system.currency = { gp: 98 }; return { status: "sealed", lines: [{ itemId: "rope", quantity: 2, lineTotalCp: 200 }] }; };
  await withLabels(async () => {
    await act(sheet, "seal");
    const { buy } = await sheet._prepareContext({});
    assert.equal(buy.seal.state, "sealed");
    assert.equal(buy.slip.purse, "now");
    assert.deepEqual(buy.basket.afterCoins.map(c => [c.denomination, c.count]), [["gp", 98]], "the coins it left, not a second payment");
    assert.equal(buy.slip.delivered, "DeliveredBuyMany(2 × rope,hero)");
    assert.equal(buy.slip.totalLabel, "MERCHANT_PRESETS.Shop.Bill.Paid");
    assert.equal(buy.slip.foot, null);
  });
});

test("where shops don't follow the world clock, Settings says so in Hours and Restock and Players see shows no chips (#149, design RRqQ7)", async t => {
  const { sheet } = openSettings(t);
  globalThis.game.settings.values.followClock = "never";
  sheet._settingsSection = "hours";
  const { settings } = await sheet._prepareContext({});
  assert.equal(settings.hours.noClock, true);
  assert.equal(settings.restock.noClock, true);
  assert.deepEqual(settings.preview.hours, { samples: [], noClock: true });
  globalThis.game.settings.values.followClock = "always";
  const clocked = (await sheet._prepareContext({})).settings;
  assert.equal(clocked.hours.noClock, false);
  assert.ok(clocked.preview.hours.samples.length > 0);
});

test("without a world clock, Restock's Players see falls back to the terms, not badges that never show (#149, #161 review)", async t => {
  const { sheet } = openSettings(t);
  globalThis.game.settings.values.followClock = "never";
  sheet._settingsSection = "restock";
  assert.equal((await sheet._prepareContext({})).settings.preview.restock, null);
  globalThis.game.settings.values.followClock = "always";
  assert.ok((await sheet._prepareContext({})).settings.preview.restock);
});

/* -------------------------------------------------------------- Till (#147, design U0HcWc / Yusa2) */

test("Settings has a Till section after Restock (#147, design U0HcWc)", async t => {
  const { sheet } = openSettings(t);
  const { settings } = await sheet._prepareContext({});
  assert.deepEqual(settings.sections.map(s => s.id), ["terms", "deals", "wontBuy", "hours", "restock", "till"]);
  assert.equal(settings.sections.at(-1).icon, "lucide:coins");
});

test("the Till section shows every coin the shop holds, what a restock refills it to and the preset's (#147)", async t => {
  const { sheet, shop } = openSettings(t);
  shop.system.currency = { pp: 0, gp: 212, ep: 0, sp: 3, cp: 0 };
  shop.flags["merchant-presets"].purse = 500;
  const { till } = (await sheet._prepareContext({})).settings;
  assert.deepEqual(till.coins.map(c => [c.denomination, c.count]), [["pp", 0], ["gp", 212], ["ep", 0], ["sp", 3], ["cp", 0]]);
  assert.equal(till.purseGp, 500);
  assert.equal(till.presetGp, 800);
  assert.equal(till.unlimited, false);
});

test("a shop with no refill amount shows the field blank, and no preset line without a preset (#147)", async t => {
  const { sheet, shop } = openSettings(t);
  delete shop.flags["merchant-presets"].purse;
  globalThis.fromUuid = async () => null;
  const { till } = (await sheet._prepareContext({})).settings;
  assert.equal(till.purseGp, null);
  assert.equal(till.presetGp, null);
});

test("under unlimited merchant coin the Till section is a note, and Players see has no till card (#147, design Yusa2)", async t => {
  const { sheet } = openSettings(t);
  globalThis.game.settings.values.merchantPurse = "unlimited";
  sheet._settingsSection = "till";
  const { settings } = await sheet._prepareContext({});
  assert.equal(settings.till.unlimited, true);
  assert.deepEqual(settings.preview.till, { card: null });
});

test("jumped to Till, Players see shows the Sell tab's till card: the coins held, no meter (#147, design U0HcWc)", async t => {
  const { sheet, shop } = openSettings(t);
  shop.system.currency = { pp: 0, gp: 212, ep: 0, sp: 0, cp: 0 };
  sheet._settingsSection = "till";
  const { preview } = (await sheet._prepareContext({})).settings;
  assert.deepEqual(preview.till.card.coins.map(c => [c.denomination, c.count]), [["gp", 212]]);
  sheet._settingsSection = "restock";
  assert.equal((await sheet._prepareContext({})).settings.preview.till, null);
});

test("a coin count the GM types is written to the shop's own currency, that coin alone (#147)", async t => {
  const { sheet, shop } = openSettings(t);
  await change(sheet, { op: "till", denomination: "sp" }, { value: "40" });
  assert.deepEqual(shop.updates, [{ "system.currency.sp": 40 }]);
});

test("a refill amount the GM types is written to the shop's purse flag (#147)", async t => {
  const { sheet, shop } = openSettings(t);
  await change(sheet, { op: "purse" }, { value: "1200" });
  assert.deepEqual(shop.updates, [{ "flags.merchant-presets.purse": 1200 }]);
});

test("a till or refill that isn't a whole number of coins is refused, the field put back and nothing written (#147)", async t => {
  const { sheet, shop, warnings } = openSettings(t);
  for (const value of ["-5", "2.5", "", "lots"]) {
    await change(sheet, { op: "till", denomination: "gp" }, { value });
    await change(sheet, { op: "purse" }, { value });
  }
  assert.deepEqual(shop.updates, []);
  assert.equal(warnings.length, 8);
  assert.ok(sheet._resetTyping, "the field goes back to what the shop holds");
});

test("a coin the world's currencies don't have is never written (#147)", async t => {
  const { sheet, shop } = openSettings(t);
  await change(sheet, { op: "till", denomination: "zz" }, { value: "4" });
  assert.deepEqual(shop.updates, []);
});

test("under unlimited merchant coin the till fields write nothing (#147, design Yusa2)", async t => {
  const { sheet, shop } = openSettings(t);
  globalThis.game.settings.values.merchantPurse = "unlimited";
  await change(sheet, { op: "till", denomination: "gp" }, { value: "4" });
  await change(sheet, { op: "purse" }, { value: "4" });
  assert.deepEqual(shop.updates, []);
});
