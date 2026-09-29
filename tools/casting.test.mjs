import { test } from "node:test";
import assert from "node:assert/strict";
import { actorEffects, castingMessage, castsIn, chatRecipients } from "../scripts/casting.mjs";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";

// Buying a spellcasting service moves gold and nothing else (#70). The trade's
// receipt already says what was paid, so this message says what was cast and
// for whom, and hands the GM the spell and its effects.

const GREATER_RESTORATION = "Compendium.dnd5e.spells24.Item.phbsplGreaterRes";
const RAISE_DEAD = "Compendium.dnd5e.spells24.Item.phbsplRaiseDead0";

test("a named service says which spell was cast, for whom, and links it", () => {
  const html = castingMessage({ shop: "Temple & Faith Store (Town)", buyer: "Aria", casts: [
    { name: "Spellcasting: Greater Restoration", quantity: 1, spell: GREATER_RESTORATION, effects: [] }
  ] });
  assert.equal(html, `<p><strong>Temple &amp; Faith Store (Town)</strong> casts @UUID[${GREATER_RESTORATION}]{Greater Restoration} `
    + "for <strong>Aria</strong>.</p>");
});

test("buying a spell more than once says how many times", () => {
  const cast = n => castingMessage({ shop: "Temple", buyer: "Aria", casts: [
    { name: "Spellcasting: Greater Restoration", quantity: n, spell: GREATER_RESTORATION, effects: [] }] });
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

test("the message goes to the trade chat's recipients: public (1), or whispered to the GMs (3)", () => {
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
  const trade = prices => ({ kind: "buy", lines: prices.buyerReceive });
  assert.deepEqual(castsIn(trade(prices)).map(e => e.quantity), [2]);
  assert.deepEqual(castsIn(trade(JSON.parse(JSON.stringify(prices)))).map(e => e.quantity), [2]);
  assert.deepEqual(castsIn(undefined), []);
  assert.deepEqual(castsIn({ kind: "sell", lines: prices.buyerReceive }), [], "selling a service back casts nothing");
});

/* ------------------------------------------------ through the real runtime */

const world = createWorld();
await loadRuntime(world);

const temple = world.merchant("Temple_Faith_Store_Town_", { table: "RollTable.wired00000000001" });
world.actors.push(temple);
const aria = Object.assign(world.character("aria", { currency: { pp: 100000 }, owners: ["p1"] }), { name: "Aria" });
world.compendium.set(RAISE_DEAD, { uuid: RAISE_DEAD, name: "Raise Dead", effects: [
  { uuid: `${RAISE_DEAD}.ActiveEffect.etY0sDrXe6DcFEzc`, name: "Resurrection Sickness (Day 1)", type: "base" }] });

const api = globalThis.game.modules.get("merchant-presets").api;
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Buy `name` from the temple through the native trade, as this client; the messages beside the receipt. */
const posted = async (name, quantity = 1) => {
  const before = world.calls.messages.length;
  const itemId = temple.items.find(i => i.name === name)._id;
  const result = await api.trade({ tradeId: globalThis.foundry.utils.randomID(), kind: "buy", shopUuid: temple.uuid,
    buyerUuid: aria.uuid, lines: [{ itemId, quantity }] });
  assert.equal(result.status, "sealed", JSON.stringify(result));
  await tick();
  return world.calls.messages.slice(before).filter(m => !m.content.includes("mp-receipt"));
};

test("buying a named spell posts one message, spoken by the shop, with the spell and its effects", async () => {
  const [message, ...more] = await posted("Spellcasting: Raise Dead");
  assert.equal(more.length, 0);
  assert.equal(message.speaker.alias, "Temple & Faith Store (Town)");
  assert.ok(message.content.includes(`casts @UUID[${RAISE_DEAD}]{Raise Dead} for <strong>Aria</strong>.`), message.content);
  assert.ok(message.content.includes(`@UUID[${RAISE_DEAD}.ActiveEffect.etY0sDrXe6DcFEzc]{Resurrection Sickness (Day 1)}`), message.content);
  assert.ok(!/GP/.test(message.content), "the price is the receipt's to show");
});

test("a spell whose document cannot be fetched is still announced, without effects", async () => {
  const [message] = await posted("Spellcasting: Greater Restoration");
  assert.ok(message.content.includes(`casts @UUID[${GREATER_RESTORATION}]{Greater Restoration} for <strong>Aria</strong>.`), message.content);
  assert.ok(!message.content.includes("Effects"), message.content);
});

test("buying a level service asks for the spell", async () => {
  const [message] = await posted("Spellcasting: Level 3");
  assert.ok(message.content.includes("Spellcasting: Level 3. Tell the GM which spell."), message.content);
});

test("another client's trade is announced by that client, not this one", async () => {
  await posted("Spellcasting: Raise Dead");
  const [sent] = world.calls.socket.filter(s => s.name === "module.merchant-presets").slice(-1);
  const before = world.calls.messages.length;
  world.receive("module.merchant-presets", { ...sent.message, trade: { ...sent.message.trade, tradeId: "elsewhere000001" } });
  await tick();
  assert.deepEqual(world.calls.messages.slice(before), []);
});

test("goods that are not spellcasting post nothing", async () => {
  assert.deepEqual(await posted("Diamond (300 GP)"), []);
});


test("with the setting off, nothing is posted", async () => {
  world.settings.spellcastingToChat = false;
  const messages = await posted("Spellcasting: Raise Dead");
  world.settings.spellcastingToChat = true;
  assert.deepEqual(messages, []);
});
