import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const kind = item => item.flags?.["merchant-presets"]?.kind;
const isComponent = item => kind(item) === "component";

const goods = load("goods").filter(isComponent);
const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const gp = n => `${n.toLocaleString("en-US")} GP`;

test("43 named spell components replace the three gem price bands (#51)", () => {
  assert.equal(goods.length, 43);
  assert.deepEqual(goods.filter(g => g.name.startsWith("Spell Components")).map(g => g.name), []);
  assert.equal(new Set(goods.map(g => g.system.identifier)).size, 43);
});

test("a component's name carries the price it sells at", () => {
  for (const g of goods) assert.ok(g.name.endsWith(`(${gp(g.system.price.value)})`), g.name);
});

// From #51's table: [Village, Town, City] components per shop. Everything else carries none.
const EXPECTED = {
  "Jeweler": [11, 15, 28],
  "Temple & Faith Store": [5, 8, 11],
  "Arcane Store": [6, 8, 9],
  "Alchemists & Apothecaries": [1, 1, 1],
  "Druidic Store": [0, 0, 1]
};

test("each shop carries the components #51 gives it, by settlement size", () => {
  for (const m of merchants) {
    const [, shop, size] = m.name.match(/^(.*) \((Village|Town|City)\)$/);
    const want = (EXPECTED[shop] ?? [0, 0, 0])[["Village", "Town", "City"].indexOf(size)];
    assert.equal(m.items.filter(isComponent).length, want, m.name);
  }
});

test("components are stock that sells out, not services, and a restock keeps them that way", () => {
  for (const m of merchants) {
    for (const item of m.items.filter(isComponent)) {
      const flags = item.flags["item-piles"].item;
      assert.equal(flags.isService, false, `${m.name}: ${item.name}`);
      assert.equal(flags.cantBeSoldToMerchants, false, `${m.name}: ${item.name}`);
      assert.equal(flags.infiniteQuantity, "no", `${m.name}: ${item.name}`);
      assert.equal(m.flags["merchant-presets"].itemFlags[item.name].infiniteQuantity, "no", `${m.name}: ${item.name}`);
    }
  }
});

test("no shop stocks two different items under one name", () => {
  // The restock helpers key a shop's item flags by name, and containers are
  // the one deliberate repeat: each is its own document.
  for (const m of merchants) {
    const stock = m.items.filter(i => kind(i) !== "gear" && i.type !== "container");
    const names = stock.map(i => i.name);
    assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), [], m.name);
  }
});

test("each shop's copy of a component matches the good it was built from", () => {
  const byName = new Map(goods.map(g => [g.name, g]));
  for (const m of merchants) {
    for (const item of m.items.filter(isComponent)) {
      const good = byName.get(item.name);
      assert.ok(good, `${m.name}: ${item.name} has no good`);
      assert.equal(item.system.description.value, good.system.description.value, `${m.name}: ${item.name}`);
      assert.deepEqual(item.system.price, good.system.price, `${m.name}: ${item.name}`);
      assert.equal(item.system.identifier, good.system.identifier, `${m.name}: ${item.name}`);
    }
  }
});
