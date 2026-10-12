import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// A good this module stops shipping (#243 dropped the Stable's coach rides and road toll, SRD 5.1
// only) is still on the stock table and shelf of every Stable a world took in before. Restocking
// draws every line of the table, and one that no longer resolves skips the whole restock (#135
// review), so those Stables would never restock again. Driven through the real merchant-presets.mjs.

const COACH = "Compendium.merchant-presets.goods.Item.aoRU3x8WIjLDElJu";   // Coach Ride between Towns, 2.3.0
const TOLL = "Compendium.merchant-presets.goods.Item.PT7FtDwr7B48MWSb";    // Road or Gate Toll, 2.3.0
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };

/** A Stable (Town) as a 2.3.0 world holds it: its own world stock table, with the coach ride and
 *  the toll as lines and on the shelf, and a GM's dice on the coach ride's line. */
async function upgraded() {
  const world = createWorld();
  const shop = world.merchant("Stable_Town_");
  const packed = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  const old = [{ id: "coachLine000001", name: "Coach Ride between Towns (per mile)", documentUuid: COACH },
    { id: "tollLine0000001", name: "Road or Gate Toll", documentUuid: TOLL }];
  const table = {
    id: "stableTable0001", uuid: "RollTable.stableTable0001", name: "Stable (Town) Stock", flags: {},
    results: [...packed.results.map(r => ({ ...r })), ...old],
    async deleteEmbeddedDocuments(_type, ids) { this.results = this.results.filter(r => !ids.includes(r.id)); }
  };
  world.tables.push(table);
  const flags = shop.flags["merchant-presets"];
  flags.shop.restock.table = table.uuid;
  flags.shop.restock.quantities = { coachLine000001: "2d4" };
  flags.shelf = "stableShelf0001";
  for (const [i, line] of old.entries()) {
    shop.items.push(Object.defineProperty({ _id: `oldGood0000000${i}`, id: `oldGood0000000${i}`, name: line.name, type: "loot",
      system: { quantity: 1, price: { value: 1, denomination: "cp" } },
      flags: { "merchant-presets": { drawn: "stableShelf0001", kind: "travel" } }, _stats: { compendiumSource: line.documentUuid } },
    "toObject", { value() { return structuredClone({ ...this }); } }));
  }
  world.actors.push(shop);
  // Each line the pack still ships, as the compendium serves it. The two old goods are gone.
  for (const result of packed.results) {
    const name = result.name;
    world.compendium.set(result.documentUuid, {
      name, toObject: () => ({ name, type: "loot", img: "x.webp", system: { quantity: 1, price: { value: 1, denomination: "gp" } }, flags: {} })
    });
  }
  await loadRuntime(world);
  await tick();
  return { world, shop, table };
}

test("a Stable from 2.3.0 still restocks once the module stops shipping two of its goods", async () => {
  const { shop } = await upgraded();
  const warned = [];
  const warn = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    const restocked = await globalThis.game.modules.get("merchant-presets").api.restock(shop);
    assert.deepEqual(warned, []);
    assert.ok(restocked, "the restock ran");
  } finally {
    console.warn = warn;
  }
});

test("it lets go of those goods: off its stock table, its shelf and its line dice", async () => {
  const { shop, table } = await upgraded();
  const gone = n => /Coach Ride|Road or Gate Toll/.test(n);
  assert.deepEqual(table.results.filter(r => gone(r.name)).map(r => r.name), []);
  assert.deepEqual(shop.items.filter(i => gone(i.name)).map(i => i.name), []);
  assert.equal(shop.flags["merchant-presets"].shop.restock.quantities.coachLine000001, undefined);
});

test("a 2.x Stable on the pack's own stock table lets go of them too: off its shelf and its line dice", async () => {
  const world = createWorld();
  const shop = world.merchant("Stable_Town_");
  const packed = world.compendium.get(shop.flags["merchant-presets"].shop.restock.table);
  const flags = shop.flags["merchant-presets"];
  // 2.3.0's own result ids for the two lines, which its Settings kept dice for; the pack's table has neither now.
  flags.shop.restock.quantities = { WnqA8YM8mLurVpfC: "2d4", h6vA3oZtthlx3qPG: "1", [packed.results[0].id]: "1d6" };
  for (const [i, uuid] of [COACH, TOLL].entries()) {
    shop.items.push(Object.defineProperty({ _id: `oldGood0000000${i}`, id: `oldGood0000000${i}`, name: `Old ${i}`, type: "loot",
      system: { quantity: 1 }, flags: {}, _stats: { compendiumSource: uuid } }, "toObject", { value() { return { ...this }; } }));
  }
  world.actors.push(shop);
  await loadRuntime(world);
  await tick();
  assert.deepEqual(shop.items.filter(i => i.name.startsWith("Old ")).map(i => i.name), []);
  assert.deepEqual(shop.flags["merchant-presets"].shop.restock.quantities, { [packed.results[0].id]: "1d6" },
    "the dice of lines its table no longer has go; a line's own dice stay");
});
