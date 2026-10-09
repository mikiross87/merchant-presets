import { test } from "node:test";
import assert from "node:assert/strict";
import { activityEffects, actorEffects, castActivity, castFlavor, castingMessage, castsIn, chatRecipients, spellCard, spellCards }
  from "../scripts/casting.mjs";
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

/* ------------------------------------------- the spell's own card (#87, #237) */

// On dnd5e 6 a named service is announced as dnd5e's usage card for the spell, spoken by the
// shop (design band 21): the spell's description and pills, and, for a spell with effects, the
// tray the GM applies them from.

test("the card's flavor line says for whom, and how many times", () => {
  assert.equal(castFlavor("Aria", 1), "Cast for <strong>Aria</strong>");
  assert.equal(castFlavor("Aria", 2), "Cast twice for <strong>Aria</strong>");
  assert.equal(castFlavor("Aria", 3), "Cast 3 times for <strong>Aria</strong>");
  assert.equal(castFlavor("A & <B>", 1), "Cast for <strong>A &amp; &lt;B&gt;</strong>");
});

test("spell cards are dnd5e 6's: 5.3 keeps the message line", () => {
  const newer = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0;
  assert.equal(spellCards("6.0.0", newer), true);
  assert.equal(spellCards("6.0.6", newer), true);
  assert.equal(spellCards("5.3.3", newer), false);
  assert.equal(spellCards(undefined, newer), false);
});

const effect = (uuid, type = "base") => ({ effect: { uuid, type } });

test("the card's effects are its activity's, without enchantments", () => {
  assert.deepEqual(activityEffects({ effects: [effect("E.day1"), effect("E.contingency", "enchantment"), { _id: "gone" }] }), ["E.day1"]);
  assert.deepEqual(activityEffects(undefined), []);
});

test("the card shows the activity that carries effects, else the spell's first", () => {
  const plain = { name: "Cast", effects: [] }, revive = { name: "Revive", effects: [effect("E.day1")] };
  assert.equal(castActivity([plain, revive]), revive);
  assert.equal(castActivity([plain, { name: "Use", effects: [] }]), plain);
  assert.equal(castActivity([]), undefined);
});

test("the card is built on dnd5e's snapshot of the spell: no compendium link, no buttons, no content", () => {
  const data = { _id: "copy00000000001", name: "Raise Dead", type: "spell" };
  const card = { title: "Raise Dead - Revive", type: "usage", system: {
    activity: { id: "act", name: "Revive" }, buttons: [{ action: "rollHealing" }],
    item: { id: "copy00000000001", name: "Raise Dead", uuid: "Actor.shop.Item.copy00000000001" }, description: "<p>With a touch…</p>" } };
  const message = spellCard({ card, data, effects: ["Actor.shop.Item.copy00000000001.ActiveEffect.day1"],
    flavor: "Cast for <strong>Aria</strong>", speaker: { actor: "shop", alias: "Temple" }, whisper: ["gm"] });
  assert.deepEqual(message, {
    title: "Raise Dead - Revive", type: "usage", speaker: { actor: "shop", alias: "Temple" }, whisper: ["gm"],
    flavor: "Cast for <strong>Aria</strong>",
    system: { activity: { id: "act", name: "Revive" }, buttons: [], description: "<p>With a touch…</p>",
      effects: ["Actor.shop.Item.copy00000000001.ActiveEffect.day1"],
      item: { id: "copy00000000001", name: "Raise Dead", uuid: null } },
    flags: { dnd5e: { item: { data } } }
  });
  assert.equal(card.system.buttons.length, 1, "dnd5e's card data is left as it was");
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
  return world.calls.messages.slice(before).filter(m => !m.content?.includes("mp-receipt"));
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

/* ------------------------------------- the spell's own card, on dnd5e 6 (#87, #237) */

/** dnd5e 6's spell as the runtime sees it: its data, and an unsaved copy whose activity builds the card. */
class SpellCopy {
  constructor(data, { parent }) {
    Object.assign(this, { name: data.name, parent, data });
    const id = data._id;
    const effects = (data.effects ?? []).map(e => ({ effect: { ...e, uuid: `${parent.uuid}.Item.${id}.ActiveEffect.${e._id}` } }));
    const activities = (data.activities ?? []).map(a => ({ ...a, effects: a.withEffects ? effects : [], metadata: { usage: { messageType: "usage" } } }));
    this.system = { activities: { contents: activities },
      getCardData: async ({ activity }) => {
        if (data.broken) throw new Error("dnd5e changed its card data");
        return { activity: { id: activity.id, name: activity.name }, buttons: [{ action: "heal" }],
          item: { id, name: data.name, uuid: `${parent.uuid}.Item.${id}` }, description: `<p>${data.name}</p>` };
      } };
  }
}
const spellDoc = (uuid, name, { effects = [], withEffects = false, broken = false } = {}) => ({ uuid, name,
  effects: effects.map(e => ({ ...e, uuid: `${uuid}.ActiveEffect.${e._id}` })),
  toObject: () => ({ _id: uuid.split(".").pop(), name, type: "spell", broken, effects, activities: [
    { id: "cast", name: "Cast", withEffects: false }, { id: "revive", name: "Revive", withEffects }] }) });
const raiseDead = opts => spellDoc(RAISE_DEAD, "Raise Dead", { withEffects: true, effects: [
  { _id: "day1", name: "Resurrection Sickness (Day 1)", type: "base" }, { _id: "spell", name: "Contingency", type: "enchantment" }], ...opts });

const IDENTIFY = "Compendium.dnd5e.spells24.Item.phbsplIdentify00";
const named = temple.items.find(i => i.name === "Spellcasting: Raise Dead");
temple.items.push({ ...structuredClone(named), _id: "identify0000001", name: "Spellcasting: Identify",
  flags: { ...structuredClone(named.flags), "merchant-presets": { ...named.flags["merchant-presets"], spell: IDENTIFY } } });

/** Run `fn` on dnd5e 6 with `spells` in its compendium; the world goes back to how it was, whatever `fn` does. */
async function onDnd5e6(spells, fn) {
  const utils = globalThis.foundry.utils;
  globalThis.game.system = { id: "dnd5e", version: "6.0.6" };
  utils.isNewerVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true }) > 0;
  globalThis.Item = { implementation: SpellCopy };
  for (const spell of spells) world.compendium.set(spell.uuid, spell);
  try {
    await fn();
  } finally {
    for (const spell of spells) world.compendium.delete(spell.uuid);
    delete globalThis.game.system;
    delete utils.isNewerVersion;
    delete globalThis.Item;
  }
}

/** Buy several of the temple's goods in one trade; the messages beside the receipt. */
const postedAll = async lines => {
  const before = world.calls.messages.length;
  const result = await api.trade({ tradeId: globalThis.foundry.utils.randomID(), kind: "buy", shopUuid: temple.uuid, buyerUuid: aria.uuid,
    lines: lines.map(([name, quantity]) => ({ itemId: temple.items.find(i => i.name === name)._id, quantity })) });
  assert.equal(result.status, "sealed", JSON.stringify(result));
  await tick();
  return world.calls.messages.slice(before).filter(m => !m.content?.includes("mp-receipt"));
};

test("on dnd5e 6, a named spell is announced as its own card, spoken by the shop, with its effects to apply", () => onDnd5e6([raiseDead()], async () => {
  const [card, ...more] = await posted("Spellcasting: Raise Dead", 2);
  assert.equal(more.length, 0, "one card, and no message line");
  assert.equal(card.type, "usage");
  assert.equal(card.content, undefined, "dnd5e shows content instead of the card");
  assert.equal(card.speaker.alias, "Temple & Faith Store (Town)");
  assert.equal(card.flavor, "Cast twice for <strong>Aria</strong>");
  assert.equal(card.system.activity.name, "Revive");
  assert.deepEqual(card.system.buttons, []);
  assert.equal(card.system.item.uuid, null);
  const data = card.flags.dnd5e.item.data;
  assert.equal(data.name, "Raise Dead");
  assert.equal(card.system.item.id, data._id);
  assert.notEqual(data._id, "phbsplRaiseDead0", "a copy of its own, not the compendium's id");
  assert.deepEqual(card.system.effects, [`${temple.uuid}.Item.${data._id}.ActiveEffect.day1`]);
}));

test("on dnd5e 6, a spell without effects is its card alone; a level service and an unfetchable spell keep the line", () => onDnd5e6([spellDoc(IDENTIFY, "Identify")], async () => {
  const [card] = await posted("Spellcasting: Identify");
  assert.equal(card.system.activity.name, "Cast");
  assert.deepEqual(card.system.effects, []);
  assert.equal(card.flavor, "Cast for <strong>Aria</strong>");
  const [level] = await posted("Spellcasting: Level 3");
  assert.ok(level.content.includes("Tell the GM which spell."), level.content);
  const [missing] = await posted("Spellcasting: Greater Restoration");
  assert.ok(missing.content.includes(`casts @UUID[${GREATER_RESTORATION}]{Greater Restoration} for <strong>Aria</strong>.`), missing.content);
}));

test("on dnd5e 6, a card that can't be built falls back to the line, and the rest of the purchase is still announced", () =>
  onDnd5e6([raiseDead({ broken: true }), spellDoc(IDENTIFY, "Identify")], async () => {
    const messages = await postedAll([["Spellcasting: Raise Dead", 1], ["Spellcasting: Identify", 1], ["Spellcasting: Level 3", 1]]);
    assert.deepEqual(messages.map(m => m.type ?? "line"), ["usage", "line"]);
    assert.equal(messages[0].flags.dnd5e.item.data.name, "Identify");
    const line = messages[1].content;
    assert.ok(line.includes(`casts @UUID[${RAISE_DEAD}]{Raise Dead} for <strong>Aria</strong>.`), line);
    assert.ok(line.includes(`@UUID[${RAISE_DEAD}.ActiveEffect.day1]{Resurrection Sickness (Day 1)}`), line);
    assert.ok(line.includes("Tell the GM which spell."), line);
  }));
