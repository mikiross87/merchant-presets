import { test } from "node:test";
import assert from "node:assert/strict";
import { boughtWith, goodFlag } from "../scripts/trade.mjs";

// A trade's lines as the listeners get them (#48): the client that made the writes holds the
// shop's Item documents, and every other client their JSON.
const flags = { "merchant-presets": { kind: "meal", nutrition: { food: 0.5, water: 0.125 } } };
const mealData = { _id: "meal1", name: "Meal, Poor", type: "loot", flags };
const mealDocument = { ...mealData, id: "meal1", uuid: "Actor.inn.Item.meal1", getFlag: (scope, key) => flags[scope]?.[key] };
const trade = lines => ({ kind: "buy", shopUuid: "Actor.inn", buyerUuid: "Actor.tess", userId: "p1", lines });

test("a good's flags read the same from an Item document and from its JSON", () => {
  assert.deepEqual(goodFlag(mealDocument, "nutrition"), { food: 0.5, water: 0.125 });
  assert.deepEqual(goodFlag(JSON.parse(JSON.stringify(mealDocument)), "nutrition"), { food: 0.5, water: 0.125 });
  assert.equal(goodFlag(mealData, "actor"), undefined);
  assert.equal(goodFlag(undefined, "nutrition"), undefined);
});

test("bought meals are found on the client that made the writes and on every other", () => {
  const here = trade([{ quantity: 1, item: mealDocument }]);
  const elsewhere = JSON.parse(JSON.stringify(here));
  assert.equal(boughtWith(here, "nutrition").length, 1);
  assert.equal(boughtWith(elsewhere, "nutrition").length, 1);
});

test("only lines actually bought and carrying the flag count", () => {
  const lines = [
    { quantity: 0, item: mealData },
    { quantity: 2, item: { name: "Rope", flags: {} } },
    { quantity: 3, item: mealData }
  ];
  assert.deepEqual(boughtWith(trade(lines), "nutrition").map(e => e.quantity), [3]);
  assert.deepEqual(boughtWith(trade(undefined), "nutrition"), []);
  assert.deepEqual(boughtWith(null, "nutrition"), []);
});
