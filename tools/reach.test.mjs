/**
 * Reach (#166): a shop opens for a player only from a token within 5 ft of the shop's token. The
 * geometry, who may open a shop, and each shop's ownership when the GM switches *Shop access*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { accessModeOf, accessOwnership, actorInReach, canOpenOn, canVisit, gridOf, inReach, reachOnScene, tokenRect, tokensOf } from "../scripts/reach.mjs";

const NONE = 0, LIMITED = 1, OWNER = 3;
/** A 100 px square grid of 5 ft squares, as a V14 scene's `grid` reads. */
const SQUARE = { size: 100, distance: 5, gridless: false };
/** A token `w`×`h` squares at column `col`, row `row` of that grid. */
const at = (col, row, w = 1, h = 1) => tokenRect({ x: col * 100, y: row * 100, width: w, height: h }, SQUARE.size);

/* ------------------------------------------------------------------ geometry */

test("a token beside the shop's, or diagonal to it, is in reach", () => {
  const shop = [at(5, 5)];
  for (const [c, r] of [[4, 5], [6, 5], [5, 4], [5, 6], [4, 4], [6, 6], [4, 6], [6, 4]]) {
    assert.equal(inReach(shop, [at(c, r)], SQUARE), true, `${c},${r}`);
  }
});

test("a token with a square between it and the shop's is out of reach", () => {
  const shop = [at(5, 5)];
  for (const [c, r] of [[3, 5], [7, 5], [5, 3], [5, 7], [3, 3], [7, 4]]) {
    assert.equal(inReach(shop, [at(c, r)], SQUARE), false, `${c},${r}`);
  }
});

test("reach is measured from a large token's edge, not its centre", () => {
  // A 2×2 stall at (5,5)-(6,6): (7,6) touches its right edge, (8,6) doesn't.
  assert.equal(inReach([at(5, 5, 2, 2)], [at(7, 6)], SQUARE), true);
  assert.equal(inReach([at(5, 5, 2, 2)], [at(8, 6)], SQUARE), false);
  // A large buyer the same way.
  assert.equal(inReach([at(5, 5)], [at(6, 6, 2, 2)], SQUARE), true);
});

test("any of the shop's tokens, and any of the buyer's, will do", () => {
  assert.equal(inReach([at(0, 0), at(10, 10)], [at(20, 20), at(11, 10)], SQUARE), true);
  assert.equal(inReach([at(0, 0), at(10, 10)], [at(20, 20)], SQUARE), false);
  assert.equal(inReach([], [at(0, 0)], SQUARE), false);
  assert.equal(inReach([at(0, 0)], [], SQUARE), false);
});

test("reach follows the scene's own grid: 5 ft is one square of 5 ft, half a square of 10 ft", () => {
  const tenFoot = { size: 100, distance: 10, gridless: false };
  assert.equal(inReach([at(5, 5)], [at(6, 5)], tenFoot), true);
  // One 10 ft square between: 10 ft of gap.
  assert.equal(inReach([at(5, 5)], [at(7, 5)], tenFoot), false);
});

test("on a gridless scene the gap between the tokens is measured as the crow flies", () => {
  const gridless = { size: 100, distance: 5, gridless: true };
  const rect = (x, y) => ({ x, y, width: 100, height: 100 });
  // 90 px apart on each axis: 127 px, 6.4 ft, as the crow flies; each axis alone is 4.5 ft.
  assert.equal(inReach([rect(0, 0)], [rect(190, 190)], gridless), false);
  assert.equal(inReach([rect(0, 0)], [rect(190, 100)], gridless), true);
});

test("a token rect is the token's footprint in scene pixels", () => {
  assert.deepEqual(tokenRect({ x: 300, y: 400, width: 2, height: 1 }, 100), { x: 300, y: 400, width: 200, height: 100 });
});

/* ------------------------------------------------------------------ scenes */

/** A token document at column `col`, row `row` of a 100 px grid, as V14 stores it. */
const token = (id, actorId, col, row, over = {}) => ({ id, actorId, actorLink: true, x: col * 100, y: row * 100, width: 1, height: 1, hidden: false, ...over });
const scene = (id, tokens, grid = { size: 100, distance: 5, type: 1 }) => ({ id, grid, tokens });
const SHOP = { id: "shop", isToken: false }, ARIA = { id: "aria", isToken: false };

test("an actor's tokens are those linked to it; an unlinked token's actor is that token alone", () => {
  const market = scene("s1", [token("t1", "shop", 5, 5), token("t2", "shop", 9, 9, { actorLink: false }), token("t3", "aria", 6, 5)]);
  assert.deepEqual(tokensOf(market, SHOP).map(t => t.id), ["t1"]);
  assert.deepEqual(tokensOf(market, { id: "shop", isToken: true, token: { id: "t2" } }).map(t => t.id), ["t2"]);
  assert.deepEqual(tokensOf(market, ARIA).map(t => t.id), ["t3"]);
});

test("a scene's grid: its square in pixels and in feet, and whether it's gridless", () => {
  assert.deepEqual(gridOf(scene("s", [], { size: 140, distance: 5, type: 1 })), { size: 140, distance: 5, gridless: false });
  assert.deepEqual(gridOf(scene("s", [], { size: 100, distance: 5, type: 0 })), { size: 100, distance: 5, gridless: true });
});

test("the GM finds a buyer in reach on whichever scene they share with the shop", () => {
  const market = scene("s1", [token("t1", "shop", 5, 5)]);
  const road = scene("s2", [token("t2", "aria", 5, 6)]);
  // Beside the shop's square on another scene is not at the counter.
  assert.equal(actorInReach([market, road], SHOP, ARIA), false);
  const together = scene("s3", [token("t3", "shop", 5, 5), token("t4", "aria", 6, 6)]);
  assert.equal(actorInReach([market, road, together], SHOP, ARIA), true);
});

test("a shop token the GM hid is no counter to stand at", () => {
  const market = scene("s1", [token("t1", "shop", 5, 5, { hidden: true }), token("t2", "aria", 6, 5)]);
  assert.equal(reachOnScene(market, SHOP, tokensOf(market, ARIA)), false);
});

/* ------------------------------------------------------------------ who may open it */

const player = (over = {}) => ({ isGM: false, mode: "reach", switchedOff: false, ownLevel: NONE, defaultLevel: NONE, reach: false, ...over });

test("in reach mode a player opens a shop only from a token in reach", () => {
  assert.equal(canVisit(player({ reach: true })), true);
  assert.equal(canVisit(player({ reach: false })), false);
});

test("a shop the GM switched off opens for no player, in reach or not", () => {
  assert.equal(canVisit(player({ reach: true, switchedOff: true })), false);
  assert.equal(canVisit(player({ mode: "anywhere", switchedOff: true })), false);
});

test("a GM opens any shop from anywhere", () => {
  assert.equal(canVisit(player({ isGM: true, switchedOff: true })), true);
});

test("a player the GM gave a level of their own opens the shop from anywhere", () => {
  assert.equal(canVisit(player({ ownLevel: LIMITED })), true);
  assert.equal(canVisit(player({ ownLevel: OWNER, switchedOff: true })), true);
});

test("a default the GM set by hand opens the shop to every player from anywhere", () => {
  assert.equal(canVisit(player({ defaultLevel: LIMITED })), true);
});

test("in anywhere mode a player opens a visitable shop from anywhere, and a hidden one not at all", () => {
  assert.equal(canVisit(player({ mode: "anywhere", defaultLevel: LIMITED })), true);
  assert.equal(canVisit(player({ mode: "anywhere", defaultLevel: NONE, reach: true })), false);
});

test("a player opens a shop from the scene they view when a token of theirs stands at it", () => {
  const P1 = { id: "p1", isGM: false };
  const owned = (id, owners) => ({ id, testUserPermission: (user, level) => level === "OWNER" && owners.includes(user.id) });
  const shop = { id: "shop", isToken: false, ownership: { default: NONE }, flags: { "merchant-presets": { shop: { version: 1 } } } };
  const aria = owned("aria", ["p1"]), tomas = owned("tomas", ["p2"]);
  const tok = (id, actor, col, row) => ({ ...token(id, actor.id, col, row), actor });
  const beside = scene("s1", [tok("t1", shop, 5, 5), tok("t2", aria, 6, 5)]);
  assert.equal(canOpenOn(beside, shop, P1, "reach"), true);
  // Someone else's token at the counter doesn't let p1 in.
  const theirs = scene("s1", [tok("t1", shop, 5, 5), tok("t3", tomas, 6, 5), tok("t2", aria, 9, 9)]);
  assert.equal(canOpenOn(theirs, shop, P1, "reach"), false);
  // No scene on the canvas: nobody's at any counter.
  assert.equal(canOpenOn(null, shop, P1, "reach"), false);
  // From anywhere, a hidden shop stays shut however close p1 stands; a visitable one opens.
  assert.equal(canOpenOn(beside, shop, P1, "anywhere"), false);
  assert.equal(canOpenOn(null, { ...shop, ownership: { default: LIMITED } }, P1, "anywhere"), true);
  assert.equal(canOpenOn(null, shop, { id: "gm", isGM: true }, "reach"), true);
});

test("only a token that could buy lets a player in: an unlinked one of theirs doesn't, as Buying as and the GM don't count it (#167 review)", () => {
  const P1 = { id: "p1", isGM: false };
  const shop = { id: "shop", isToken: false, ownership: { default: NONE }, flags: { "merchant-presets": { shop: { version: 1 } } } };
  const hireling = { id: "hireling", testUserPermission: (user, level) => level === "OWNER" && user.id === "p1" };
  const market = scene("s1", [{ ...token("t1", "shop", 5, 5), actor: shop }, { ...token("t2", "hireling", 6, 5, { actorLink: false }), actor: hireling }]);
  assert.equal(canOpenOn(market, shop, P1, "reach"), false);
});

test("a stored Shop access reads as reach unless it says anywhere", () => {
  assert.equal(accessModeOf("anywhere"), "anywhere");
  for (const v of ["reach", undefined, null, "", "nonsense"]) assert.equal(accessModeOf(v), "reach");
});

/* ------------------------------------------------------------------ switching Shop access */

const WORLD = "world-a";
const shopActor = (over = {}) => ({
  ownership: { default: NONE, gm0000000000001: OWNER, ...over.ownership },
  flags: { "merchant-presets": { shop: { version: 1 }, ...over.flags } }
});
const isPlayer = id => id.startsWith("p");

test("switching to reach hides a shop placing its token made visitable, and forgets that it did", () => {
  const actor = shopActor({ ownership: { default: LIMITED }, flags: { madeVisitable: WORLD } });
  assert.deepEqual(accessOwnership(actor, { mode: "reach", hasTokenOnScene: true, worldId: WORLD, isPlayer }),
    { "ownership.default": NONE, "flags.merchant-presets.madeVisitable": null });
});

test("switching to reach keeps the GM's Players can visit but takes the default back to None", () => {
  const actor = shopActor({ ownership: { default: LIMITED }, flags: { visibility: true } });
  assert.deepEqual(accessOwnership(actor, { mode: "reach", hasTokenOnScene: true, worldId: WORLD, isPlayer }), { "ownership.default": NONE });
});

test("switching to reach leaves a default the GM set by hand, and a hidden shop, alone", () => {
  const byHand = shopActor({ ownership: { default: LIMITED } });
  assert.equal(accessOwnership(byHand, { mode: "reach", hasTokenOnScene: true, worldId: WORLD, isPlayer }), null);
  assert.equal(accessOwnership(shopActor(), { mode: "reach", hasTokenOnScene: true, worldId: WORLD, isPlayer }), null);
});

test("switching to anywhere makes a placed shop visitable, as placing its token did (#104)", () => {
  assert.deepEqual(accessOwnership(shopActor(), { mode: "anywhere", hasTokenOnScene: true, worldId: WORLD, isPlayer }),
    { "ownership.default": LIMITED, "flags.merchant-presets.madeVisitable": WORLD });
  assert.equal(accessOwnership(shopActor(), { mode: "anywhere", hasTokenOnScene: false, worldId: WORLD, isPlayer }), null);
});

test("switching to anywhere opens a shop the GM said players can visit, and keeps one switched off hidden", () => {
  const on = shopActor({ flags: { visibility: true } });
  assert.deepEqual(accessOwnership(on, { mode: "anywhere", hasTokenOnScene: false, worldId: WORLD, isPlayer }), { "ownership.default": LIMITED });
  const off = shopActor({ flags: { visibility: false } });
  assert.equal(accessOwnership(off, { mode: "anywhere", hasTokenOnScene: true, worldId: WORLD, isPlayer }), null);
});

test("switching to anywhere leaves a shop the GM opened to one player alone", () => {
  const one = shopActor({ ownership: { p0000000000000001: LIMITED } });
  assert.equal(accessOwnership(one, { mode: "anywhere", hasTokenOnScene: true, worldId: WORLD, isPlayer }), null);
});
