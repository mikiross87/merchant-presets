import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Shops and trade days describe themselves with facts from their own data, not flavour text of
 * ours (#249): what a shop sells, what a caster shop casts and how much, and
 * what a kind of day does to trade. Checked against the built `_source`, from `data/` directly.
 */

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const data = name => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));

const shops = data("recipes.json").shops;
const days = data("trade-days.json").days;
const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const tables = load("stock").filter(d => d._key.startsWith("!tables!"));

const TIER = { Village: "v", Town: "t", City: "c" };
const list = xs => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
const SHOP_RULE = "Spells with expensive components that work without the caster are listed by name, with the "
  + "components in the price; for any other spell, add the cost of any expensive components you don't bring.";

/** What a shop of `shop`'s trade, at `tier`, says it sells. Not its hours: a GM changes those. */
function described(shop, tier) {
  const cats = [...new Set(shop.stock.filter(l => l.t.includes(TIER[tier])).map(l => l.cat))].sort();
  return `<p>Sells ${list(cats)}.</p>`;
}

const shopOf = m => {
  const [, name, tier] = m.name.match(/^(.*) \((Village|Town|City)\)$/);
  return { shop: shops.find(s => s.name === name), tier };
};

test("data/ holds no flavour text: no shop blurbs, caster notes as data, trade days without names or lines (#249)", () => {
  assert.deepEqual(shops.filter(s => "desc" in s).map(s => s.id), []);
  assert.deepEqual(shops.filter(s => s.note != null && typeof s.note !== "object").map(s => s.id), []);
  assert.deepEqual(days.filter(d => "name" in d || "text" in d).map(d => d.name), []);
});

test("every merchant says what it sells at its size, wherever its description shows (#249)", () => {
  assert.equal(merchants.length, 51);
  for (const m of merchants) {
    const { shop, tier } = shopOf(m);
    const expected = described(shop, tier);
    assert.equal(m.system.details.biography.value, expected, m.name);
    assert.ok(m.flags["merchant-presets"].shop.description.startsWith(expected), m.name);
    assert.ok(m.flags["item-piles"].data.description.startsWith(expected), m.name);
  }
});

test("a caster shop's note says which lists it casts from and its slots a day, then the by-name rule (#249, #55)", () => {
  const casters = shops.filter(s => s.note);
  assert.equal(casters.length, 3);
  for (const shop of casters) {
    const [v, t, c] = shop.note.slots;
    const note = `<p><em>Casts spells from the ${shop.note.lists} lists: ${v} spell slots a day in a village, `
      + `${t} in a town, ${c} in a city. ${SHOP_RULE}</em></p>`;
    for (const m of merchants.filter(x => x.name.startsWith(`${shop.name} (`))) {
      assert.ok(m.flags["merchant-presets"].shop.description.endsWith(note), m.name);
    }
  }
});

const DEMAND = { 0.25: "Very quiet", 0.5: "Quiet", 1: "Steady", 2: "Busy", 3: "Very busy" };
const groups = boosts => {
  const by = new Map();
  for (const [cat, n] of Object.entries(boosts)) by.set(n, [...(by.get(n) ?? []), cat]);
  return [...by].sort((a, b) => b[0] - a[0]);
};

/** A kind of day's name and line, from its data alone. */
function dayText({ global, boosts }) {
  const [top] = groups(boosts);
  const name = !top ? DEMAND[global]
    : global === 1 ? `${list(top[1])} in demand` : `${DEMAND[global]}; ${list(top[1])} in demand`;
  const faster = groups(boosts).flatMap(([n, cats]) => cats.map(c => `${c} ×${n}`));
  const line = `Customers ×${global}.${faster.length ? ` Selling faster: ${faster.join(", ")}.` : ""}`;
  return { name, line };
}

test("a kind of day is named and described by what it does to trade, one name each (#249)", () => {
  const dayTables = tables.filter(t => t.flags?.["merchant-presets"]?.tradeDays);
  assert.equal(dayTables.length, 3);
  for (const table of dayTables) {
    const names = table.results.map(r => r.name);
    assert.equal(new Set(names).size, names.length, `${table.name}: names are unique`);
    for (const r of table.results) {
      const { name, line } = dayText(r.flags["merchant-presets"].day);
      assert.equal(r.name, name);
      assert.equal(r.description, line, r.name);
    }
  }
});
