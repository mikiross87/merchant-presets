import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// #104, the cut-over, driven through the real merchant-presets.mjs: a shop is visited through
// its own window, made visitable by placing its token, and gets its per-import stock without
// Item Piles.

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

/** A world whose Item Piles is gone (the cut-over's premise), with General Store (Town) in the pack. */
async function setUp() {
  const world = createWorld();
  globalThis.game.modules.set("item-piles", { active: false });
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
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");
  await tick(40);
  assert.equal(shop.flags.core?.sheetClass, "merchant-presets.ShopSheet");
  assert.equal(shop.flags["item-piles"].data.enabled, false);
  assert.ok(shop.flags["merchant-presets"].shelf, "adopted by its first native restock");
  assert.ok(shop.items.filter(i => i.flags["merchant-presets"]?.kind !== "gear").every(i => i.flags["merchant-presets"]?.drawn),
    "every good on the shelf was drawn by it");
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
  globalThis.game.modules.set("item-piles", { active: false });
  globalThis.game.users.activeGM = { id: "another-gm", isGM: true };   // this client is a second GM
  const shop = world.merchant("General_Store_Town_");
  serveStock(world, shop);
  world.actors.push(shop);
  await loadRuntime(world);
  await tick();
  assert.equal(shop.flags["merchant-presets"].shelf ?? null, null);
});
