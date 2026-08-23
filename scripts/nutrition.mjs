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

/**
 * What one unit of an item is worth when eaten or drunk, by Simple Nutrition's
 * own rules (scripts/nutrition/hooks.mjs, getFoodCandidates/getWaterCandidates):
 * only consumables; a registered water identifier is a pint of water and never
 * food; any other consumable of type "food" is food by its weight in pounds.
 * Loose "water-pint" only counts inside a waterskin, which needs the live
 * document to judge, so it is left to Simple Nutrition's own dialog.
 *
 * @param {object} item  { type, consumableType, identifier, weightLb }
 * @param {Set<string>} waterIdentifiers  Simple Nutrition's WATER_IDENTIFIERS.
 * @param {number} waterAmount  Simple Nutrition's WATER_ITEM_AMOUNT (gallons).
 * @returns {{ food: number, water: number } | null}  null when it is not nutrition.
 */
export function nutritionOfItem(item, waterIdentifiers, waterAmount) {
  if (item.type !== "consumable") return null;
  if (waterIdentifiers.has(item.identifier)) {
    if (item.identifier === "water-pint") return null;
    return { food: 0, water: waterAmount };
  }
  if (item.consumableType !== "food") return null;
  if (item.identifier === "waterskin") return null;
  if (!(item.weightLb > 0)) return null;
  return { food: item.weightLb, water: 0 };
}

/**
 * Did an activity use actually consume its item? dnd5e lets the user untick
 * consumption in the usage dialog, which lands in usageConfig.consume as
 * false, { resources: false } or an empty resources list.
 *
 * @param {object} usageConfig  dnd5e's ActivityUseConfiguration.
 * @returns {boolean}
 */
export function usageConsumes(usageConfig) {
  const consume = usageConfig?.consume;
  if (consume === false) return false;
  const resources = consume?.resources;
  if (resources === false) return false;
  if (Array.isArray(resources) && resources.length === 0) return false;
  return true;
}
