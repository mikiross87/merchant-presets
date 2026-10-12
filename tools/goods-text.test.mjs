import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Goods descriptions against what the goods are (#242, #243): the built `_source`, both the goods
 * and the copies embedded in each merchant, since the copy is what a player reads in the shop.
 */

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};

const goods = load("goods").filter(d => d._key.startsWith("!items!"));
const embedded = load("merchants").filter(d => d._key.startsWith("!actors!"))
  .flatMap(m => m.items.map(i => ({ ...i, name: `${i.name} (in ${m.name})` })));

const unitOf = text => text.match(/\bper (day|mile|night|week|month)\b/)?.[1];

test("a good sold per one unit doesn't describe itself per another (#242)", () => {
  const wrong = [...goods, ...embedded].flatMap(item => {
    const named = unitOf(item.name);
    const described = unitOf(item.system?.description?.value ?? "");
    return named && described && named !== described ? [`${item.name}: per ${described}`] : [];
  });
  assert.deepEqual(wrong, []);
});
