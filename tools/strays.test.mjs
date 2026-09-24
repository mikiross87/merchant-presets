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
