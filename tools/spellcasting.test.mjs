import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// SRD 5.2, Spellcasting Services: "If a spell has expensive components, add the
// cost of those components to the cost listed in the Spellcasting Services table."
// Those spells are sold by name with the component in the price (#55), if they
// work without the caster; the level services say what to add for any other.
const SERVICE_RULE = "Spells with expensive components that work without the caster are also listed by name, "
  + "with the components in the price. For any other spell, add the cost of any expensive components you don't bring yourself.";
const SHOP_RULE = "Spells with expensive components that work without the caster are listed by name, with the "
  + "components in the price; for any other spell, add the cost of any expensive components you don't bring.";

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
// part of the spell's material component, each multiple counted. Only the 31
// spells that work without the caster (#55, reopened).
const PRICES = {
  "Arcane Lock": 225, "Clairvoyance": 400, "Clone": 23000, "Continual Flame": 250, "Divination": 2025,
  "Forbiddance": 21000, "Gate": 105000, "Glyph of Warding": 500, "Greater Restoration": 2100,
  "Guards and Wards": 20010, "Hallow": 3000, "Heroes' Feast": 21000, "Identify": 150, "Illusory Script": 60,
  "Legend Lore": 2450, "Magic Circle": 400, "Magic Mouth": 210, "Nondetection": 325,
  "Programmed Illusion": 20025, "Protection from Evil and Good": 75, "Raise Dead": 2500, "Reincarnate": 3000,
  "Resurrection": 21000, "Revivify": 600, "Scrying": 3000, "Sequester": 25000, "Stoneskin": 2100,
  "Symbol": 21000, "Teleportation Circle": 2050, "True Resurrection": 125000, "True Seeing": 20025
};

// Costly spells a hire cannot use: the caster keeps the benefit (Find Familiar),
// has to come along (Warding Bond works within 60 feet of the caster), or holds
// it some other way (Awaken's creature is charmed by the caster).
const CASTER_BOUND = [
  "Contingency", "Shapechange", "Magic Jar", "Project Image", "Find Familiar",
  "Simulacrum", "Create Undead", "Instant Summons", "Secret Chest",
  "Warding Bond", "Holy Aura", "Find the Path", "Astral Projection",
  "Chromatic Orb", "Circle of Death", "Arcane Sword", "Forcecage", "Summon Dragon",
  "Bless", "Augury", "Awaken", "Planar Binding",
  "Magnificent Mansion", "Imprisonment", "Plane Shift"
];

// [Village, Town, City] named spells per shop, from #55. Everything else sells none.
const EXPECTED = {
  "Arcane Store": [6, 15, 22],
  "Druidic Store": [2, 9, 12],
  "Temple & Faith Store": [2, 12, 19]
};

test("the seven level services say what to add for a spell not listed by name (#55)", () => {
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
});

test("a spell that only works with the caster is not sold by name", () => {
  const sold = new Set(named.map(s => s.name));
  assert.equal(CASTER_BOUND.length, 25);
  for (const spell of CASTER_BOUND) assert.ok(!sold.has(`Spellcasting: ${spell}`), spell);
  for (const m of merchants) {
    for (const spell of CASTER_BOUND) {
      assert.ok(!m.items.some(i => i.name === `Spellcasting: ${spell}`), `${m.name}: ${spell}`);
    }
  }
});

test("each caster shop sells the named spells of its lists, by settlement size (#55)", () => {
  for (const m of merchants) {
    const [, shop, size] = m.name.match(/^(.*) \((Village|Town|City)\)$/);
    const want = (EXPECTED[shop] ?? [0, 0, 0])[["Village", "Town", "City"].indexOf(size)];
    assert.equal(m.items.filter(isService).filter(i => !isLevel(i)).length, want, m.name);
  }
});

// Item Piles lists a shop window's headings by label and the items under each by
// name (refreshItems, both localeCompare). Under one Service heading the level
// services sorted in among the named spells, Cantrip after Bless. So the named
// spells get a heading of their own. The default heading's label is its
// translation key, which is what it sorts by.
const SERVICE_HEADING = "ITEM-PILES.Merchant.Service";
const NAMED_HEADING = "Spells, Components Included";
const category = item => item.flags?.["item-piles"]?.item?.customCategory;

test("the shop window lists the level services in level order, then the named spells under their own heading", () => {
  assert.ok(SERVICE_HEADING.localeCompare(NAMED_HEADING) < 0);
  assert.deepEqual(levels.map(s => s.name).sort((a, b) => a.localeCompare(b)), [
    "Spellcasting: Cantrip", "Spellcasting: Level 1", "Spellcasting: Level 2", "Spellcasting: Level 3",
    "Spellcasting: Level 4-5", "Spellcasting: Level 6-8", "Spellcasting: Level 9"
  ]);
  for (const s of levels) assert.equal(category(s), undefined, s.name);
  for (const s of named) assert.equal(category(s), NAMED_HEADING, s.name);
  for (const m of casters) {
    for (const item of m.items.filter(isService)) {
      const want = isLevel(item) ? undefined : NAMED_HEADING;
      assert.equal(category(item), want, `${m.name}: ${item.name}`);
      assert.equal(m.flags["merchant-presets"].itemFlags[item.name].customCategory, want, `${m.name}: ${item.name}`);
    }
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
