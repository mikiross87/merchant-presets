import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isPreset, keepableItems, listShops, needsWiring, planShop, planWorldTable, tierOf } from "../scripts/shop.mjs";

/** A real shipped document, as the generator writes it. */
function source(sub, prefix) {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  const file = readdirSync(dir).find(f => f.startsWith(prefix));
  return JSON.parse(readFileSync(new URL(file, dir), "utf8"));
}

const shipped = source("merchants", "Temple_Faith_Store_Town_");

/** The world copy a GM gets by dragging the merchant out of the compendium. */
const dragged = () => structuredClone(shipped);

/** That copy after wireTables has pointed its stock table at the world RollTable. */
function imported() {
  const actor = dragged();
  for (const t of actor.flags["item-piles"].data.tablesForPopulate) t.uuid = "RollTable.world1";
  return actor;
}

test("a merchant dragged into the world is ours", () => {
  assert.equal(isPreset(dragged()), true);
});

test("a merchant stays ours after import repoints its stock table at the world copy (#56)", () => {
  assert.equal(isPreset(imported()), true);
});

test("the copy inside the compendium is never touched", () => {
  assert.equal(isPreset({ ...dragged(), pack: "merchant-presets.merchants" }), false);
});

test("a GM's own Item Piles merchant is not ours", () => {
  const own = imported();
  delete own.flags["merchant-presets"];
  assert.equal(isPreset(own), false);
  assert.equal(isPreset({ name: "Barthen", flags: {} }), false);
  assert.equal(isPreset(undefined), false);
});

/* ------------------------------------------------------------- stock tables */

const jeweler = source("stock", "Jeweler_Town_");
const DIAMOND = "Compendium.merchant-presets.goods.Item.diamond300gpXXXX";

/** The Jeweler (Town) stock table as the compendium serves it. */
const shipTable = results => ({
  uuid: `Compendium.merchant-presets.stock.RollTable.${jeweler._id}`,
  name: jeweler.name,
  results: structuredClone(results)
});
const before = shipTable(jeweler.results);

/** The same shop after an update swaps its 500 GP gem band for a named diamond. */
const after = shipTable(jeweler.results
  .filter(r => !r.name.includes("500 gp"))
  .concat({ ...jeweler.results[0], _id: "diamondResult001", name: "Diamond (300 GP)", documentUuid: DIAMOND }));

/** A world copy in Merchant Stock, as Foundry holds it. */
const worldTable = (name, results, stamp) => ({
  name,
  results: structuredClone(results),
  flags: stamp ? { "merchant-presets": { stock: stamp } } : {}
});

test("a first import names the world copy after the shop", () => {
  const plan = planWorldTable([], before, "1.3.0");
  assert.equal(plan.existing, undefined);
  assert.equal(plan.name, "Jeweler (Town)");
});

test("an import after the shop's stock list changed does not reuse the copy of the old list (#63)", () => {
  const old = worldTable("Jeweler (Town)", before.results);
  assert.equal(planWorldTable([old], after, "1.3.0").existing, undefined);
});

test("the new copy is named for the version when the old copy holds the shop's name", () => {
  const old = worldTable("Jeweler (Town)", before.results);
  assert.equal(planWorldTable([old], after, "1.3.0").name, "Jeweler (Town) (v1.3.0)");
});

test("a copy made before copies were stamped is reused while its list is unchanged, in any order", () => {
  const old = worldTable("Jeweler (Town)", before.results.toReversed());
  assert.equal(planWorldTable([old], before, "1.3.0").existing, old);
});

test("a copy of the current list is reused after the GM edits it", () => {
  const old = worldTable("Jeweler (Town)", before.results);
  const { name, stamp } = planWorldTable([old], after, "1.3.0");
  const edited = worldTable(name, after.results.slice(1), stamp);
  assert.equal(planWorldTable([old, edited], after, "1.3.0").existing, edited);
});

test("a stamped copy of an older list is not reused", () => {
  const { name, stamp } = planWorldTable([], before, "1.2.4");
  const old = worldTable(name, before.results, stamp);
  assert.equal(planWorldTable([old], after, "1.3.0").existing, undefined);
});

test("a stamped copy of another shop's identical list is not reused", () => {
  const village = { ...before, uuid: "Compendium.merchant-presets.stock.RollTable.jewelerVillage01", name: "Jeweler (Village)" };
  const { name, stamp } = planWorldTable([], village, "1.3.0");
  const other = worldTable(name, before.results, stamp);
  assert.equal(planWorldTable([other], before, "1.3.0").existing, undefined);
});

/* ---------------------------------------------------------- needs wiring */

test("a merchant still on its compendium stock table needs wiring (#66)", () => {
  assert.equal(needsWiring(dragged()), true);
});

test("a merchant wired to a world table, a compendium copy, or a GM's own merchant does not", () => {
  assert.equal(needsWiring(imported()), false);
  assert.equal(needsWiring({ ...dragged(), pack: "merchant-presets.merchants" }), false);
  const own = imported();
  delete own.flags["merchant-presets"];
  assert.equal(needsWiring(own), false);
  assert.equal(needsWiring(undefined), false);
});

/* ------------------------------------------------------- setting up a shop */

const templeUuid = `Compendium.merchant-presets.merchants.Actor.${shipped._id}`;
const temple = () => ({ ...structuredClone(shipped), uuid: templeUuid });
const armourerDoc = source("merchants", "Armourer_Blacksmiths_City_");
const armourer = () => ({
  ...structuredClone(armourerDoc),
  uuid: `Compendium.merchant-presets.merchants.Actor.${armourerDoc._id}`
});

/** Sister Garaele, as a GM's own NPC: a stat block with gear and a spell. */
function garaele() {
  return {
    name: "Sister Garaele", type: "npc", flags: {},
    items: [
      { _id: "longsword0000001", name: "Longsword", type: "weapon", system: {}, flags: {} },
      { _id: "pack000000000001", name: "Backpack", type: "container", system: {}, flags: {} },
      { _id: "rope000000000001", name: "Rope", type: "loot", system: { container: "pack000000000001" }, flags: {} },
      { _id: "potion0000000001", name: "Potion of Healing", type: "consumable", system: {}, flags: {} },
      { _id: "spell00000000001", name: "Bless", type: "spell", system: {}, flags: {} },
      { _id: "feat000000000001", name: "Multiattack", type: "feat", system: {}, flags: {} }
    ]
  };
}

const kind = item => item.flags?.["merchant-presets"]?.kind;

test("an NPC with the shop marker is ours", () => {
  const npc = garaele();
  npc.flags["merchant-presets"] = { shop: { source: templeUuid, tier: "Town" } };
  assert.equal(isPreset(npc), true);
});

test("the stock tier comes from the marker, then the name, then Town", () => {
  assert.equal(tierOf({ name: "Garaele", flags: { "merchant-presets": { shop: { tier: "City" } } } }), "City");
  assert.equal(tierOf({ name: "Temple & Faith Store (Village)", flags: {} }), "Village");
  assert.equal(tierOf({ name: "Garaele (City)", flags: { "merchant-presets": { shop: { tier: "Village" } } } }), "Village");
  assert.equal(tierOf({ name: "Garaele", flags: {} }), "Town");
});

test("listShops groups the merchants index by shop and settlement size", () => {
  const shops = listShops([
    { name: "Jeweler (Town)", uuid: "u-jt" },
    { name: "Arcane Store (City)", uuid: "u-ac" },
    { name: "Jeweler (Village)", uuid: "u-jv" },
    { name: "Not a shop", uuid: "u-x" }
  ]);
  assert.deepEqual(shops, [
    { name: "Arcane Store", tiers: { City: "u-ac" } },
    { name: "Jeweler", tiers: { Town: "u-jt", Village: "u-jv" } }
  ]);
});

test("the dialog lists every physical item on a new NPC, contents included", () => {
  assert.deepEqual(keepableItems(garaele()).map(i => i.name),
    ["Longsword", "Backpack", "Rope", "Potion of Healing"]);
});

test("the dialog lists only gear on an actor that is already a shop", () => {
  const names = keepableItems(temple()).map(i => i.name);
  assert.ok(names.includes("Mace") && names.includes("Chain Shirt"));
  assert.ok(!names.includes("Flask"), "stock is not offered as gear");
  assert.ok(!names.includes("Bless"), "spells are not listed");
});

test("unticked physical items are deleted and ticked ones are kept", () => {
  const plan = planShop(temple(), garaele(), ["longsword0000001", "rope000000000001"]);
  assert.deepEqual(plan.deletes.toSorted(), ["pack000000000001", "potion0000000001"]);
});

test("non-physical items are always kept and tagged as gear", () => {
  const plan = planShop(temple(), garaele(), []);
  assert.ok(!plan.deletes.includes("spell00000000001") && !plan.deletes.includes("feat000000000001"));
  const tagged = plan.updates.filter(u => u["flags.merchant-presets.kind"] === "gear").map(u => u._id);
  assert.ok(tagged.includes("spell00000000001") && tagged.includes("feat000000000001"));
});

test("kept contents of a deleted container are moved out of it", () => {
  const plan = planShop(temple(), garaele(), ["rope000000000001"]);
  const rope = plan.updates.find(u => u._id === "rope000000000001");
  assert.equal(rope["system.container"], null);
  assert.equal(rope["flags.merchant-presets.kind"], "gear");
});

test("the source's gear and profile are never copied", () => {
  const plan = planShop(temple(), garaele(), []);
  assert.ok(plan.creates.length > 0);
  assert.ok(plan.creates.every(i => kind(i) !== "gear"));
  assert.ok(!plan.creates.some(i => i.name === "Mace"));
  assert.equal("profile" in plan.moduleFlags, false);
});

test("the shop window shows the NPC's portrait and the marker is written", () => {
  const plan = planShop(temple(), garaele(), []);
  assert.equal(plan.pileData.merchantImage, "");
  assert.deepEqual(plan.moduleFlags.shop, { source: templeUuid, tier: "Town" });
  assert.equal(plan.moduleFlags.purse, shipped.flags["merchant-presets"].purse);
  assert.deepEqual(plan.moduleFlags.containers, shipped.flags["merchant-presets"].containers);
  assert.deepEqual(plan.currency, shipped.system.currency);
  assert.equal(plan.pileData.tablesForPopulate[0].uuid, shipped.flags["item-piles"].data.tablesForPopulate[0].uuid);
});

test("the plan does not alter the source document", () => {
  const src = temple();
  const before = JSON.stringify(src);
  planShop(src, garaele(), []);
  assert.equal(JSON.stringify(src), before);
});

test("re-applying keeps the gear and replaces the stock", () => {
  // Garaele as a Temple (Town) after a first setup: gear tagged, stock created.
  const first = planShop(temple(), garaele(), ["longsword0000001"]);
  const shop = garaele();
  shop.items = shop.items.filter(i => !first.deletes.includes(i._id));
  for (const i of shop.items) i.flags = { "merchant-presets": { kind: "gear" } };
  shop.items.push(...structuredClone(first.creates));
  shop.flags["merchant-presets"] = first.moduleFlags;

  const again = planShop(armourer(), shop, ["longsword0000001"]);
  const stockIds = first.creates.map(i => i._id);
  assert.deepEqual(again.deletes.toSorted(), stockIds.toSorted());
  assert.ok(!again.deletes.includes("longsword0000001"));
  assert.ok(!again.deletes.includes("spell00000000001"));
  assert.equal(again.moduleFlags.shop.tier, "City");
  assert.ok(again.creates.every(i => kind(i) !== "gear"));
});

test("re-applying drops gear the GM unticks", () => {
  const shop = garaele();
  for (const i of shop.items) i.flags = { "merchant-presets": { kind: "gear" } };
  shop.flags["merchant-presets"] = { shop: { source: templeUuid, tier: "Town" } };
  const plan = planShop(temple(), shop, ["potion0000000001"]);
  assert.ok(plan.deletes.includes("longsword0000001"));
  assert.ok(!plan.deletes.includes("potion0000000001"));
});
