import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// #104, the cut-over, driven through the real merchant-presets.mjs: a shop is visited through
// its own window, made visitable by placing its token, and gets its per-import stock without
// Item Piles.

const LIMITED = 1;
const tick = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A world whose Item Piles is gone (the cut-over's premise), with General Store (Town) in the pack. */
async function setUp() {
  const world = createWorld();
  globalThis.game.modules.set("item-piles", { active: false });
  await loadRuntime(world);
  const shop = world.merchant("General_Store_Town_");
  shop.ownership = { default: 0 };
  // Each stock table line's document, as the compendium serves it (tools/restock-runtime.test.mjs).
  const table = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  for (const result of table.results) {
    const onShelf = shop.items.find(i => i.name === result.name);
    world.compendium.set(result.documentUuid, { name: result.name, uuid: result.documentUuid,
      toObject: () => ({ name: result.name, type: onShelf?.type ?? "loot", system: { quantity: 1, price: structuredClone(onShelf?.system.price ?? { value: 1, denomination: "gp" }) }, flags: {} }) });
  }
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
