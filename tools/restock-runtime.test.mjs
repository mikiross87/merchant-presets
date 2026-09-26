import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime, source } from "./foundry-stub.mjs";

// #105's restock on the world clock, driven through the real merchant-presets.mjs: the
// schedule (schedule.mjs's dueRestock/planRestock, unit-tested in tools/schedule.test.mjs)
// wired to updateWorldTime, the shop's own stock table and the trade queue.

const DAY = 24 * 60 * 60;
const at = (day, hour = 0) => day * DAY + hour * 3600;
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A world with General Store (Town) (open 07:00-19:00, restocks every 3 days) and automatic restocking on. */
async function setUp() {
  const world = createWorld();
  world.settings.autoRestock = true;
  globalThis.game.time.calendar.days = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
  globalThis.game.time.calendar.timeToComponents = t => ({ hour: Math.floor((t % DAY) / 3600), minute: 0 });
  // Settled in the world (1.x wired it to a world table), not fresh from the pack: the schedule, not
  // an arrival, gives it its first restock.
  const shop = world.merchant("General_Store_Town_", { table: "RollTable.worldCopy000001" });
  world.actors.push(shop);
  // Each stock table line's document, as the compendium serves it: the shelf's own copy, stripped
  // of what this shop stamped on it.
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  for (const result of table.results) {
    const onShelf = shop.items.find(i => i.name === result.name);
    const name = result.name;   // the item's own name, fixed: relabelling the table line doesn't rename it
    world.compendium.set(result.documentUuid, {
      name,
      toObject: () => ({ name, type: onShelf?.type ?? "loot", img: "x.webp",
        system: { quantity: 1, price: structuredClone(onShelf?.system.price ?? { value: 1, denomination: "gp" }) }, flags: {} })
    });
  }
  await loadRuntime(world);
  const clock = async (worldTime) => { globalThis.game.time.worldTime = worldTime; await world.fire("updateWorldTime", worldTime, 0); await tick(); };
  return { world, shop, clock };
}

/** Make the shop's stock table unfindable, wherever it lives (the compendium's, or a world copy); returns an undo. */
function hideTable(world, shop) {
  const uuid = shop.flags["merchant-presets"].shop.restock.table;
  const packed = world.compendium.get(uuid);
  const index = world.tables.findIndex(t => t.uuid === uuid);
  const [worldCopy] = index === -1 ? [] : world.tables.splice(index, 1);
  world.compendium.delete(uuid);
  return () => { if (packed) world.compendium.set(uuid, packed); if (worldCopy) world.tables.push(worldCopy); };
}

const byName = (shop, name) => shop.items.filter(i => i.name === name);
const drawn = item => !!item.flags?.["merchant-presets"]?.drawn;

test("the first tick a shop is seen adopts its shelf as drawn and schedules it, without restocking", async () => {
  const { shop, clock } = await setUp();
  const ids = shop.items.map(i => i._id).sort();
  await clock(at(0, 1));
  assert.deepEqual(shop.items.map(i => i._id).sort(), ids, "nothing redrawn yet");
  assert.ok(byName(shop, "Bell").every(drawn));
  assert.ok(!byName(shop, "Club").some(drawn), "the shopkeeper's own club is gear, not stock");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(0, 1), dueAt: at(3), every: 3 });
});

test("on the due day's opening the shelf is redrawn: hand-added goods, gear and a GM's stock edit all survive", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  await shop.createEmbeddedDocuments("Item", [{ _id: "handAdded000001", name: "Grandma's Locket", type: "loot", system: { quantity: 1 }, flags: {} }]);
  byName(shop, "Bell")[0].flags["merchant-presets"].stock.hidden = true;   // the GM hid the bells
  const oldBell = byName(shop, "Bell")[0]._id;

  await clock(at(2, 12));   // day 2: not due yet
  assert.equal(byName(shop, "Bell")[0]._id, oldBell);

  await clock(at(3, 8));    // day 3, past the 07:00 opening
  const [bell, ...more] = byName(shop, "Bell");
  assert.equal(more.length, 0, "one Bell line, not a second shelf beside the first");
  assert.notEqual(bell._id, oldBell, "redrawn");
  assert.ok(drawn(bell));
  assert.equal(bell.flags["merchant-presets"].stock.hidden, true, "the GM's edit came through the reroll");
  assert.equal(byName(shop, "Grandma's Locket").length, 1);
  assert.equal(byName(shop, "Club").length, 1);
  assert.equal(byName(shop, "Waterskin").length, 3, "containers come back as their recorded count of documents");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(3, 7), dueAt: at(6), every: 3 });
});

test("a skipped week restocks once; rewinding the clock never does", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  const creates = () => world.calls.writes.filter(w => w.type === "actorUpdate" && w.changes["flags.merchant-presets.schedule"]).length;
  await clock(at(10, 12));
  assert.equal(creates(), 2, "first sight, then one restock");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(10, 7), dueAt: at(13), every: 3 });
  await clock(at(4, 12));   // rewound
  assert.equal(creates(), 2);
});

test("with automatic restocking off, the clock redraws nothing", async () => {
  const world = createWorld();
  world.settings.autoRestock = false;
  const shop = world.merchant("General_Store_Town_");
  world.actors.push(shop);
  await loadRuntime(world);
  await world.fire("updateWorldTime", at(9, 12), 0);
  await tick();
  assert.equal(shop.flags["merchant-presets"].schedule ?? null, null);
});

test("a restock waits for a trade in progress on the same queue", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  const tess = world.character("tess", { currency: { gp: 20 } });
  let release;
  const write = tess.createEmbeddedDocuments;
  tess.createEmbeddedDocuments = async (...args) => { await new Promise(r => { release = r; }); return write.apply(tess, args); };
  const bell = byName(shop, "Bell")[0];
  const trade = globalThis.game.modules.get("merchant-presets").api.trade({
    tradeId: "queued000000001", kind: "buy", shopUuid: shop.uuid, buyerUuid: tess.uuid, lines: [{ itemId: bell._id, quantity: 1 }] });
  await tick();
  const restock = globalThis.game.modules.get("merchant-presets").api.restock(shop);
  await tick();
  assert.equal(byName(shop, "Bell")[0]._id, bell._id, "the restock hasn't touched the shelf mid-trade");
  release();
  assert.equal((await trade).status, "sealed");
  await restock;
  assert.notEqual(byName(shop, "Bell")[0]._id, bell._id, "then it ran");
});

test("an assistant GM's client never restocks: only the active GM does (#135 review)", async () => {
  const { shop, clock } = await setUp();
  globalThis.game.users.activeGM = { id: "other-gm", isGM: true };
  await clock(at(0, 1));
  assert.equal(shop.flags["merchant-presets"].schedule ?? null, null);
});

test("Restock now is carried out by the tab holding the trade claim, as a trade is (#140 review, round 8)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const gm = globalThis.game.users.activeGM;
  const asked = [];
  const query = gm.query;
  gm.query = (name, data, options) => { asked.push(name); return query.call(gm, name, data, options); };
  const bell = byName(shop, "Bell")[0];
  const restocked = await globalThis.game.modules.get("merchant-presets").api.restock(shop);
  gm.query = query;
  assert.deepEqual(asked, ["merchant-presets.restock"]);
  assert.ok(Array.isArray(restocked));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell._id, "the claiming tab restocked it");
});

test("a player can't restock a shop through the query (#140 review, round 8)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0];
  const answer = await globalThis.CONFIG.queries["merchant-presets.restock"]({ shopUuid: shop.uuid }, { user: { id: "player", isGM: false } });
  assert.deepEqual(answer, { restocked: null });
  assert.equal(byName(shop, "Bell")[0]._id, bell._id);
});

test("turning restocking off mid-session stops it at the next tick (#135 review)", async () => {
  const { world, shop, clock } = await setUp();
  world.settings.autoRestock = false;   // what migrateShop does when a 1.x merchant arrives
  await clock(at(0, 1));
  assert.equal(shop.flags["merchant-presets"].schedule ?? null, null);
});

test("a shop whose stock table is missing isn't scheduled until it's found, so its shelf is adopted first (#135 review)", async () => {
  const { world, shop, clock } = await setUp();
  const restore = hideTable(world, shop);
  await clock(at(0, 1));
  assert.equal(shop.flags["merchant-presets"].schedule ?? null, null);
  restore();
  await clock(at(0, 2));
  assert.ok(byName(shop, "Bell").every(drawn));
  assert.ok(shop.flags["merchant-presets"].schedule);
});

test("a due shop whose table has gone isn't reported as restocked (#135 review)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  hideTable(world, shop);
  const told = [];
  globalThis.ui.notifications.info = message => told.push(message);
  const warn = console.warn;
  console.warn = () => {};
  try { await clock(at(3, 8)); } finally { console.warn = warn; }
  assert.deepEqual(told, []);
});

/** The shop's stock table, wherever it lives (the compendium's, or a world copy). */
const tableOf = (world, shop) => {
  const uuid = shop.flags["merchant-presets"].shop.restock.table;
  return world.compendium.get(uuid) ?? world.tables.find(t => t.uuid === uuid);
};

test("a restock that couldn't run keeps the shop due, and it restocks at the next opening (#135 review, round 3)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  const restore = hideTable(world, shop);
  const bell = byName(shop, "Bell")[0]._id;
  const warn = console.warn;
  console.warn = () => {};
  try { await clock(at(3, 8)); } finally { console.warn = warn; }
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(0, 1), dueAt: at(3), every: 3 }, "still due");
  restore();
  await clock(at(4, 8));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell, "restocked a day late rather than a cycle late");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(4, 7), dueAt: at(7), every: 3 });
});

test("a hidden line that sells out and leaves the shelf comes back hidden (#135 review, round 4)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0];
  bell.flags["merchant-presets"].stock.hidden = true;
  await clock(at(3, 8));                                     // restocked: the shop notes each line's settings
  await shop.deleteEmbeddedDocuments("Item", byName(shop, "Bell").map(b => b._id));   // sold out, keep: false
  await clock(at(6, 8));
  const [back] = byName(shop, "Bell");
  assert.equal(back.flags["merchant-presets"].stock.hidden, true);
});

test("a second manual restock doesn't adopt a same-named good the GM added by hand since (#135 review, round 5)", async () => {
  const { shop } = await setUp();
  const api = globalThis.game.modules.get("merchant-presets").api;
  await api.restock(shop);                          // never scheduled (a 1.x world with the switch off)
  await shop.createEmbeddedDocuments("Item", [{ _id: "myOwnRope00001", name: "Rope", type: "consumable", system: { quantity: 2 }, flags: {} }]);
  await api.restock(shop);
  assert.ok(shop.items.some(i => i._id === "myOwnRope00001"), "the GM's own Rope stays");
});

test("a restock that fails part-way has already noted each line's settings (#135 review, round 5)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  byName(shop, "Bell")[0].flags["merchant-presets"].stock.hidden = true;
  shop.createEmbeddedDocuments = async () => { throw new Error("stub: a create failed validation"); };
  const error = console.error;
  console.error = () => {};
  try { await clock(at(3, 8)); } finally { console.error = error; }
  assert.equal(shop.flags["merchant-presets"].lines?.find(l => l.name === "Bell")?.stock?.hidden, true);
});

test("a duplicated shop still knows its own shelf: one line each, not a second shelf (#135 review, round 6)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));                              // adopted and scheduled
  const copy = world.merchant("General_Store_Town_");
  copy._id = copy.id = "copyOfTheStore0";
  copy.uuid = "Actor.copyOfTheStore0";
  copy.flags = structuredClone(shop.flags);
  copy.items.splice(0, copy.items.length);
  await copy.createEmbeddedDocuments("Item", shop.items.map(i => i.toObject()));
  world.actors.push(copy);
  await clock(at(3, 8));
  assert.equal(byName(copy, "Bell").length, 1);
  assert.notEqual(byName(copy, "Bell")[0]._id, byName(shop, "Bell")[0]._id);
});

test("turning the schedule on after a manual restock doesn't adopt a good added by hand since (#135 review, round 6)", async () => {
  const { world, shop, clock } = await setUp();
  world.settings.autoRestock = false;
  await globalThis.game.modules.get("merchant-presets").api.restock(shop);
  await shop.createEmbeddedDocuments("Item", [{ _id: "myOwnRope00001", name: "Rope", type: "consumable", system: { quantity: 2 }, flags: {} }]);
  world.settings.autoRestock = true;
  await clock(at(0, 1));
  await clock(at(3, 8));
  assert.ok(shop.items.some(i => i._id === "myOwnRope00001"), "the GM's own Rope stays");
});

test("a table line labelled apart from its item still adopts that item (#135 review, round 6)", async () => {
  const { world, shop, clock } = await setUp();
  tableOf(world, shop).results.find(r => r.name === "Bell").name = "A bell, brass";
  await clock(at(0, 1));
  await clock(at(3, 8));
  assert.equal(byName(shop, "Bell").length, 1);
});

test("a due opening while no tab held the claim is still restocked once one does (#135 review, round 6)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const gm = globalThis.game.user;
  const claim = gm.flags["merchant-presets"].tradeTab;
  const bell = byName(shop, "Bell")[0]._id;
  gm.flags["merchant-presets"].tradeTab = "tab-mid-handoff";
  await clock(at(3, 8));
  assert.equal(byName(shop, "Bell")[0]._id, bell);
  gm.flags["merchant-presets"].tradeTab = claim;
  await clock(at(3, 9));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell, "restocked on the day, not a cycle later");
});

test("setting a shop up again starts its shelf afresh: no second shelf at the next reroll (#135 review, round 7)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));                                    // adopted and scheduled
  const api = globalThis.game.modules.get("merchant-presets").api;
  const city = "Compendium.merchant-presets.merchants.Actor.cityGeneralStore";
  world.compendium.set(city, { uuid: city, toObject: () => source("merchants", "General_Store_City_") });
  await api.setUpShop(shop, city, []);                      // made over as the City store
  const flags = shop.flags["merchant-presets"];
  assert.equal(flags.shelf ?? null, null);
  assert.equal(flags.schedule ?? null, null);
  assert.equal(flags.lines ?? null, null);
});

test("a plain text line in the stock table doesn't stop the shop restocking (#135 review, round 8)", async () => {
  const { world, shop, clock } = await setUp();
  tableOf(world, shop).results.push({ _id: "textLine0000001", id: "textLine0000001", type: "text", name: "Nothing today" });
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0]._id;
  await clock(at(3, 8));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell);
});

test("a shop given a shorter interval restocks on the new one, not the old due date (#135 review, round 8)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));                                  // every 3 days: due day 3
  shop.flags["merchant-presets"].shop.restock.every = 1;  // the GM makes it daily
  const bell = byName(shop, "Bell")[0]._id;
  await clock(at(1, 8));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell, "restocked on day 1");
  assert.equal(shop.flags["merchant-presets"].schedule.dueAt, at(2));
});

test("restocking a scheduled shop by hand moves its next due date on (#135 review, round 9)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));                                   // due day 3
  globalThis.game.time.worldTime = at(2, 12);
  await globalThis.game.modules.get("merchant-presets").api.restock(shop);
  assert.equal(shop.flags["merchant-presets"].schedule.dueAt, at(5));
  const bell = byName(shop, "Bell")[0]._id;
  await clock(at(3, 8));
  assert.equal(byName(shop, "Bell")[0]._id, bell, "no second reroll the next morning");
});

test("a shelf isn't adopted while one of its table's items can't be found (#135 review, round 9)", async () => {
  const { world, shop, clock } = await setUp();
  const bellUuid = tableOf(world, shop).results.find(r => r.name === "Bell").documentUuid;
  const bellDoc = world.compendium.get(bellUuid);
  world.compendium.delete(bellUuid);
  const warn = console.warn;
  console.warn = () => {};
  try { await clock(at(0, 1)); } finally { console.warn = warn; }
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
  world.compendium.set(bellUuid, bellDoc);
  await clock(at(0, 2));
  assert.ok(byName(shop, "Bell").every(drawn));
});

test("a table line pointing at something other than an item is skipped, not an emptied shelf (#135 review, round 10)", async () => {
  const { world, shop, clock } = await setUp();
  world.compendium.set("Compendium.world.tables.RollTable.nestedTable0001", { name: "Trinkets", documentName: "RollTable",
    toObject: () => ({ name: "Trinkets", results: [] }) });
  tableOf(world, shop).results.push({ _id: "nestedLine00001", id: "nestedLine00001", type: "document", name: "Trinkets",
    documentUuid: "Compendium.world.tables.RollTable.nestedTable0001" });
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0]._id;
  await clock(at(3, 8));
  assert.notEqual(byName(shop, "Bell")[0]?._id, bell, "restocked");
  assert.equal(byName(shop, "Trinkets").length, 0);
});

test("a line whose item records its own compendium source keeps it (#135 review, round 10)", async () => {
  const { world, shop, clock } = await setUp();
  const line = tableOf(world, shop).results.find(r => r.name === "Bell");
  const doc = world.compendium.get(line.documentUuid);
  world.compendium.set(line.documentUuid, { ...doc, toObject: () => ({ ...doc.toObject(), _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.srdBell0000000" } }) });
  await clock(at(0, 1));
  await clock(at(3, 8));
  assert.equal(byName(shop, "Bell")[0]._stats.compendiumSource, "Compendium.dnd5e.equipment24.Item.srdBell0000000");
});

test("setting a shop up waits for a trade in progress on the same queue (#135 review, round 11)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  const tess = world.character("tess", { currency: { gp: 20 } });
  let release;
  const write = tess.createEmbeddedDocuments;
  tess.createEmbeddedDocuments = async (...args) => { await new Promise(r => { release = r; }); return write.apply(tess, args); };
  const api = globalThis.game.modules.get("merchant-presets").api;
  const trade = api.trade({ tradeId: "queued000000002", kind: "buy", shopUuid: shop.uuid, buyerUuid: tess.uuid,
    lines: [{ itemId: byName(shop, "Bell")[0]._id, quantity: 1 }] });
  await tick();
  const city = "Compendium.merchant-presets.merchants.Actor.cityGeneralStore";
  world.compendium.set(city, { uuid: city, toObject: () => source("merchants", "General_Store_City_") });
  const setup = api.setUpShop(shop, city, []);
  await tick();
  assert.ok(shop.flags["merchant-presets"].shelf, "not yet made over while the trade is in flight");
  release();
  await trade;
  await setup;
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
});

test("a restocked copy remembers the compendium item it came from (#135 review, round 2)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  await clock(at(3, 8));
  const bellSource = tableOf(world, shop).results.find(r => r.name === "Bell").documentUuid;
  assert.equal(byName(shop, "Bell")[0]._stats?.compendiumSource, bellSource);
});

test("a table line whose document can't be found stops the restock, rather than losing the line (#135 review, round 2)", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  world.compendium.delete(tableOf(world, shop).results.find(r => r.name === "Bell").documentUuid);
  const bell = byName(shop, "Bell")[0]._id;
  const warn = console.warn;
  console.warn = () => {};
  try { await clock(at(3, 8)); } finally { console.warn = warn; }
  assert.equal(byName(shop, "Bell")[0]?._id, bell, "the Bell line is still on the shelf");
});

test("a topup that found nothing sold isn't reported as a restock (#135 review, round 2)", async () => {
  const { shop, clock } = await setUp();
  shop.flags["merchant-presets"].shop.restock.mode = "topup";
  shop.system.currency.gp = shop.flags["merchant-presets"].purse;
  for (const item of shop.items) if (item.system.quantity === 0) item.system.quantity = 1;
  await clock(at(0, 1));
  const told = [];
  globalThis.ui.notifications.info = message => told.push(message);
  await clock(at(3, 8));
  assert.deepEqual(told, []);
});
