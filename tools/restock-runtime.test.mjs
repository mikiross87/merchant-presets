import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// #105's restock on the world clock, driven through the real merchant-presets.mjs: the
// schedule (schedule.mjs's dueRestock/planRestock, unit-tested in tools/schedule.test.mjs)
// wired to updateWorldTime, the shop's own stock table and the trade queue. No Item Piles
// involved: the stub's refreshMerchantInventory isn't there to call.

const DAY = 24 * 60 * 60;
const at = (day, hour = 0) => day * DAY + hour * 3600;
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A world with General Store (Town) (open 07:00-19:00, restocks every 3 days) and automatic restocking on. */
async function setUp() {
  const world = createWorld();
  world.settings.autoRestock = true;
  globalThis.game.time.calendar.days = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
  globalThis.game.time.calendar.timeToComponents = t => ({ hour: Math.floor((t % DAY) / 3600), minute: 0 });
  const shop = world.merchant("General_Store_Town_");
  world.actors.push(shop);
  // Each stock table line's document, as the compendium serves it: the shelf's own copy, stripped
  // of what this shop stamped on it.
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  for (const result of table.results) {
    const onShelf = shop.items.find(i => i.name === result.name);
    world.compendium.set(result.documentUuid, {
      name: result.name,
      toObject: () => ({ name: result.name, type: onShelf?.type ?? "loot", img: "x.webp",
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
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(0, 1), dueAt: at(3) });
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
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(3, 7), dueAt: at(6) });
});

test("a skipped week restocks once; rewinding the clock never does", async () => {
  const { world, shop, clock } = await setUp();
  await clock(at(0, 1));
  const creates = () => world.calls.writes.filter(w => w.type === "actorUpdate" && w.changes["flags.merchant-presets.schedule"]).length;
  await clock(at(10, 12));
  assert.equal(creates(), 2, "first sight, then one restock");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(10, 7), dueAt: at(13) });
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
  assert.equal(shop.flags["merchant-presets"].schedule, undefined);
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
  assert.equal(shop.flags["merchant-presets"].schedule, undefined);
});

test("turning restocking off mid-session stops it at the next tick (#135 review)", async () => {
  const { world, shop, clock } = await setUp();
  world.settings.autoRestock = false;   // what migrateShop does when a 1.x merchant arrives
  await clock(at(0, 1));
  assert.equal(shop.flags["merchant-presets"].schedule, undefined);
});

test("a shop whose stock table is missing isn't scheduled until it's found, so its shelf is adopted first (#135 review)", async () => {
  const { world, shop, clock } = await setUp();
  const restore = hideTable(world, shop);
  await clock(at(0, 1));
  assert.equal(shop.flags["merchant-presets"].schedule, undefined);
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
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(0, 1), dueAt: at(3) }, "still due");
  restore();
  await clock(at(4, 8));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell, "restocked a day late rather than a cycle late");
  assert.deepEqual(shop.flags["merchant-presets"].schedule, { lastRestock: at(4, 7), dueAt: at(7) });
});

test("a hidden line that sells out and leaves the shelf comes back hidden (#135 review, round 4)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0];
  bell.flags["merchant-presets"].stock.hidden = true;
  bell.flags["item-piles"] = { ...bell.flags["item-piles"], item: { ...bell.flags["item-piles"]?.item, hidden: true } };
  await clock(at(3, 8));                                     // restocked: the shop notes each line's settings
  await shop.deleteEmbeddedDocuments("Item", byName(shop, "Bell").map(b => b._id));   // sold out, keep: false
  await clock(at(6, 8));
  const [back] = byName(shop, "Bell");
  assert.equal(back.flags["merchant-presets"].stock.hidden, true);
  assert.equal(back.flags["item-piles"]?.item?.hidden, true);
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

test("a line hidden through Item Piles stays hidden through a reroll (#135 review, round 2)", async () => {
  const { shop, clock } = await setUp();
  await clock(at(0, 1));
  const bell = byName(shop, "Bell")[0];
  bell.flags["item-piles"] = { ...bell.flags["item-piles"], item: { ...bell.flags["item-piles"]?.item, hidden: true } };
  await clock(at(3, 8));
  assert.notEqual(byName(shop, "Bell")[0]._id, bell._id, "rerolled");
  assert.equal(byName(shop, "Bell")[0].flags["item-piles"]?.item?.hidden, true);
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
