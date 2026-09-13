import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMeal } from "../scripts/nutrition.mjs";

const needs = { food: 1, water: 1 };          // a Medium creature's day
const large = { food: 4, water: 4 };
const tiny = { food: 0.25, water: 0.25 };
const modest = { food: 1, water: 0.125 };
const squalid = { food: 0.25, water: 0 };

test("adds the meal's food and water to today's tally", () => {
  const r = applyMeal({ food: 0.5, water: 0.25 }, needs, modest, 1, {});
  assert.equal(r.state.food, 1.5);
  assert.equal(r.state.water, 0.375);
});

test("the tally is a fraction of the day's need, not pounds or gallons", () => {
  const big = applyMeal({ food: 0, water: 0 }, large, modest, 1, {});
  assert.equal(big.state.food, 0.25);
  assert.equal(big.state.water, 0.03125);
  const small = applyMeal({ food: 0, water: 0 }, tiny, { food: 0, water: 0.125 }, 1, {});
  assert.equal(small.state.water, 0.5);
});

test("a condition clears when the fraction reaches a whole day, whatever the size", () => {
  const r = applyMeal({ food: 0.75, water: 0 }, large, modest, 1, { malnourished: true });
  assert.equal(r.state.food, 1);
  assert.equal(r.clearMalnutrition, true);
  const short = applyMeal({ food: 0, water: 0 }, large, modest, 3, { malnourished: true });
  assert.equal(short.clearMalnutrition, false);
});

test("quantity multiplies", () => {
  const r = applyMeal({ food: 0, water: 0 }, needs, squalid, 4, {});
  assert.equal(r.state.food, 1);
});

test("clears malnutrition only once the day's food need is met, and records it", () => {
  const short = applyMeal({ food: 0, water: 0 }, needs, squalid, 1, { malnourished: true });
  assert.equal(short.clearMalnutrition, false);
  assert.equal(short.state.foodConditionRemoved, false);
  const full = applyMeal({ food: 0, water: 0 }, needs, modest, 1, { malnourished: true });
  assert.equal(full.clearMalnutrition, true);
  assert.equal(full.state.foodConditionRemoved, true);
});

test("clears dehydration the same way, independently", () => {
  const r = applyMeal({ food: 0, water: 0.875 }, needs, modest, 1, { dehydrated: true });
  assert.equal(r.clearDehydration, true);
  assert.equal(r.state.waterConditionRemoved, true);
  assert.equal(r.clearMalnutrition, false);
});

test("never clears a condition the actor does not have, and keeps an earlier marker", () => {
  const r = applyMeal({ food: 0, water: 0, foodConditionRemoved: true }, needs, modest, 1, {});
  assert.equal(r.clearMalnutrition, false);
  assert.equal(r.state.foodConditionRemoved, true);
});

test("a day's worth eaten a piece at a time reaches a whole day, whatever the need", () => {
  const wedge = { food: 0.5, water: 0 };
  const ale = { food: 0, water: 0.125 };
  let fed = { state: { food: 0, water: 0 } };
  for (let i = 0; i < 6; i++) fed = applyMeal(fed.state, { food: 3, water: 1 }, wedge, 1, { malnourished: true });
  assert.equal(fed.state.food, 1);
  assert.equal(fed.clearMalnutrition, true);
  let drunk = { state: { food: 0, water: 0 } };
  for (let i = 0; i < 6; i++) drunk = applyMeal(drunk.state, { food: 1, water: 0.75 }, ale, 1, { dehydrated: true });
  assert.equal(drunk.state.water, 1);
  assert.equal(drunk.clearDehydration, true);
  let thirds = { state: { food: 0, water: 0 } };
  for (let i = 0; i < 3; i++) thirds = applyMeal(thirds.state, { food: 3, water: 1 }, { food: 1, water: 0 }, 1, { malnourished: true });
  assert.equal(thirds.state.food, 1);
  assert.equal(thirds.clearMalnutrition, true);
  const third = applyMeal({ food: 0, water: 0 }, { food: 3, water: 1 }, { food: 1, water: 0 }, 1, {});
  assert.equal(third.state.food, 1 / 3);
});

test("a meal leaves the tally it provides nothing for untouched, even against a need of zero", () => {
  const bread = { food: 1, water: 0 };
  const r = applyMeal({ food: 0, water: 0.5 }, { food: 1, water: 0 }, bread, 1, {});
  assert.equal(r.state.water, 0.5);
});

test("anything meets a need of zero", () => {
  const bread = { food: 1, water: 0 };
  const r = applyMeal({ food: 0, water: 0 }, { food: 0, water: 1 }, bread, 1, { malnourished: true });
  assert.equal(r.state.food, 1);
  assert.equal(r.clearMalnutrition, true);
});

test("only clears the condition for what the meal provides, as Simple Nutrition does", () => {
  const ale = { food: 0, water: 0.125 };
  const r = applyMeal({ food: 1, water: 0 }, needs, ale, 1, { malnourished: true });
  assert.equal(r.clearMalnutrition, false);
  assert.equal(r.state.foodConditionRemoved, false);
});

test("untouched state fields survive", () => {
  const r = applyMeal({ food: 0, water: 0, starvation: 3 }, needs, modest, 1, {});
  assert.equal(r.state.starvation, 3);
});

import { nutritionOfItem, usageConsumes } from "../scripts/nutrition.mjs";

const water = new Set(["water-pint", "ale", "wine-common"]);
const ale = { type: "consumable", consumableType: "food", identifier: "ale", weightLb: 0.5 };
const bread = { type: "consumable", consumableType: "food", identifier: "bread", weightLb: 1 };

test("a registered drink is water, worth one pint, never food", () => {
  assert.deepEqual(nutritionOfItem(ale, water, 0.125), { food: 0, water: 0.125 });
});

test("other food consumables are food by weight", () => {
  assert.deepEqual(nutritionOfItem(bread, water, 0.125), { food: 1, water: 0 });
});

test("things Simple Nutrition would not list are not nutrition", () => {
  assert.equal(nutritionOfItem({ ...bread, type: "loot" }, water, 0.125), null);
  assert.equal(nutritionOfItem({ ...bread, consumableType: "potion" }, water, 0.125), null);
  assert.equal(nutritionOfItem({ ...bread, weightLb: 0 }, water, 0.125), null);
  assert.equal(nutritionOfItem({ ...bread, identifier: "waterskin" }, water, 0.125), null);
  // loose water needs a waterskin around it; that is Simple Nutrition's call, not ours
  assert.equal(nutritionOfItem({ ...ale, identifier: "water-pint" }, water, 0.125), null);
});

test("a use only counts when it actually consumed the item", () => {
  assert.equal(usageConsumes({}), true);
  assert.equal(usageConsumes({ consume: true }), true);
  assert.equal(usageConsumes({ consume: { resources: true } }), true);
  assert.equal(usageConsumes({ consume: { resources: [0] } }), true);
  assert.equal(usageConsumes({ consume: false }), false);
  assert.equal(usageConsumes({ consume: { resources: false } }), false);
  assert.equal(usageConsumes({ consume: { resources: [] } }), false);
});

import { oneAtATime } from "../scripts/nutrition.mjs";

// Foundry applies a flag update locally only once the server answers, so a
// second read that starts before then sees the tally without the first credit.
function slowActor() {
  const actor = { flag: { food: 0, water: 0 } };
  actor.write = state => new Promise(resolve => setTimeout(() => { actor.flag = state; resolve(); }, 10));
  return actor;
}

test("credits for one actor started together all land (#44)", async () => {
  const actor = slowActor();
  const credit = () => oneAtATime("Actor.tess", async () => {
    await actor.write(applyMeal(actor.flag, needs, squalid, 1, {}).state);
  });
  await Promise.all([credit(), credit(), credit(), credit()]);
  assert.equal(actor.flag.food, 1);
});

test("a credit that fails does not hold up the ones queued behind it", async () => {
  const failed = oneAtATime("Actor.tess", async () => { throw new Error("server went away"); });
  const next = oneAtATime("Actor.tess", async () => "fed");
  await assert.rejects(failed, /server went away/);
  assert.equal(await next, "fed");
});

test("different actors do not wait for each other", async () => {
  const order = [];
  const slow = oneAtATime("Actor.a", () => new Promise(resolve => setTimeout(() => { order.push("a"); resolve(); }, 20)));
  const quick = oneAtATime("Actor.b", async () => { order.push("b"); });
  await Promise.all([slow, quick]);
  assert.deepEqual(order, ["b", "a"]);
});
