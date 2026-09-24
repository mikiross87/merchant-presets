// Spike for #96: a player buys from a merchant they cannot write, through the GM's User#query.
// Throwaway — never merged. Pricing and change here are the crudest that work; #101 does it properly.

const RATES = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const DENOMS = ["pp", "gp", "ep", "sp", "cp"];

const toCp = cur => DENOMS.reduce((t, d) => t + (cur[d] ?? 0) * RATES[d], 0);

// Re-express an amount in gp/sp/cp, the coins a till would hand back.
const fromCp = cp => ({ gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), cp: cp % 10 });

// Spend `cost` from `cur`: lowest coins first, then break the smallest coin that covers the rest.
function pay(cur, cost) {
  const next = { ...cur };
  let owed = cost;
  for (const d of [...DENOMS].reverse()) {
    const use = Math.min(next[d] ?? 0, Math.floor(owed / RATES[d]));
    next[d] -= use;
    owed -= use * RATES[d];
  }
  if (owed > 0) {
    const d = [...DENOMS].reverse().find(d => (next[d] ?? 0) > 0 && RATES[d] >= owed);
    if (!d) throw new Error("Not enough coin");
    next[d] -= 1;
    const change = fromCp(RATES[d] - owed);
    for (const [k, v] of Object.entries(change)) next[k] += v;
  }
  return next;
}

const log = [];
globalThis.mpSpikeLog = log;
let chain = Promise.resolve();

async function buy({ tradeId, merchantUuid, itemId, buyerUuid, quantity = 1, delayMs = 0, serialize = true }, { user }) {
  const received = Date.now();
  const run = async () => {
    const started = Date.now();
    const merchant = await fromUuid(merchantUuid);
    const buyer = await fromUuid(buyerUuid);
    if (!merchant || !buyer) throw new Error("Unknown actor");
    if (!buyer.testUserPermission(user, "OWNER")) throw new Error(`${user.name} does not own ${buyer.name}`);
    if (!merchant.testUserPermission(user, "LIMITED")) throw new Error(`${user.name} cannot see ${merchant.name}`);
    const item = merchant.items.get(itemId);
    if (!item || item.getFlag("merchant-presets", "kind") === "gear") throw new Error("Not for sale");
    const stock = item.system.quantity;
    if (stock < quantity) throw new Error(`Only ${stock} ${item.name} left`);
    const cost = item.system.price.value * RATES[item.system.price.denomination] * quantity;
    if (toCp(buyer.system.currency) < cost) throw new Error("Not enough coin");
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));

    const buyerCur = pay(buyer.system.currency, cost);
    const till = fromCp(cost);
    const merchantCur = { ...merchant.system.currency };
    for (const [k, v] of Object.entries(till)) merchantCur[k] += v;

    // The trade's chat record doubles as its lock: a second GM tab fails here on the duplicate id.
    if (tradeId) {
      const record = await ChatMessage.create({ _id: tradeId, content: `${buyer.name} bought ${quantity} ${item.name}` }, { keepId: true })
        .catch(e => e);
      if (!(record instanceof ChatMessage)) {
        const entry = { received, started, done: Date.now(), by: user.name, duplicate: record?.message ?? String(record) };
        log.push(entry);
        return entry;
      }
    }
    const data = item.toObject();
    delete data._id;
    data.system.quantity = quantity;
    await buyer.createEmbeddedDocuments("Item", [data]);
    await buyer.update({ "system.currency": buyerCur });
    await item.update({ "system.quantity": stock - quantity });
    await merchant.update({ "system.currency": merchantCur });
    const entry = { received, started, done: Date.now(), by: user.name, item: item.name, cost, stockBefore: stock };
    log.push(entry);
    return entry;
  };
  if (!serialize) return run();
  const result = chain.then(run);
  chain = result.catch(() => {});
  return result;
}

Hooks.once("init", () => {
  CONFIG.queries["merchant-presets.buy"] = buy;
});
