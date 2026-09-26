import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bundleResolver, checkParties, claimsTrades, clientOutcome, hookPayload, outcomes, receiptHtml, recipients,
  recordedOutcome, resultOf, serial, shouldReclaim, CLAIM_STALE_MS, TRADE_RECORDS, withRecord, worldTerms
} from "../scripts/trade-desk.mjs";

/** CONFIG.DND5E.currencies, 6.0.5 shape (same fixture as tools/pricing.test.mjs). */
const CURRENCIES = {
  pp: { conversion: 0.1, abbreviation: "pp" },
  gp: { conversion: 1, abbreviation: "gp" },
  ep: { conversion: 2, abbreviation: "ep" },
  sp: { conversion: 10, abbreviation: "sp" },
  cp: { conversion: 100, abbreviation: "cp" }
};

const tick = () => new Promise(resolve => setImmediate(resolve));

/* ------------------------------------------------------------- worldTerms */

/** A `game.settings.get` stand-in over `values`. */
const settings = values => key => values[key];

test("the world terms read the rates as percentages, and the stock and purse modes", () => {
  assert.deepEqual(worldTerms(settings({ sellsAt: 110, buysAt: 40, stockMode: "unlimited", merchantPurse: "finite" })), {
    rates: { sellsAt: 1.1, buysAt: 0.4 }, infiniteStock: true, infinitePurse: false
  });
  assert.deepEqual(worldTerms(settings({ sellsAt: 100, buysAt: 50, stockMode: "finite", merchantPurse: "unlimited" })), {
    rates: { sellsAt: 1, buysAt: 0.5 }, infiniteStock: false, infinitePurse: true
  });
});

test("a world rate that isn't a usable number reads as the default: list price, half back", () => {
  for (const bad of [undefined, null, "100", NaN, Infinity, -5]) {
    assert.deepEqual(worldTerms(settings({ sellsAt: bad, buysAt: bad })).rates, { sellsAt: 1, buysAt: 0.5 }, String(bad));
  }
  // A shop can't give goods away, but it can refuse to pay anything for them.
  assert.equal(worldTerms(settings({ sellsAt: 0, buysAt: 0 })).rates.sellsAt, 1);
  assert.equal(worldTerms(settings({ sellsAt: 0, buysAt: 0 })).rates.buysAt, 0);
});

test("a percentage reads back without float noise", () => {
  assert.equal(worldTerms(settings({ sellsAt: 115, buysAt: 57 })).rates.sellsAt, 1.15);
  assert.equal(worldTerms(settings({ sellsAt: 115, buysAt: 57 })).rates.buysAt, 0.57);
});

/* ------------------------------------------------------------------ serial */

test("serial runs one trade at a time, in the order they arrived", async () => {
  const run = serial();
  const order = [];
  let release;
  const first = run(async () => { order.push("first:start"); await new Promise(r => { release = r; }); order.push("first:end"); return 1; });
  const second = run(async () => { order.push("second"); return 2; });
  await tick();
  assert.deepEqual(order, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("a trade that throws doesn't stall the ones queued behind it", async () => {
  const run = serial();
  const failed = run(async () => { throw new Error("boom"); });
  const next = run(async () => "ok");
  await assert.rejects(failed, /boom/);
  assert.equal(await next, "ok");
});

/* ---------------------------------------------------------------- outcomes */

test("a repeated trade id gets the first outcome back and never runs again", async () => {
  const memo = outcomes();
  let runs = 0;
  const once = () => memo.once("u1", "t1", async () => { runs++; return { status: "sealed", n: runs }; });
  const [a, b] = await Promise.all([once(), once()]);
  const c = await once();
  assert.equal(runs, 1);
  assert.deepEqual([a, b, c].map(r => r.n), [1, 1, 1]);
});

test("the same trade id from two users is two trades", async () => {
  const memo = outcomes();
  let runs = 0;
  await memo.once("u1", "t1", async () => ++runs);
  await memo.once("u2", "t1", async () => ++runs);
  assert.equal(runs, 2);
});

test("the memo forgets its oldest trades past its limit", async () => {
  const memo = outcomes(2);
  let runs = 0;
  for (const id of ["a", "b", "c"]) await memo.once("u", id, async () => ++runs);
  await memo.once("u", "c", async () => ++runs);
  assert.equal(runs, 3, "c is still remembered");
  await memo.once("u", "a", async () => ++runs);
  assert.equal(runs, 4, "a was forgotten");
});

test("a trade that threw is remembered as thrown, not run again", async () => {
  const memo = outcomes();
  let runs = 0;
  await assert.rejects(memo.once("u", "t", async () => { runs++; throw new Error("half-written"); }), /half-written/);
  await assert.rejects(memo.once("u", "t", async () => { runs++; return "again"; }), /half-written/);
  assert.equal(runs, 1);
});

/* ---------------------------------------------------------------- resultOf */

const plan = {
  tradeId: "t1", kind: "buy",
  hook: {
    tradeId: "t1", kind: "buy", shopId: "shop", buyerId: "pc", totalCp: 150, changeCp: 50,
    lines: [
      { itemId: "rope", item: { _id: "rope", name: "Rope", img: "rope.webp" }, quantity: 1, bundlePriceCp: 100, lineTotalCp: 100, category: "gear", layer: "world" },
      { itemId: "arrows", item: { _id: "arrows", name: "Arrows", img: "arrows.webp" }, quantity: 20, bundlePriceCp: 50, lineTotalCp: 50, category: "consumable", layer: "world" }
    ]
  },
  chatCard: { kind: "buy", shopName: "General Store", buyerName: "Tess", lines: [], totalCp: 150, direction: "Paid", footnote: { changeCp: 50, exact: false } }
};

test("a planned trade seals with what was carried out, line by line", () => {
  assert.deepEqual(resultOf({ ok: true, plan }), {
    status: "sealed",
    lines: [{ itemId: "rope", quantity: 1, lineTotalCp: 100 }, { itemId: "arrows", quantity: 20, lineTotalCp: 50 }],
    receipt: plan.chatCard
  });
});

test("a refusal passes its reason and line or fresh lines through", () => {
  assert.deepEqual(resultOf({ ok: false, reason: "closed" }), { status: "refused", reason: "closed" });
  assert.deepEqual(resultOf({ ok: false, reason: "out-of-stock", line: { itemId: "rope", quantity: 3 } }),
    { status: "refused", reason: "out-of-stock", line: { itemId: "rope", quantity: 3 } });
  const lines = [{ itemId: "rope", quantity: 1, bundlePriceCp: 120 }];
  assert.deepEqual(resultOf({ ok: false, reason: "stock-changed", lines }), { status: "refused", reason: "stock-changed", lines });
});

/* ----------------------------------------------------------- bundleResolver */

test("an SRD good's bundle comes from its compendium source's quantity", () => {
  const bundleOf = bundleResolver(new Map([["Compendium.dnd5e.equipment24.Item.arrows", 20], ["Compendium.dnd5e.equipment24.Item.rope", 1]]));
  assert.equal(bundleOf({ _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.arrows" } }), 20);
  assert.equal(bundleOf({ flags: { core: { sourceId: "Compendium.dnd5e.equipment24.Item.arrows" } } }), 20);
});

test("no source, an unknown source, or a bundle of one falls through to the default", () => {
  const bundleOf = bundleResolver(new Map([["Compendium.dnd5e.equipment24.Item.rope", 1]]));
  assert.equal(bundleOf({}), undefined);
  assert.equal(bundleOf({ _stats: { compendiumSource: "Compendium.dnd5e.equipment24.Item.rope" } }), undefined);
  assert.equal(bundleOf({ _stats: { compendiumSource: "Compendium.world.homebrew.Item.arrows" } }), undefined);
});

/* ------------------------------------------------------------ claimsTrades */

test("only the tab named on the GM user answers trades", () => {
  assert.equal(claimsTrades("tabA", "tabA"), true);
  assert.equal(claimsTrades("tabA", "tabB"), false);
  assert.equal(claimsTrades(undefined, "tabB"), false, "no claim: nobody answers, rather than every tab");
});

/* ----------------------------------------------------------- clientOutcome */

test("no GM connected reads as no-gm; a query that failed or timed out as unconfirmed", () => {
  assert.deepEqual(clientOutcome(false), { status: "no-gm" });
  assert.deepEqual(clientOutcome(true), { status: "unconfirmed" });
});

/* ------------------------------------------------------------ checkParties */

const SHOP_FLAGS = { "merchant-presets": { shop: { version: 1 } } };
const party = (id, { flags = {}, owners = [], viewers = [] } = {}) => ({
  id, flags,
  testUserPermission: (user, level) => (level === "OWNER" ? owners : [...owners, ...viewers]).includes(user.id)
});

test("a player may trade for a character they own at a shop they can see", () => {
  const user = { id: "p1", isGM: false };
  const shop = party("shop", { flags: SHOP_FLAGS, viewers: ["p1"] });
  const buyer = party("pc", { owners: ["p1"] });
  assert.equal(checkParties({ user, shop, buyer }), null);
});

test("a player can't trade for a character they don't own", () => {
  const user = { id: "p1", isGM: false };
  const shop = party("shop", { flags: SHOP_FLAGS, viewers: ["p1"] });
  assert.equal(checkParties({ user, shop, buyer: party("pc", { viewers: ["p1"] }) }), "invalid-request");
});

test("a player can't trade at a shop they can't see", () => {
  const user = { id: "p1", isGM: false };
  assert.equal(checkParties({ user, shop: party("shop", { flags: SHOP_FLAGS }), buyer: party("pc", { owners: ["p1"] }) }), "invalid-request");
});

test("a GM may trade for anyone at any shop", () => {
  const user = { id: "gm", isGM: true };
  assert.equal(checkParties({ user, shop: party("shop", { flags: SHOP_FLAGS }), buyer: party("pc") }), null);
});

test("an actor that isn't a shop, a missing party, or trading with yourself is refused", () => {
  const user = { id: "gm", isGM: true };
  assert.equal(checkParties({ user, shop: party("npc"), buyer: party("pc") }), "invalid-request");
  assert.equal(checkParties({ user, shop: null, buyer: party("pc") }), "not-found");
  assert.equal(checkParties({ user, shop: party("shop", { flags: SHOP_FLAGS }), buyer: null }), "not-found");
  const shop = party("shop", { flags: SHOP_FLAGS });
  assert.equal(checkParties({ user, shop, buyer: shop }), "invalid-request");
});

test("an actor in a compendium never trades, shop or buyer (#134 review)", () => {
  const user = { id: "gm", isGM: true };
  const packed = { ...party("shop", { flags: SHOP_FLAGS }), pack: "merchant-presets.merchants" };
  assert.equal(checkParties({ user, shop: packed, buyer: party("pc") }), "invalid-request");
  assert.equal(checkParties({ user, shop: party("shop", { flags: SHOP_FLAGS }), buyer: { ...party("pc"), pack: "world.heroes" } }), "invalid-request");
});

/* ---------------------------------------------------------------- recipients */

test("the trade chat mode picks who sees the receipt", () => {
  assert.equal(recipients("off", ["gm"]), null);
  assert.deepEqual(recipients("gm", ["gm", "gm2"]), ["gm", "gm2"]);
  assert.deepEqual(recipients("public", ["gm"]), []);
  assert.deepEqual(recipients("nonsense", ["gm"]), [], "an unknown mode reads as the default, public");
});

/* ---------------------------------------------------------------- receiptHtml */

test("the receipt names the shop, the buyer, each line and the total in coins", () => {
  const html = receiptHtml({
    kind: "buy", shopName: "General Store", buyerName: "Tess <the bold>",
    lines: [{ icon: "rope.webp", label: "Rope", quantity: 1, lineTotalCp: 100 }, { icon: "a.webp", label: "Arrows", quantity: 20, lineTotalCp: 150 }],
    totalCp: 250, direction: "Paid", footnote: { changeCp: 50, exact: false }
  }, CURRENCIES);
  assert.match(html, /General Store/);
  assert.match(html, /Tess &lt;the bold&gt;/, "names are escaped");
  assert.match(html, /20 × Arrows/);
  assert.match(html, /1 gp 5 sp/);
  assert.match(html, /Paid[^<]*<[^>]*>?\s*2 gp 5 sp/);
  assert.match(html, /5 sp/, "the change given is named");
});

test("a sale's receipt says received, and a free line reads as free", () => {
  const html = receiptHtml({
    kind: "sell", shopName: "Shop", buyerName: "Tess",
    lines: [{ label: "Pebble", quantity: 1, lineTotalCp: 0 }], totalCp: 0, direction: "Received", footnote: { changeCp: 0, exact: true }
  }, CURRENCIES);
  assert.match(html, /sold/i);
  assert.match(html, /Received/);
  assert.match(html, /free/i);
});

/* ---------------------------------------------------------------- hookPayload */

test("the trade hook carries uuids, the trader and each line's item", () => {
  const payload = hookPayload(plan, { shopUuid: "Actor.shop", buyerUuid: "Actor.pc", userId: "p1" });
  assert.deepEqual(Object.keys(payload).sort(), ["buyerUuid", "changeCp", "kind", "lines", "shopUuid", "totalCp", "tradeId", "userId"]);
  assert.equal(payload.kind, "buy");
  assert.equal(payload.lines[1].item.name, "Arrows");
  assert.equal(payload.lines[1].quantity, 20);
  assert.doesNotThrow(() => JSON.stringify(payload), "it crosses the socket as JSON");
});

/* ---------------------------------------------------------- trade records */

test("a sealed trade is found on the buyer's record by who asked and its id", () => {
  const records = withRecord([], { userId: "p1", tradeId: "t1", result: { status: "sealed", lines: [] } });
  assert.deepEqual(recordedOutcome(records, "p1", "t1"), { status: "sealed", lines: [] });
  assert.equal(recordedOutcome(records, "p2", "t1"), null);
  assert.equal(recordedOutcome(undefined, "p1", "t1"), null);
  assert.equal(recordedOutcome("junk", "p1", "t1"), null, "a hand-edited flag never throws");
});

test("the record keeps only the latest trades, newest last", () => {
  let records = [];
  for (let i = 0; i < TRADE_RECORDS + 3; i++) records = withRecord(records, { userId: "p1", tradeId: `t${i}`, result: {} });
  assert.equal(records.length, TRADE_RECORDS);
  assert.equal(records.at(-1).tradeId, `t${TRADE_RECORDS + 2}`);
  assert.equal(recordedOutcome(records, "p1", "t0"), null);
});

/* ----------------------------------------------------------- shouldReclaim */

test("a GM tab takes the claim when nobody holds it", () => {
  assert.equal(shouldReclaim({ claim: undefined, tabId: "b", lastAliveAt: 0, now: 0 }), true);
});

test("a GM tab takes the claim from a claimer that's gone quiet (#102 live run: a closed tab's unload write never landed)", () => {
  assert.equal(shouldReclaim({ claim: "a", tabId: "b", lastAliveAt: 1000, now: 1000 + CLAIM_STALE_MS + 1 }), true);
  assert.equal(shouldReclaim({ claim: "a", tabId: "b", lastAliveAt: 1000, now: 1000 + CLAIM_STALE_MS }), false);
});

test("the claiming tab never re-claims from itself", () => {
  assert.equal(shouldReclaim({ claim: "b", tabId: "b", lastAliveAt: 0, now: 10 * CLAIM_STALE_MS }), false);
});
