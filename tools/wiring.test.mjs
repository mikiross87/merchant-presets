import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// The real runtime, driven through the hooks Foundry fires when a merchant is
// dragged out of the compendium. Foundry keeps the compendium id on import, so
// dragging a shop the world already holds asks to replace it, and *Replace
// Actor* is the default: importDocument then writes the compendium data over
// the existing actor with updateDocuments, which fires updateActor, not
// createActor (#66).

const TEMPLE = "Temple_Faith_Store_Town_";
const JEWELER = "Jeweler_Town_";
const COMPENDIUM = "Compendium.merchant-presets.stock.RollTable.";

const world = createWorld();
const tableOf = actor => actor.flags["item-piles"].data.tablesForPopulate[0].uuid;
const rolls = actor => world.calls.itemUpdates.filter(c => c.actor === actor.id).length;

// Replaced in place before this session started: still on its compendium
// table when the world loads.
const replacedEarlier = world.merchant("Druidic_Store_Town_");
world.actors.push(replacedEarlier);
await loadRuntime(world);

test("a merchant dragged in as a new actor is wired to a world table and stocked", async () => {
  const temple = world.merchant(TEMPLE);
  world.actors.push(temple);
  await world.fire("createActor", temple, {}, "gm");
  assert.match(tableOf(temple), /^RollTable\./);
  assert.equal(rolls(temple), 1);
});

test("a merchant replaced in place from the compendium is wired and stocked (#66)", async () => {
  const jeweler = world.merchant(JEWELER);
  world.actors.push(jeweler);
  await world.fire("updateActor", jeweler, { flags: {} }, { diff: false, recursive: false }, "gm");
  assert.match(tableOf(jeweler), /^RollTable\./);
  assert.equal(rolls(jeweler), 1);
});

test("a merchant replaced before the world loaded is wired when it loads (#66)", () => {
  assert.match(tableOf(replacedEarlier), /^RollTable\./);
  assert.equal(rolls(replacedEarlier), 1);
});

test("an ordinary update leaves a wired merchant as it is", async () => {
  const wired = world.merchant("General_Store_Town_", { table: "RollTable.alreadyWired0001" });
  // Closed by hand. With trading hours off, the open/closed pass would open it.
  wired.flags["item-piles"].data.openTimes.status = "closed";
  world.actors.push(wired);
  await world.fire("updateActor", wired, { name: "Barthen's Provisions" }, {}, "gm");
  assert.equal(tableOf(wired), "RollTable.alreadyWired0001");
  assert.equal(rolls(wired), 0);
  assert.equal(wired.flags["item-piles"].data.openTimes.status, "closed");
});

test("another user's update is left to the client that made it", async () => {
  const theirs = world.merchant("Arcane_Store_Town_");
  world.actors.push(theirs);
  await world.fire("updateActor", theirs, { flags: {} }, {}, "someone-else");
  assert.ok(tableOf(theirs).startsWith(COMPENDIUM));
  assert.equal(rolls(theirs), 0);
});

test("a create and an update arriving together wire and stock a merchant once", async () => {
  const smith = world.merchant("Armourer_Blacksmiths_Town_");
  world.actors.push(smith);
  const tablesBefore = world.calls.tablesCreated;
  const create = world.fire("createActor", smith, {}, "gm");
  const update = world.fire("updateActor", smith, { flags: {} }, {}, "gm");
  await Promise.all([create, update]);
  assert.match(tableOf(smith), /^RollTable\./);
  assert.equal(rolls(smith), 1);
  assert.equal(world.calls.tablesCreated - tablesBefore, 1);
});
