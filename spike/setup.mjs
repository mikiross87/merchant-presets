// One-time world setup: enable the spike module, two players each with a character, one merchant at Limited.
import { browser, join, ev, show } from "./harness.mjs";

let gm = await join("Gamemaster");
const enabled = await ev(gm, () => game.modules.get("merchant-presets")?.active);
if (!enabled) {
  await ev(gm, async () => {
    const cfg = game.settings.get("core", "moduleConfiguration");
    await game.settings.set("core", "moduleConfiguration", { ...cfg, "merchant-presets": true });
  });
  await gm.close();
  gm = await join("Gamemaster");
}

const state = await ev(gm, async () => {
  for (const name of ["P1", "P2"]) {
    if (!game.users.getName(name)) await User.create({ name, role: CONST.USER_ROLES.PLAYER });
  }
  for (const [name, owner] of [["C1", "P1"], ["C2", "P2"]]) {
    if (game.actors.getName(name)) continue;
    await Actor.create({
      name, type: "character",
      ownership: { default: 0, [game.users.getName(owner).id]: 3 },
      system: { currency: { gp: 20 } }
    });
  }
  let merchant = game.actors.getName("General Store (Town)");
  if (!merchant) {
    const pack = game.packs.get("merchant-presets.merchants");
    const entry = pack.index.getName("General Store (Town)");
    merchant = await game.actors.importFromCompendium(pack, entry._id);
    await merchant.update({ "ownership.default": CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED });
  }
  return {
    query: "merchant-presets.buy" in CONFIG.queries,
    users: game.users.map(u => `${u.name}:${u.role}`),
    actors: game.actors.map(a => `${a.name} ${a.uuid} default=${a.ownership.default}`)
  };
});
show("setup", state);
await browser.close();
