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
  modules: { get: () => ({ api }) },
  settings: { values: { merchantPurse: "finite", tradingHours: true, stockMode: "finite" }, get(_module, key) { return this.values[key]; } },
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

function actor(id, items, { permission = OWNERSHIP.OWNER, currency = { gp: 100 } } = {}) {
  return {
    id, uuid: `Actor.${id}`, name: id, type: "npc", flags: { "merchant-presets": { shop: structuredClone(SHOP_DEFAULTS) } },
    system: { currency },
    items: collection(items),
    // Foundry takes a level's number or its name ("OWNER").
    testUserPermission: (_user, level) => permission >= (OWNERSHIP[level] ?? level)
  };
}

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
  assert.deepEqual([...sell.willBuy, ...sell.wontBuy].map(r => r.id), ["gem"]);
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
  assert.deepEqual(sell.willBuy.map(r => r.id), []);
  assert.deepEqual(sell.wontBuy.map(r => r.id), ["gem"]);
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
  assert.deepEqual(sell.willBuy.map(r => r.id), []);
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
  assert.deepEqual([...sell.willBuy, ...sell.wontBuy].map(r => r.id), ["gem"]);
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
  globalThis.fromUuid = async uuid => (uuid === PRESET_UUID ? { flags: { "merchant-presets": { shop: preset } } } : null);
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
  api.restock = async actor => { restocked.push(actor); return []; };
  t.after(() => { delete api.restock; });
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
  for (const key of ["sellsAt", "buysAt", "stockMode", "merchantPurse", "tradingHours", "autoRestock"]) {
    fire("updateSetting", { key: `merchant-presets.${key}` });
  }
  assert.equal(sheet.renders, renders + 6);
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
  const { sheet } = openSettings(t, { shopConfig: { terms: { sellsAt: 0.4, buysAt: null, categories: [] } } });
  const { settings } = await sheet._prepareContext({});
  // Never buys above what it sells at: the world's half is capped to 40%, as the chip and trades say.
  assert.equal(settings.terms.buys.word, "40%");
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
  assert.equal((await sheet._prepareContext({})).settings.restock.next, `t${14 * 86400}`);
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

test("the category picked in Add rule survives a re-render (#140 review, round 7)", async t => {
  const { sheet } = openSettings(t);
  sheet._ruleChoice = "tool";   // what the select's change listener notes
  const { settings } = await sheet._prepareContext({});
  assert.deepEqual(settings.terms.ruleChoices.filter(c => c.selected).map(c => c.value), ["tool"]);
});

test("the Settings tab keeps its scroll position across re-renders (#140 review, round 7)", () => {
  assert.ok(ShopSheet.PARTS.body.scrollable.includes(".settings-body"));
});

test("a restock that can't run says so without blaming a missing table", async t => {
  const { sheet, warnings } = openSettings(t);
  api.restock = async () => null;
  t.after(() => { delete api.restock; });
  await act(sheet, "restockNow");
  assert.deepEqual(warnings, ["MERCHANT_PRESETS.Shop.Settings.Restock.Failed"]);
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url)));
  assert.doesNotMatch(lang.MERCHANT_PRESETS.Shop.Settings.Restock.Failed, /table is missing/);
});
