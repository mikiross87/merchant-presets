import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// #104, the cut-over, driven through the real merchant-presets.mjs: a shop is visited through
// its own window, made visitable by placing its token, and gets its per-import stock without
// Item Piles. Placing a token opens a shop only with *Shop access* set to From anywhere; within
// reach, the world's default, it stays hidden and players open it at its counter (#166).

const LIMITED = 1;
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Serve each stock table line's document, as the compendium would (tools/restock-runtime.test.mjs). */
function serveStock(world, shop) {
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  for (const result of table.results) {
    const onShelf = shop.items.find(i => i.name === result.name);
    const name = result.name;
    world.compendium.set(result.documentUuid, { name, uuid: result.documentUuid,
      toObject: () => ({ name, type: onShelf?.type ?? "loot", system: { quantity: 1, price: structuredClone(onShelf?.system.price ?? { value: 1, denomination: "gp" }) }, flags: {} }) });
  }
}

/**
 * A world whose Item Piles is gone (the cut-over's premise), with General Store (Town) in the pack.
 * `access` is the world's *Shop access*: From anywhere unless said, #104's own rule, these tests'.
 */
async function setUp({ access = "anywhere" } = {}) {
  const world = createWorld();
  world.settings.shopAccess = access;
  await loadRuntime(world);
  const shop = world.merchant("General_Store_Town_");
  // As Foundry leaves an imported shop: hidden, and owned by the GM who imported it.
  shop.ownership = { default: 0, gm: 3 };
  serveStock(world, shop);
  return { world, shop };
}

test("placing a hidden shop's token makes it visitable (#104)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("placing a token leaves a GM's own visibility choice alone (#104)", async () => {
  const { world, shop } = await setUp();
  shop.ownership = { default: 2 };                                   // the GM chose Observer
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, 2);

  const hidden = world.merchant("General_Store_Village_");
  hidden.ownership = { default: 0 };
  hidden.flags["merchant-presets"].visibility = "hidden";            // the GM's "Players can visit" switch, off (#110)
  world.actors.push(hidden);
  await world.fire("createToken", { actor: hidden, actorId: hidden.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(hidden.ownership.default, 0);
});

test("a shop the GM hides again after placing it stays hidden when another token is placed (#138 review, round 4)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
  shop.ownership.default = 0;                                         // the GM hides it again
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, 0);
});

test("a shop marked visitable in another world, exported and imported here, is made visitable (#138 review, round 6)", async () => {
  const { world, shop } = await setUp();
  shop.flags["merchant-presets"].madeVisitable = "some-other-world";   // export keeps flags, clears ownership
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("a shop the GM opened to one player only stays that way when its token is placed (#138 review, round 6)", async () => {
  const { world, shop } = await setUp();
  globalThis.game.users.push({ id: "rogueUser000001", isGM: false });
  shop.ownership = { default: 0, rogueUser000001: 1 };
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.deepEqual(shop.ownership, { default: 0, rogueUser000001: 1 });
});

test("a shop the GM gave one player Owner of stays that way when its token is placed (#138 review, round 8)", async () => {
  const { world, shop } = await setUp();
  globalThis.game.users.push({ id: "rogueUser000001", isGM: false });
  shop.ownership = { default: 0, gm: 3, rogueUser000001: 3 };
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.deepEqual(shop.ownership, { default: 0, gm: 3, rogueUser000001: 3 });
});

test("a shop exported and brought back into this world is made visitable when placed (#138 review, round 9)", async () => {
  const { world, shop } = await setUp();
  // Made visitable here once; the compendium trip cleared its ownership and kept its flags.
  shop.flags["merchant-presets"].madeVisitable = "stub-world";
  await world.fire("preCreateActor", shop, {}, {}, "gm");
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("a shop exported with the GM's Players can visit choice is made visitable when placed here (#140 review, round 6)", async () => {
  const { world, shop } = await setUp();
  // The choice was the other world's, set against ownership the compendium trip cleared.
  shop.flags["merchant-presets"].visibility = true;
  await world.fire("preCreateActor", shop, {}, {}, "gm");
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("a copy of a shop the GM hid keeps it hidden when placed (#140 review, round 8)", async () => {
  const { world, shop } = await setUp();
  // Duplicated in this world, or imported: "hidden" is right whatever ownership came along.
  shop.flags["merchant-presets"].visibility = false;
  shop.ownership = { default: 0 };
  await world.fire("preCreateActor", shop, {}, {}, "gm");
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, 0);
});

test("a level left for a player since deleted doesn't keep a placed shop hidden (#138 review, round 9)", async () => {
  const { world, shop } = await setUp();
  shop.ownership = { default: 0, gm: 3, goneUser00000001: 2 };
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("a scene arriving with a shop's token already on it makes the shop visitable (#138 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  // An Adventure or scene import: the tokens come with the scene, and only createScene fires.
  await world.fire("createScene", { tokens: [{ actor: shop, actorId: shop.id, actorLink: true }] }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, LIMITED);
});

test("a scene in a compendium (an Adventure being built) never opens the world's shops (#138 review, round 5)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  await world.fire("createScene", { pack: "world.my-adventure", tokens: [{ actor: shop, actorId: shop.id, actorLink: true }] }, {}, "gm");
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true, parent: { pack: "world.my-adventure" } }, {}, "gm");
  await tick();
  assert.equal(shop.ownership.default, 0);
});

test("a 1.x merchant dropped straight onto the canvas is made visitable too (#138 review)", async () => {
  const { world } = await setUp();
  const legacy = world.merchant("General_Store_Village_");
  legacy.ownership = { default: 0 };
  delete legacy.flags["merchant-presets"].shop;          // not migrated yet when its token lands
  world.actors.push(legacy);
  await world.fire("createToken", { actor: legacy, actorId: legacy.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(legacy.ownership.default, LIMITED);
});

test("within reach, placing a shop's token leaves it hidden: players open it at its counter (#166)", async () => {
  const { world, shop } = await setUp({ access: "reach" });
  world.actors.push(shop);
  await world.fire("createToken", { actor: shop, actorId: shop.id, actorLink: true }, {}, "gm");
  await world.fire("createScene", { tokens: [{ actor: shop, actorId: shop.id, actorLink: true }] }, {}, "gm");
  await tick();
  assert.deepEqual(shop.ownership, { default: 0, gm: 3 });
  assert.equal(shop.flags["merchant-presets"].madeVisitable, undefined);
});

test("within reach, a shop an earlier build made visitable is hidden again when the world loads (#167 live check)", async () => {
  const world = createWorld();
  world.settings.shopAccess = "reach";
  const shop = world.merchant("General_Store_Town_");
  // Placing its token opened it before #166, in this world.
  shop.ownership = { default: LIMITED, gm: 3 };
  shop.flags["merchant-presets"].madeVisitable = "stub-world";
  world.actors.push(shop);
  serveStock(world, shop);
  await loadRuntime(world);
  await tick(40);
  assert.equal(shop.ownership.default, 0);
  assert.equal(shop.flags["merchant-presets"].madeVisitable ?? null, null);
});

test("placing a token of an actor that isn't a shop changes nothing (#104)", async () => {
  const { world } = await setUp();
  const npc = world.character("goblin");
  npc.ownership = { default: 0 };
  await world.fire("createToken", { actor: npc, actorId: npc.id, actorLink: true }, {}, "gm");
  await tick();
  assert.equal(npc.ownership.default, 0);
});

test("a shop imported from the pack opens as the shop window and rolls its own shelf, no Item Piles (#104)", async () => {
  const { world, shop } = await setUp();
  assert.equal(shop.flags.core?.sheetClass, undefined, "the pack copy keeps the NPC sheet (#204 review)");
  await world.fire("preCreateActor", shop, {}, {}, "gm");
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");
  await tick(40);
  assert.equal(shop.flags.core?.sheetClass, "merchant-presets.ShopSheet");
  assert.equal(shop.flags["item-piles"].data.enabled, false);
  assert.ok(shop.flags["merchant-presets"].shelf, "adopted by its first native restock");
  assert.ok(shop.items.filter(i => i.flags["merchant-presets"]?.kind !== "gear").every(i => i.flags["merchant-presets"]?.drawn),
    "every good on the shelf was drawn by it");
  assert.ok(shop.items.every(i => i.flags["merchant-presets"]?.newAt === undefined), "a shop just placed has nothing New (#152 review)");
  assert.equal(shop.flags["merchant-presets"].restockedAt ?? null, null, "nor fresh stock");
});

test("a shop arriving with a GM's own sheet choice keeps it (#204 review)", async () => {
  const { world, shop } = await setUp();
  shop.flags.core = { sheetClass: "dnd5e.NPCActorSheet" };
  await world.fire("preCreateActor", shop, {}, {}, "gm");
  assert.equal(shop.flags.core.sheetClass, "dnd5e.NPCActorSheet");
});

test("a shop exported into a world compendium gets no sheet there (#204 review)", async () => {
  const { world, shop } = await setUp();
  // V14 names the pack on the document; the create options arrive without it (live probe, #204).
  shop.pack = "world.my-shops";
  await world.fire("preCreateActor", shop, {}, { keepId: true, clearOwnership: true, action: "create", render: true }, "gm");
  assert.equal(shop.flags.core?.sheetClass, undefined);
});

test("of one GM's tabs only the one that claims trades takes in a shop that GM dragged in: two would each roll a shelf (#136)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  globalThis.game.user.flags["merchant-presets"].tradeTab = "anotherTabOfThisGM";   // this tab hears it, but doesn't claim
  await world.fire("createActor", shop, {}, "gm");
  await tick(40);
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null, "left to the claiming tab");
});

test("of one GM's tabs only the one that claims trades takes in a shop that GM replaced from the pack (#136)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  globalThis.game.user.flags["merchant-presets"].tradeTab = "anotherTabOfThisGM";
  await world.fire("updateActor", shop, {}, {}, "gm");
  await tick(40);
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null, "left to the claiming tab");
});

test("a shop another GM drags in is taken in by the active GM's claiming tab, where the restocks run (#157 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  globalThis.game.users.push({ id: "gm2", isGM: true });
  await world.fire("createActor", shop, {}, "gm2");
  await tick(40);
  assert.ok(shop.flags["merchant-presets"].shelf, "rolled here, on the one queue the scheduled restocks share");
  assert.equal(shop.flags.core?.sheetClass, "merchant-presets.ShopSheet");
});

test("a GM who isn't the active GM leaves the shop they drag in to the active GM (#157 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  globalThis.game.users.activeGM = { id: "gm2", isGM: true };
  await world.fire("createActor", shop, {}, "gm");
  await world.fire("updateActor", shop, {}, {}, "gm");
  await tick(40);
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
});

test("a shop a player's client creates isn't taken in: only a GM's arrival is (#157 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  globalThis.game.users.push({ id: "player", isGM: false });
  await world.fire("createActor", shop, {}, "player");
  await tick(40);
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
});

test("a shop whose arrival roll failed gets nothing New from its first roll, whichever restock draws it (#153)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  const missing = table.results[0].documentUuid;
  const served = world.compendium.get(missing);
  world.compendium.delete(missing);                  // a line that won't resolve: the arrival rolls nothing
  const warn = console.warn;
  console.warn = () => {};
  try {
    await world.fire("createActor", shop, {}, "gm");
    await tick(40);
  } finally { console.warn = warn; }
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null, "not rolled");
  world.compendium.set(missing, served);
  await globalThis.game.modules.get("merchant-presets").api.restock(shop);   // the GM's Restock now
  assert.ok(shop.flags["merchant-presets"].shelf, "rolled now");
  assert.ok(shop.items.every(i => i.flags["merchant-presets"]?.newAt === undefined), "players never saw this shop: nothing is back in stock");
  assert.equal(shop.flags["merchant-presets"].restockedAt ?? null, null, "nor fresh stock today");
});

test("a shop whose arrival roll failed and the clock then adopted marks none of its pack goods New at its first restock (#158 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  world.settings.autoRestock = true;
  globalThis.game.time.calendar.days = { secondsPerMinute: 60, minutesPerHour: 60, hoursPerDay: 24 };
  globalThis.game.time.calendar.timeToComponents = t => ({ hour: Math.floor((t % 86_400) / 3600), minute: 0 });
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  const missing = table.results[0].documentUuid;
  const served = world.compendium.get(missing);
  world.compendium.delete(missing);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await world.fire("createActor", shop, {}, "gm");
    await tick(40);
  } finally { console.warn = warn; }
  world.compendium.set(missing, served);
  globalThis.game.time.worldTime = 3600;
  await world.fire("updateWorldTime", 3600, 0);                   // the schedule sees it first: adopts the pack's goods
  await tick(40);
  assert.ok(shop.flags["merchant-presets"].shelf, "adopted by the clock");
  await globalThis.game.modules.get("merchant-presets").api.restock(shop);
  assert.ok(shop.items.every(i => i.flags["merchant-presets"]?.newAt === undefined), "the pack's goods were in stock all along");
});

test("a shop replaced from the pack mid-session starts a fresh shelf: one of each line (#66, #135 review)", async () => {
  const { world, shop } = await setUp();
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");
  await tick(40);
  const first = shop.flags["merchant-presets"].shelf;
  assert.ok(first);
  // Replace Actor writes the pack's data over the shop with recursive: false: its flags and items
  // are the pack's again, the shelf key and every stamp gone, and updateActor fires.
  const pack = world.merchant("General_Store_Town_");
  shop.flags = structuredClone(pack.flags);
  shop.items.splice(0, shop.items.length, ...pack.items);
  await world.fire("updateActor", shop, {}, {}, "gm");
  await tick(40);
  const again = shop.flags["merchant-presets"].shelf;
  assert.ok(again && again !== first, "adopted afresh under a new key");
  const goods = shop.items.filter(i => i.flags["merchant-presets"]?.kind !== "gear");
  assert.ok(goods.every(i => i.flags["merchant-presets"]?.drawn === again));
  assert.equal(goods.filter(i => i.name === "Bell").length, 1);
});

test("setting an NPC up as a shop migrates it to the shop window itself, and rolls its shelf once (#138 review)", async () => {
  const { world, shop } = await setUp();
  const npc = world.character("grumm");
  npc.type = "npc";
  world.actors.push(npc);
  const source = "Compendium.merchant-presets.merchants.Actor.generalStoreTown";
  world.compendium.set(source, { uuid: source, toObject: () => structuredClone(shop.toObject()) });
  // As Foundry does for this user's own update: fire updateActor, where the native arrival hook listens.
  const update = npc.update.bind(npc);
  npc.update = async changes => {
    await update(changes);
    for (const fn of world.hooks.on.get("updateActor") ?? []) fn(npc, changes, {}, "gm");
  };
  let draws = 0;
  const create = npc.createEmbeddedDocuments.bind(npc);
  npc.createEmbeddedDocuments = async (type, data, options) => {
    if (data.some(d => d.flags?.["merchant-presets"]?.drawn)) draws++;
    return create(type, data, options);
  };
  await globalThis.game.modules.get("merchant-presets").api.setUpShop(npc, source, []);
  await tick(60);
  assert.equal(npc.flags.core?.sheetClass, "merchant-presets.ShopSheet");
  assert.equal(npc.flags["item-piles"].data.enabled, false);
  assert.equal(draws, 1, "one restock draws the new shelf, not a second from the arrival hook");
});

test("shops replaced while the world was closed are rolled by the active GM only (#138 review)", async () => {
  const world = createWorld();
  globalThis.game.users.activeGM = { id: "another-gm", isGM: true };   // this client is a second GM
  const shop = world.merchant("General_Store_Town_");
  serveStock(world, shop);
  world.actors.push(shop);
  await loadRuntime(world);
  await tick();
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
});
