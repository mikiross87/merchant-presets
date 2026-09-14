import { test } from "node:test";
import assert from "node:assert/strict";
import { actorEffects, castingMessage, castsIn, chatRecipients } from "../scripts/casting.mjs";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// Buying a spellcasting service moves gold and nothing else (#70). Item Piles'
// own trade card already says what was paid, so this message says what was
// cast and for whom, and hands the GM the spell and its effects.

const WARDING_BOND = "Compendium.dnd5e.spells24.Item.phbsplWardingBon";
const RAISE_DEAD = "Compendium.dnd5e.spells24.Item.phbsplRaiseDead0";

test("a named service says which spell was cast, for whom, and links it", () => {
  const html = castingMessage({ shop: "Temple & Faith Store (Town)", buyer: "Aria", casts: [
    { name: "Spellcasting: Warding Bond", quantity: 1, spell: WARDING_BOND, effects: [] }
  ] });
  assert.equal(html, `<p><strong>Temple &amp; Faith Store (Town)</strong> casts @UUID[${WARDING_BOND}]{Warding Bond} `
    + "for <strong>Aria</strong>.</p>");
});

test("buying a spell more than once says how many times", () => {
  const cast = n => castingMessage({ shop: "Temple", buyer: "Aria", casts: [
    { name: "Spellcasting: Warding Bond", quantity: n, spell: WARDING_BOND, effects: [] }] });
  assert.ok(cast(2).includes("for <strong>Aria</strong> twice.</p>"));
  assert.ok(cast(3).includes("for <strong>Aria</strong> 3 times.</p>"));
});

test("a spell's effects are linked, to drag onto whoever it was cast on", () => {
  const html = castingMessage({ shop: "Temple", buyer: "Aria", casts: [
    { name: "Spellcasting: Raise Dead", quantity: 1, spell: RAISE_DEAD, effects: [
      { uuid: `${RAISE_DEAD}.ActiveEffect.day1`, name: "Resurrection Sickness (Day 1)" },
      { uuid: `${RAISE_DEAD}.ActiveEffect.day2`, name: "Resurrection Sickness (Day 2)" }
    ] }] });
  assert.ok(html.endsWith(`<p>Effects to drag onto the creature it was cast on: `
    + `@UUID[${RAISE_DEAD}.ActiveEffect.day1]{Resurrection Sickness (Day 1)}, `
    + `@UUID[${RAISE_DEAD}.ActiveEffect.day2]{Resurrection Sickness (Day 2)}</p>`), html);
});

test("an enchantment is not offered as an effect: it belongs on an item, not a creature", () => {
  assert.deepEqual(actorEffects([
    { uuid: "E.contingency", name: "Contingency Spell", type: "enchantment" },
    { uuid: "E.bonded", name: "Bonded", type: "base" }
  ]), [{ uuid: "E.bonded", name: "Bonded" }]);
  assert.deepEqual(actorEffects(undefined), []);
});

test("a level service asks the buyer to name the spell", () => {
  const html = n => castingMessage({ shop: "Temple", buyer: "Aria", casts: [
    { name: "Spellcasting: Level 3", quantity: n, spell: null, effects: [] }] });
  assert.equal(html(1), "<p><strong>Temple</strong> casts a spell for <strong>Aria</strong>: "
    + "Spellcasting: Level 3. Tell the GM which spell.</p>");
  assert.equal(html(2), "<p><strong>Temple</strong> casts 2 spells for <strong>Aria</strong>: "
    + "Spellcasting: Level 3 × 2. Tell the GM which spells.</p>");
});

test("names from the world are escaped", () => {
  const html = castingMessage({ shop: "<Shop>", buyer: "A & B", casts: [
    { name: "Spellcasting: Level 1", quantity: 1, spell: null, effects: [] }] });
  assert.ok(html.startsWith("<p><strong>&lt;Shop&gt;</strong> casts a spell for <strong>A &amp; B</strong>"), html);
});

test("the message goes where Item Piles sends its own trade card", () => {
  const gms = ["gm1", "gm2"];
  assert.deepEqual(chatRecipients(0, gms, "player"), []);
  assert.deepEqual(chatRecipients(1, gms, "player"), []);
  assert.deepEqual(chatRecipients(2, gms, "player"), ["gm1", "gm2", "player"]);
  assert.deepEqual(chatRecipients(3, gms, "player"), ["gm1", "gm2"]);
  assert.deepEqual(chatRecipients(2, ["gm1"], "gm1"), ["gm1"]);
});

test("only spellcasting actually bought counts, as the GM's client and the player's receive it", () => {
  const spell = { name: "Spellcasting: Level 1", flags: { "merchant-presets": { kind: "spellcasting" } } };
  const prices = { buyerReceive: [
    { quantity: 0, item: spell },
    { quantity: 1, item: { name: "Meal, Poor", flags: { "merchant-presets": { kind: "meal" } } } },
    { quantity: 2, item: spell }
  ] };
  assert.deepEqual(castsIn(prices).map(e => e.quantity), [2]);
  assert.deepEqual(castsIn(JSON.parse(JSON.stringify(prices))).map(e => e.quantity), [2]);
  assert.deepEqual(castsIn(undefined), []);
});

/* ------------------------------------------------ through the real runtime */

const world = createWorld();
await loadRuntime(world);

const temple = world.merchant("Temple_Faith_Store_Town_", { table: "RollTable.wired00000000001" });
world.actors.push(temple);
const aria = { id: "aria", uuid: "Actor.aria", name: "Aria", type: "character", flags: {} };
world.actors.push(aria);
world.compendium.set(WARDING_BOND, { uuid: WARDING_BOND, name: "Warding Bond", effects: [
  { uuid: `${WARDING_BOND}.ActiveEffect.bonded`, name: "Bonded", type: "base" }] });

const shelf = name => structuredClone(temple.items.find(i => i.name === name));
const buy = (name, quantity = 1) => ({ buyerReceive: [{ quantity, item: shelf(name) }] });
const posted = async (...args) => {
  const before = world.calls.messages.length;
  await world.fire("item-piles-tradeItems", ...args);
  return world.calls.messages.slice(before);
};

test("buying a named spell posts one message, spoken by the shop, with the spell and its effects", async () => {
  const [message, ...more] = await posted(temple, aria, buy("Spellcasting: Warding Bond"), "gm", "i1");
  assert.equal(more.length, 0);
  assert.equal(message.speaker.alias, "Temple & Faith Store (Town)");
  assert.ok(message.content.includes(`casts @UUID[${WARDING_BOND}]{Warding Bond} for <strong>Aria</strong>.`), message.content);
  assert.ok(message.content.includes(`@UUID[${WARDING_BOND}.ActiveEffect.bonded]{Bonded}`), message.content);
  assert.ok(!/GP/.test(message.content), "the price is Item Piles' trade card's to show");
});

test("a spell whose document cannot be fetched is still announced, without effects", async () => {
  const [message] = await posted(temple, aria, buy("Spellcasting: Raise Dead"), "gm", "i2");
  assert.ok(message.content.includes(`casts @UUID[${RAISE_DEAD}]{Raise Dead} for <strong>Aria</strong>.`), message.content);
  assert.ok(!message.content.includes("Effects"), message.content);
});

test("buying a level service asks for the spell", async () => {
  const [message] = await posted(temple, aria, buy("Spellcasting: Level 3"), "gm", "i3");
  assert.ok(message.content.includes("Spellcasting: Level 3. Tell the GM which spell."), message.content);
});

test("another user's trade is announced by that user's client, not this one", async () => {
  assert.deepEqual(await posted(temple, aria, buy("Spellcasting: Warding Bond"), "someone-else", "i4"), []);
});

test("goods that are not spellcasting post nothing", async () => {
  assert.deepEqual(await posted(temple, aria, buy("Diamond (300 GP)"), "gm", "i5"), []);
});

test("the message follows Item Piles' chat visibility", async () => {
  world.settings["item-piles.outputToChat"] = 2;
  const [message] = await posted(temple, aria, buy("Spellcasting: Level 3"), "gm", "i6");
  world.settings["item-piles.outputToChat"] = 1;
  assert.deepEqual(message.whisper, ["gm"]);
});

test("with the setting off, nothing is posted", async () => {
  world.settings.spellcastingToChat = false;
  const messages = await posted(temple, aria, buy("Spellcasting: Warding Bond"), "gm", "i7");
  world.settings.spellcastingToChat = true;
  assert.deepEqual(messages, []);
});
