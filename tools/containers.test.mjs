import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// An item whose system.container names nothing on its merchant is loose to
// dnd5e but contained to Item Piles, whose shop window hides it (#89). The SRD
// kits carry such ids on their contents, so a good copied out of a kit brings
// the kit's id with it.

const DIR = new URL("../_source/merchants/", import.meta.url);
const merchants = readdirSync(DIR).filter(f => f.endsWith(".json"))
  .map(f => JSON.parse(readFileSync(new URL(f, DIR), "utf8")))
  .filter(d => d._key.startsWith("!actors!"));        // the folders sit alongside

test("the merchant source is there to check", () => {
  assert.ok(merchants.length > 0);
});

test("no merchant item names a container the merchant does not hold (#89)", () => {
  const strays = [];
  for (const actor of merchants) {
    const ids = new Set(actor.items.map(i => i._id));
    for (const item of actor.items) {
      const container = item.system?.container;
      if (container && !ids.has(container)) strays.push(`${actor.name}: ${item.name} -> ${container}`);
    }
  }
  assert.deepEqual(strays, []);
});
