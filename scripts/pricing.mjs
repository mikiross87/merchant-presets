/**
 * Pricing (#101): the shop's four rate layers, an item's price in the shop's
 * smallest coin, and paying it with change.
 *
 * Foundry-free, like schema.mjs (tools/pricing.test.mjs runs it under plain
 * Node). The caller supplies dnd5e's currency config
 * (`CONFIG.DND5E.currencies`, `{denom: {conversion, ...}}`, where
 * `conversion` is how many of that coin make one reference unit — dnd5e's gp
 * is 1, cp is 100): this module never assumes which denominations exist, so
 * homebrew currencies work. Amounts move in the *finest* coin the config
 * defines — the denomination with the highest `conversion`, dnd5e's copper
 * piece — kept as a whole number everywhere but the one place a price is
 * computed.
 *
 * **Rounding, decided once: a price rounds down to the nearest finest coin.**
 * Item Piles 3.3.4 computes a price at ~5-decimal gp precision
 * (`getPriceData`, item-piles.js:35791-35796) — six times finer than a
 * copper piece, so that step is float cleanup, not a real rounding choice —
 * then breaks the amount into coins largest first, `Math.floor`ing the count
 * at every denomination and dropping whatever's left below the smallest coin
 * (`getPriceArray`, item-piles.js:35502-35544, walking pp -> ep -> sp -> cp,
 * the descending order itempilesdnd5e registers them in,
 * dist/module.js:75-130). dnd5e's own `roundCurrency` floors the same way
 * when a currency has no configured fractional digits (dnd5e.mjs:119-124).
 * Flooring the whole price to the finest coin in a single step lands on the
 * same result, so this matches 1.x for every price a shop can show. That
 * floor has to run on a *cleaned* number (see `clean`): a plain
 * `price × rate` can land a hair under the intended whole cp (e.g. 15gp ×
 * 1.15 is 1724.9999999999998 in float), and flooring that raw value would
 * knock a real price down by a full copper.
 *
 * **Payment, decided for #101:** of every way the buyer's coins can cover the
 * price, pick the one that overpays the least (see `selectPayment`) — a
 * purse of {1gp, 9sp} paying a 95cp price hands over just the gold piece (5cp
 * overpaid), not the gold *and* all nine silver (95cp overpaid) that a single
 * greedy largest-first pass would have already spent by the time it needed a
 * bigger coin to close the gap. Change comes out of the till: both sides stay
 * *literal* coins throughout, added or removed one denomination at a time —
 * neither purse is ever re-minted from its total, so an NPC's gold doesn't
 * turn into platinum just because a sale needed change. The till gives
 * change the same largest-first way payment is taken; when that undershoots,
 * it breaks the smallest coin it holds that's still bigger than what's left
 * into smaller coins (see `breakIntoCoins`) and tries again — the
 * money-changer from the #101 decision, working one coin at a time rather
 * than inventing a coin it never held. A trade is refused only when the
 * purse's total is short of the price, or the till's own total (before the
 * sale) is short of the change.
 */

/* ---------------------------------------------------------------- coins */

/** Clears float noise from a product or quotient of coin values; not a real rounding rule. */
function clean(value) {
  return Math.round(value * 1e9) / 1e9;
}

/** The denomination with the highest `conversion`: the smallest coin, dnd5e's cp. */
function baseDenomination(currencies) {
  return Object.keys(currencies).reduce((base, key) =>
    base === null || currencies[key].conversion > currencies[base].conversion ? key : base, null);
}

/** One `denomination` coin's worth in the finest coin, a whole number for any sane currency config. */
function cpValue(denomination, currencies, base) {
  return clean(currencies[base].conversion / currencies[denomination].conversion);
}

/** `[denomination, cpValue]` pairs, largest coin first. */
function denominationsByValue(currencies) {
  const base = baseDenomination(currencies);
  return Object.keys(currencies)
    .map(denomination => [denomination, cpValue(denomination, currencies, base)])
    .sort((a, b) => b[1] - a[1]);
}

/**
 * A purse or till's total worth, in the finest coin. Missing denominations
 * count as 0.
 *
 * @param {Record<string, number>} coins
 * @param {Record<string, {conversion: number}>} currencies
 * @returns {number}
 */
export function totalCp(coins, currencies) {
  return denominationsByValue(currencies)
    .reduce((sum, [denomination, value]) => sum + (coins[denomination] ?? 0) * value, 0);
}

/** `amountCp` built from `denominations` (`[denomination, value]` pairs, largest first). */
function breakIntoCoins(amountCp, denominations) {
  const coins = {};
  let remaining = amountCp;
  for (const [denomination, value] of denominations) {
    const count = Math.floor(remaining / value);
    if (count > 0) {
      coins[denomination] = count;
      remaining -= count * value;
    }
  }
  return coins;
}

/* ---------------------------------------------------------------- price */

/**
 * An item's price in the finest coin, for one of the `bundle` it's sold in.
 *
 * @param {{value: number, denomination: string}} price  dnd5e's `item.system.price`
 * @param {number} rate    the effective sellsAt or buysAt rate (see `effectiveRates`)
 * @param {number} bundle  `quantityForPrice`: how many the price buys
 * @param {Record<string, {conversion: number}>} currencies
 * @returns {number}
 * @throws {RangeError} if `price.denomination` isn't in `currencies`
 */
export function itemPriceCp(price, rate, bundle, currencies) {
  if (!(price.denomination in currencies)) {
    throw new RangeError(`unknown denomination: ${price.denomination}`);
  }
  const base = baseDenomination(currencies);
  const raw = price.value * cpValue(price.denomination, currencies, base) * rate / bundle;
  return Math.floor(clean(raw));
}

/* ---------------------------------------------------------------- rates */

/**
 * @typedef {{rate: number, layer: "world"|"shop"|"category"|"deal"|"cap"}} EffectiveRate
 */

/**
 * The rates a shop actually charges, layered world -> shop terms -> category
 * rule -> deal (#111), then capped: the shop's `buysAt` (what it pays) can
 * never exceed its `sellsAt` (what it charges), whatever the layers stack
 * to. Each returned rate names the layer that set it, for the UI.
 *
 * @param {{sellsAt: number, buysAt: number}} world  Configure Settings defaults (#110)
 * @param {{sellsAt: number|null, buysAt: number|null,
 *   categories: {category: string, sellsAt: number, buysAt: number}[]}} shop  a shop config's `terms` (#98)
 * @param {string|null} [category]  the item's category, matched against `shop.categories`
 * @param {{buy?: number, sell?: number}|null} [deal]  a character's deal (#111), as a percentage
 *   of what the character would otherwise pay or be offered *at this shop*: `buy` scales
 *   `sellsAt` by `(1 + buy)` (e.g. -0.1 is 10% off whatever this shop charges, so a 1.25 markup
 *   becomes 1.125, not 1.25 - 0.1); `sell` scales `buysAt` by `(1 + sell)` the same way (e.g. 0.1
 *   is 10% more on this shop's own offers).
 * @returns {{sellsAt: EffectiveRate, buysAt: EffectiveRate}}
 */
export function effectiveRates(world, shop, category = null, deal = null) {
  let sellsAt = { rate: world.sellsAt, layer: "world" };
  let buysAt = { rate: world.buysAt, layer: "world" };

  if (shop.sellsAt !== null) sellsAt = { rate: shop.sellsAt, layer: "shop" };
  if (shop.buysAt !== null) buysAt = { rate: shop.buysAt, layer: "shop" };

  const rule = category ? shop.categories.find(c => c.category === category) : null;
  if (rule) {
    sellsAt = { rate: rule.sellsAt, layer: "category" };
    buysAt = { rate: rule.buysAt, layer: "category" };
  }

  if (deal?.buy) sellsAt = { rate: clean(sellsAt.rate * (1 + deal.buy)), layer: "deal" };
  if (deal?.sell) buysAt = { rate: clean(buysAt.rate * (1 + deal.sell)), layer: "deal" };

  if (buysAt.rate > sellsAt.rate) buysAt = { rate: sellsAt.rate, layer: "cap" };

  return { sellsAt, buysAt };
}

/* -------------------------------------------------------------- payment */

/** As much of `targetCp` as `available` coins can make without exceeding it: largest-value first. */
function greedyTake(available, targetCp, denominations) {
  const taken = {};
  let paid = 0;
  for (const [denomination, value] of denominations) {
    const have = available[denomination] ?? 0;
    const need = Math.floor((targetCp - paid) / value);
    const take = Math.min(have, need);
    if (take > 0) {
      taken[denomination] = take;
      paid += take * value;
    }
  }
  return { taken, paid };
}

/**
 * The buyer's coins to hand over, minimising overpayment: for every prefix of denominations
 * (largest coin alone, largest two, and so on down to all of them), take as many of that
 * prefix as fit without exceeding the price, then — if that's short — one more coin of the
 * smallest denomination in the prefix, if the purse has one spare. Each prefix that reaches
 * the price is a valid way to pay; this picks whichever overpays the least. A single greedy
 * pass (just the last, full-denominations prefix) can already have spent every small coin
 * before it discovers it needs a bigger one, forcing that bigger coin on top instead of in
 * place of what's spent — trying every prefix considers paying with the bigger coin alone
 * too. A candidate always exists: with every denomination in the prefix, greedy-without-
 * exceeding spends the purse's entire supply of any denomination it doesn't have enough of
 * to meet the price alone, so whichever denomination first has enough left over (there must
 * be one once the purse's total covers the price) either lands exactly on the price or has
 * a spare coin ready to close the last, sub-one-coin gap.
 */
function selectPayment(purse, priceCp, currencies) {
  const byValue = denominationsByValue(currencies);
  let best = null;
  for (let i = 0; i < byValue.length; i++) {
    const prefix = byValue.slice(0, i + 1);
    const { taken, paid } = greedyTake(purse, priceCp, prefix);
    const [smallest, smallestValue] = prefix[prefix.length - 1];
    const spent = taken[smallest] ?? 0;
    const candidate = paid === priceCp ? { taken, paid }
      : (purse[smallest] ?? 0) > spent ? { taken: { ...taken, [smallest]: spent + 1 }, paid: paid + smallestValue }
      : null;
    if (candidate && (!best || candidate.paid - priceCp < best.paid - priceCp)) best = candidate;
  }
  return best;
}

/**
 * The coins to hand back as `amountCp` change from `holdings`, and what's left of `holdings`
 * afterwards. Largest-value first, without exceeding the amount; when that undershoots, the
 * smallest held coin that's still worth more than what's left is broken into smaller coins
 * (only those smaller than it, never itself) and the attempt starts over. Assumes
 * `totalCp(holdings, currencies) >= amountCp` — every leftover coin after a failed pass is,
 * by construction, worth more than what's still owed, so there's always something to break,
 * and breaking only ever increases how finely the total can be split.
 */
function makeChange(holdings, amountCp, currencies) {
  const byValue = denominationsByValue(currencies);
  const available = { ...holdings };
  for (;;) {
    const { taken, paid } = greedyTake(available, amountCp, byValue);
    if (paid === amountCp) {
      const remaining = { ...available };
      for (const [denomination, count] of Object.entries(taken)) remaining[denomination] -= count;
      return { given: taken, remaining };
    }
    const shortfall = amountCp - paid;
    const breakable = byValue
      .filter(([d, v]) => v > shortfall && (available[d] ?? 0) - (taken[d] ?? 0) > 0);
    const [breakDenomination, breakValue] = breakable[breakable.length - 1];   // the smallest still too big
    available[breakDenomination] -= 1;
    const smaller = byValue.filter(([, v]) => v < breakValue);
    for (const [denomination, count] of Object.entries(breakIntoCoins(breakValue, smaller))) {
      available[denomination] = (available[denomination] ?? 0) + count;
    }
  }
}

/**
 * Pays `priceCp` out of `purse`, breaking coins from `till` for change.
 * Never mutates `purse` or `till`.
 *
 * @param {Record<string, number>} purse  the payer's coins by denomination
 * @param {number} priceCp                the price, in the finest coin
 * @param {Record<string, number>} till   the payee's coins by denomination
 * @param {Record<string, {conversion: number}>} currencies
 * @returns {{ok: true, purse: Record<string, number>, till: Record<string, number>, changeCp: number}
 *         | {ok: false, reason: "purse"|"till"}}
 */
export function pay(purse, priceCp, till, currencies) {
  if (totalCp(purse, currencies) < priceCp) return { ok: false, reason: "purse" };

  const { taken, paid } = selectPayment(purse, priceCp, currencies);
  const changeCp = paid - priceCp;

  if (totalCp(till, currencies) < changeCp) return { ok: false, reason: "till" };

  const { given, remaining } = makeChange(till, changeCp, currencies);

  const newPurse = { ...purse };
  for (const [denomination, count] of Object.entries(taken)) {
    newPurse[denomination] = (newPurse[denomination] ?? 0) - count;
  }
  for (const [denomination, count] of Object.entries(given)) {
    newPurse[denomination] = (newPurse[denomination] ?? 0) + count;
  }

  const newTill = { ...remaining };
  for (const [denomination, count] of Object.entries(taken)) {
    newTill[denomination] = (newTill[denomination] ?? 0) + count;
  }

  return { ok: true, purse: newPurse, till: newTill, changeCp };
}
