import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMeal } from "../scripts/nutrition.mjs";

const needs = { food: 1, water: 1 };          // a Medium creature's day
const modest = { food: 1, water: 0.125 };
const squalid = { food: 0.25, water: 0 };

test("adds the meal's food and water to today's tally", () => {
  const r = applyMeal({ food: 0.5, water: 0.25 }, needs, modest, 1, {});
  assert.equal(r.state.food, 1.5);
  assert.equal(r.state.water, 0.375);
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
