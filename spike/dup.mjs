import { browser, join, ev, show } from "./harness.mjs";
const gm = await join("Gamemaster"), gm2 = await join("Gamemaster");
await gm.waitForTimeout(12_000);
const id = await ev(gm, () => foundry.utils.randomID());
const mk = (p, tag) => ev(p, async ({ id, tag }) => {
  const errs = []; const orig = console.error; console.error = (...a) => { errs.push(a.map(String).join(" ")); orig(...a); };
  const r = await ChatMessage.create({ _id: id, content: tag }, { keepId: true }).then(m => m ? `${m.constructor.name} ${m.id} content=${m.content}` : String(m), e => `threw: ${e.message}`);
  console.error = orig; return { r, errs, count: game.messages.filter(m => m.id === id).length };
}, { id, tag });
show("sequential, same tab", [await mk(gm, "first"), await mk(gm, "second")]);
const id2 = await ev(gm, () => foundry.utils.randomID());
show("concurrent, two tabs", await Promise.all([ev(gm, a => ChatMessage.create({ _id: a, content: "tab1" }, { keepId: true }).then(m => m?.content ?? String(m), e => "threw: " + e.message), id2),
  ev(gm2, a => ChatMessage.create({ _id: a, content: "tab2" }, { keepId: true }).then(m => m?.content ?? String(m), e => "threw: " + e.message), id2)]));
await gm.waitForTimeout(1000);
show("stored", await ev(gm, ids => ids.map(i => game.messages.get(i)?.content), [id, id2]));
await browser.close();
