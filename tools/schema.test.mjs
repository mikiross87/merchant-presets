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
    image: d.merchantImage,
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
  assert.deepEqual(shopFrom({}), SHOP_DEFAULTS);
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
    [{ restock: { table: null, every: 7 } }, /restock\.every/],
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
  assert.deepEqual(shopFrom({}).wontBuy.kinds, []);
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
