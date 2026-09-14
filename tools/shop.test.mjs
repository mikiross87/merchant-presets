import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { isPreset } from "../scripts/shop.mjs";

// A real shipped merchant, as the generator writes it.
const dir = new URL("../_source/merchants/", import.meta.url);
const file = readdirSync(dir).find(f => f.startsWith("Temple_Faith_Store_Town_"));
const shipped = JSON.parse(readFileSync(new URL(file, dir), "utf8"));

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
