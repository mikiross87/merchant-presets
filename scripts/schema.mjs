/**
 * The module's own shop config (#98), kept free of Foundry so it can be tested
 * with plain Node (tools/schema.test.mjs).
 *
 * `flags.merchant-presets.shop` on a shop actor, `flags.merchant-presets.stock`
 * on each stock item. They replace the Item Piles flags, whose shape isn't
 * ours and whose defaults Item Piles strips on every write. Only what varies
 * between the 51 shops is config; what they all share is fixed behaviour:
 * non-item types, natural weapons and shopkeeper gear are never bought.
 *
 * Rates read from the shop's side, as the shop window words them: it *sells
 * at* `terms.sellsAt` × price and *buys at* `terms.buysAt` × value. A null
 * rate follows the world default (#110). `deals` (#111, deals.mjs) give one
 * character their own price, as a factor on the shop's. The portrait is the actor's own
 * image and the title its name, so neither is config.
 */

export const SHOP_VERSION = 1;

/** Freezes `obj` and everything inside it, so a stray write to the defaults throws. */
function deepFreeze(obj) {
  for (const v of Object.values(obj)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(obj);
}

const TIERS = ["Village", "Town", "City"];

export const SHOP_DEFAULTS = deepFreeze({
  version: SHOP_VERSION,
  tier: "Town",
  source: null,            // the shipped merchant an NPC was set up from (#57)
  description: "",
  terms: { sellsAt: null, buysAt: null, categories: [] },
  hours: { open: { hour: 7, minute: 0 }, close: { hour: 19, minute: 0 } },   // null: always open
  restock: { table: null, quantities: {}, onOpen: true, every: 7, mode: "reroll" },   // #105
  wontBuy: { types: [], kinds: [] },
  deals: []                // one character's own price here (#111)
});

export const STOCK_DEFAULTS = deepFreeze({
  infinite: null,          // null follows the world's stock setting
  keep: true,
  service: false,
  noBuyback: false,
  category: "",            // "" files it under its item type
  bundle: 1,               // how many the price buys
  hidden: false,
  notForSale: false
});

/* -------------------------------------------------------------------------- */
/*  Checks: each takes (value, path, errors) and pushes what's wrong           */
/* -------------------------------------------------------------------------- */

const isObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const check = (test, message) => (v, path, errors) => {
  if (!test(v)) errors.push(`${path}: ${message}`);
};

const bool = check(v => typeof v === "boolean", "must be true or false");
const string = check(v => typeof v === "string", "must be a string");
const name = check(v => typeof v === "string" && v.length > 0, "must be a non-empty string");
const rate = min => check(v => typeof v === "number" && Number.isFinite(v) && (min === 0 ? v >= 0 : v > 0),
  min === 0 ? "must be a number, 0 or more" : "must be a number above 0");
const nullOr = inner => (v, path, errors) => { if (v !== null) inner(v, path, errors); };
// A roll formula of dice and arithmetic: "1", "2d6+4", "1d2-1", "(2d6+4)*20" for
// goods sold by the bundle. Shape only; Foundry's Roll parses it for real.
const formula = check(v => typeof v === "string" && /^[\d\sd+\-*/()]+$/.test(v) && /\d/.test(v),
  "must be a dice formula like 2d6+4");
const oneOf = values => check(v => values.includes(v), `must be one of ${values.join(", ")}`);

/**
 * A plain object holding only `fields`; every field optional unless listed in
 * `required`. A key set to `undefined` counts as missing, as it does in
 * `shopFrom`. Own keys only: flag data is untrusted, and `constructor` or
 * `__proto__` must read as unknown, not as something inherited.
 */
const shape = (fields, required = []) => (v, path, errors) => {
  if (!isObject(v)) return errors.push(`${path || "config"}: must be an object`);
  const at = key => (path ? `${path}.${key}` : key);
  for (const key of Object.keys(v)) {
    if (!Object.hasOwn(fields, key)) errors.push(`${at(key)}: unknown key`);
    else if (v[key] !== undefined) fields[key](v[key], at(key), errors);
  }
  for (const key of required) if (!Object.hasOwn(v, key) || v[key] === undefined) errors.push(`${at(key)}: missing`);
};

/** An array of distinct entries; `key` picks what must be distinct. */
const list = (inner, key = v => v) => (v, path, errors) => {
  if (!Array.isArray(v)) return errors.push(`${path}: must be a list`);
  const seen = new Set();
  for (let i = 0; i < v.length; i++) {   // not forEach, which skips holes
    if (!(i in v)) { errors.push(`${path}.${i}: missing`); continue; }
    inner(v[i], `${path}.${i}`, errors);
    if (key(v[i]) !== undefined && seen.has(key(v[i]))) errors.push(`${path}.${i}: duplicate`);
    seen.add(key(v[i]));
  }
};

// A deal's adjustment, as a factor on this shop's own rate (pricing.mjs `effectiveRates`): -0.1 is
// 10% off. Above -1, so no deal gives the goods away or has the shop paid to take them.
const adjustment = check(v => typeof v === "number" && Number.isFinite(v) && v > -1, "must be a number above -1");

const deal = (v, path, errors) => {
  shape({
    actor: name,
    name: string,
    buy: nullOr(adjustment),
    sell: nullOr(adjustment),
    note: string,
    ends: nullOr(shape({
      at: check(v => typeof v === "number" && Number.isFinite(v), "must be a world time"),
      when: oneOf(["close", "date"])
    }, ["at", "when"]))
  }, ["actor", "buy", "sell"])(v, path, errors);
  if (isObject(v) && !v.buy && !v.sell) errors.push(`${path}: changes no price`);
};

const time = shape({
  hour: check(v => isInt(v, 0, 23), "must be a whole hour, 0 to 23"),
  minute: check(v => isInt(v, 0, 59), "must be a whole minute, 0 to 59")
}, ["hour", "minute"]);

const hours = (v, path, errors) => {
  shape({ open: time, close: time }, ["open", "close"])(v, path, errors);
  if (v?.open && v?.close && v.open.hour === v.close.hour && v.open.minute === v.close.minute) {
    errors.push(`${path}: opens and closes at the same time`);
  }
};

const shopShape = shape({
  version: check(v => v === SHOP_VERSION, `must be ${SHOP_VERSION}`),
  tier: oneOf(TIERS),
  source: nullOr(name),
  description: string,
  terms: shape({
    sellsAt: nullOr(rate(1)),
    buysAt: nullOr(rate(0)),
    categories: list(shape({ category: name, sellsAt: rate(1), buysAt: rate(0) }, ["category", "sellsAt", "buysAt"]),
      c => c?.category)
  }),
  hours: nullOr(hours),
  restock: shape({
    table: nullOr(name),
    quantities: (v, path, errors) => {
      if (!isObject(v)) return errors.push(`${path}: must be an object`);
      for (const [id, f] of Object.entries(v)) formula(f, `${path}.${id}`, errors);
    },
    onOpen: bool,
    every: (v, path, errors) => {
      if (v === "never" || isInt(v, 1, Infinity)) return;
      formula(v, path, errors);
    },
    mode: oneOf(["reroll", "topup"])
  }),
  // dnd5e item types and our `kind`s. Checked for shape only: the item types
  // live in CONFIG, which a Foundry-free module can't read.
  wontBuy: shape({ types: list(name), kinds: list(name) }),
  deals: list(deal, d => d?.actor)
}, ["version"]);

const stockShape = shape({
  infinite: nullOr(bool),
  keep: bool,
  service: bool,
  noBuyback: bool,
  category: string,
  bundle: check(v => isInt(v, 1, Infinity), "must be a whole number, 1 or more"),
  hidden: bool,
  notForSale: bool
});

const run = (checker, v) => {
  const errors = [];
  checker(v, "", errors);
  return { ok: errors.length === 0, errors };
};

/**
 * Whether `shop` is a valid `flags.merchant-presets.shop`. Missing keys are
 * fine (they take the defaults), except `version`: a shop without the current
 * one still needs migrating.
 *
 * @param {unknown} shop
 * @returns {{ok: boolean, errors: string[]}}
 */
export const validateShop = shop => run(shopShape, shop);

/**
 * Whether `stock` is a valid `flags.merchant-presets.stock`.
 *
 * @param {unknown} stock
 * @returns {{ok: boolean, errors: string[]}}
 */
export const validateStock = stock => run(stockShape, stock);

/** `value` over `defaults`, key by key through plain objects; lists and null replace, undefined doesn't. */
function merge(defaults, value) {
  if (!isObject(defaults) || !isObject(value)) return structuredClone(value === undefined ? defaults : value);
  const out = {};
  for (const key of new Set([...Object.keys(defaults), ...Object.keys(value)])) out[key] = merge(defaults[key], value[key]);
  return out;
}

/** Merges only valid input: guessing would stamp an old config as current, or complete half-set hours. */
function complete(validate, defaults, value, what) {
  const { ok, errors } = validate(value);
  if (!ok) throw new TypeError(`Invalid ${what}: ${errors.join("; ")}`);
  return merge(defaults, value);
}

/**
 * A full shop config: `shop` over the defaults, as a fresh copy. `shop` must
 * pass `validateShop`, so check a raw flag first; a shop without the current
 * `version` needs migrating, not filling in.
 *
 * @param {object} shop
 * @returns {object}
 * @throws {TypeError} listing every error, when `shop` is invalid
 */
export const shopFrom = shop => complete(validateShop, SHOP_DEFAULTS, shop, "shop config");

/**
 * A full stock config: `stock` over the defaults, as a fresh copy. `stock`
 * must pass `validateStock`.
 *
 * @param {object} stock
 * @returns {object}
 * @throws {TypeError} listing every error, when `stock` is invalid
 */
export const stockFrom = stock => complete(validateStock, STOCK_DEFAULTS, stock, "stock config");
