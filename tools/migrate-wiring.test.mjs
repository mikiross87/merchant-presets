import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// migrateShop's own runtime orchestration — write ordering, and what a
// failed Foundry write actually does — driven through the real hooks via
// the stub. scripts/migrate.mjs's pure planners (including
// shouldForceAutoRestockOff itself) are tested in tools/migrate.test.mjs;
// this is only for what can't be tested without Foundry's own write calls.

/** A merchant with the new #98/#99 flags stripped back off, as it would
 *  have sat in a world before 2.0 shipped — what #100 actually migrates. */
function legacyMerchant(world, prefix) {
  const actor = world.merchant(prefix);
  delete actor.flags["merchant-presets"].shop;
  for (const item of actor.items) delete item.flags["merchant-presets"]?.stock;
  return actor;
}

const shopWrites = (world, actorId) => world.calls.writes.filter(w =>
  w.type === "actorUpdate" && w.actor === actorId && "flags.merchant-presets.shop" in w.changes);

test("the autoRestock write lands before the actor's own shop update", async () => {
  const world = createWorld();
  // An empty world at the first 2.0 load: nothing legacy yet, so
  // applyAutoRestockDefault's own check writes nothing and autoRestock
  // stays unset — the precondition for migrateShop's own check to fire.
  await loadRuntime(world);
  assert.equal(world.settings.autoRestock, false);   // the stub's own default, untouched so far

  // A 1.x merchant now arrives — from a world compendium or an Adventure,
  // say — well after that first load.
  const shop = legacyMerchant(world, "General_Store_Village_");
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");

  const settingIndex = world.calls.writes.findIndex(w => w.type === "setting" && w.key === "autoRestock");
  const actorIndex = world.calls.writes.findIndex(w => shopWrites(world, shop.id).includes(w));
  assert.ok(settingIndex !== -1, "the setting was written at all");
  assert.ok(actorIndex !== -1, "the actor's shop config was written at all");
  assert.ok(settingIndex < actorIndex, "the setting landed before the actor's own update");
  assert.equal(shop.flags["merchant-presets"].shop.version, 1);
});

test("a failed autoRestock write leaves the shop unmigrated, not partially written (#100 review)", async () => {
  const world = createWorld();
  await loadRuntime(world);   // empty world: autoRestock stays unset, same precondition

  world.failSetting("merchant-presets", "autoRestock");
  const shop = legacyMerchant(world, "General_Store_Village_");
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");

  assert.equal(shop.flags["merchant-presets"].shop, undefined);
  assert.deepEqual(shopWrites(world, shop.id), []);
});

test("a 1.x merchant created inside a compendium is never migrated there (#120 review)", async () => {
  const world = createWorld();
  await loadRuntime(world);
  const shop = legacyMerchant(world, "General_Store_Village_");
  shop.pack = "world.my-merchants";   // an unlocked world compendium, or an Adventure being built
  await world.fire("createActor", shop, {}, "gm");
  assert.deepEqual(shopWrites(world, shop.id), []);
  assert.equal(world.calls.writes.some(w => w.type === "setting" && w.key === "autoRestock"), false);
});

test("forcing autoRestock off after the first load tells the GM, not just the log (#120 review)", async () => {
  const world = createWorld();
  await loadRuntime(world);
  const told = [];
  globalThis.ui.notifications.warn = message => told.push(message);
  const shop = legacyMerchant(world, "General_Store_Village_");
  world.actors.push(shop);
  await world.fire("createActor", shop, {}, "gm");
  assert.equal(told.length, 1);
  assert.match(told[0], /restock/i);
});
