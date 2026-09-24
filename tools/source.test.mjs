import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { validateShop, validateStock } from "../scripts/schema.mjs";

/**
 * The shipped #99 config: every merchant carries `flags.merchant-presets.shop`
 * and its stock items `flags.merchant-presets.stock`, beside the Item Piles
 * flags they are built from. tools/schema.test.mjs is the schema's own unit
 * test, with a hand-mapped positive control; this file checks the real build
 * output instead — that it validates, and that it agrees with the Item Piles
 * flags sitting right next to it in the same files, so the two can never
 * quietly drift apart.
 */

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};

const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const goods = load("goods").filter(d => !d._key.startsWith("!folders"));

const errorsOf = r => r.errors.join(" | ");
const kind = item => item.flags?.["merchant-presets"]?.kind;
const stockItems = m => m.items.filter(i => kind(i) !== "gear");

/* -------------------------------------------------------------- validity */

test("every merchant's shop config validates", () => {
  assert.equal(merchants.length, 51);
  for (const m of merchants) {
    const r = validateShop(m.flags["merchant-presets"].shop);
    assert.ok(r.ok, `${m.name}: ${errorsOf(r)}`);
  }
});

test("every stock item's config validates; shopkeeper gear carries none", () => {
  let checked = 0;
  for (const m of merchants) {
    for (const item of m.items) {
      const stock = item.flags?.["merchant-presets"]?.stock;
      if (kind(item) === "gear") {
        assert.equal(stock, undefined, `${m.name}: ${item.name} is gear but has a stock config`);
        continue;
      }
      assert.ok(stock, `${m.name}: ${item.name} has no stock config`);
      const r = validateStock(stock);
      assert.ok(r.ok, `${m.name}: ${item.name}: ${errorsOf(r)}`);
      checked++;
    }
  }
  assert.equal(checked, 1551);
});

test("every good that carries Item Piles flags has a valid stock config", () => {
  const withFlags = goods.filter(g => g.flags?.["item-piles"]?.item);
  assert.equal(withFlags.length, 113);
  for (const g of withFlags) {
    const stock = g.flags?.["merchant-presets"]?.stock;
    assert.ok(stock, g.name);
    const r = validateStock(stock);
    assert.ok(r.ok, `${g.name}: ${errorsOf(r)}`);
  }
});

/* --------------------------------------------------- agrees with Item Piles */

const INFINITE = { default: null, yes: true, no: false };

/**
 * The stock config tools/build_srd.py's stock_flags() derives from one
 * item's `flags.item-piles.item`, mirrored here so this test fails the
 * moment the two stop agreeing.
 */
function expectedStock(ipItem, bundle = 1) {
  const service = Boolean(ipItem.isService);
  return {
    infinite: INFINITE[ipItem.infiniteQuantity ?? "default"],
    keep: ipItem.keepOnMerchant ?? true,
    service,
    noBuyback: service,
    category: ipItem.customCategory ?? "",
    bundle,
    hidden: false,
    notForSale: false
  };
}

test("every embedded stock item's config agrees with its own Item Piles flags", () => {
  for (const m of merchants) {
    for (const item of stockItems(m)) {
      const ip = item.flags["item-piles"];
      const bundle = ip.system?.quantityForPrice ?? 1;
      assert.deepEqual(item.flags["merchant-presets"].stock, expectedStock(ip.item, bundle),
        `${m.name}: ${item.name}`);
    }
  }
});

test("every good's config agrees with its own Item Piles flags", () => {
  for (const g of goods.filter(g => g.flags?.["item-piles"]?.item)) {
    assert.deepEqual(g.flags["merchant-presets"].stock, expectedStock(g.flags["item-piles"].item), g.name);
  }
});

test("a stock config that disagrees with its Item Piles flags is caught (negative control)", () => {
  const item = merchants[0].items.find(i => kind(i) !== "gear" && i.flags["item-piles"]?.item);
  const wrong = { ...item.flags["merchant-presets"].stock, service: !item.flags["merchant-presets"].stock.service };
  assert.notDeepEqual(wrong, expectedStock(item.flags["item-piles"].item));
});

/* ---------------------------------------------------------------- shop-level */

// The DND5E_ITEM_FILTERS fixed behaviour that overrideItemFilters always
// carries, and gear, which the runtime already refuses as fixed behaviour
// (isGear): neither is config, so wontBuy leaves both out.
const FIXED_TYPES = "background,class,facility,feat,race,spell,subclass";

/**
 * A merchant's terms/hours/restock/wontBuy, read back out of its Item Piles
 * flags the way tools/build_srd.py derives `flags.merchant-presets.shop` from
 * them, so this test fails the moment the two stop agreeing.
 */
function expectedShop(merchant) {
  const d = merchant.flags["item-piles"].data;
  const table = d.tablesForPopulate[0];
  const filters = d.overrideItemFilters.filter(f =>
    !(f.path === "type" && f.filters === FIXED_TYPES) && f.path !== "system.type.value");
  const list = path => filters.filter(f => f.path === path)
    .flatMap(f => f.filters.split(",")).filter(k => k !== "gear");
  return {
    tier: merchant.name.match(/\((Village|Town|City)\)/)[1],
    description: d.description,
    sellsAt: d.buyPriceModifier,
    buysAt: d.sellPriceModifier,
    categories: (d.itemTypePriceModifiers ?? []).map(mod =>
      ({ category: mod.category, sellsAt: mod.buyPriceModifier, buysAt: mod.sellPriceModifier })),
    hours: { open: d.openTimes.open, close: d.openTimes.close },
    table: table.uuid,
    quantities: table.items,
    onOpen: d.refreshItemsOnOpen,
    types: list("type"),
    kinds: list("flags.merchant-presets.kind")
  };
}

test("each shop's terms, hours and restock table agree with its Item Piles data", () => {
  for (const m of merchants) {
    const shop = m.flags["merchant-presets"].shop;
    const expected = expectedShop(m);
    assert.equal(shop.tier, expected.tier, m.name);
    assert.equal(shop.description, expected.description, m.name);
    assert.equal(shop.terms.sellsAt, expected.sellsAt, m.name);
    assert.equal(shop.terms.buysAt, expected.buysAt, m.name);
    assert.deepEqual(shop.terms.categories, expected.categories, m.name);
    assert.deepEqual(shop.hours, expected.hours, m.name);
    assert.equal(shop.restock.table, expected.table, m.name);
    assert.deepEqual(shop.restock.quantities, expected.quantities, m.name);
    assert.equal(shop.restock.onOpen, expected.onOpen, m.name);
    assert.deepEqual(shop.wontBuy.types, expected.types, m.name);
    assert.deepEqual(shop.wontBuy.kinds, expected.kinds, m.name);
  }
});

test("restock.every is the recipe's interval, doubled for a Village (#105)", () => {
  const byTier = tier => merchants.filter(m => m.flags["merchant-presets"].shop.tier === tier);
  for (const town of byTier("Town")) {
    const village = merchants.find(m => m.name === town.name.replace("(Town)", "(Village)"));
    const city = merchants.find(m => m.name === town.name.replace("(Town)", "(City)"));
    const every = town.flags["merchant-presets"].shop.restock.every;
    if (city) assert.equal(city.flags["merchant-presets"].shop.restock.every, every, town.name);
    if (village) {
      const doubled = typeof every === "number" ? every * 2 : `(${every})*2`;
      assert.equal(village.flags["merchant-presets"].shop.restock.every, doubled, town.name);
    }
  }
});

/* --------------------------------------------------------------- valuables */

test("Valuables survives the move: at least one shop prices the category, and some items carry it", () => {
  const shopsWithRule = merchants.filter(m =>
    m.flags["merchant-presets"].shop.terms.categories.some(c => c.category === "Valuables"));
  assert.ok(shopsWithRule.length > 0);

  const stockedAsValuable = merchants.flatMap(stockItems)
    .filter(i => i.flags["merchant-presets"].stock.category === "Valuables");
  assert.ok(stockedAsValuable.length > 0);

  const goodsAsValuable = goods.filter(g => g.flags["merchant-presets"]?.stock?.category === "Valuables");
  assert.ok(goodsAsValuable.length > 0);
});
