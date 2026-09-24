import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// Merchants dragged in from earlier builds hold goods copied out of the SRD
// kits, still naming the kit in system.container, and their world tables
// point at those copies, so a restock brings them back. Item Piles hides such
// goods from the shop window (#89); the runtime lets go of the kit's id.

const KIT = "phbagExplorersPa";
const world = createWorld();

/** A merchant with its first good naming a kit it does not hold, and its
 *  second good inside a container it does hold. */
function strayed(prefix, table) {
  const actor = world.merchant(prefix, { table });
  const [stray, held, box] = actor.items.filter(i => i.type !== "container").slice(0, 2)
    .concat(actor.items.find(i => i.type === "container"));
  stray.system.container = KIT;
  held.system.container = box.id;
  return { actor, stray, held };
}
const released = actor => world.calls.itemUpdates
  .filter(c => c.actor === actor.id)
  .flatMap(c => c.updates)
  .filter(u => "system.container" in u);

// World copies of the stock tables from those builds, still rolling the kit
// copies — one in the module's folder, one stamped and moved out of it — and a
// GM's own table that happens to roll the same kit copy.
const ROPE_IN_KIT = "Compendium.dnd5e.equipment24.Item.5KMKEV07I25SVth0";
const ROPE = "Compendium.dnd5e.equipment24.Item.phbagRope0000000";
const ARROWS = "Compendium.dnd5e.equipment24.Item.phbamoArrows0000";
const folder = await Folder.implementation.create({ name: "Merchant Stock", type: "RollTable" });
const results = () => [{ name: "Rope", documentUuid: ROPE_IN_KIT }, { name: "Arrows", documentUuid: ARROWS }];
const inFolder = await RollTable.implementation.create({ name: "General Store (Town)", folder: folder.id, results: results() });
const stamped = await RollTable.implementation.create({ name: "Moved", results: results(),
  flags: { "merchant-presets": { stock: { source: "x", signature: "y" } } } });
const theirs = await RollTable.implementation.create({ name: "Loot", results: results() });

// Already in the world, and already wired, when the world loads.
const loaded = strayed("General_Store_Town_", "RollTable.wired");
world.actors.push(loaded.actor);
await loadRuntime(world);

test("a merchant already in the world lets go of a kit it does not hold (#89)", () => {
  assert.deepEqual(released(loaded.actor), [{ _id: loaded.stray.id, "system.container": null }]);
});

test("a merchant dragged in lets go of a kit it does not hold (#89)", async () => {
  const dragged = strayed("Adventurers_Store_Town_");
  world.actors.push(dragged.actor);
  await world.fire("createActor", dragged.actor, {}, "gm");
  assert.deepEqual(released(dragged.actor), [{ _id: dragged.stray.id, "system.container": null }]);
});

test("the module's world tables roll the standalone goods, not the kit copies (#89)", () => {
  const repointed = table => world.calls.resultUpdates.filter(c => c.table === table.id).flatMap(c => c.updates);
  for (const table of [inFolder, stamped]) {
    assert.deepEqual(repointed(table), [{ _id: table.results[0].id, documentUuid: ROPE }]);
  }
  assert.deepEqual(repointed(theirs), []);
});
