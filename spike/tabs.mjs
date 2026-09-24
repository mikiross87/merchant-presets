// Q2b — the GM has the world open in two tabs; does one query run the handler once or twice?
import { browser, join, ev, show } from "./harness.mjs";
const M = "Actor.57oHVmTqHdn2T8iW";
const gm = await join("Gamemaster"), gm2 = await join("Gamemaster"), p1 = await join("P1");
await gm.waitForTimeout(15_000);
await ev(gm, M => fromUuid(M).then(m => m.items.getName("Bell").update({ "system.quantity": 5 })), M);
await gm.waitForTimeout(2000);
const snap = () => ev(gm, M => fromUuid(M).then(m => ({ bellStock: m.items.getName("Bell").system.quantity, tillGp: m.system.currency.gp, C1gp: game.actors.getName("C1").system.currency.gp })), M);
const before = await snap();
const r = await ev(p1, async M => { const bell = (await fromUuid(M)).items.getName("Bell"); const buyer = game.actors.find(a => a.isOwner && a.type === "character");
  return game.users.activeGM.query("merchant-presets.buy", { tradeId: foundry.utils.randomID(), merchantUuid: M, itemId: bell.id, buyerUuid: buyer.uuid }, { timeout: 30_000 }).then(v => v, e => e.message); }, M);
await gm.waitForTimeout(10_000);
show("Q2b two GM tabs, settled", { before, P1: r, after: await snap(), tab1: await ev(gm, () => mpSpikeLog), tab2: await ev(gm2, () => mpSpikeLog), C1bells: await ev(gm, () => game.actors.getName("C1").items.filter(i => i.name === "Bell").length), chat: await ev(gm, () => game.messages.contents.map(m => m.id + ': ' + m.content)),
  tab2ready: await ev(gm2, () => game.ready && game.socket.connected) });
await browser.close();
