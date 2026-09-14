import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isPreset, needsWiring, planWorldTable } from "../scripts/shop.mjs";

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
