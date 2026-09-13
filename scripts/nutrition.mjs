/**
 * The arithmetic of eating a meal, kept free of Foundry so it can be tested
 * with plain Node (tools/nutrition.test.mjs).
 *
 * This mirrors what Simple Nutrition 5e (1.0+) does when its own Eat dialog
 * consumes an item (scripts/nutrition/consumption.mjs, consumeNutrition): add
 * the amount to today's tally as a fraction of the day's need, and if that
 * tally reaches a whole day while the actor is carrying the matching condition,
 * clear it and remember having done so. As there, only a type the meal
 * actually provides is touched, so drinking an ale never clears Malnourished.
 * Both tallies reset at Simple Nutrition's day change, so nothing carries over.
 *
 * @param {object} state      Simple Nutrition's state for the actor: food, water
 *                            (fractions of a day), starvation, foodConditionRemoved,
 *                            waterConditionRemoved.
 * @param {object} needs      The actor's daily need: { food (lb), water (gallons) }.
 * @param {object} nutrition  What one meal provides: { food (lb), water (gallons) }.
 * @param {number} quantity   How many were bought.
 * @param {object} has        Which conditions the actor currently carries:
 *                            { malnourished, dehydrated }.
 * @returns {{ state: object, clearMalnutrition: boolean, clearDehydration: boolean }}
 */
export function applyMeal(state, needs, nutrition, quantity, has) {
  const food = tally(state.food, nutrition.food, quantity, needs.food);
  const water = tally(state.water, nutrition.water, quantity, needs.water);
  const clearMalnutrition = !!has.malnourished && nutrition.food > 0 && food >= 1;
  const clearDehydration = !!has.dehydrated && nutrition.water > 0 && water >= 1;
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
 * One of today's tallies after a meal, in fractions of a day. A meal with none
 * of the type leaves it alone, and anything meets a need of zero, so a GM who
 * sets a need to 0 never gets NaN or Infinity written into the flag.
 *
 * A day eaten piece by piece — six 0.5 lb wedges against a 3 lb need — sums to
 * 0.9999999999999999 in floating point, and Simple Nutrition's day change reads
 * the stored value with `>= 1`. So a sum within float error of a millionth is
 * snapped onto it. Rounding every sum instead would not do: it would drop the
 * repeating tail of each third and leave three thirds at 0.999999999.
 */
function tally(current, amount, quantity, need) {
  const before = current ?? 0;
  const total = (amount ?? 0) * quantity;
  if (!(total > 0)) return before;
  const sum = before + (need > 0 ? total / need : 1);
  const tidy = Math.round(sum * 1e6) / 1e6;
  return Math.abs(sum - tidy) < 1e-9 ? tidy : sum;
}

/** The tail of each actor's queue of nutrition credits, by key. */
const queues = new Map();

/**
 * Run `task` once every task queued before it under the same key has settled.
 *
 * Crediting a meal reads Simple Nutrition's tally and then awaits the flag
 * write, which Foundry applies to the local actor only once the server
 * answers. Two credits for one actor that overlap both read the tally without
 * the other, and the later write erases the earlier credit (#44). Queued, each
 * read waits for the write before it. A task that fails still lets the next
 * one run. This orders credits made on this client only: Simple Nutrition's
 * own dialog, or another user's client, can still interleave.
 *
 * @template T
 * @param {string} key           What to serialise on: the actor's uuid.
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}         The task's own result or rejection.
 */
export function oneAtATime(key, task) {
  const run = (queues.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/**
 * What one unit of an item is worth when eaten or drunk, by Simple Nutrition's
 * own rules (scripts/nutrition/consumption.mjs, getFoodCandidates/getWaterCandidates):
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
