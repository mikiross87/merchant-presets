import { test } from "node:test";
import assert from "node:assert/strict";
import { boughtWith, goodFlag, uuidOf } from "../scripts/trade.mjs";

// item-piles-tradeItems as Item Piles 3.3.4 fires it (#48): its callHook swaps
// UUID strings for documents, and socketlib hands the GM that ran the trade the
// Item documents but sends every other client their JSON.
const flags = { "item-piles": { item: { isService: true } }, "merchant-presets": { kind: "meal", nutrition: { food: 0.5, water: 0.125 } } };
const mealData = { _id: "meal1", name: "Meal, Poor", type: "loot", flags };
const mealDocument = { ...mealData, id: "meal1", uuid: "Actor.inn.Item.meal1", getFlag: (scope, key) => flags[scope]?.[key] };
const buyer = { uuid: "Actor.tess", name: "Tess", type: "character" };

test("the buyer is found whether the hook passed its UUID or the actor itself", () => {
  assert.equal(uuidOf("Actor.tess"), "Actor.tess");
  assert.equal(uuidOf(buyer), "Actor.tess");
  assert.equal(uuidOf(null), null);
  assert.equal(uuidOf({ name: "no uuid" }), null);
});

test("a good's flags read the same from an Item document and from its JSON", () => {
  assert.deepEqual(goodFlag(mealDocument, "nutrition"), { food: 0.5, water: 0.125 });
  assert.deepEqual(goodFlag(JSON.parse(JSON.stringify(mealDocument)), "nutrition"), { food: 0.5, water: 0.125 });
  assert.equal(goodFlag(mealData, "actor"), undefined);
  assert.equal(goodFlag(undefined, "nutrition"), undefined);
});

test("bought meals are found on the GM's client and on the buying player's", () => {
  const onGM = { buyerReceive: [{ quantity: 1, name: "Meal, Poor", item: mealDocument }] };
  const onPlayer = JSON.parse(JSON.stringify(onGM));
  assert.equal(boughtWith(onGM, "nutrition").length, 1);
  assert.equal(boughtWith(onPlayer, "nutrition").length, 1);
});

test("only entries actually bought and carrying the flag count", () => {
  const prices = { buyerReceive: [
    { quantity: 0, item: mealData },
    { quantity: 2, item: { name: "Rope", flags: {} } },
    { quantity: 3, item: mealData }
  ] };
  assert.deepEqual(boughtWith(prices, "nutrition").map(e => e.quantity), [3]);
  assert.deepEqual(boughtWith(undefined, "nutrition"), []);
});
