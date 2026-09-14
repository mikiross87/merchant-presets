import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// SRD 5.2, Spellcasting Services: "If a spell has expensive components, add the
// cost of those components to the cost listed in the Spellcasting Services table."
// Those spells are sold by name with the component in the price (#55), so the
// level services say when their price is the whole price.
const SERVICE_RULE = "Spells with expensive components are also listed by name, with the components in the price. "
  + "For any other spell, or if you bring the components yourself, this is the whole price.";
const SHOP_RULE = "Spells with expensive components are listed by name, with the components in the price; "
  + "any other spell, or one you bring the components for, costs its level's price.";

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};
const isService = item => item.flags?.["merchant-presets"]?.kind === "spellcasting";
const isLevel = item => /^Spellcasting: (Cantrip|Level \d(-\d)?)$/.test(item.name);

const services = load("goods").filter(isService);
const levels = services.filter(isLevel);
const named = services.filter(s => !isLevel(s));
const merchants = load("merchants").filter(d => d._key.startsWith("!actors!"));
const casters = merchants.filter(m => m.items.some(isService));

// From #55's tables: the level's Spellcasting Services price plus every costed
// part of the spell's material component, each multiple counted.
const PRICES = {
  "Arcane Lock": 225, "Arcane Sword": 20250, "Astral Projection": 101100, "Augury": 225, "Awaken": 3000,
  "Bless": 55, "Chromatic Orb": 100, "Circle of Death": 20500, "Clairvoyance": 400, "Clone": 23000,
  "Contingency": 21500, "Continual Flame": 250, "Create Undead": 20150, "Divination": 2025,
  "Find Familiar": 60, "Find the Path": 20100, "Forbiddance": 21000, "Forcecage": 21500, "Gate": 105000,
  "Glyph of Warding": 500, "Greater Restoration": 2100, "Guards and Wards": 20010, "Hallow": 3000,
  "Heroes' Feast": 21000, "Holy Aura": 21000, "Identify": 150, "Illusory Script": 60, "Imprisonment": 105000,
  "Instant Summons": 21000, "Legend Lore": 2450, "Magic Circle": 400, "Magic Jar": 20500, "Magic Mouth": 210,
  "Magnificent Mansion": 20015, "Nondetection": 325, "Planar Binding": 3000, "Plane Shift": 20250,
  "Programmed Illusion": 20025, "Project Image": 20005, "Protection from Evil and Good": 75, "Raise Dead": 2500,
  "Reincarnate": 3000, "Resurrection": 21000, "Revivify": 600, "Scrying": 3000, "Secret Chest": 7050,
  "Sequester": 25000, "Shapechange": 101500, "Simulacrum": 21500, "Stoneskin": 2100, "Summon Dragon": 2500,
  "Symbol": 21000, "Teleportation Circle": 2050, "True Resurrection": 125000, "True Seeing": 20025,
  "Warding Bond": 300
};

// [Village, Town, City] named spells per shop, from #55. Everything else sells none.
const EXPECTED = {
  "Arcane Store": [9, 21, 42],
  "Druidic Store": [3, 12, 18],
  "Temple & Faith Store": [5, 16, 28]
};

test("the seven level services say when their price is the whole price (#55)", () => {
  assert.equal(levels.length, 7);
  for (const s of levels) {
    assert.ok(s.system.description.value.includes(SERVICE_RULE), s.name);
    assert.ok(!s.system.description.value.includes("add the cost of those components"), s.name);
  }
});

test("every shop that sells spellcasting says so in its shop window (#55)", () => {
  assert.equal(casters.length, 9);
  for (const m of casters) {
    const note = m.flags["item-piles"].data.description;
    assert.ok(note.includes(SHOP_RULE), m.name);
    assert.ok(!note.includes("costs those components on top"), m.name);
  }
});

test("each spell with a costly component is sold by name, priced with its component (#55)", () => {
  assert.deepEqual(named.map(s => s.name).sort(), Object.keys(PRICES).map(n => `Spellcasting: ${n}`).sort());
  for (const s of named) {
    assert.equal(s.system.price.value, PRICES[s.name.replace("Spellcasting: ", "")], s.name);
    assert.equal(s.system.price.denomination, "gp", s.name);
    assert.equal(s.flags["item-piles"].item.isService, true, s.name);
    assert.match(s.flags["merchant-presets"].spell, /^Compendium\.dnd5e\.spells24\.Item\./, s.name);
    assert.equal(s.folder, levels[0].folder, s.name);
  }
});

test("a named service quotes the component it provides, from the spell text", () => {
  const byName = new Map(named.map(s => [s.name, s.system.description.value]));
  assert.equal(byName.get("Spellcasting: Revivify"),
    "<p>A spellcaster casts @UUID[Compendium.dnd5e.spells24.Item.phbsplRevivify00]{Revivify} on your behalf "
    + "and provides its material component: a diamond worth 300+ GP, which the spell consumes.</p>");
  assert.ok(byName.get("Spellcasting: Legend Lore").includes(
    "provides its material components: incense worth 250+ GP, which the spell consumes, and four ivory strips worth 50+ GP each."));
  assert.ok(byName.get("Spellcasting: Astral Projection").includes(
    "<p>The price covers one target; each further target costs 1,100 GP more.</p>"));
  assert.ok(byName.get("Spellcasting: Create Undead").includes(
    "<p>The price covers one corpse; each further corpse costs 150 GP more.</p>"));
});

test("each caster shop sells the named spells of its lists, by settlement size (#55)", () => {
  for (const m of merchants) {
    const [, shop, size] = m.name.match(/^(.*) \((Village|Town|City)\)$/);
    const want = (EXPECTED[shop] ?? [0, 0, 0])[["Village", "Town", "City"].indexOf(size)];
    assert.equal(m.items.filter(isService).filter(i => !isLevel(i)).length, want, m.name);
  }
});

test("a named service is a service on the shelf too: never sold out, never bought back", () => {
  for (const m of casters) {
    for (const item of m.items.filter(isService)) {
      const flags = item.flags["item-piles"].item;
      assert.equal(flags.isService, true, `${m.name}: ${item.name}`);
      assert.equal(flags.infiniteQuantity, "yes", `${m.name}: ${item.name}`);
      assert.equal(flags.cantBeSoldToMerchants, true, `${m.name}: ${item.name}`);
    }
  }
});

test("each shop's copy of a service matches the good it was built from", () => {
  const byName = new Map(services.map(s => [s.name, s]));
  for (const m of casters) {
    for (const item of m.items.filter(isService)) {
      const good = byName.get(item.name);
      assert.ok(good, `${m.name}: ${item.name} has no good`);
      assert.equal(item.system.description.value, good.system.description.value, `${m.name}: ${item.name}`);
      assert.deepEqual(item.system.price, good.system.price, `${m.name}: ${item.name}`);
    }
  }
});
