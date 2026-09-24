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
 * same result, so this matches 1.x for every price a shop can show.
 *
 * **Payment, decided for #101:** pay from the buyer's actual coins, largest
 * value first without exceeding the price — that's what lands on an exact
 * price using the fewest, biggest coins. If that undershoots (a purse of
 * only large coins), the smallest coin that can finish the price in one go
 * tops it up, repeated until the price is met, so overpayment stays as small
 * as the purse allows. Change comes out of the till, which is a
 * money-changer: only its *total* matters (the decided rule), so once a
 * trade needs change the till's whole post-trade balance is re-minted
 * canonically (see `breakIntoCoins`) rather than adjusted coin by coin — a
 * till can give change in coins it never physically held, as long as the
 * total covers it. The buyer's own coins stay literal throughout: specific
 * coins are spent, specific change coins are added, the rest of the purse is
 * untouched. A trade is refused only when the purse's total is short of the
 * price, or the till's total is short of the change.
 */

/* ---------------------------------------------------------------- coins */

/** The denomination with the highest `conversion`: the smallest coin, dnd5e's cp. */
function baseDenomination(currencies) {
  return Object.keys(currencies).reduce((base, key) =>
    base === null || currencies[key].conversion > currencies[base].conversion ? key : base, null);
}

/** One `denomination` coin's worth in the finest coin, a whole number for any sane currency config. */
function cpValue(denomination, currencies, base) {
  const value = currencies[base].conversion / currencies[denomination].conversion;
  return Math.round(value * 1e6) / 1e6;   // clears float noise (e.g. 100 / 0.1), not real rounding
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

/** `amountCp` re-minted from scratch: as many of the largest coin as fit, then the next, and so on. */
function breakIntoCoins(amountCp, currencies) {
  const coins = {};
  let remaining = amountCp;
  for (const [denomination, value] of denominationsByValue(currencies)) {
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
  return Math.floor(price.value * cpValue(price.denomination, currencies, base) * rate / bundle);
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
 * @param {{buy?: number, sell?: number}|null} [deal]  a character's deal (#111): `buy` shifts
 *   `sellsAt` (what the character pays, e.g. -0.1 for "10% off"), `sell` shifts `buysAt`
 *   (what the shop pays the character, e.g. 0.1 for "+10% on sale offers"). Both are added
 *   straight to the rate, not multiplied, matching the schema's rates (1 = full price).
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

  if (deal?.buy) sellsAt = { rate: sellsAt.rate + deal.buy, layer: "deal" };
  if (deal?.sell) buysAt = { rate: buysAt.rate + deal.sell, layer: "deal" };

  if (buysAt.rate > sellsAt.rate) buysAt = { rate: sellsAt.rate, layer: "cap" };

  return { sellsAt, buysAt };
}

/* -------------------------------------------------------------- payment */

/** The buyer's coins to hand over: largest-value first, then a top-up coin if that undershoots. */
function selectPayment(purse, priceCp, currencies) {
  const byValue = denominationsByValue(currencies);
  const taken = {};
  let paid = 0;
  for (const [denomination, value] of byValue) {
    const available = purse[denomination] ?? 0;
    const need = Math.floor((priceCp - paid) / value);
    const take = Math.min(available, need);
    if (take > 0) {
      taken[denomination] = take;
      paid += take * value;
    }
  }
  const leftOf = denomination => (purse[denomination] ?? 0) - (taken[denomination] ?? 0);
  while (paid < priceCp) {
    const remaining = priceCp - paid;
    const available = [...byValue].reverse().filter(([d]) => leftOf(d) > 0);   // smallest first
    const [denomination, value] = available.find(([, v]) => v >= remaining)
      ?? available[available.length - 1];   // no single coin covers it: take the largest there is
    taken[denomination] = (taken[denomination] ?? 0) + 1;
    paid += value;
  }
  return { taken, paid };
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
  const newPurse = { ...purse };
  for (const [denomination, count] of Object.entries(taken)) {
    newPurse[denomination] = (newPurse[denomination] ?? 0) - count;
  }

  if (changeCp === 0) {
    const newTill = { ...till };
    for (const [denomination, count] of Object.entries(taken)) {
      newTill[denomination] = (newTill[denomination] ?? 0) + count;
    }
    return { ok: true, purse: newPurse, till: newTill, changeCp: 0 };
  }

  const tillTotal = totalCp(till, currencies);
  if (tillTotal < changeCp) return { ok: false, reason: "till" };

  for (const [denomination, count] of Object.entries(breakIntoCoins(changeCp, currencies))) {
    newPurse[denomination] = (newPurse[denomination] ?? 0) + count;
  }
  // The till converts freely (#101 decision): its post-trade balance is
  // re-minted canonically rather than tracked coin by coin, so it can give
  // change in coins it never held, as long as the total covers it. Its net
  // gain is always exactly the price (paid in, changeCp out).
  const newTill = breakIntoCoins(tillTotal + priceCp, currencies);

  return { ok: true, purse: newPurse, till: newTill, changeCp };
}
