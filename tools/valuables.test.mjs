import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const kind = item => item.flags?.["merchant-presets"]?.kind;
const category = item => item.flags?.["item-piles"]?.item?.customCategory;

// SRD 5.2 Equipment: "trade goods and valuables—like gems and art objects—retain
// their full value in the marketplace." Loot only: dnd5e files artisan's tools
// under system.type.value "art" too, and a smith's tools sell back at half.
const isValuable = item => item.type === "loot"
  && ["gem", "art", "trade"].includes(item.system?.type?.value);

const goods = load("goods").filter(d => !d._key.startsWith("!folders"));
const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const pileData = m => m.flags["item-piles"].data;
const stock = m => m.items.filter(i => kind(i) !== "gear");

/** Whether a merchant's item filters let a player sell it `item` (#53). */
const accepts = (m, item) => !pileData(m).overrideItemFilters
  .some(f => f.filters.split(",").includes(String(get(item, f.path))));

test("29 goods are valuables: the gem, art and trade-good components (#53)", () => {
  const valuables = goods.filter(isValuable);
  assert.equal(valuables.length, 29);
  assert.deepEqual(valuables.filter(g => kind(g) !== "component").map(g => g.name), []);
});

test("every valuable carries the Valuables category, on the good, the shelf and the restock record", () => {
  for (const g of goods.filter(isValuable)) assert.equal(category(g), "Valuables", g.name);
  for (const m of merchants) {
    for (const item of stock(m).filter(isValuable)) {
      assert.equal(category(item), "Valuables", `${m.name}: ${item.name}`);
      assert.equal(m.flags["merchant-presets"].itemFlags[item.name].customCategory, "Valuables",
        `${m.name}: ${item.name}`);
    }
  }
});

test("nothing else is filed under Valuables, artisan's tools included", () => {
  for (const g of goods.filter(g => !isValuable(g))) assert.notEqual(category(g), "Valuables", g.name);
  for (const m of merchants) {
    for (const item of m.items.filter(i => !isValuable(i))) {
      assert.notEqual(category(item), "Valuables", `${m.name}: ${item.name}`);
    }
  }
  const tools = merchants.flatMap(stock).filter(i => i.type === "tool" && i.system.type.value === "art");
  assert.ok(tools.length > 0, "the art-typed tools this guards against are still stocked");
});

test("a shop that buys valuables pays full value for them, whatever its own rate", () => {
  const valuables = goods.filter(isValuable);
  for (const m of merchants) {
    const data = pileData(m);
    const entries = (data.itemTypePriceModifiers ?? [])
      .filter(e => e.type === "custom" && e.category === "Valuables");
    if (valuables.some(v => accepts(m, v))) {
      assert.deepEqual(entries, [{ type: "custom", category: "Valuables", override: true,
        buyPriceModifier: data.buyPriceModifier, sellPriceModifier: 1 }], m.name);
    } else {
      assert.deepEqual(entries, [], m.name);
    }
  }
});

test("the shops that buy valuables are the five that stock spell components", () => {
  const buyers = merchants.filter(m => goods.filter(isValuable).some(v => accepts(m, v)))
    .map(m => m.name).sort();
  assert.deepEqual(buyers, [
    "Alchemists & Apothecaries (City)", "Alchemists & Apothecaries (Town)", "Alchemists & Apothecaries (Village)",
    "Arcane Store (City)", "Arcane Store (Town)", "Arcane Store (Village)",
    "Druidic Store (City)",
    "Jeweler (City)", "Jeweler (Town)", "Jeweler (Village)",
    "Temple & Faith Store (City)", "Temple & Faith Store (Town)", "Temple & Faith Store (Village)"
  ]);
});
