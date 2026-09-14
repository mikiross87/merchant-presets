import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// SRD 5.2, Spellcasting Services: "If a spell has expensive components, add the
// cost of those components to the cost listed in the Spellcasting Services table."
const SERVICE_RULE = "If the spell has expensive components, add the cost of those components to this price.";
const SHOP_RULE = "A spell with expensive components costs those components on top.";

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const isService = item => item.flags?.["merchant-presets"]?.kind === "spellcasting";

const services = load("goods").filter(isService);
const casters = load("merchants").filter(m => (m.items ?? []).some(isService));

test("every spellcasting service says expensive components cost extra (#52)", () => {
  assert.equal(services.length, 7);
  for (const s of services) assert.ok(s.system.description.value.includes(SERVICE_RULE), s.name);
});

test("every shop that sells spellcasting says so in its shop window (#52)", () => {
  assert.equal(casters.length, 9);
  for (const m of casters) assert.ok(m.flags["item-piles"].data.description.includes(SHOP_RULE), m.name);
});

test("each shop's copy of a service matches the good it was built from", () => {
  const byName = new Map(services.map(s => [s.name, s.system.description.value]));
  for (const m of casters) {
    for (const item of m.items.filter(isService)) {
      assert.equal(item.system.description.value, byName.get(item.name), `${m.name}: ${item.name}`);
    }
  }
});
