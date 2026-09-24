// Q2 — two players buy the last Bell at once, with clients given time to settle first.
import { browser, join, ev, show } from "./harness.mjs";
const M = "Actor.57oHVmTqHdn2T8iW";
const gm = await join("Gamemaster"), p1 = await join("P1"), p2 = await join("P2");
await gm.waitForTimeout(15_000);
const snap = () => ev(gm, M => fromUuid(M).then(m => ({ bellStock: m.items.getName("Bell").system.quantity, tillGp: m.system.currency.gp,
  C1: [game.actors.getName("C1").system.currency.gp, game.actors.getName("C1").items.filter(i => i.name === "Bell").length],
  C2: [game.actors.getName("C2").system.currency.gp, game.actors.getName("C2").items.filter(i => i.name === "Bell").length] })), M);
const buy = (p, serialize) => ev(p, async ({ M, serialize }) => {
  const bell = (await fromUuid(M)).items.getName("Bell");
  const buyer = game.actors.find(a => a.isOwner && a.type === "character");
  const t0 = Date.now();
  try { return { ok: await game.users.activeGM.query("merchant-presets.buy", { merchantUuid: M, itemId: bell.id, buyerUuid: buyer.uuid, delayMs: 1500, serialize }, { timeout: 30_000 }), ms: Date.now() - t0 }; }
  catch (e) { return { error: e.message, ms: Date.now() - t0 }; }
}, { M, serialize });
for (const serialize of [false, true]) {
  await ev(gm, M => fromUuid(M).then(m => m.items.getName("Bell").update({ "system.quantity": 1 })), M);
  await gm.waitForTimeout(2000);
  const before = await snap();
  const [r1, r2] = await Promise.all([buy(p1, serialize), buy(p2, serialize)]);
  await gm.waitForTimeout(1000);
  show(`Q2 last Bell, serialize=${serialize}`, { before, P1: r1, P2: r2, after: await snap(), runs: await ev(gm, () => globalThis.mpSpikeLog.splice(0).map(e => `${e.by} stockBefore=${e.stockBefore}`)) });
}
await browser.close();
