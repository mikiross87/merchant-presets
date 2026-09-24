// The #96 questions, each against live GM + player clients.
import { browser, join, ev, show } from "./harness.mjs";

const M = "Actor.57oHVmTqHdn2T8iW";
const snapshot = page => ev(page, async ({ M }) => {
  const m = await fromUuid(M);
  const bell = m.items.getName("Bell");
  const c = n => { const a = game.actors.getName(n); return { gp: a.system.currency, bells: a.items.filter(i => i.name === "Bell").reduce((t, i) => t + i.system.quantity, 0) }; };
  return { bellStock: bell?.system.quantity ?? 0, till: m.system.currency, C1: c("C1"), C2: c("C2") };
}, { M });
const buy = (page, args, opts) => ev(page, async ({ M, args, opts }) => {
  const t0 = Date.now();
  const bell = (await fromUuid(M)).items.getName("Bell");
  const buyer = game.user.character ?? game.actors.find(a => a.isOwner && a.type === "character");
  try {
    const r = await game.users.activeGM.query("merchant-presets.buy",
      { merchantUuid: M, itemId: bell.id, buyerUuid: buyer.uuid, ...args }, opts);
    return { ok: r, ms: Date.now() - t0 };
  } catch (e) { return { error: e.message, ms: Date.now() - t0 }; }
}, { M, args, opts });
const setBells = (gm, q) => ev(gm, async ({ M, q }) => {
  const m = await fromUuid(M);
  const bell = m.items.getName("Bell");
  if (bell) return bell.update({ "system.quantity": q });
  const src = game.actors.getName("C1").items.getName("Bell").toObject();
  delete src._id;
  return m.createEmbeddedDocuments("Item", [{ ...src, system: { ...src.system, quantity: q } }]);
}, { M, q });
const gmLog = gm => ev(gm, () => globalThis.mpSpikeLog.splice(0));

let gm = await join("Gamemaster");
const p1 = await join("P1");
const p2 = await join("P2");

// Q1 — what a Limited player's client holds.
await ev(gm, M => fromUuid(M).then(m => m.setFlag("merchant-presets", "dealNotes", "GM ONLY: C1 gets 10% off")), M);
show("Q1 Limited player's view of the merchant", await ev(p1, async M => {
  const m = await fromUuid(M);
  return {
    permission: m.permission, limited: m.limited, canWrite: m.canUserModify(game.user, "update"),
    items: m.items.size, forSale: m.items.filter(i => i.getFlag("merchant-presets", "kind") !== "gear").length,
    currency: m.system.currency, flagKeys: Object.keys(m.flags), dealNotes: m.getFlag("merchant-presets", "dealNotes"),
    itemPilesData: Object.keys(m.flags["item-piles"]?.data ?? {}).length,
    directWrite: await m.update({ "system.currency.gp": 9999 }).then(() => "WROTE", e => `refused: ${e.message}`)
  };
}, M));

// Buy — one bell at 1 gp, paid from 20 gp.
show("buy: before", await snapshot(gm));
show("buy: P1 buys one Bell", await buy(p1, {}));
show("buy: after (GM view)", await snapshot(gm));
show("buy: after (P1 view)", await snapshot(p1));

// Q2 — two players buy the last item at once.
for (const serialize of [false, true]) {
  await setBells(gm, 1);
  const before = await snapshot(gm);
  const res = await Promise.all([buy(p1, { delayMs: 3000, serialize }), buy(p2, { delayMs: 3000, serialize })]);
  await gm.waitForTimeout(1000);
  show(`Q2 last Bell, both at once, serialize=${serialize}`, { before, P1: res[0], P2: res[1], after: await snapshot(gm), handlerRuns: await gmLog(gm) });
}

// Q2b — the GM has the world open in two tabs: does the handler run once per socket?
await setBells(gm, 5);
const gm2 = await join("Gamemaster");
await gm.waitForTimeout(500);
{
  const before = await snapshot(gm);
  const res = await buy(p1, {});
  await gm.waitForTimeout(1500);
  show("Q2b two GM tabs, P1 buys one Bell", { before, P1: res, after: await snapshot(gm), runsTab1: await gmLog(gm), runsTab2: await gmLog(gm2) });
}
await gm2.close();
await gm.waitForTimeout(1000);

// Q4 — slow GM: 3 s handler, 1 s timeout.
await setBells(gm, 5);
{
  const before = await snapshot(gm);
  const res = await buy(p1, { delayMs: 3000 }, { timeout: 1000 });
  const atReply = await snapshot(gm);
  await gm.waitForTimeout(3500);
  show("Q4 timeout 1 s, handler 3 s", { before, P1: res, atReply, after3s: await snapshot(gm), handlerRuns: await gmLog(gm) });
}

// Q3b — the GM disconnects mid-trade and the player set no timeout.
{
  const pending = buy(p1, { delayMs: 3000 });
  await gm.waitForTimeout(1000);
  await gm.context().close();
  const res = await Promise.race([pending, new Promise(r => setTimeout(() => r("STILL PENDING after 15 s"), 15_000))]);
  show("Q3b GM disconnects mid-trade, no timeout", res);
}

// Q3 — no GM connected at all.
show("Q3 no GM connected", await ev(p1, async M => {
  const gmUser = game.users.find(u => u.isGM);
  const r = { activeGM: game.users.activeGM?.name ?? null, gmActive: gmUser.active };
  try { await gmUser.query("merchant-presets.buy", { merchantUuid: M }); r.direct = "resolved?"; }
  catch (e) { r.direct = e.message; }
  try { await game.users.activeGM.query("merchant-presets.buy", {}); } catch (e) { r.viaActiveGM = e.message; }
  return r;
}, M));

await browser.close();
