import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// The real runtime, driven through the hooks Foundry fires when a merchant is
// dragged out of the compendium. Foundry keeps the compendium id on import, so
// dragging a shop the world already holds asks to replace it, and *Replace
// Actor* is the default: importDocument then writes the compendium data over
// the existing actor with updateDocuments, which fires updateActor, not
// createActor (#66).
//
// With the shops native (#104), a merchant arriving either way is migrated to
// its shop window and rolls its own shelf from its stock table, the native
// restock; Item Piles' populate tables are no longer wired.

const TEMPLE = "Temple_Faith_Store_Town_";
const JEWELER = "Jeweler_Town_";

const world = createWorld();
/** Serve every stock table line's document, as the SRD and goods packs would. */
function stockPack(actor) {
  const table = world.compendium.get(actor.flags["merchant-presets"].shop.restock.table);
  for (const result of table?.results ?? []) {
    if (world.compendium.has(result.documentUuid)) continue;
    const onShelf = actor.items.find(i => i.name === result.name);
    const name = result.name;
    world.compendium.set(result.documentUuid, { name, uuid: result.documentUuid,
      toObject: () => ({ name, type: onShelf?.type ?? "loot", system: { quantity: 1, price: structuredClone(onShelf?.system.price ?? { value: 1, denomination: "gp" }) }, flags: {} }) });
  }
  return actor;
}
const merchant = (prefix, opts) => stockPack(world.merchant(prefix, opts));
/** Whether the shop rolled its own shelf: adopted by a native restock, every good stamped with its key. */
const rolled = actor => !!actor.flags["merchant-presets"].shelf
  && actor.items.filter(i => i.flags?.["merchant-presets"]?.kind !== "gear").every(i => i.flags["merchant-presets"]?.drawn);
const tick = async (n = 40) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

// Replaced in place before this session started: fresh pack data, never rolled, when the world loads.
const replacedEarlier = merchant("Druidic_Store_Town_");
world.actors.push(replacedEarlier);
await loadRuntime(world);
await tick();

test("a merchant dragged in as a new actor opens as the shop window and rolls its shelf", async () => {
  const temple = merchant(TEMPLE);
  world.actors.push(temple);
  await world.fire("createActor", temple, {}, "gm");
  await tick();
  assert.equal(temple.flags.core?.sheetClass, "merchant-presets.ShopSheet");
  assert.ok(rolled(temple));
});

test("a merchant replaced in place from the compendium is migrated and rolls its shelf (#66)", async () => {
  const jeweler = merchant(JEWELER);
  world.actors.push(jeweler);
  await world.fire("updateActor", jeweler, { flags: {} }, { diff: false, recursive: false }, "gm");
  await tick();
  assert.equal(jeweler.flags.core?.sheetClass, "merchant-presets.ShopSheet");
  assert.ok(rolled(jeweler));
});

test("a merchant replaced before the world loaded rolls its shelf when it loads (#66)", () => {
  assert.ok(rolled(replacedEarlier));
});

test("an ordinary update leaves a rolled shop as it is", async () => {
  const shop = merchant("General_Store_Town_");
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");
  await tick();
  const shelf = shop.flags["merchant-presets"].shelf;
  const ids = shop.items.map(i => i._id).join();
  await world.fire("updateActor", shop, { name: "Barthen's Provisions" }, {}, "gm");
  await tick();
  assert.equal(shop.flags["merchant-presets"].shelf, shelf);
  assert.equal(shop.items.map(i => i._id).join(), ids);
});

test("another user's update is left to the client that made it", async () => {
  const theirs = merchant("Arcane_Store_Town_");
  world.actors.push(theirs);
  await world.fire("updateActor", theirs, { flags: {} }, {}, "someone-else");
  await tick();
  assert.equal(theirs.flags["merchant-presets"].shelf ?? null, null);
});

test("a create and an update arriving together roll a merchant's shelf once", async () => {
  const smith = merchant("Armourer_Blacksmiths_Town_");
  world.actors.push(smith);
  const creates = () => world.calls.writes.filter(w => w.type === "actorUpdate" && w.actor === smith.id
    && "flags.merchant-presets.shelf" in w.changes).length;
  const create = world.fire("createActor", smith, {}, "gm");
  const update = world.fire("updateActor", smith, { flags: {} }, {}, "gm");
  await Promise.all([create, update]);
  await tick();
  assert.ok(rolled(smith));
  assert.equal(creates(), 1, "adopted once");
});
