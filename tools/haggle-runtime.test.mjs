import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorld, loadRuntime } from "./foundry-stub.mjs";
import { receiptIcons } from "../scripts/trade-desk.mjs";

// The #112 haggle card's chrome, driven through the real merchant-presets.mjs: a GM's call posts
// a card that heads like a trade receipt (design XAkJh), the shop speaking, whispered, under the
// "Haggle" strip. The call's rules are tools/haggle.test.mjs's.

async function setUp() {
  const world = createWorld();
  await loadRuntime(world);
  const shop = world.merchant("Armourer_Blacksmiths_Town_");
  shop.name = "Smith & <Sons>";
  shop.img = "icons/smith.webp";
  world.actors.push(shop);
  const aria = world.character("aria", { owners: ["p1"] });
  aria.name = "Aria";
  globalThis.game.messages = [];
  globalThis.foundry.utils.escapeHTML = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  const api = globalThis.game.modules.get("merchant-presets").api;
  return { world, shop, aria, api };
}

test("a haggle call posts a whispered card that heads like a receipt: the shop, Whisper, and the Haggle strip", async () => {
  const { world, shop, aria, api } = await setUp();
  const answer = await api.callHaggle({ shopUuid: shop.uuid, actorUuid: aria.uuid, side: "buy", skill: null, dc: 14 });
  assert.equal(answer.status, "called", JSON.stringify(answer));
  const [card] = world.calls.messages;
  // Drawn as a receipt by the stylesheet and the icon hook (`.mp-receipt`), and a haggle card by the roll hook.
  assert.match(card.content, /^<div class="merchant-presets mp-receipt mp-haggle-card" data-pen="Haggle card">/);
  assert.match(card.content, /<img class="mp-receipt-portrait" data-pen="Speaker img" src="icons\/smith.webp"/);
  assert.match(card.content, /<b data-pen="Speaker name">Smith &#38; &#60;Sons&#62;<\/b>/);
  assert.match(card.content, /<span data-pen="Vis text">MERCHANT_PRESETS.Haggle.Whisper<\/span>/);
  assert.match(card.content, /<b data-pen="Kicker">MERCHANT_PRESETS.Haggle.Kicker<\/b>/);
  assert.match(card.content, /<p class="mp-haggle-line" data-pen="Haggle call">MERCHANT_PRESETS.Haggle.Call<\/p><\/div>$/);
  // Its icons are slots a receipt's render draws in: a message's saved content can't hold an <svg>.
  const drawn = receiptIcons(card.content);
  assert.match(drawn, /<svg class="mp-icon" data-icon="eye-off" data-pen="Vis icon"/);
  assert.match(drawn, /<svg class="mp-icon" data-icon="messages-square" data-pen="Kicker icon"/);
  // The call keeps what the head needs, so a lapsed or rolled card is drawn the same way.
  const call = card.flags["merchant-presets"].haggle;
  assert.equal(call.shopImg, "icons/smith.webp");
  assert.equal(typeof call.when, "string");
});
