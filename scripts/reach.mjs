import { isMadeVisitable, planOwnership } from "./migrate.mjs";

/**
 * Reach (#166): a player opens a shop only from a token within 5 ft of one of the shop's tokens,
 * kept free of Foundry so it can be tested with plain Node (tools/reach.test.mjs).
 *
 * In reach mode (the world's *Shop access* setting, `shopAccess`) a shop stays at ownership None:
 * players never see it in their Actors sidebar, and moving a token never writes to it. The
 * runtime's double-click wrapper opens it when `canVisit` says so; the shop window refuses to
 * render otherwise; and the GM's trade re-checks it (trade-desk.mjs `checkParties`). *From
 * anywhere* is #104's rule: placing a shop's token makes it Limited for every player.
 */

const NONE = 0, LIMITED = 1;   // CONST.DOCUMENT_OWNERSHIP_LEVELS

/** How close a buyer's token has to stand to a shop's, in the scene's own units (feet). */
export const REACH_FT = 5;

/** The world's *Shop access* choices, by the setting's stored value. */
export const ACCESS_MODES = Object.freeze(["reach", "anywhere"]);

/** A stored *Shop access* read as a mode: anything but "anywhere" is reach, the default. */
export const accessModeOf = value => (value === "anywhere" ? "anywhere" : "reach");

/**
 * A token's footprint in scene pixels: its top-left corner and its size, which a token document
 * gives in grid squares. Read from the document's source, as core reads a token's position: while
 * a move is under way V14's getters still give where it started (seen at `updateToken`, #167 live
 * check), and reach is where the token was moved to.
 *
 * @param {{x: number, y: number, width: number, height: number, _source?: object}} token
 * @param {number} gridSize  pixels per grid square (`scene.grid.size`)
 */
export function tokenRect(token, gridSize) {
  const t = token._source ?? token;
  return { x: t.x, y: t.y, width: t.width * gridSize, height: t.height * gridSize };
}

/**
 * The gap between two footprints in the scene's units: 0 when they touch, corner to corner
 * included. On a grid it's the wider of the two axes' gaps, as squares count in 5e (a diagonal
 * neighbour is 5 ft away); gridless, it's the straight line between the nearest edges.
 */
function gap(a, b, { size, distance, gridless }) {
  const dx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const dy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  const px = gridless ? Math.hypot(dx, dy) : Math.max(dx, dy);
  return (px / size) * distance;
}

/**
 * Whether any of a buyer's tokens stands within reach of any of a shop's, on one scene: the gap
 * between their footprints is under `reachFt`. So on a 5 ft grid a token beside the shop's, or
 * diagonal to it, is in reach, and one with a square between them isn't; a large stall measures
 * from its edge.
 *
 * @param {{x: number, y: number, width: number, height: number}[]} shopRects  `tokenRect`s
 * @param {{x: number, y: number, width: number, height: number}[]} buyerRects
 * @param {{size: number, distance: number, gridless: boolean}} grid  the scene's
 * @param {number} [reachFt]
 */
export function inReach(shopRects, buyerRects, grid, reachFt = REACH_FT) {
  // A hair under: a token one square away sits exactly `reachFt` out, and stays out.
  return shopRects.some(s => buyerRects.some(b => gap(s, b, grid) < reachFt - 1e-6));
}

/**
 * A scene's grid as `inReach` reads it: pixels per square, units per square, and whether it's
 * gridless (`scene.grid.type` is `CONST.GRID_TYPES.GRIDLESS`, 0).
 *
 * @param {{grid?: {size?: number, distance?: number, type?: number}}} scene
 */
export function gridOf(scene, gridlessType = 0) {
  const grid = scene?.grid ?? {};
  return { size: grid.size ?? 100, distance: grid.distance ?? 5, gridless: grid.type === gridlessType };
}

/**
 * An actor's tokens on a scene. A world actor's are the tokens linked to it; an unlinked token's
 * actor (a synthetic one, `isToken`) is that token alone, since each unlinked token is a shop, or
 * a character, of its own.
 *
 * @param {{tokens?: Iterable<object>, id?: string}} scene
 * @param {{id: string, isToken?: boolean, token?: {id: string}}} actor
 */
export function tokensOf(scene, actor) {
  const tokens = Array.from(scene?.tokens ?? []);
  if (!actor) return [];
  if (actor.isToken) return tokens.filter(t => t.id === actor.token?.id);
  return tokens.filter(t => t.actorLink && t.actorId === actor.id);
}

/**
 * Whether any of `buyerTokens` stands in reach of the shop on `scene`. A shop token the GM hid is
 * no counter to stand at.
 *
 * @param {object} scene
 * @param {object} shop  the shop actor
 * @param {object[]} buyerTokens  token documents on `scene`
 */
export function reachOnScene(scene, shop, buyerTokens, gridlessType = 0) {
  const grid = gridOf(scene, gridlessType);
  const shopRects = tokensOf(scene, shop).filter(t => !t.hidden).map(t => tokenRect(t, grid.size));
  return inReach(shopRects, buyerTokens.map(t => tokenRect(t, grid.size)), grid);
}

/**
 * Whether `buyer` stands in reach of `shop` on any of `scenes`: the GM's check at trade time, which
 * has every scene, where a player's window has only the one they're viewing.
 *
 * @param {Iterable<object>} scenes
 */
export function actorInReach(scenes, shop, buyer, gridlessType = 0) {
  return Array.from(scenes ?? []).some(scene => reachOnScene(scene, shop, tokensOf(scene, buyer), gridlessType));
}

/**
 * Whether a user may open a shop, and trade at it.
 *
 * - A GM, always.
 * - A player the GM gave a level of their own on the shop, or a default the GM set by hand to
 *   Limited or more, from anywhere: a player-merchant, a fence opened to one rogue.
 * - Nobody else once the GM switched *Players can visit* off.
 * - In reach mode, a player with a token in reach.
 *
 * In anywhere mode the default is what #104 raised on placing a token, so "visitable" is it alone.
 *
 * @param {{isGM: boolean, mode: string, switchedOff: boolean, ownLevel: number,
 *   defaultLevel: number, reach: boolean}} access  `accessOf`, plus whether a token is in reach
 */
export function canVisit({ isGM, mode, switchedOff, ownLevel, defaultLevel, reach }) {
  if (isGM) return true;
  if (ownLevel >= LIMITED) return true;
  if (switchedOff) return false;
  if (defaultLevel >= LIMITED) return true;
  return mode === "reach" && !!reach;
}

/**
 * Everything `canVisit` needs to know of a shop and a user, but reach.
 *
 * @param {{ownership?: object, flags?: object}} shop
 * @param {{id: string, isGM: boolean}} user
 * @param {string} mode  the world's `shopAccess`
 */
export function accessOf(shop, user, mode) {
  const ownership = shop?.ownership ?? {};
  return {
    isGM: !!user?.isGM,
    mode,
    // The GM's *Players can visit*, once set (#110): false is off, and nothing else hides a shop.
    switchedOff: shop?.flags?.["merchant-presets"]?.visibility === false,
    ownLevel: ownership[user?.id] ?? NONE,
    defaultLevel: ownership.default ?? NONE
  };
}

/**
 * Whether `user` may open `shop` from `scene`, the one their canvas shows: the double-click, the
 * shop window's own check and its "Buying as" all ask this. Reach counts any token on the scene
 * whose actor the user owns.
 *
 * @param {object|null} scene  `canvas.scene`
 * @param {object} shop  the shop actor
 * @param {{id: string, isGM: boolean}} user
 * @param {string} mode  the world's `shopAccess`
 */
export function canOpenOn(scene, shop, user, mode, gridlessType = 0) {
  const access = accessOf(shop, user, mode);
  // Only reach mode, and only a player not already let in, needs the tokens looked at.
  const reach = mode === "reach" && !canVisit({ ...access, reach: false }) && !!scene
    && reachOnScene(scene, shop, ownedTokens(scene, user, shop), gridlessType);
  return canVisit({ ...access, reach });
}

/**
 * The tokens on `scene` that could buy for `user`: linked to a world actor they own, the shop's
 * own aside. The same tokens "Buying as" lists (a world actor's, `tokensOf`) and the GM's trade
 * counts, so no one opens a window there's nobody at the counter to buy from (#167 review).
 */
export function ownedTokens(scene, user, shop) {
  return Array.from(scene?.tokens ?? []).filter(t => t.actorLink && t.actor && t.actor !== shop && t.actor.testUserPermission(user, "OWNER"));
}

/** dnd5e's group actors: a party or an encounter, which hold no purse of their own to trade from. */
const GROUP_TYPES = new Set(["group", "encounter"]);

/**
 * Who a GM trades and makes deals as at `shop` (#200, #201): every character in the world, then
 * whoever stands on `scene`, the one the GM's canvas shows. A GM owns every actor, and a premade
 * adventure brings hundreds. A token stands for its own actor: a linked token for the world
 * actor, an unlinked one for its synthetic actor, with the token's own purse. Never a shop, nor a
 * group; each actor once, characters first.
 *
 * @param {Iterable<object>} actors  `game.actors`
 * @param {object|null} scene  `canvas.scene`, or null with no canvas
 * @param {object} shop  the shop actor
 * @returns {object[]}
 */
export function gmCandidates(actors, scene, shop) {
  const candidate = a => a && a !== shop && a.uuid !== shop?.uuid && !a.flags?.["merchant-presets"]?.shop && !GROUP_TYPES.has(a.type);
  const characters = Array.from(actors ?? []).filter(a => a.type === "character" && candidate(a));
  const seen = new Set(characters.map(a => a.uuid));
  const present = [];
  for (const token of scene?.tokens ?? []) {
    const a = token.actor;
    if (!candidate(a) || seen.has(a.uuid)) continue;
    seen.add(a.uuid);
    present.push(a);
  }
  return [...characters, ...present];
}

/**
 * The update one shop needs when the GM switches *Shop access* to `mode`, or null: its default
 * ownership, as the other mode leaves it.
 *
 * - To reach: a default this module raised (placing a token, #104, or the GM's *Players can
 *   visit*) goes back to None, and the placing's mark is forgotten, so switching back re-opens
 *   it. A default the GM set by hand stays: it opens the shop from anywhere in either mode.
 * - To anywhere: *Players can visit* on is Limited, off stays hidden, and a shop the GM never
 *   switched is #104's: Limited when a token of it stands on a scene.
 *
 * @param {object} actor  the shop actor's data
 * @param {{mode: string, hasTokenOnScene: boolean, worldId: string|null,
 *   isPlayer?: (userId: string, level: number) => boolean}} context
 * @returns {object|null}  an `Actor#update` payload
 */
export function accessOwnership(actor, { mode, hasTokenOnScene, worldId, isPlayer }) {
  const visibility = actor?.flags?.["merchant-presets"]?.visibility;
  const current = actor?.ownership?.default ?? NONE;
  if (mode === "reach") {
    if (current !== LIMITED) return null;
    if (isMadeVisitable(actor, worldId)) return { "ownership.default": NONE, "flags.merchant-presets.madeVisitable": null };
    return visibility === true ? { "ownership.default": NONE } : null;
  }
  if (visibility === true) return current >= LIMITED ? null : { "ownership.default": LIMITED };
  if (visibility === false) return null;
  const level = planOwnership(actor, hasTokenOnScene, worldId, isPlayer, "anywhere");
  if (level == null) return null;
  return level > NONE ? { "ownership.default": level, "flags.merchant-presets.madeVisitable": worldId } : { "ownership.default": level };
}
