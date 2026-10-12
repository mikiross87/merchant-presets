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
    const note = `<p><em>Casts spells from the ${shop.note.lists} lists: roll ${v} spell slots a day in a village, `
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

/** The categories a kind of day boosts, biggest boost first, in the data's order within each. */
const boosted = boosts => groups(boosts).flatMap(([, cats]) => cats);

/** Every kind of day's name, in data order: its top boosted category, and the next ones only as far
 *  as an earlier day already has that name, so a name stays short enough for the header chip. */
const NAMES = (() => {
  const used = new Set();
  return days.map(({ global, boosts }) => {
    const cats = boosted(boosts);
    let name = DEMAND[global];
    for (let k = 1; k <= cats.length; k++) {
      const what = `${list(cats.slice(0, k))} in demand`;
      name = global === 1 ? what : `${DEMAND[global]}; ${what}`;
      if (!used.has(name)) break;
    }
    used.add(name);
    return name;
  });
})();

/** A kind of day's line, from its data alone. */
function dayLine({ global, boosts }) {
  const faster = groups(boosts).flatMap(([n, cats]) => cats.map(c => `${c} ×${n}`));
  return `Customers ×${global}.${faster.length ? ` Selling faster: ${faster.join(", ")}.` : ""}`;
}

test("a kind of day is named and described by what it does to trade, one name each (#249)", () => {
  const dayTables = tables.filter(t => t.flags?.["merchant-presets"]?.tradeDays);
  assert.equal(dayTables.length, 3);
  for (const table of dayTables) {
    const names = table.results.map(r => r.name);
    assert.equal(new Set(names).size, names.length, `${table.name}: names are unique`);
    for (const r of table.results) {
      const day = r.flags["merchant-presets"].day;
      const i = days.findIndex(d => d.global === day.global && JSON.stringify(d.boosts) === JSON.stringify(day.boosts));
      assert.equal(r.name, NAMES[i]);
      assert.equal(r.description, dayLine(day), r.name);
    }
  }
});

test("day names stay short enough for the header chip, and read as GMs see them (#249 review)", () => {
  assert.deepEqual(NAMES, ["Very quiet", "Quiet", "Quiet; Potions in demand", "Steady", "Busy", "Very busy",
    "Food & Drink in demand", "Weapons in demand", "Food & Drink and Instruments in demand", "Holy Symbols in demand",
    "Magic Items in demand"]);
  const town = tables.find(t => t.flags?.["merchant-presets"]?.tradeDays === "Town");
  assert.deepEqual(town.results.map(r => r.name), NAMES, "the shipped Town table, every kind of day");
  const fever = town.results.find(r => r.name === "Quiet; Potions in demand");
  assert.equal(fever.description, "Customers ×0.5. Selling faster: Potions ×3, Holy Symbols ×2.");
});

test("a shop and a caster read as GMs see them (#249 review)", () => {
  const smith = merchants.find(m => m.name === "Armourer & Blacksmiths (Town)");
  assert.equal(smith.system.details.biography.value, "<p>Sells Adventuring Gear, Armor, Magic Items, Tools and Weapons.</p>");
  const arcane = merchants.find(m => m.name === "Arcane Store (Village)");
  assert.match(arcane.flags["merchant-presets"].shop.description,
    /Casts spells from the arcane lists: roll 1d4\+1 spell slots a day in a village, 1d8\+1 in a town, 1d12\+1 in a city\./);
});
