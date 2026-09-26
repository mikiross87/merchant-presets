/**
 * Just enough of Foundry, dnd5e and Item Piles to load the real runtime under
 * plain Node and drive it through its hooks. Not a test file itself.
 *
 * Only what merchant-presets.mjs touches on import, at `ready`, and on the way
 * through `rewire` and `migrateShop` (#100) is modelled; settings default to
 * the module's own defaults with trading hours, restocking and stock weight
 * off so those passes stay out of the way. `game.scenes` starts empty — no
 * test here places a token — so `migrateShop`'s per-scene token pass always
 * finds nothing to do.
 */
import { readdirSync, readFileSync } from "node:fs";

const get = (o, path) => path.split(".").reduce((a, k) => a?.[k], o);
function set(o, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  let at = o;
  for (const k of keys) at = at[k] ??= {};
  at[last] = value;
}

/** A shipped document from _source, as the compendium serves it. */
export function source(sub, prefix) {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  const file = readdirSync(dir).find(f => f.startsWith(prefix));
  return JSON.parse(readFileSync(new URL(file, dir), "utf8"));
}

let nextId = 1;
const newId = prefix => `${prefix}${String(nextId++).padStart(15, "0")}`;

/** A document's flag accessors, over its plain `flags`. */
const flagged = doc => Object.assign(doc, {
  getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
  async setFlag(scope, key, value) { set(this, `flags.${scope}.${key}`, value); },
  async unsetFlag(scope, key) { delete this.flags?.[scope]?.[key]; }
});

/** `doc`'s own data, the way `Document#toObject()` strips a document back to
 *  plain data — everything but its methods. */
function plainData(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (typeof v !== "function") out[k] = structuredClone(v);
  return out;
}

/**
 * Install the globals and return the world they describe.
 * @returns {{hooks, actors, tables, scenes, compendium, calls, settings, merchant, character, receive, fire, failSetting}}
 */
export function createWorld() {
  const hooks = { once: new Map(), on: new Map() };
  const actors = [];
  const tables = [];
  const folders = [];
  const scenes = [];
  const compendium = new Map();
  // `writes` is every settings.set and actor#update call, in the order they
  // actually happened — the only way to test a write-ordering guarantee
  // (#100 review: the autoRestock write must land before the actor's own).
  const calls = { itemUpdates: [], tablesCreated: 0, messages: [], writes: [], socket: [] };
  // This module's settings by key; another module's as "<module>.<key>".
  const settings = {
    stockMode: "finite", merchantPurse: "finite", autoRestock: false, tradingHours: false,
    ignoreStockWeight: false, drinksHydrate: true, mealsFeed: true, activityFeeds: true, animalsSpawn: true,
    spellcastingToChat: true, tradeChat: "public", "item-piles.outputToChat": 1
  };
  // No world ever has a stored value in the stub: every setting is at its default.
  const storage = { get: () => ({ find: () => undefined }) };
  // Keys a test has asked settings.set to fail for, once — see `failSetting`.
  const failingSettings = new Set();

  globalThis.Hooks = {
    once: (name, fn) => hooks.once.set(name, fn),
    on: (name, fn) => hooks.on.set(name, [...(hooks.on.get(name) ?? []), fn]),
    callAll: (name, ...args) => { for (const fn of hooks.on.get(name) ?? []) fn(...args); return true; }
  };
  globalThis.foundry = {
    utils: {
      getProperty: get, setProperty: set,
      isEmpty: o => !o || !Object.keys(o).length,
      deepClone: o => structuredClone(o),
      randomID: () => newId("r"),
      fromUuid: async uuid => compendium.get(uuid) ?? tables.find(t => t.uuid === uuid)
        ?? actors.find(a => a.uuid === uuid) ?? null
    }
  };
  globalThis.ChatMessage = {
    create: async data => { calls.messages.push(data); return data; },
    getSpeaker: ({ actor } = {}) => ({ actor: actor?.id, alias: actor?.name })
  };
  globalThis.fromUuid = globalThis.foundry.utils.fromUuid;
  // The real _replace forces mergeObject to overwrite a nested object wholesale
  // instead of merging into it; `set` below already overwrites a leaf value
  // outright with no merge step to force past, so unwrapping is a no-op here.
  globalThis._replace = v => v;
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.CONFIG = { DND5E: { currencies: {
    pp: { conversion: 0.1, abbreviation: "pp" }, gp: { conversion: 1, abbreviation: "gp" },
    ep: { conversion: 2, abbreviation: "ep" }, sp: { conversion: 10, abbreviation: "sp" }, cp: { conversion: 100, abbreviation: "cp" }
  } } };
  globalThis.CONST = {};
  globalThis.Roll = class { async evaluate() { return { total: 1 }; } };
  globalThis.Folder = { implementation: { create: async data => {
    const folder = { ...data, id: newId("F") };
    folders.push(folder);
    return folder;
  } } };
  globalThis.RollTable = { implementation: { create: async data => {
    const id = newId("T");
    const table = flagged({ ...structuredClone(data), id, uuid: `RollTable.${id}`,
      folder: folders.find(f => f.id === data.folder) });
    table.results = table.results.map(r => ({ ...r, id: newId("R") }));
    tables.push(table);
    calls.tablesCreated++;
    return table;
  } } };

  // The GM's `query` answers the way Foundry's server does for a single tab:
  // it runs this client's own handler with the querying user in the context.
  const user = flagged({ id: "gm", isGM: true, flags: {}, hasPermission: () => true,
    async query(name, data) { return globalThis.CONFIG.queries[name](data, { user: globalThis.game.user }); } });
  const socketHandlers = new Map();
  globalThis.game = {
    user,
    users: Object.assign([user], { activeGM: user }),
    socket: {
      on: (name, fn) => socketHandlers.set(name, fn),
      emit: (name, message) => calls.socket.push({ name, message })
    },
    packs: [],
    actors,
    scenes,
    folders: { find: fn => folders.find(fn) },
    tables: {
      find: fn => tables.find(fn), filter: fn => tables.filter(fn),
      fromCompendium: src => ({
        name: src.name, flags: {},
        results: src.results.map(r => ({ documentUuid: r.documentUuid, name: r.name }))
      })
    },
    settings: {
      register() {},
      get: (scope, key) => settings[scope === "merchant-presets" ? key : `${scope}.${key}`],
      async set(scope, key, value) {
        const full = scope === "merchant-presets" ? key : `${scope}.${key}`;
        if (failingSettings.delete(full)) throw new Error(`stub: ${full} write failed`);
        settings[full] = value;
        calls.writes.push({ type: "setting", key: full, value });
      },
      storage
    },
    modules: new Map([["merchant-presets", { version: "1.3.0" }], ["item-piles", { active: true }]]),
    itempiles: { API: {
      ITEM_QUANTITY_ATTRIBUTE: "system.quantity",
      isItemPileMerchant: actor => actor?.flags?.["item-piles"]?.data?.type === "merchant"
    } },
    time: { worldTime: 0, calendar: { name: "stub", days: { minutesPerHour: 60 } } }
  };

  /**
   * One of our merchants as it sits in the world, built from its shipped
   * source. `table` is where its populate table points: the compendium's
   * (dragged in, or replaced in place) or a world copy (already wired).
   */
  function merchant(prefix, { table } = {}) {
    const doc = source("merchants", prefix);
    const stock = source("stock", prefix);
    const tableUuid = `Compendium.merchant-presets.stock.RollTable.${stock._id}`;
    if (!compendium.has(tableUuid)) {
      compendium.set(tableUuid, { uuid: tableUuid, name: stock.name,
        results: stock.results.map(r => ({ ...r, id: r._id })) });
    }
    if (table) doc.flags["item-piles"].data.tablesForPopulate[0].uuid = table;
    return actorLike(flagged(Object.assign(doc, {
      id: doc._id, uuid: `Actor.${doc._id}`, pack: null, effects: [],
      items: doc.items.map(i => ({ ...i, id: i._id }))
    })));
  }

  /**
   * The Actor methods the runtime calls, over plain data. `updateEmbeddedDocuments`
   * both records the call (wiring/strays tests count them) and applies it (the
   * trade tests read the result back); a create keeps a given `_id`, as
   * `keepId` does.
   */
  function actorLike(doc, { owners = [] } = {}) {
    return Object.assign(doc, {
      documentName: "Actor",
      testUserPermission: (u, level) => u.isGM || owners.includes(u.id) || (level === "LIMITED" && doc.ownership?.default >= 1),
      async update(changes) {
        for (const [k, v] of Object.entries(changes)) set(this, k, v);
        calls.writes.push({ type: "actorUpdate", actor: this.id, changes });
      },
      async updateEmbeddedDocuments(_type, updates) {
        calls.itemUpdates.push({ actor: this.id, updates });
        for (const { _id, ...changes } of updates) {
          const item = this.items.find(i => i._id === _id);
          if (item) for (const [k, v] of Object.entries(changes)) set(item, k, v);
        }
      },
      async createEmbeddedDocuments(_type, data) {
        const created = data.map(d => { const id = d._id ?? newId("I"); return { ...structuredClone(d), _id: id, id }; });
        this.items.push(...created);
        return created;
      },
      async deleteEmbeddedDocuments(_type, ids) {
        for (const id of ids) this.items.splice(this.items.findIndex(i => i._id === id), 1);
      },
      toObject() { return plainData(this); }
    });
  }

  /** A player character, owned by `owners`, with `currency` and `items`. */
  function character(id, { currency = {}, items = [], owners = [] } = {}) {
    const doc = actorLike(flagged({ _id: id, id, uuid: `Actor.${id}`, name: id, type: "character", flags: {},
      system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, ...currency } },
      items: items.map(i => ({ ...i, id: i._id })) }), { owners });
    actors.push(doc);
    return doc;
  }

  /** Deliver a socket message the way another client would receive it. */
  const receive = (name, message) => socketHandlers.get(name)?.(message);

  /** Call every listener on a hook, then let the promises they start settle. */
  async function fire(name, ...args) {
    for (const fn of hooks.on.get(name) ?? []) fn(...args);
    await new Promise(resolve => setImmediate(resolve));
  }

  /** Make the next `game.settings.set(scope, key, …)` for this key throw,
   *  once — to test that a failed settings write stops whatever depended on
   *  it landing first, rather than being silently skipped over. */
  const failSetting = (scope, key) => failingSettings.add(scope === "merchant-presets" ? key : `${scope}.${key}`);

  return { hooks, actors, tables, scenes, compendium, calls, settings, merchant, character, receive, fire, failSetting };
}

/** Load the runtime into the world `createWorld` installed, and run init and ready. */
let runtimeLoads = 0;

export async function loadRuntime(world) {
  const log = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith("merchant-presets |")) log(...args); };
  // A fresh module instance per world: its own state (migrationGateOpen, say)
  // must not leak from one test's world into the next.
  await import(`../scripts/merchant-presets.mjs?world=${++runtimeLoads}`);
  world.hooks.once.get("init")?.();
  world.hooks.once.get("ready")?.();
  await new Promise(resolve => setImmediate(resolve));
}
