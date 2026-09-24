/**
 * Just enough of Foundry, dnd5e and Item Piles to load the real runtime under
 * plain Node and drive it through its hooks. Not a test file itself.
 *
 * Only what merchant-presets.mjs touches on import, at `ready`, and on the way
 * through `rewire` is modelled; settings default to the module's own defaults
 * with trading hours, restocking and stock weight off so those passes stay out
 * of the way.
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
  async setFlag(scope, key, value) { set(this, `flags.${scope}.${key}`, value); }
});

/**
 * Install the globals and return the world they describe.
 * @returns {{hooks, actors, tables, compendium, calls, settings, merchant, fire}}
 */
export function createWorld() {
  const hooks = { once: new Map(), on: new Map() };
  const actors = [];
  const tables = [];
  const folders = [];
  const compendium = new Map();
  const calls = { itemUpdates: [], tablesCreated: 0, messages: [] };
  // This module's settings by key; another module's as "<module>.<key>".
  const settings = {
    stockMode: "finite", merchantPurse: "finite", autoRestock: false, tradingHours: false,
    ignoreStockWeight: false, drinksHydrate: true, mealsFeed: true, activityFeeds: true, animalsSpawn: true,
    spellcastingToChat: true, "item-piles.outputToChat": 1
  };

  globalThis.Hooks = {
    once: (name, fn) => hooks.once.set(name, fn),
    on: (name, fn) => hooks.on.set(name, [...(hooks.on.get(name) ?? []), fn])
  };
  globalThis.foundry = {
    utils: {
      getProperty: get, setProperty: set,
      isEmpty: o => !o || !Object.keys(o).length,
      deepClone: o => structuredClone(o),
      fromUuid: async uuid => compendium.get(uuid) ?? tables.find(t => t.uuid === uuid)
        ?? actors.find(a => a.uuid === uuid) ?? null
    }
  };
  globalThis.ChatMessage = {
    create: async data => { calls.messages.push(data); return data; },
    getSpeaker: ({ actor } = {}) => ({ actor: actor?.id, alias: actor?.name })
  };
  globalThis.fromUuid = globalThis.foundry.utils.fromUuid;
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.CONFIG = {};
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

  const user = { id: "gm", isGM: true };
  globalThis.game = {
    user,
    users: Object.assign([user], { activeGM: user }),
    actors,
    folders: { find: fn => folders.find(fn) },
    tables: {
      find: fn => tables.find(fn), filter: fn => tables.filter(fn),
      fromCompendium: src => ({
        name: src.name, flags: {},
        results: src.results.map(r => ({ documentUuid: r.documentUuid, name: r.name }))
      })
    },
    settings: { register() {}, get: (scope, key) => settings[scope === "merchant-presets" ? key : `${scope}.${key}`] },
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
    return flagged(Object.assign(doc, {
      id: doc._id, uuid: `Actor.${doc._id}`, pack: null, effects: [],
      items: doc.items.map(i => ({ ...i, id: i._id })),
      async update(changes) { for (const [k, v] of Object.entries(changes)) set(this, k, v); },
      async updateEmbeddedDocuments(_type, updates) { calls.itemUpdates.push({ actor: this.id, updates }); },
      async deleteEmbeddedDocuments() {}
    }));
  }

  /** Call every listener on a hook, then let the promises they start settle. */
  async function fire(name, ...args) {
    for (const fn of hooks.on.get(name) ?? []) fn(...args);
    await new Promise(resolve => setImmediate(resolve));
  }

  return { hooks, actors, tables, compendium, calls, settings, merchant, fire };
}

/** Load the runtime into the world `createWorld` installed, and run init and ready. */
export async function loadRuntime(world) {
  const log = console.log;
  console.log = (...args) => { if (!String(args[0]).startsWith("merchant-presets |")) log(...args); };
  await import("../scripts/merchant-presets.mjs");
  world.hooks.once.get("init")?.();
  world.hooks.once.get("ready")?.();
  await new Promise(resolve => setImmediate(resolve));
}
