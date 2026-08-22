/**
 * The arithmetic of eating a meal, kept free of Foundry so it can be tested
 * with plain Node (tools/nutrition.test.mjs).
 *
 * This mirrors what Simple Nutrition 5e does when its own Eat dialog consumes
 * an item (scripts/nutrition/hooks.mjs, consumeNutrition): add the amount to
 * today's tally, and if that tally now meets the day's need while the actor is
 * carrying the matching condition, clear it and remember having done so. Both
 * tallies reset to zero at the next long rest, so nothing carries over.
 *
 * @param {object} state      Simple Nutrition's state for the actor: food, water,
 *                            starvation, foodConditionRemoved, waterConditionRemoved.
 * @param {object} needs      The actor's daily need: { food (lb), water (gallons) }.
 * @param {object} nutrition  What one meal provides: { food (lb), water (gallons) }.
 * @param {number} quantity   How many were bought.
 * @param {object} has        Which conditions the actor currently carries:
 *                            { malnourished, dehydrated }.
 * @returns {{ state: object, clearMalnutrition: boolean, clearDehydration: boolean }}
 */
export function applyMeal(state, needs, nutrition, quantity, has) {
  const food = (state.food ?? 0) + (nutrition.food ?? 0) * quantity;
  const water = (state.water ?? 0) + (nutrition.water ?? 0) * quantity;
  const clearMalnutrition = !!has.malnourished && food >= needs.food;
  const clearDehydration = !!has.dehydrated && water >= needs.water;
  return {
    state: {
      ...state,
      food,
      water,
      foodConditionRemoved: !!state.foodConditionRemoved || clearMalnutrition,
      waterConditionRemoved: !!state.waterConditionRemoved || clearDehydration
    },
    clearMalnutrition,
    clearDehydration
  };
}
