/**
 * The Foundry-free half of the GM-side trade runtime (#102): the rules the
 * `CONFIG.queries` handler in merchant-presets.mjs follows around
 * `planTrade`, kept here so `tools/trade-desk.test.mjs` runs them under plain
 * Node. merchant-presets.mjs does the Foundry calls; nothing here touches a
 * global.
 *
 * Each constraint comes from the #96 spike (spike/FINDINGS.md), observed in a
 * headless GM + player run:
 * - `serial`: two buyers racing for the last item both got it until trades ran
 *   one at a time on the GM client.
 * - `claimsTrades`: `User#query` reaches every socket the GM has open, and one
 *   purchase gave the buyer two items. One tab claims trades; the others never
 *   answer (the server acks whichever answers first).
 * - `clientOutcome`: a timed-out query may still land, so it's "unconfirmed",
 *   not "failed". The shop window resends the same `tradeId`, and `outcomes`
 *   answers a repeat with the first outcome, never planning it again (#102,
 *   2026-09-25).
 */

import { COIN_METALS, coinBreakdown, rateFraction } from "./shop-view.mjs";
import { ICONS, icon } from "./icons.mjs";

/**
 * The world's own trade terms (#110): the Configure Settings default rates, stored as percentages
 * (`sellsAt` 100, `buysAt` 50: list price to buy, half to sell back), and the stock and purse
 * modes. The shop window and the GM's trade both read them through this one function, so a price
 * the window shows is the price the GM charges; a copy each would let the window bill at a rate
 * the trade then refuses as `stock-changed`, on every retry (#110, from the #130 review). A rate
 * that isn't a usable number (a hand-edited setting) reads as its default.
 *
 * @param {(key: string) => unknown} get  `key => game.settings.get("merchant-presets", key)`
 * @returns {{rates: {sellsAt: number, buysAt: number}, infiniteStock: boolean, infinitePurse: boolean}}
 */
export function worldTerms(get) {
  const rate = (key, fallback, ok) => {
    const percent = get(key);
    // Rounded to a hundredth of a percent: 57 / 100 is 0.5700000000000001.
    return typeof percent === "number" && Number.isFinite(percent) && ok(percent)
      ? Math.round(percent * 100) / 10_000 : fallback;
  };
  return {
    rates: { sellsAt: rate("sellsAt", 1, p => p > 0), buysAt: rate("buysAt", 0.5, p => p >= 0) },
    infiniteStock: get("stockMode") === "unlimited",
    infinitePurse: get("merchantPurse") === "unlimited"
  };
}

/** The `CONFIG.queries` key a trade is sent under. */
export const QUERY = "merchant-presets.trade";

/** The `CONFIG.queries` key a GM's "Restock now" (#110) is sent under, to the tab that holds the trade claim. */
export const RESTOCK_QUERY = "merchant-presets.restock";

/** The `CONFIG.queries` key a GM's *Set up shop…* (#136) is sent under, to the tab that holds the trade claim. */
export const SETUP_QUERY = "merchant-presets.setup";

/** How long a player waits for the GM before the trade reads as unconfirmed. */
export const QUERY_TIMEOUT_MS = 15_000;

/** The hook every client hears once a trade has been carried out. */
export const TRADE_HOOK = "merchant-presets.trade";

/**
 * A queue that runs one job at a time, in arrival order. A job that throws rejects its own
 * promise and the queue moves on.
 *
 * @returns {<T>(job: () => Promise<T>) => Promise<T>}
 */
export function serial() {
  let tail = Promise.resolve();
  return job => {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}

/**
 * A bounded memo of trade outcomes, keyed by the querying user and the trade's id. `once` runs
 * `job` the first time a key is seen and hands every repeat the same promise, resolved or
 * rejected, whatever the repeat's own lines say. The oldest keys are dropped past `limit`, since
 * a retry only ever follows within a query timeout or two.
 *
 * @param {number} [limit]
 */
export function outcomes(limit = 500) {
  const seen = new Map();
  return {
    once(userId, tradeId, job) {
      const key = `${userId}:${tradeId}`;
      if (seen.has(key)) return seen.get(key);
      const outcome = job();
      seen.set(key, outcome);
      outcome.catch(() => {});
      while (seen.size > limit) seen.delete(seen.keys().next().value);
      return outcome;
    }
  };
}

/** How many sealed trades a shop's record keeps, across all its customers: a resend comes within a minute or two. */
export const TRADE_RECORDS = 50;

/**
 * The first outcome of a sealed trade, from the record kept on the shop
 * (`flags.merchant-presets.trades`), or null. The in-memory `outcomes` memo dies with the tab
 * that answered; this record is written in the trade's last write, the shop's own, so a resend
 * reaching another GM tab after the claim moved (#134 review) finds it, and only once the
 * whole trade has landed.
 *
 * @param {unknown} records  the flag's value, as stored (never trusted to be well-formed)
 * @param {string} userId
 * @param {string} tradeId
 * @returns {object|null}
 */
export function recordedOutcome(records, userId, tradeId) {
  if (!Array.isArray(records)) return null;
  return records.find(r => r?.userId === userId && r?.tradeId === tradeId)?.result ?? null;
}

/**
 * `records` with `entry` added last, keeping the newest `TRADE_RECORDS`.
 *
 * @param {unknown} records
 * @param {{userId: string, tradeId: string, result: object}} entry
 * @returns {object[]}
 */
export function withRecord(records, entry) {
  return [...(Array.isArray(records) ? records : []), entry].slice(-TRADE_RECORDS);
}

/**
 * `planTrade`'s answer as `api.trade` returns it. A sealed trade carries the lines actually
 * carried out, which the window stamps its bill from, and the chat card's data as `receipt`.
 *
 * @param {{ok: boolean, plan?: object, reason?: string, line?: object, lines?: object[]}} planned
 * @returns {{status: "sealed"|"refused", reason?: string, line?: object, lines?: object[], receipt?: object}}
 */
export function resultOf(planned) {
  if (planned.ok) {
    return {
      status: "sealed",
      lines: planned.plan.hook.lines.map(({ itemId, quantity, lineTotalCp }) => ({ itemId, quantity, lineTotalCp })),
      receipt: planned.plan.chatCard
    };
  }
  const refusal = { status: "refused", ...planned };
  delete refusal.ok;
  return refusal;
}

const sourceOf = item => item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? null;

/**
 * `planTrade`'s and the window's `bundleOf`: the bundle a good states through its compendium
 * source, for a good that never carried a bundle flag of ours (starting gear, say). `quantities`
 * maps a source uuid to that source document's `system.quantity`, built by the runtime from the
 * dnd5e SRD equipment packs' indexes, so the lookup is synchronous. A bundle of 1, or a source
 * not in the map, is `undefined`: the chain's own default then applies.
 *
 * @param {Map<string, number>} quantities
 * @returns {(item: object) => number|undefined}
 */
export function bundleResolver(quantities) {
  return item => {
    const quantity = quantities.get(sourceOf(item));
    return quantity > 1 ? quantity : undefined;
  };
}

/**
 * Whether the tab `tabId` is the one that answers trades. `claim` is the tab id stored on the GM
 * user. With no claim nobody answers, and the player's query times out as unconfirmed. That's
 * better than every tab answering and handing the buyer the goods twice.
 *
 * @param {string|undefined} claim
 * @param {string} tabId
 */
export function claimsTrades(claim, tabId) {
  return claim != null && claim === tabId;
}

/** How often the claiming tab says it's still there, on the module socket. */
export const CLAIM_HEARTBEAT_MS = 10_000;

/** How long the other GM tabs wait on a silent claimer before one of them takes over. */
export const CLAIM_STALE_MS = 25_000;

/**
 * Whether tab `tabId` should claim trades now: nobody holds the claim, or another tab holds it
 * but hasn't said it's there for longer than `CLAIM_STALE_MS`. A tab that closes clears its claim
 * as it goes, but that write doesn't always land (#102's live run), and a crashed tab never
 * writes at all, so silence is what finally moves the claim. Several tabs may take it at once;
 * the last write wins and every tab then reads the same claim.
 *
 * @param {{claim: string|undefined, tabId: string, lastAliveAt: number, now: number}} state
 *   `lastAliveAt`: when this tab last heard the claimer, or took notice of its claim.
 */
export function shouldReclaim({ claim, tabId, lastAliveAt, now }) {
  if (claim == null) return true;
  return claim !== tabId && now - lastAliveAt > CLAIM_STALE_MS;
}

/**
 * What `api.trade` tells the window when the query itself didn't come back with an answer.
 *
 * @param {boolean} hasGm  Whether a GM was connected to ask. With one, the query was sent, so a
 *   timeout or a disconnect may still have landed the trade.
 */
export function clientOutcome(hasGm) {
  return hasGm ? { status: "unconfirmed" } : { status: "no-gm" };
}

/**
 * Who may trade: the request is untrusted client input, so the uuids it names are checked before
 * any planning. The shop has to be one of this module's shops, the buyer someone else, and the
 * querying user either a GM or the buyer's owner who can see the shop.
 *
 * @param {{user: {id: string, isGM: boolean}, shop: object|null, buyer: object|null}} parties
 *   `shop` and `buyer` are actors (anything with `flags`, `id` and `testUserPermission`).
 * @returns {null|"not-found"|"invalid-request"}  null when the trade may go ahead.
 */
export function checkParties({ user, shop, buyer }) {
  if (!shop || !buyer) return "not-found";
  // A compendium's actors are read-only to a trade: a locked pack would refuse the shop's half
  // after the buyer's had already been written.
  if (shop.pack || buyer.pack) return "invalid-request";
  if (!shop.flags?.["merchant-presets"]?.shop) return "invalid-request";
  if (shop === buyer || (shop.uuid && shop.uuid === buyer.uuid)) return "invalid-request";
  if (user.isGM) return null;
  if (!buyer.testUserPermission(user, "OWNER")) return "invalid-request";
  if (!shop.testUserPermission(user, "LIMITED")) return "invalid-request";
  return null;
}

/**
 * Who sees a trade's chat message, by the `tradeChat` setting: `null` posts nothing, an empty
 * list is public, otherwise a whisper to those ids.
 *
 * @param {"off"|"gm"|"public"|string} mode
 * @param {string[]} gmIds
 * @returns {string[]|null}
 */
export function recipients(mode, gmIds) {
  if (mode === "off") return null;
  if (mode === "gm") return [...gmIds];
  return [];
}

const escape = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

/** `amountCp` in the fewest everyday coins, "1 gp 5 sp"; nothing at all reads as "free". */
function coins(amountCp, currencies) {
  const parts = coinBreakdown(amountCp, currencies);
  return parts.length ? parts.map(c => `${c.count} ${c.abbreviation}`).join(" ") : "free";
}

/**
 * Where a receipt's icon goes: an empty slot, since Foundry strips <svg> from a message's content
 * when it's saved. `receiptIcons` draws the icon in when the message renders.
 */
const iconSlot = (name, pen) => `<span class="mp-icon-slot" data-icon="${name}" data-pen="${escape(pen)}"></span>`;

/**
 * A receipt's HTML with its icon slots drawn in (the `renderChatMessageHTML` hook's work): each
 * slot becomes the Lucide icon it names, keeping its layer name. A slot naming no icon stays.
 *
 * @param {string} html
 * @returns {string}
 */
export function receiptIcons(html) {
  return html.replace(/<span class="mp-icon-slot" data-icon="([a-z0-9-]+)" data-pen="([^"]*)"><\/span>/g,
    (slot, name, pen) => (ICONS[name] ? icon(name, { "data-pen": pen.replace(/&amp;/g, "&") }) : slot));
}

/** `amountCp` as the window draws coins (templates/shop-sheet.hbs "mpCoins"): each a count and its coin, named "gold 15". */
function coinsHtml(amountCp, currencies, free) {
  const parts = coinBreakdown(amountCp, currencies);
  if (!parts.length) return `<span class="mp-coin" data-pen="Free"><b class="is-free" data-pen="Amount">${escape(free)}</b></span>`;
  return parts.map(c => `<span class="mp-coin coin-${c.denomination}" data-pen="${COIN_METALS[c.denomination] ?? c.denomination} ${c.count}">`
    + `<b data-pen="Amount">${c.count}</b><img data-pen="Coin" src="${escape(c.icon)}" alt="${escape(c.abbreviation)}" /></span>`).join("");
}

/**
 * The one chat message a trade posts (design z5RBkd): the shop speaking, when in the world and who
 * sees it, then what changed hands, the total and a word on the coins. `planTrade`'s `chatCard`,
 * as HTML; the meal, animal and spellcasting messages still post beside it on their own. Foundry's
 * own message header is hidden for it (styles/shop.css): the receipt draws its own speaker.
 *
 * @param {object} card  `plan.chatCard`
 * @param {object} currencies  `CONFIG.DND5E.currencies`
 * @param {{t: (key: string, data?: object) => string, when: string, whispered: boolean}} options
 *   `t` localizes a key under `MERCHANT_PRESETS.Shop`; `when` is the trade's world date and part of
 *   day; `whispered`, whether only the GM sees it.
 */
export function receiptHtml(card, currencies, { t, when, whispered }) {
  const lines = card.lines.map(l => {
    const name = escape(l.label);
    return `<div class="mp-receipt-line" data-pen="Line ${name}">`
      + `<img class="mp-receipt-art" data-pen="${name} img" src="${escape(l.icon ?? "")}" alt="" />`
      + `<span class="mp-receipt-good" data-pen="${name} text">${l.quantity} × ${name}</span>`
      + `<span class="mp-receipt-coins" data-pen="${name} coins">${coinsHtml(l.lineTotalCp, currencies, t("Receipt.Free"))}</span></div>`;
  }).join("");
  const foot = card.kind === "buy"
    ? (card.footnote?.changeCp > 0 ? t("Receipt.Change", { name: card.buyerName, change: coins(card.footnote.changeCp, currencies) })
      : t("Receipt.Exact", { name: card.buyerName }))
    : [card.rate != null && t("Receipt.AtRate", { fraction: rateFraction(card.rate) }),
      card.tillCp != null && t("Receipt.Till", { coins: coins(card.tillCp, currencies) })].filter(Boolean).join(" ");
  return `<div class="merchant-presets mp-receipt">`
    + `<div class="mp-receipt-speaker" data-pen="Speaker">`
    + `<img class="mp-receipt-portrait" data-pen="Speaker img" src="${escape(card.shopImg ?? "")}" alt="" />`
    + `<span class="mp-receipt-who" data-pen="Speaker text"><b data-pen="Speaker name">${escape(card.shopName)}</b>`
    // No time where shops don't follow the world clock (#149): `when` is empty.
    + (when ? `<span data-pen="Speaker time">${escape(when)}</span>` : "") + `</span>`
    + `<span class="mp-receipt-vis" data-pen="Visibility">${whispered ? iconSlot("eye-off", "Vis icon") : iconSlot("globe", "Vis icon")}`
    + `<span data-pen="Vis text">${escape(t(whispered ? "Receipt.GmOnly" : "Receipt.Public"))}</span></span></div>`
    + `<div class="mp-receipt-head" data-pen="Card header">${card.kind === "buy" ? iconSlot("shopping-bag", "Kicker icon") : iconSlot("hand-coins", "Kicker icon")}`
    + `<b data-pen="Kicker">${escape(t(card.kind === "buy" ? "Receipt.Bought" : "Receipt.Sold", { name: card.buyerName }))}</b></div>`
    + `<div class="mp-receipt-lines" data-pen="Lines">${lines}</div>`
    + `<hr class="mp-receipt-rule" data-pen="Rule" />`
    + `<div class="mp-receipt-total" data-pen="Total"><b data-pen="Total label">${escape(t(card.kind === "buy" ? "Receipt.Paid" : "Receipt.Received"))}</b>`
    + `<span class="mp-receipt-coins" data-pen="Total coins">${coinsHtml(card.totalCp, currencies, t("Receipt.Free"))}</span></div>`
    + (foot ? `<p class="mp-receipt-foot" data-pen="Foot">${escape(foot)}</p>` : "")
    + `</div>`;
}

/**
 * The payload of `Hooks.callAll("merchant-presets.trade", trade, {carriedOut})`, fired on every
 * client after a trade lands. Plain data, so it crosses the socket unchanged.
 *
 * - `tradeId`, `kind` ("buy": the shop sold to the character; "sell": the character sold to the shop)
 * - `shopUuid`, `buyerUuid`: the shop, and the character trading with it, either way round
 * - `userId`: the user who asked for the trade
 * - `lines`: `{itemId, item, quantity, bundlePriceCp, lineTotalCp, category, layer}`, `item` being
 *   the traded item's data as it stood before the trade (on the shop for a buy, the character for a sale)
 * - `totalCp`, `changeCp`
 *
 * The second argument's `carriedOut` is true only on the GM tab that made the writes: the one
 * place for a listener that creates documents to run, exactly once.
 *
 * @param {object} plan  `planTrade`'s plan
 * @param {{shopUuid: string, buyerUuid: string, userId: string}} parties
 */
export function hookPayload(plan, { shopUuid, buyerUuid, userId }) {
  const { tradeId, kind, lines, totalCp, changeCp } = plan.hook;
  return { tradeId, kind, shopUuid, buyerUuid, userId, lines, totalCp, changeCp };
}
