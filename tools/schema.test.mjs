import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  SHOP_DEFAULTS, SHOP_VERSION, STOCK_DEFAULTS, shopFrom, stockFrom, validateShop, validateStock
} from "../scripts/schema.mjs";

/** Every shipped merchant, as the generator writes it. */
const dir = new URL("../_source/merchants/", import.meta.url);
const merchants = readdirSync(dir)
  .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")))
  .filter(m => m.flags?.["item-piles"]);

/** Filters every shop carries, which the schema turns into fixed behaviour. */
const FIXED_TYPES = "background,class,facility,feat,race,spell,subclass";

/**
 * A shipped merchant's Item Piles data in the new shape, mapped by hand. This
 * is the positive control for the schema, not the migration (#100).
 */
function shopOf(merchant) {
  const d = merchant.flags["item-piles"].data;
  const table = d.tablesForPopulate[0];
  const filters = d.overrideItemFilters.filter(f =>
    !(f.path === "type" && f.filters === FIXED_TYPES) && f.path !== "system.type.value");
  const list = path => filters.filter(f => f.path === path)
    .flatMap(f => f.filters.split(",")).filter(k => k !== "gear");
  return {
    version: SHOP_VERSION,
    tier: merchant.name.match(/\((Village|Town|City)\)/)[1],
    source: null,
    description: d.description,
    terms: {
      sellsAt: d.buyPriceModifier,
      buysAt: d.sellPriceModifier,
      categories: (d.itemTypePriceModifiers ?? []).map(m =>
        ({ category: m.category, sellsAt: m.buyPriceModifier, buysAt: m.sellPriceModifier }))
    },
    hours: { open: d.openTimes.open, close: d.openTimes.close },
    restock: { table: table.uuid, quantities: table.items, onOpen: d.refreshItemsOnOpen },
    wontBuy: { types: list("type"), kinds: list("flags.merchant-presets.kind") }
  };
}

const INFINITE = { default: null, yes: true, no: false };

/** A shipped stock line's Item Piles flags in the new shape. */
function stockOf(item) {
  const ip = item.flags["item-piles"];
  const out = {
    infinite: INFINITE[ip.item.infiniteQuantity],
    keep: ip.item.keepOnMerchant,
    service: ip.item.isService,
    noBuyback: ip.item.cantBeSoldToMerchants
  };
  if (ip.item.customCategory) out.category = ip.item.customCategory;
  if (ip.system?.quantityForPrice) out.bundle = ip.system.quantityForPrice;
  return out;
}

const stockLines = merchants.flatMap(m => m.items)
  .filter(i => i.flags?.["merchant-presets"]?.kind !== "gear" && i.flags?.["item-piles"]?.item);

const errorsOf = r => r.errors.join(" | ");

/* ------------------------------------------------------------- real data */

test("every shipped merchant's config validates in the new shape", () => {
  assert.equal(merchants.length, 51);
  for (const m of merchants) {
    const r = validateShop(shopOf(m));
    assert.ok(r.ok, `${m.name}: ${errorsOf(r)}`);
  }
});

test("every shipped stock line validates in the new shape", () => {
  assert.equal(stockLines.length, 1551);
  for (const i of stockLines) {
    const r = validateStock(stockOf(i));
    assert.ok(r.ok, `${i.name}: ${errorsOf(r)}`);
  }
});

test("the same real data with one key misspelt fails (negative control)", () => {
  const shop = shopOf(merchants[0]);
  shop.terms.sellAt = shop.terms.sellsAt;
  delete shop.terms.sellsAt;
  const r = validateShop(shop);
  assert.equal(r.ok, false);
  assert.match(errorsOf(r), /terms\.sellAt/);

  const stock = stockOf(stockLines[0]);
  stock.keepOnMerchant = stock.keep;
  const s = validateStock(stock);
  assert.equal(s.ok, false);
  assert.match(errorsOf(s), /keepOnMerchant/);
});

/* ---------------------------------------------------------------- shop */

test("an empty shop takes every default, and the defaults validate", () => {
  assert.deepEqual(shopFrom({ version: SHOP_VERSION }), SHOP_DEFAULTS);
  assert.ok(validateShop(SHOP_DEFAULTS).ok, errorsOf(validateShop(SHOP_DEFAULTS)));
  assert.equal(SHOP_DEFAULTS.version, SHOP_VERSION);
});

test("a partial shop is valid; version is the one required key", () => {
  assert.ok(validateShop({ version: SHOP_VERSION, tier: "City" }).ok);
  assert.ok(validateShop({ version: SHOP_VERSION, terms: { buysAt: 0.35 } }).ok);
  assert.match(errorsOf(validateShop({ tier: "City" })), /version/);
  assert.match(errorsOf(validateShop({ version: SHOP_VERSION + 1 })), /version/);
});

test("unknown keys are rejected at every level, by path", () => {
  const cases = [
    [{ colour: "red" }, /^colour\b/],
    [{ terms: { sellAt: 1 } }, /terms\.sellAt/],
    [{ terms: { categories: [{ category: "Valuables", sellsAt: 1, buysAt: 1, note: "" }] } }, /terms\.categories\.0\.note/],
    [{ hours: { open: { hour: 7, minute: 0, second: 0 }, close: { hour: 19, minute: 0 } } }, /hours\.open\.second/],
    [{ restock: { table: null, days: 7 } }, /restock\.days/],
    [{ wontBuy: { items: [] } }, /wontBuy\.items/]
  ];
  for (const [shop, message] of cases) {
    const r = validateShop({ version: SHOP_VERSION, ...shop });
    assert.equal(r.ok, false, JSON.stringify(shop));
    assert.match(errorsOf(r), message);
  }
});

test("wrong types and out-of-range values are errors", () => {
  const bad = [
    { tier: "Hamlet" },
    { source: 7 },
    { description: null },
    { terms: { sellsAt: 0 } },
    { terms: { buysAt: -0.5 } },
    { terms: { sellsAt: "1" } },
    { terms: { categories: [{ category: "", sellsAt: 1, buysAt: 1 }] } },
    { terms: { categories: [{ category: "Valuables", sellsAt: 1, buysAt: 1 }, { category: "Valuables", sellsAt: 1, buysAt: 0.5 }] } },
    { terms: { categories: {} } },
    { hours: { open: { hour: 24, minute: 0 }, close: { hour: 19, minute: 0 } } },
    { hours: { open: { hour: 7, minute: 60 }, close: { hour: 19, minute: 0 } } },
    { hours: { open: { hour: 7.5, minute: 0 }, close: { hour: 19, minute: 0 } } },
    { hours: { open: { hour: 7, minute: 0 } } },
    { hours: { open: { hour: 7, minute: 0 }, close: { hour: 7, minute: 0 } } },
    { restock: { table: "" } },
    { restock: { quantities: { abc: 3 } } },
    { restock: { onOpen: "yes" } },
    { wontBuy: { types: "weapon" } },
    { wontBuy: { types: ["weapon", "weapon"] } },
    { wontBuy: { kinds: [""] } },
    null,
    []
  ];
  for (const shop of bad) {
    const input = shop && !Array.isArray(shop) ? { version: SHOP_VERSION, ...shop } : shop;
    assert.equal(validateShop(input).ok, false, JSON.stringify(shop));
  }
});

test("hours may be null (always open) or run overnight", () => {
  assert.ok(validateShop({ version: SHOP_VERSION, hours: null }).ok);
  const overnight = { open: { hour: 20, minute: 0 }, close: { hour: 4, minute: 0 } };
  assert.ok(validateShop({ version: SHOP_VERSION, hours: overnight }).ok);
});

test("shopFrom fills what is missing, deeply, without touching its input or the defaults", () => {
  const input = { version: SHOP_VERSION, terms: { buysAt: 0.35 }, restock: { table: "RollTable.x" } };
  const frozen = structuredClone(input);
  const shop = shopFrom(input);
  assert.deepEqual(input, frozen);
  assert.equal(shop.terms.buysAt, 0.35);
  assert.equal(shop.terms.sellsAt, SHOP_DEFAULTS.terms.sellsAt);
  assert.deepEqual(shop.terms.categories, []);
  assert.equal(shop.restock.table, "RollTable.x");
  assert.equal(shop.restock.onOpen, true);

  shop.terms.categories.push({ category: "Valuables", sellsAt: 1, buysAt: 1 });
  shop.wontBuy.kinds.push("meal");
  assert.deepEqual(SHOP_DEFAULTS.terms.categories, []);
  assert.deepEqual(SHOP_DEFAULTS.wontBuy.kinds, []);
  assert.deepEqual(shopFrom({ version: SHOP_VERSION }).wontBuy.kinds, []);
});

test("shopFrom keeps null hours rather than restoring the default window", () => {
  assert.equal(shopFrom({ version: SHOP_VERSION, hours: null }).hours, null);
});

/* --------------------------------------------------------------- stock */

test("empty stock takes every default, and the defaults validate", () => {
  assert.deepEqual(stockFrom({}), STOCK_DEFAULTS);
  assert.ok(validateStock(STOCK_DEFAULTS).ok, errorsOf(validateStock(STOCK_DEFAULTS)));
});

test("stock rejects unknown keys and bad values", () => {
  const bad = [
    { isService: true },
    { infinite: "default" },
    { keep: 1 },
    { category: 5 },
    { bundle: 0 },
    { bundle: 2.5 },
    { hidden: "no" },
    { notForSale: null },
    null
  ];
  for (const stock of bad) assert.equal(validateStock(stock).ok, false, JSON.stringify(stock));
  assert.match(errorsOf(validateStock({ isService: true })), /isService/);
});

test("stock carries hidden and not-for-sale for goods a GM hid in Item Piles (#97)", () => {
  assert.ok(validateStock({ hidden: true, notForSale: true }).ok);
  const s = stockFrom({ hidden: true });
  assert.equal(s.hidden, true);
  assert.equal(s.notForSale, false);
});

test("stockFrom does not touch its input", () => {
  const input = { bundle: 20, category: "Valuables" };
  const frozen = structuredClone(input);
  assert.deepEqual(stockFrom(input), { ...STOCK_DEFAULTS, ...frozen });
  assert.deepEqual(input, frozen);
});

/* ------------------------------------------------ untrusted flag data (#100) */

test("keys inherited from Object.prototype are unknown keys, not a crash", () => {
  for (const json of ['{"version":1,"__proto__":{"x":1}}', '{"version":1,"constructor":5}', '{"version":1,"toString":5}']) {
    const r = validateShop(JSON.parse(json));
    assert.equal(r.ok, false, json);
    assert.match(errorsOf(r), /unknown key/);
  }
  assert.equal(validateStock({ hasOwnProperty: 1 }).ok, false);
  assert.equal(validateShop(Object.create({ version: SHOP_VERSION })).ok, false);
});

test("shopFrom refuses __proto__ instead of adopting it as the prototype", () => {
  assert.throws(() => shopFrom(JSON.parse('{"version":1,"__proto__":{"polluted":1}}')), /__proto__: unknown key/);
  assert.equal({}.polluted, undefined);
});

test("a key set to undefined counts as missing, in validation and in shopFrom alike", () => {
  // A mapping from Item Piles data whose defaults were stripped yields undefined values.
  assert.ok(validateShop({ version: SHOP_VERSION, tier: undefined }).ok);
  assert.ok(validateStock({ keep: undefined, bundle: undefined }).ok);
  assert.equal(shopFrom({ version: SHOP_VERSION, tier: undefined }).tier, SHOP_DEFAULTS.tier);
});

test("the defaults can't be changed by accident", () => {
  assert.throws(() => { SHOP_DEFAULTS.terms.sellsAt = 9; }, TypeError);
  assert.throws(() => { SHOP_DEFAULTS.terms.categories.push({}); }, TypeError);
  assert.throws(() => { STOCK_DEFAULTS.keep = false; }, TypeError);
  assert.equal(shopFrom({ version: SHOP_VERSION }).terms.sellsAt, null);
});

test("lists with holes and non-finite numbers are errors", () => {
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(validateShop({ version: SHOP_VERSION, wontBuy: { types: [, "weapon"] } }).ok, false);
  assert.equal(validateShop({ version: SHOP_VERSION, wontBuy: { kinds: new Array(2) } }).ok, false);
  for (const n of [NaN, Infinity]) {
    assert.equal(validateShop({ version: SHOP_VERSION, terms: { sellsAt: n } }).ok, false, String(n));
    assert.equal(validateShop({ version: SHOP_VERSION, terms: { buysAt: n } }).ok, false, String(n));
  }
  assert.equal(validateStock({ bundle: Infinity }).ok, false);
});

/* ------------------------------------------- later decisions on #98 (#105, #110) */

test("rates may be null, meaning the world default (#110)", () => {
  assert.ok(validateShop({ version: SHOP_VERSION, terms: { sellsAt: null, buysAt: null } }).ok);
  assert.equal(SHOP_DEFAULTS.terms.sellsAt, null);
  assert.equal(SHOP_DEFAULTS.terms.buysAt, null);
  // A category rule is a rule: it always states its own rates.
  const rule = { category: "Valuables", sellsAt: null, buysAt: 1 };
  assert.equal(validateShop({ version: SHOP_VERSION, terms: { categories: [rule] } }).ok, false);
});

test("the shop's portrait is the actor's image, so there is no image field", () => {
  assert.equal("image" in SHOP_DEFAULTS, false);
  assert.match(errorsOf(validateShop({ version: SHOP_VERSION, image: "a.webp" })), /image: unknown key/);
});

test("restock runs every N days, on a dice formula, or never, and re-rolls or tops up (#105)", () => {
  for (const every of [1, 7, 14, "1d4+2", "2d6", "never"]) {
    assert.ok(validateShop({ version: SHOP_VERSION, restock: { every } }).ok, String(every));
  }
  for (const every of [0, -1, 2.5, "", "weekly", "Never", null]) {
    assert.equal(validateShop({ version: SHOP_VERSION, restock: { every } }).ok, false, String(every));
  }
  for (const mode of ["reroll", "topup"]) assert.ok(validateShop({ version: SHOP_VERSION, restock: { mode } }).ok);
  assert.equal(validateShop({ version: SHOP_VERSION, restock: { mode: "refill" } }).ok, false);
  assert.equal(SHOP_DEFAULTS.restock.mode, "reroll");
});

test("restock quantities are dice formulas", () => {
  assert.ok(validateShop({ version: SHOP_VERSION, restock: { quantities: { a: "1", b: "2d6+4", c: "1d2-1", d: "(2d6+4)*20" } } }).ok);
  assert.equal(validateShop({ version: SHOP_VERSION, restock: { quantities: { a: "lots" } } }).ok, false);
});

/* ------------------------------------------------- merging needs valid input */

test("shopFrom and stockFrom refuse invalid input rather than guess", () => {
  assert.throws(() => shopFrom(null), TypeError);
  assert.throws(() => stockFrom(null), TypeError);
  // No version: an old config must not come back stamped as the current one.
  assert.throws(() => shopFrom({}), /version: missing/);
  assert.throws(() => shopFrom({ tier: "City" }), /version: missing/);
  // Half-set hours must not be completed with a window the GM never set.
  assert.throws(() => shopFrom({ version: SHOP_VERSION, hours: { open: { hour: 20, minute: 0 } } }), /hours\.close: missing/);
  assert.throws(() => stockFrom({ bundle: 0 }), /bundle/);
});

test("a category rule without a name is missing its name, not a duplicate", () => {
  const rule = { sellsAt: 1, buysAt: 1 };
  const r = validateShop({ version: SHOP_VERSION, terms: { categories: [rule, rule] } });
  assert.equal(r.ok, false);
  assert.match(errorsOf(r), /category: missing/);
  assert.doesNotMatch(errorsOf(r), /duplicate/);
});
