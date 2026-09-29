/**
 * The SRD 5.2 magic items in the shops (#33), checked on the generated `_source`: what the
 * generators wrote, not what they meant to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const kind = item => item.flags?.["merchant-presets"]?.kind;
const COIN = { pp: 10, gp: 1, ep: 0.5, sp: 0.1, cp: 0.01 };
const gp = item => (item.system?.price?.value ?? 0) * (COIN[item.system?.price?.denomination] ?? 1);
/** A magic item, as the SRD marks one: a rarity, or the Magical property. */
const isMagic = item => Boolean(item.system?.rarity) || (item.system?.properties ?? []).includes("mgc");

const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const stock = m => m.items.filter(i => kind(i) !== "gear");

test("no shop stocks a magic item at no price", () => {
  // About fifty SRD magic items are unpriced (the "+1, +2, or +3" parents, the Immovable Rod):
  // stocked as they are, they fall in the cheapest stock band and a city rolls dozens of them.
  const free = merchants.flatMap(m => stock(m).filter(i => isMagic(i) && !gp(i)).map(i => `${m.name}: ${i.name}`));
  assert.deepEqual(free, []);
});

const goods = load("goods").filter(d => !d._key.startsWith("!folders"));
// The module's own magic goods: an SRD enchantment baked onto a base, or an item the SRD leaves unpriced.
const ours = goods.filter(g => g.flags?.["merchant-presets"]?.magic);
const baked = ours.filter(g => g.flags["merchant-presets"].magic.enchantment);
const recipes = JSON.parse(readFileSync(new URL("../data/recipes.json", import.meta.url), "utf8"));
// The SRD's Magic Item Rarity table: what an item of each rarity is worth.
const RARITY_VALUE = { common: 100, uncommon: 400, rare: 4000 };
const TIERS = { common: "vtc", uncommon: "tc", rare: "c" };
// Shipped before #33, and kept: the scrolls to 9th level and the Supreme healing potion.
const OLDER = /^(Spell Scroll, |Potion of Healing \(Supreme\)$)/;
const tierOf = name => (/\((Village|Town|City)\)$/.exec(name) ?? [])[1]?.[0].toLowerCase();

test("the magic goods: a hundred and twelve baked, four priced, each named once", () => {
  assert.equal(baked.length, 112);
  assert.deepEqual(ours.filter(g => !baked.includes(g)).map(g => g.name).sort(),
    ["Headband of Intellect", "Immovable Rod", "Sentinel Shield", "Silver Raven"]);
  const names = ours.map(g => g.name);
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});

test("a baked good works as an item: a weapon deals damage, armour and shields give AC", () => {
  const broken = baked.filter(g => g.type === "weapon"
    ? !(g.system.damage?.base?.number && g.system.damage?.base?.denomination)
    : g.type === "equipment" && ["light", "medium", "heavy", "shield"].includes(g.system.type?.value) && !(g.system.armor?.value > 0))
    .map(g => g.name);
  assert.deepEqual(broken, []);
  // Every armour and weapon template went onto a base; only the rings and wands stand alone.
  const loose = baked.filter(g => g.type === "weapon" || ["light", "medium", "heavy", "shield"].includes(g.system.type?.value))
    .filter(g => !g.system.type?.baseItem).map(g => g.name);
  assert.deepEqual(loose, []);
});

test("a magic good is magic, of a stocked rarity, at no less than the SRD's value for it", () => {
  for (const g of ours) {
    assert.ok(g.system.properties.includes("mgc"), g.name);
    assert.ok(g.system.rarity in RARITY_VALUE, `${g.name}: ${g.system.rarity}`);
    assert.ok(gp(g) >= RARITY_VALUE[g.system.rarity], `${g.name}: ${gp(g)} gp`);
    assert.deepEqual(g.system.source, { book: "SRD 5.2", license: "CC-BY-4.0", rules: "2024", revision: 1 }, g.name);
  }
});

test("a baked good carries no enchantment left to apply", () => {
  for (const g of baked) {
    // Flame Tongue's Engulf in Flames keeps its Ablaze, which the activity turns on in play.
    assert.deepEqual(g.effects.filter(e => e.type === "enchantment" && !e.disabled).map(e => e.name), [], g.name);
    const ids = new Set(g.effects.map(e => e._id));
    for (const a of Object.values(g.system.activities ?? {}).filter(a => a.type === "enchant")) {
      assert.deepEqual(a.effects.map(e => e._id).filter(id => !ids.has(id)), [], `${g.name}: ${a.name}`);
    }
    // An item's rider list marks effects and activities that apply only with an enchantment on.
    const riders = g.flags.dnd5e?.riders ?? {};
    assert.deepEqual([...(riders.activity ?? []), ...(riders.effect ?? [])], [], g.name);
  }
});

test("magic is stocked by rarity: common everywhere, uncommon in towns and cities, rare in cities", () => {
  const wrong = [];
  for (const m of merchants) {
    for (const i of stock(m).filter(isMagic)) {
      if (OLDER.test(i.name)) continue;
      const tiers = TIERS[i.system.rarity];
      if (!tiers || !tiers.includes(tierOf(m.name))) wrong.push(`${m.name}: ${i.name} (${i.system.rarity})`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("every magic line is limited, and names a baked good only by its uuid", () => {
  const magic = recipes.shops.flatMap(s => s.stock.filter(l => l.cat === "Magic Items").map(l => ({ shop: s.id, ...l })));
  assert.equal(magic.length, 310);
  assert.deepEqual(magic.filter(l => !l.limited).map(l => `${l.shop}: ${l.n}`), []);
  // A price on a line reaches only the shipped snapshot: a shop rolls its shelf from the table.
  assert.deepEqual(magic.filter(l => "price" in l).map(l => l.n), []);
  const bakedUuids = new Set(ours.map(g => `Compendium.merchant-presets.goods.Item.${g._id}`));
  assert.deepEqual(magic.filter(l => l.uuid && !bakedUuids.has(l.uuid)).map(l => l.n), []);
  const stocked = new Set(magic.map(l => l.uuid).filter(Boolean));
  assert.deepEqual([...bakedUuids].filter(u => !stocked.has(u)), []);
});

test("a shop holds one of each magic container, not a pile of Bags of Holding", () => {
  for (const m of merchants) {
    const counts = {};
    for (const i of stock(m).filter(i => i.type === "container" && isMagic(i))) counts[i.name] = (counts[i.name] ?? 0) + 1;
    assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 1), [], m.name);
  }
});

test("a shop that stocks no magic item won't buy one; every shop that stocks one will (#184)", () => {
  const wrong = merchants.filter(m => stock(m).some(isMagic) === m.flags["merchant-presets"].shop.wontBuy.kinds.includes("magic"))
    .map(m => m.name);
  assert.deepEqual(wrong, []);
  // The General Stores and most village shops: #33 starts uncommon items at town.
  assert.equal(merchants.filter(m => m.flags["merchant-presets"].shop.wontBuy.kinds.includes("magic")).length, 14);
});
