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

import { coinBreakdown } from "./shop-view.mjs";

/**
 * World default rates: list price to buy, half to sell back (#110 hasn't shipped the Configure
 * Settings entry yet). Every shipped preset's own terms start from these. The shop window and the
 * GM's trade both read this one object, so a price the window shows is the price the GM charges.
 */
export const WORLD_RATES = Object.freeze({ sellsAt: 1, buysAt: 0.5 });

/** The `CONFIG.queries` key a trade is sent under. */
export const QUERY = "merchant-presets.trade";

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
 * The one chat message a trade posts: `planTrade`'s `chatCard`, as HTML. The meal, animal and
 * spellcasting messages still post beside it on their own.
 *
 * @param {object} card  `plan.chatCard`
 * @param {object} currencies  `CONFIG.DND5E.currencies`
 */
export function receiptHtml(card, currencies) {
  const verb = card.kind === "buy" ? "bought from" : "sold to";
  const rows = card.lines.map(l => `<li>${l.quantity > 1 ? `${l.quantity} × ` : ""}${escape(l.label)}`
    + ` <span class="mp-receipt-price">${coins(l.lineTotalCp, currencies)}</span></li>`).join("");
  const change = card.footnote?.changeCp > 0 ? `<p class="mp-receipt-change">Change given: ${coins(card.footnote.changeCp, currencies)}</p>` : "";
  return `<div class="merchant-presets mp-receipt">`
    + `<p><strong>${escape(card.buyerName)}</strong> ${verb} <strong>${escape(card.shopName)}</strong>:</p>`
    + `<ul>${rows}</ul>`
    + `<p class="mp-receipt-total">${escape(card.direction)}: <strong>${coins(card.totalCp, currencies)}</strong></p>`
    + change
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
