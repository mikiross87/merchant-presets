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
