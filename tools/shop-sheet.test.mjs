/**
 * The shop window's own behaviour (#103), driven through its registered actions under plain Node.
 * The base class stands in for V14's ActorSheetV2 only where the window relies on it: the
 * `isEditable` gate `DocumentSheetV2#_onRender` applies (document-sheet.mjs: a user below
 * `editPermission` gets every form control disabled), `tabGroups` and `render`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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
globalThis.foundry = {
  applications: {
    sheets: { ActorSheetV2 },
    api: { HandlebarsApplicationMixin: Base => Base },
    apps: { DocumentSheetConfig: { registerSheet() {} } }
  },
  utils: { randomID: () => "trade00000000001" }
};
globalThis.ui = { notifications: { warn() {} } };
const api = {};
globalThis.game = {
  user: { isGM: false, character: null },
  modules: { get: () => ({ api }) },
  actors: [],
  i18n: { localize: key => key },
  // Noon on a 24-hour day: inside the shop's default 07:00-19:00.
  time: {
    worldTime: 0,
    calendar: {
      days: { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 },
      timeToComponents: () => ({ hour: 12, minute: 0 }),
      format: () => ""
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
  return { id, ...data, toObject: () => structuredClone(data) };
}

function actor(id, items, { permission = OWNERSHIP.OWNER, currency = { gp: 100 } } = {}) {
  return {
    id, uuid: `Actor.${id}`, name: id, type: "npc", flags: { "merchant-presets": { shop: structuredClone(SHOP_DEFAULTS) } },
    system: { currency },
    items: collection(items),
    testUserPermission: (_user, level) => permission >= level
  };
}

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

test("a retry after an unconfirmed trade resends the same tradeId, so it can't land twice", async () => {
  const { sheet } = openShop({ shopItems: [item("rope", { quantity: 5 })] });
  act(sheet, "addLine", { itemId: "rope" });
  const ids = [];
  let n = 0;
  globalThis.foundry.utils.randomID = () => `trade${String(++n).padStart(11, "0")}`;
  api.trade = async request => { ids.push(request.tradeId); return { status: "unconfirmed" }; };
  await act(sheet, "seal");
  await act(sheet, "seal");
  act(sheet, "stepLine", { itemId: "rope", delta: "1" });
  await act(sheet, "seal");
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test("the Sell bill's purse-after is the seller's purse plus the sale, not the till's", async () => {
  const { sheet } = openShop({ buyerItems: [item("gem", { price: { value: 14, denomination: "gp" } })] });
  sheet.document.system.currency = { gp: 200 };
  sheet.tabGroups.primary = "sell";
  act(sheet, "addLine", { itemId: "gem" });
  const { sell } = await sheet._prepareContext({});
  assert.deepEqual(sell.basket.afterCoins.map(c => [c.denomination, c.count]), [["pp", 10], ["gp", 7]]);
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
