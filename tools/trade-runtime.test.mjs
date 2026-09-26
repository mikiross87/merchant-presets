import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// The #102 trade runtime, driven through the real merchant-presets.mjs: the
// CONFIG.queries handler, api.trade, the writes, the hook and the receipt.
// The rules around it (serial, outcomes, checkParties, ...) are unit-tested in
// tools/trade-desk.test.mjs, and planTrade itself in tools/trade-plan.test.mjs;
// this checks they're wired together. One stub client plays the GM's claiming
// tab; `asPlayer` swaps in the player who asks.

const BELL = "FYvUPYlkE83ShQOU";   // General Store (Town): 11 Bells at 1 gp, finite
const ROPE = "0wfKo0RNo9Yf0S0e";   // 7 Rope at 1 gp, a consumable (stacks)
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setUp() {
  const world = createWorld();
  await loadRuntime(world);
  const shop = world.merchant("General_Store_Town_");
  world.actors.push(shop);
  const tess = world.character("tess", { currency: { gp: 20 }, owners: ["p1"] });
  const api = globalThis.game.modules.get("merchant-presets").api;
  const request = (lines, over = {}) => ({
    tradeId: over.tradeId ?? globalThis.foundry.utils.randomID(), kind: over.kind ?? "buy",
    shopUuid: shop.uuid, buyerUuid: over.buyerUuid ?? tess.uuid, lines
  });
  return { world, shop, tess, api, request };
}

/** Run `fn` as a player: `api.trade` asks as them, while the GM's tab answers as itself. */
async function asPlayer(fn, id = "p1") {
  const gm = globalThis.game.user;
  const player = { id, isGM: false, hasPermission: () => true };
  const query = gm.query;
  gm.query = async (name, data) => {
    const asking = globalThis.game.user;
    globalThis.game.user = gm;
    try { return await globalThis.CONFIG.queries[name](data, { user: asking }); }
    finally { globalThis.game.user = asking; }
  };
  globalThis.game.user = player;
  try { return await fn(); }
  finally { globalThis.game.user = gm; gm.query = query; }
}

const qty = (actor, id) => actor.items.find(i => i._id === id)?.system.quantity;
const named = (actor, name) => actor.items.filter(i => i.name === name);

test("a player's purchase lands: goods on the character, coin in the till, stock down", async () => {
  const { shop, tess, api, request } = await setUp();
  shop.ownership = { default: 1 };
  const result = await asPlayer(() => api.trade(request([{ itemId: BELL, quantity: 2, expectedBundlePriceCp: 100 }])));
  assert.equal(result.status, "sealed", JSON.stringify(result));
  assert.deepEqual(result.lines, [{ itemId: BELL, quantity: 2, lineTotalCp: 200 }]);
  assert.equal(qty(shop, BELL), 9);
  assert.deepEqual(named(tess, "Bell").map(b => b.system.quantity), [2]);
  assert.equal(named(tess, "Bell")[0].flags["merchant-presets"]?.stock, undefined, "shelf flags stay on the shelf");
  assert.equal(tess.system.currency.gp, 18);
  assert.equal(shop.system.currency.gp, 252);
});

test("a trade resent after the claim moved to a fresh tab is still carried out only once (#134 review)", async () => {
  const { world, shop, tess, request } = await setUp();
  const first = request([{ itemId: ROPE, quantity: 1 }], { tradeId: "moved0000000001" });
  const sealed = await globalThis.game.modules.get("merchant-presets").api.trade(first);
  assert.equal(sealed.status, "sealed");
  await loadRuntime(world);   // the claiming tab reloads (or another takes over): its memory is empty
  const shelf = qty(shop, ROPE);   // (the reload's own wiring may re-roll the shelf; only the resend matters)
  const again = await globalThis.game.modules.get("merchant-presets").api.trade({ ...first, lines: [{ itemId: ROPE, quantity: 1 }] });
  assert.equal(again.status, "sealed");
  assert.deepEqual(again.lines, sealed.lines, "the first trade's lines");
  assert.equal(qty(shop, ROPE), shelf);
  assert.deepEqual(named(tess, "Rope").map(r => r.system.quantity), [1]);
  assert.equal(tess.system.currency.gp, 19);
});

test("a trade whose shop half never landed isn't recorded as sealed (#134 review, round 3)", async () => {
  const { world, shop, request } = await setUp();
  const write = shop.updateEmbeddedDocuments;
  shop.updateEmbeddedDocuments = async () => { throw new Error("stub: the claiming tab died here"); };
  const error = console.error;
  console.error = () => {};
  const first = request([{ itemId: BELL, quantity: 1 }], { tradeId: "halfway00000001" });
  try { await globalThis.game.modules.get("merchant-presets").api.trade(first); }
  finally { console.error = error; shop.updateEmbeddedDocuments = write; }
  await loadRuntime(world);   // another tab takes the claim
  const shelf = qty(shop, BELL);
  const again = await globalThis.game.modules.get("merchant-presets").api.trade(first);
  assert.equal(again.status, "sealed");
  assert.equal(qty(shop, BELL), shelf - 1, "the resend carried the shop's half out, rather than answering from a record");
});

test("a claim-alive from a tab that doesn't hold the claim keeps nobody waiting (#134 review, round 3)", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { world } = await setUp();
  const gm = globalThis.game.user;
  gm.flags["merchant-presets"].tradeTab = "dead-tab";
  for (let s = 0; s < 60; s += 10) {
    t.mock.timers.tick(10_000);
    world.receive("module.merchant-presets", { type: "claim-alive", userId: "gm", tabId: "forged-tab" });
  }
  await tick();
  assert.notEqual(gm.flags["merchant-presets"].tradeTab, "dead-tab");
});

test("a player whose role can't query users is told so, not left unconfirmed (#134 review)", async () => {
  const { shop, api, request } = await setUp();
  shop.ownership = { default: 1 };
  const told = [];
  globalThis.ui.notifications.warn = message => told.push(message);
  const result = await asPlayer(() => {
    globalThis.game.user.hasPermission = permission => permission !== "QUERY_USER";
    return api.trade(request([{ itemId: BELL, quantity: 1 }]));
  });
  assert.deepEqual(result, { status: "refused", reason: "no-permission" });
  assert.equal(told.length, 1);
  assert.match(told[0], /permission/i);
  assert.equal(qty(shop, BELL), 11);
});

test("a shop in a compendium is refused before anything is written (#134 review)", async () => {
  const { shop, tess, api, request } = await setUp();
  shop.pack = "merchant-presets.merchants";
  const result = await api.trade(request([{ itemId: BELL, quantity: 1 }]));
  assert.deepEqual([result.status, result.reason], ["refused", "invalid-request"]);
  assert.equal(tess.system.currency.gp, 20);
  assert.equal(named(tess, "Bell").length, 0);
});

test("a sale lands: the item leaves the character, the shop pays exactly", async () => {
  const { shop, tess, api, request } = await setUp();
  tess.items.push({ _id: "ownedRope000001", id: "ownedRope000001", name: "Rope", type: "consumable",
    system: { quantity: 2, price: { value: 1, denomination: "gp" } }, flags: {} });
  const result = await api.trade(request([{ itemId: "ownedRope000001", quantity: 2 }], { kind: "sell" }));
  assert.equal(result.status, "sealed", JSON.stringify(result));
  assert.equal(named(tess, "Rope").length, 0);
  assert.equal(tess.system.currency.gp, 21, "2 rope at half of 1 gp");
  assert.equal(shop.system.currency.gp, 249);
});

test("a resent trade id gets the first outcome and is never carried out twice, even with other lines", async () => {
  const { shop, tess, api, request } = await setUp();
  const first = request([{ itemId: BELL, quantity: 1 }], { tradeId: "resent000000001" });
  const [a, b] = await Promise.all([api.trade(first), api.trade(first)]);
  const c = await api.trade({ ...first, lines: [{ itemId: BELL, quantity: 5 }] });
  assert.deepEqual([a, b, c].map(r => r.status), ["sealed", "sealed", "sealed"]);
  assert.deepEqual(c.lines, [{ itemId: BELL, quantity: 1, lineTotalCp: 100 }], "the first trade's lines");
  assert.equal(qty(shop, BELL), 10);
  assert.equal(named(tess, "Bell").length, 1);
});

test("two buyers racing for the last one: one gets it, the other is told it's gone", async () => {
  const { world, shop, tess, api, request } = await setUp();
  shop.items.find(i => i._id === BELL).system.quantity = 1;
  const kit = world.character("kit", { currency: { gp: 20 }, owners: ["p2"] });
  const [first, second] = await Promise.all([
    api.trade(request([{ itemId: BELL, quantity: 1 }])),
    api.trade(request([{ itemId: BELL, quantity: 1 }], { buyerUuid: kit.uuid }))
  ]);
  assert.equal(first.status, "sealed");
  assert.deepEqual([second.status, second.reason], ["refused", "out-of-stock"]);
  assert.equal(named(tess, "Bell").length + named(kit, "Bell").length, 1);
  assert.equal(shop.system.currency.gp, 251);
});

test("a player can't trade on behalf of a character they don't own", async () => {
  const { shop, tess, api, request } = await setUp();
  shop.ownership = { default: 1 };
  const result = await asPlayer(() => api.trade(request([{ itemId: BELL, quantity: 1 }])), "p2");
  assert.deepEqual([result.status, result.reason], ["refused", "invalid-request"]);
  assert.equal(qty(shop, BELL), 11);
  assert.equal(tess.system.currency.gp, 20);
});

test("a shop outside its hours refuses, when trading hours are on", async () => {
  const { world, api, request } = await setUp();
  world.settings.tradingHours = true;
  globalThis.game.time.calendar.timeToComponents = () => ({ hour: 22, minute: 0 });
  globalThis.game.time.calendar.days = { minutesPerHour: 60, hoursPerDay: 24 };
  const result = await api.trade(request([{ itemId: BELL, quantity: 1 }]));
  assert.deepEqual([result.status, result.reason], ["refused", "closed"]);
});

test("no GM connected reads as no-gm; a query that fails reads as unconfirmed", async () => {
  const { api, request } = await setUp();
  const gm = globalThis.game.users.activeGM;
  globalThis.game.users.activeGM = null;
  assert.deepEqual(await api.trade(request([{ itemId: BELL, quantity: 1 }])), { status: "no-gm" });
  globalThis.game.users.activeGM = gm;
  const query = gm.query;
  gm.query = async () => { throw new Error("The operation has timed out"); };
  const warn = console.warn;
  console.warn = () => {};
  try { assert.deepEqual(await api.trade(request([{ itemId: BELL, quantity: 1 }])), { status: "unconfirmed" }); }
  finally { gm.query = query; console.warn = warn; }
});

test("a GM tab without the trade claim never answers", async () => {
  const { shop, request } = await setUp();
  globalThis.game.user.flags["merchant-presets"].tradeTab = "another-tab";
  const answer = Promise.resolve(globalThis.CONFIG.queries["merchant-presets.trade"](request([{ itemId: BELL, quantity: 1 }]), { user: globalThis.game.user }));
  const winner = await Promise.race([answer.then(() => "answered"), tick().then(() => "silent")]);
  assert.equal(winner, "silent");
  assert.equal(qty(shop, BELL), 11);
});

test("the tab that loads claims trades, and takes the claim back when it's given up", async () => {
  const { world } = await setUp();
  const gm = globalThis.game.user;
  const claim = gm.flags["merchant-presets"].tradeTab;
  assert.equal(typeof claim, "string");
  delete gm.flags["merchant-presets"].tradeTab;
  await world.fire("updateUser", gm, {});
  assert.equal(gm.flags["merchant-presets"].tradeTab, claim);
});

test("a GM tab takes the claim over from a claiming tab that has gone quiet, not from one still talking", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { world } = await setUp();
  const gm = globalThis.game.user;
  const alive = () => world.receive("module.merchant-presets", { type: "claim-alive", userId: "gm", tabId: "other-tab" });
  gm.flags["merchant-presets"].tradeTab = "other-tab";   // another tab opened later and claimed
  alive();
  for (let s = 0; s < 60; s += 10) { t.mock.timers.tick(10_000); alive(); }
  assert.equal(gm.flags["merchant-presets"].tradeTab, "other-tab", "a claimer that keeps saying so keeps the claim");

  t.mock.timers.tick(40_000);   // it closed without its unload write landing (the #102 live run)
  await tick();
  assert.notEqual(gm.flags["merchant-presets"].tradeTab, "other-tab");
  assert.equal(typeof gm.flags["merchant-presets"].tradeTab, "string");
});

test("the claiming tab says so on the socket, so the others know it's still there", async t => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { world } = await setUp();
  t.mock.timers.tick(10_000);
  const said = world.calls.socket.filter(s => s.message.type === "claim-alive");
  assert.equal(said.length, 1);
  assert.equal(said[0].message.tabId, globalThis.game.user.flags["merchant-presets"].tradeTab);
});

test("a trade is heard on this client and sent to every other, then posts one receipt", async () => {
  const { world, shop, api, request } = await setUp();
  const heard = [];
  globalThis.Hooks.on("merchant-presets.trade", (trade, where) => heard.push({ trade, where }));
  await api.trade(request([{ itemId: ROPE, quantity: 1 }], { tradeId: "heard0000000001" }));
  assert.equal(heard.length, 1);
  assert.equal(heard[0].where.carriedOut, true);
  assert.equal(heard[0].trade.shopUuid, shop.uuid);
  assert.equal(heard[0].trade.lines[0].item.name, "Rope");
  const sent = world.calls.socket.filter(s => s.name === "module.merchant-presets");
  assert.deepEqual(sent.map(s => s.message.trade.tradeId), ["heard0000000001"]);

  world.receive("module.merchant-presets", sent[0].message);
  assert.equal(heard[1].where.carriedOut, false, "another client hears it, but didn't make the writes");

  const receipts = world.calls.messages.filter(m => m.content.includes("mp-receipt"));
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].whisper, []);
  assert.match(receipts[0].content, /bought from/);
});

test("the receipt follows the trade chat setting", async () => {
  const { world, api, request } = await setUp();
  world.settings.tradeChat = "gm";
  await api.trade(request([{ itemId: ROPE, quantity: 1 }]));
  world.settings.tradeChat = "off";
  await api.trade(request([{ itemId: ROPE, quantity: 1 }]));
  const receipts = world.calls.messages.filter(m => m.content.includes("mp-receipt"));
  assert.deepEqual(receipts.map(m => m.whisper), [["gm"]]);
});

test("bought spellcasting is announced by the client that asked, at the trade chat's visibility", async () => {
  const world = createWorld();
  await loadRuntime(world);
  const temple = world.merchant("Temple_Faith_Store_Town_");
  world.actors.push(temple);
  const aria = world.character("aria", { currency: { gp: 1000 }, owners: ["p1"] });
  world.settings.tradeChat = "gm";
  const level3 = temple.items.find(i => i.name === "Spellcasting: Level 3");
  const api = globalThis.game.modules.get("merchant-presets").api;
  const result = await api.trade({ tradeId: "cast00000000001", kind: "buy", shopUuid: temple.uuid, buyerUuid: aria.uuid,
    lines: [{ itemId: level3._id, quantity: 1 }] });
  await tick();
  assert.equal(result.status, "sealed", JSON.stringify(result));
  const [message, ...more] = world.calls.messages.filter(m => m.content.includes("Spellcasting: Level 3. Tell the GM which spell."));
  assert.equal(more.length, 0);
  assert.deepEqual(message.whisper, ["gm"]);
  assert.equal(named(aria, "Spellcasting: Level 3").length, 0, "a service hands nothing over");
});

test("a write that fails part-way is refused as an error, not reported sealed", async () => {
  const { shop, tess, api, request } = await setUp();
  tess.createEmbeddedDocuments = async () => { throw new Error("stub: create failed"); };
  const error = console.error;
  console.error = () => {};
  try {
    const result = await api.trade(request([{ itemId: BELL, quantity: 1 }]));
    assert.deepEqual(result, { status: "refused", reason: "error" });
  } finally { console.error = error; }
  assert.ok(shop);
});
