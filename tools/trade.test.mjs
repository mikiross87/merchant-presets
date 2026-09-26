import { test } from "node:test";
import assert from "node:assert/strict";
import { boughtWith, fromItemPiles, goodFlag, uuidOf } from "../scripts/trade.mjs";

// item-piles-tradeItems as Item Piles 3.3.4 fires it (#48): its callHook swaps
// UUID strings for documents, and socketlib hands the GM that ran the trade the
// Item documents but sends every other client their JSON.
const flags = { "item-piles": { item: { isService: true } }, "merchant-presets": { kind: "meal", nutrition: { food: 0.5, water: 0.125 } } };
const mealData = { _id: "meal1", name: "Meal, Poor", type: "loot", flags };
const mealDocument = { ...mealData, id: "meal1", uuid: "Actor.inn.Item.meal1", getFlag: (scope, key) => flags[scope]?.[key] };
const buyer = { uuid: "Actor.tess", name: "Tess", type: "character" };
const inn = { uuid: "Actor.inn", name: "Inn", type: "npc", merchant: true };
const isMerchant = actor => actor?.merchant === true;

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
  assert.equal(boughtWith(fromItemPiles(inn, buyer, onGM, "p1", isMerchant), "nutrition").length, 1);
  assert.equal(boughtWith(fromItemPiles(inn, buyer, onPlayer, "p1", isMerchant), "nutrition").length, 1);
});

test("only entries actually bought and carrying the flag count", () => {
  const prices = { buyerReceive: [
    { quantity: 0, item: mealData },
    { quantity: 2, item: { name: "Rope", flags: {} } },
    { quantity: 3, item: mealData }
  ] };
  assert.deepEqual(boughtWith(fromItemPiles(inn, buyer, prices, "p1", isMerchant), "nutrition").map(e => e.quantity), [3]);
  assert.deepEqual(boughtWith(fromItemPiles(inn, buyer, undefined, "p1", isMerchant), "nutrition"), []);
  assert.deepEqual(boughtWith(null, "nutrition"), []);
});

test("an Item Piles purchase reads as a buy by the character from the shop", () => {
  const prices = { buyerReceive: [{ quantity: 2, item: mealData }] };
  assert.deepEqual(fromItemPiles(inn, buyer, prices, "p1", isMerchant), {
    kind: "buy", shopUuid: "Actor.inn", buyerUuid: "Actor.tess", userId: "p1",
    lines: [{ item: mealData, quantity: 2 }]
  });
});

test("an Item Piles sale reads as a sell by the character to the shop, lines being what the shop received", () => {
  const prices = { buyerReceive: [{ quantity: 1, item: mealData }] };
  assert.deepEqual(fromItemPiles(buyer, inn, prices, "p1", isMerchant), {
    kind: "sell", shopUuid: "Actor.inn", buyerUuid: "Actor.tess", userId: "p1",
    lines: [{ item: mealData, quantity: 1 }]
  });
});

test("a trade with no merchant on either side isn't a shop trade", () => {
  assert.equal(fromItemPiles(buyer, { uuid: "Actor.bob" }, { buyerReceive: [] }, "p1", isMerchant), null);
});
