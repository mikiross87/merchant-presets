/**
 * The shop window (#103): a merchant NPC's own actor sheet, registered per #104's decision
 * (`DocumentSheetConfig.registerSheet`, never the default — each shop opts in by setting its own
 * `flags.core.sheetClass` to `"merchant-presets.ShopSheet"`, which the #99 migration does). Core's
 * own double-click, the sidebar and the token HUD then open it with no patching.
 *
 * This class only ever *reads* Foundry data and turns it into the plain view-model
 * `scripts/shop-view.mjs` builds the pricing and formatting for; it never writes to the shop or
 * the buyer directly. A trade is carried out by calling
 * `game.modules.get("merchant-presets").api.trade(request)` — the #102 runtime in
 * merchant-presets.mjs, carried out on the GM's side — and applying whatever it reports back.
 * Before the runtime's `ready` has set the API, a seal attempt reads as `"no-gm"`, the same as no
 * GM connected (design/README.md, "Trade states").
 */

import { effectiveRates, itemPriceCp, payExact, totalCp } from "./pricing.mjs";
import { mealsFeed, NUTRITION_MODULE } from "./nutrition.mjs";
import { SHOP_DEFAULTS, STOCK_DEFAULTS, shopFrom, validateShop } from "./schema.mjs";
import { EVERY_CHOICES, WONT_BUY_KINDS, WONT_BUY_TYPES, applyChange, dealFields, dealReading, everyChoice, hoursSamples, openMinutes, percentOf, timeText, wholeCoins } from "./shop-settings.mjs";
import { worldTerms } from "./trade-desk.mjs";
import { activeDeal } from "./deals.mjs";
import { icon } from "./icons.mjs";
import { worldFollowsClock } from "./clock.mjs";
import { isOpen, nextCloseAt, nextOpen } from "./schedule.mjs";
import { bundleFor, bundlePriceCp, categoryFor, isFixedExcluded, lineTotalCp, safeShopOf, safeStockOf } from "./trade-plan.mjs";
import {
  basketTotals, buyRow, coinAriaLabel, coinBreakdown, groupCategories, isVisibleStock,
  COIN_METALS, fitQuantity, isFresh, isNewGood, daysUntil, presetSchedule, commonFormula, itemMeta, matchingStockLine, partOfDay, purseAfter, rateFraction, sealState, sellRowMeta, sellWorth, sellRow, wontBuyReason, wontBuyTerms, compactMeta, billSummary, shelfGroup, signedPercent, stepQuantity, titleParts, goodName, isNamedSpell, joinsBuyer, sealsShort,
  inspectTargets, itemTooltipHtml, currentSection
} from "./shop-view.mjs";

import { accessModeOf, accessOf, canOpenOn, canVisit, gmCandidates, reachOnScene, tokensOf } from "./reach.mjs";

const MODULE = "merchant-presets";
const TEMPLATES = `modules/${MODULE}/templates`;
/** `CONST.GRID_TYPES.GRIDLESS`, read late: reach measures gridless scenes as the crow flies (#166). */
const gridless = () => globalThis.CONST?.GRID_TYPES?.GRIDLESS ?? 0;

/**
 * The runtime's bundle resolver (#102), the same one the GM's trade prices by: a good with no
 * bundle of its own (SRD Arrows dragged onto a shelf, starting gear) reads it off its compendium
 * source. Undefined before the runtime's `ready` has run, which `bundleFor` treats as no resolver.
 */
const bundleOf = item => game.modules.get(MODULE)?.api?.bundleOf?.(item);
/** The world's rates and stock mode, read the way the GM's trade reads them (trade-desk.mjs `worldTerms`). */
const worldOf = () => worldTerms(key => game.settings.get(MODULE, key));
/** The world's stock mode: whether a line with no `stock.infinite` of its own never runs out. */
const worldInfiniteStock = () => worldOf().infiniteStock;

/*
 * Flags are read the trade engine's way (`safeShopOf`/`safeStockOf`): data some other bug or a
 * hand edit left invalid mustn't stop the window opening. A broken shop config shows the
 * defaults (the engine refuses its trades as shop-misconfigured); a broken shelf line isn't
 * listed (the engine refuses it too).
 */
const shopConfigOf = actor => safeShopOf(actor) ?? SHOP_DEFAULTS;
const stockConfigOf = item => (item ? safeStockOf(item) : null) ?? STOCK_DEFAULTS;

/**
 * Refusals that rest on live data (the hours, the purse, the till). A GM refusal for one stays on
 * the bill, since the GM can know more than the window does (whether the till can make change),
 * until that data changes: the clock moves, or the shop or the buyer updates. Then it's dropped
 * and the window's own checks decide again.
 */
const LIVE_REFUSALS = ["closed", "cant-afford", "till-short"];

/** The GM Settings tab's sections (#110), in its side nav's order, with their icons. */
const SETTINGS_SECTIONS = [
  { id: "terms", icon: "lucide:scale" },
  { id: "deals", icon: "lucide:handshake" },
  { id: "wontBuy", icon: "lucide:ban" },
  { id: "hours", icon: "lucide:hourglass" },
  { id: "restock", icon: "lucide:refresh-cw" },
  { id: "till", icon: "lucide:coins" }
];

/**
 * A bought service's note on the bill (design mRg3y): a meal feeds the buyer where meals do, and a
 * room is theirs from tonight. `note` replaces the unit price; null for anything else.
 */
function serviceNote(kind, item, stock, buyer) {
  if (kind !== "buy" || !stock?.service) return { note: null, noteIcon: null };
  const goodKind = item.flags?.[MODULE]?.kind;
  if (goodKind === "meal" && goodsWorld().feeds && buyer) {
    return { note: game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.Feeds", { name: buyer.name }), noteIcon: "lucide:utensils" };
  }
  if (goodKind === "lodging") return { note: game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.FromTonight"), noteIcon: "lucide:bed-double" };
  // A spell is cast for whoever it's bought as (design IeGac), whatever the chat is told.
  if (goodKind === "spellcasting" && buyer) return { note: game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.CastFor", { name: buyer.name }), noteIcon: "lucide:sparkles" };
  return { note: null, noteIcon: null };
}

/** A bought mount's bill line (design pI7Yd): it joins the buyer, where bought animals spawn. */
function mountNote(kind, item, buyer) {
  if (kind !== "buy" || !buyer || !goodsWorld().spawns || !joinsBuyer(item)) return null;
  return { note: game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.Joins", { name: buyer.name }), noteIcon: "lucide:paw-print" };
}

/**
 * A named spell's level and school ("Level 1 Abjuration", design IeGac), by its uuid: looked up
 * once and kept, since the row is drawn on every render. Null for a spell that can't be found.
 */
const SPELL_FACTS = new Map();
async function learnSpells(items) {
  const uuids = [...new Set(items.filter(isNamedSpell).map(i => i.flags[MODULE].spell))].filter(u => !SPELL_FACTS.has(u));
  await Promise.all(uuids.map(async uuid => {
    const spell = await Promise.resolve(fromUuid(uuid)).catch(() => null);
    const level = spell?.system?.level;
    SPELL_FACTS.set(uuid, Number.isInteger(level) ? { level, school: CONFIG.DND5E.spellSchools?.[spell.system.school]?.label ?? spell.system.school ?? "" } : null);
  }));
}
const spellFacts = item => (isNamedSpell(item) ? SPELL_FACTS.get(item.flags[MODULE].spell) ?? null : null);

/** A row's stock in words: "7 left", "Last one", "Sold out", "Always". */
function stockWords(stock) {
  const key = { count: "Left", last: "Last", soldOut: "SoldOut" }[stock?.state] ?? "Always";
  return game.i18n.localize(`MERCHANT_PRESETS.Shop.Stock.${key}`, { count: stock?.count });
}

/** "list" as a chip starts it: "List". */
const sentence = text => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

/** The meta line's words (shop-view.mjs `itemMeta`/`sellWorth`). */
const metaWords = (key, data) => game.i18n.localize(`MERCHANT_PRESETS.Shop.Meta.${key}`, data);

/**
 * What this world's goods do for a buyer (shop-view.mjs `itemMeta`): meals feed through Simple
 * Nutrition, and ale and wine hydrate where the module registers them (merchant-presets.mjs).
 */
function goodsWorld() {
  const sn = game.modules.get(NUTRITION_MODULE);
  return { feeds: mealsFeed(sn, foundry.utils.isNewerVersion), hydrates: !!sn?.active && game.settings.get(MODULE, "drinksHydrate"),
    spawns: !!game.settings.get(MODULE, "animalsSpawn") };
}

/** CONFIG.DND5E's labels a row's meta line reads (shop-view.mjs `itemMeta`). */
function metaLabels() {
  const D = CONFIG.DND5E;
  return {
    weaponTypes: D.weaponTypes, armorTypes: D.armorTypes, toolTypes: D.toolTypes, consumableTypes: D.consumableTypes,
    typeLabels: Object.fromEntries(Object.entries(CONFIG.Item.typeLabels ?? {}).map(([k, v]) => [k, game.i18n.localize(v)])),
    goodKinds: Object.fromEntries(["vehicle", "tack", "mount"].map(k => [k, game.i18n.localize(`MERCHANT_PRESETS.Shop.Meta.Kind.${k}`)])),
    properties: D.itemProperties, weaponProperties: [...(D.validProperties?.weapon ?? [])], weightUnits: D.weightUnits,
    rarities: D.itemRarity, equipmentTypes: D.miscEquipmentTypes
  };
}

/** A row's group on its tab's list (shop-view.mjs `shelfGroup`): its id, icon and heading. */
function groupFields(item, stock) {
  const group = shelfGroup(item, stock, CONFIG.DND5E.armorTypes ?? {});
  return { group: group.id, groupIcon: group.icon, groupLabel: group.named ?? game.i18n.localize(`MERCHANT_PRESETS.Shop.Group.${group.id}`) };
}

/** A shelf group's design layer name: the gear group is "Adventuring gear" on the canvas, "Gear" on screen. */
const groupPen = (id, label) => (id === "all" ? "All goods" : id === "gear" ? "Adventuring gear" : label);

/** The design names a coin by its metal ("gold 15"); a homebrew coin by its own label. */

/**
 * The hero's kind chip icon for each shipped shop (design: the smith's hammer, the inn's beer),
 * by its name without the tier; any other shop gets the storefront.
 */
const KIND_ICONS = {
  "Adventurers' Store": "lucide:backpack",
  "Alchemists & Apothecaries": "lucide:flask-conical",
  "Arcane Store": "lucide:wand-sparkles",
  "Armourer & Blacksmiths": "lucide:hammer",
  "Criminal & Illicit Store": "lucide:venetian-mask",
  "Dock": "lucide:anchor",
  "Druidic Store": "lucide:leaf",
  "Fletcher & Woodworker": "lucide:axe",
  "General Store": "lucide:store",
  "Inn & Tavern": "lucide:beer",
  "Jeweler": "lucide:gem",
  "Leatherworker": "lucide:scissors",
  "Musical Store": "lucide:music",
  "Stable": "lucide:fence",
  "Tailor & Textile Store": "lucide:shirt",
  "Temple & Faith Store": "lucide:church",
  "Tinkering Store": "lucide:cog"
};
function kindIcon(actor, shop) {
  // The shipped merchant it came from, as #presetShop finds it: set up from one (#57), or imported.
  const uuid = shop.source ?? actor._stats?.compendiumSource;
  let name = null;
  try { name = uuid ? fromUuidSync(uuid)?.name ?? null : null; }
  catch { /* a pack that's gone: no kind of its own */ }
  return KIND_ICONS[titleParts(name ?? "").title] ?? "lucide:store";
}

/** CONST.DOCUMENT_OWNERSHIP_LEVELS: a shop players can visit is Limited to them by default. */
const NONE = 0, LIMITED = 1;

/** A Settings-tab field typed into (text, number, time), as opposed to a box, radio or select. */
const isTypedField = control => control.tagName === "INPUT" && !["checkbox", "radio"].includes(control.type);

/** A value quoted for an attribute selector. */
const attr = value => String(value).replace(/["\\]/g, "\\$&");

/**
 * A selector that finds `control` again in the next render: its data-op and the data it edits,
 * and a radio's own value (the restock mode's two radios share everything else).
 */
const settingSelector = control => `.settings-tab ${["op", "side", "category", "list", "value", "end", "denomination"]
  .filter(key => control.dataset[key] != null)
  .map(key => `[data-${key}="${attr(control.dataset[key])}"]`).join("")}${
  control.type === "radio" ? `[value="${attr(control.value)}"]` : ""}`;

/**
 * A text field's selection, `[start, end]` (a caret is an empty one); null for a time input or a
 * box, which have none. The tab's percentages are text fields for this: a number input's caret
 * can't be read or put back.
 */
function selectionOf(control) {
  try {
    return control.selectionStart == null ? null : [control.selectionStart, control.selectionEnd];
  } catch { return null; }
}

/** A number typed into the tab; an emptied field is no number at all, not 0. */
const typedNumber = text => (String(text).trim() === "" ? NaN : Number(text));

/**
 * The header chip with a buyer's deal after the shop's terms (#111; design v8ap9 "Sells at list ·
 * Your price −10%"). Only the character with the deal is ever shown it. Each side says what the
 * deal really does at the shop's own terms, as the rows' tags do, so a deal the sell <= buy cap cut
 * short promises no more than a sale pays (#142 review).
 */
function dealChip(termsChip, deal, world, terms) {
  if (!deal) return termsChip;
  const list = effectiveRates(world, terms);
  const dealt = effectiveRates(world, terms, null, deal);
  const effect = (from, to) => (from > 0 && Math.abs(to - from) > 1e-9 ? signedPercent(to / from - 1) : null);
  const price = effect(list.sellsAt.rate, dealt.sellsAt.rate);
  const offers = effect(list.buysAt.rate, dealt.buysAt.rate);
  if (!price && !offers) return termsChip;
  // The design's "Sells at list · Your price −10%": the shop's selling rate, then the deal's own.
  return [game.i18n.localize("MERCHANT_PRESETS.Shop.TermsChipSells", { sells: chipWord(list.sellsAt.rate) }),
    price ? game.i18n.localize("MERCHANT_PRESETS.Shop.Deal.YourPrice", { percent: price }) : null,
    offers ? game.i18n.localize("MERCHANT_PRESETS.Shop.Deal.YourOffers", { percent: offers }) : null
  ].filter(Boolean).join(" · ");
}

/**
 * The price without the buyer's deal, as the small struck text over theirs (design AutYE, "2 gp"):
 * words, since a strike can't cross coin icons. Empty when the deal didn't move the price.
 */
/** Which Players see view a Settings section has: its own, or the terms and deals one. */
const previewOf = section => (["restock", "wontBuy", "hours", "till"].includes(section) ? section : "terms");
/** `items` in rows of `size`, each numbered from 1 for its layer name. */
// A short last row keeps its checks under the columns above with empty cells (design dYANz, #184).
const inRows = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => {
  const row = items.slice(i * size, (i + 1) * size);
  return { number: i + 1, items: row, fillers: row.length < size && i > 0 ? Array(size - row.length).fill(0) : [] };
});
const listText = (cp, currencies) => coinBreakdown(cp ?? 0, currencies).map(c => `${c.count} ${c.abbreviation ?? c.denomination}`).join(" ");

/**
 * The hours a shop really closes by: none while the world's trading hours are off, since every
 * shop is then open around the clock, so no deal can last "until the shop closes" (#142 review).
 */
const closingHours = shop => (keepsHours() ? shop.hours : null);

/**
 * Whether shops keep their hours: the world's trading hours are on, and shops follow the world
 * clock (#149). Where they don't, every shop is open around the clock, as with hours off.
 */
const keepsHours = () => worldFollowsClock() && game.settings.get(MODULE, "tradingHours");

/** Text for a form's HTML: the deal form is built as a string (DialogV2.input). */
const escapeText = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Whether a seal is out or its bill is stamped: either way the live checks no longer apply. */
const isSettled = state => state === "sealing" || state === "sealed";

/** A purse's coins for display: an empty one reads as 0 of the everyday coin, not as "worthless". */
function purseCoins(amountCp, currencies) {
  const coins = coinBreakdown(amountCp, currencies);
  if (!coins.length) {
    const denomination = "gp" in currencies ? "gp" : Object.keys(currencies)[0];
    const c = currencies[denomination];
    coins.push({ denomination, count: 0, abbreviation: c?.abbreviation ?? denomination, icon: c?.icon, label: c?.label });
  }
  return coins.map(c => ({ ...c, aria: coinAriaLabel(c) }));
}

/**
 * The coins a character actually holds, denomination by denomination as their sheet shows them,
 * not the total re-split largest-first (150 gp and 30 sp is not "15 pp 3 gp"). Empty reads as 0.
 */
function heldCoins(currency, currencies) {
  const coins = Object.entries(currencies)
    .filter(([denomination]) => (currency?.[denomination] ?? 0) > 0)
    .map(([denomination, c]) => ({ denomination, count: currency[denomination], abbreviation: c.abbreviation ?? denomination, icon: c.icon, label: c.label }));
  return coins.length ? coins.map(c => ({ ...c, aria: coinAriaLabel(c) })) : purseCoins(0, currencies);
}

/** `coinBreakdown`'s own array, read back as plain text — "30 gp", "1 gp 9 sp 2 cp" — for the button labels and notices #101/#98's coin data doesn't otherwise have a string form for. */
function coinsText(coins) {
  return coins.length ? coins.map(c => `${c.count} ${c.abbreviation}`).join(" ") : "0";
}

/**
 * The header chip and Terms of Trade popover read the two common rates in words, per
 * design/README.md ("Sells at list price", "Buys at half value"); `rateFraction` (shop-view.mjs)
 * is for a row's own tag, a different vocabulary ("½"). Anything else falls back to a percentage.
 */
/** The chip's short word for a selling rate: "list" at list price, else a percentage. */
function chipWord(rate) {
  return Math.abs(rate - 1) < 1e-9 ? game.i18n.localize("MERCHANT_PRESETS.Shop.Terms.List") : `${Math.round(rate * 100)}%`;
}

function termsWord(rate, kind) {
  if (kind === "sell" && rate === 1) return game.i18n.localize("MERCHANT_PRESETS.Shop.Terms.ListPrice");
  if (kind === "buy" && rate === 0.5) return game.i18n.localize("MERCHANT_PRESETS.Shop.Terms.HalfValue");
  return `${Math.round(rate * 100)}%`;
}

/** A character's short subtitle in the buyer picker — a class and level when dnd5e's own `classes` getter has one, else the actor's type label. */
function actorSubtitle(actor) {
  if (actor.type === "character") {
    const cls = Object.values(actor.classes ?? {})[0];
    const level = cls?.system?.levels ?? actor.system?.details?.level;
    if (cls?.name && level) return `${cls.name} ${level}`;
  }
  // A creature's kind: "Beast", "Humanoid".
  const creature = CONFIG.DND5E?.creatureTypes?.[actor.system?.details?.type?.value];
  if (creature) return game.i18n.localize(creature.label ?? creature);
  return game.i18n.localize(CONFIG.Actor?.typeLabels?.[actor.type] ?? actor.type);
}

// `merchant-presets.mjs` is loaded, under plain Node with tools/foundry-stub.mjs's minimal
// world, by the wiring/casting/strays tests that have nothing to do with this window — that stub
// models only what the pre-2.0 runtime touches, not `foundry.applications`. Guarded rather than
// assumed, so importing this module stays safe there: a real Foundry client always has the
// Applications v2 API by the time module scripts run (this mirrors dnd5e's own top-level sheet
// class declarations), so the guard is a no-op everywhere this module actually needs to work.
const hasApplicationsApi = !!(globalThis.foundry?.applications?.sheets?.ActorSheetV2
  && globalThis.foundry?.applications?.api?.HandlebarsApplicationMixin);

/**
 * The design's own Window Bar (#145) on core's header, so core's dragging and closing still work:
 * the title, then (with `npcSheet`, for a GM) a button to the NPC sheet, then close. No icon, no id
 * link and no controls menu; the NPC sheet has its own, and it's the one a GM configures.
 */
function windowBar(frame, { npcSheet }) {
  const header = frame.querySelector(":scope > .window-header");
  if (!header) return frame;
  header.dataset.pen = "Window Bar";
  header.querySelector(":scope > .window-title")?.setAttribute("data-pen", "Window Title");
  for (const el of header.querySelectorAll(":scope > .window-icon, :scope > .document-id-link, :scope > [data-action='toggleControls'], :scope > .controls-dropdown")) el.remove();
  const right = document.createElement("div");
  right.className = "mp-bar-right";
  right.dataset.pen = "Bar right";
  if (npcSheet) {
    right.insertAdjacentHTML("beforeend", `<button type="button" class="mp-npc-sheet" data-action="npcSheet" data-pen="NPC sheet button">`
      + `${icon("user-round", { "data-pen": "NPC sheet icon" })}<span data-pen="NPC sheet label">${escapeText(game.i18n.localize("MERCHANT_PRESETS.Shop.NpcSheet"))}</span></button>`);
  }
  const close = header.querySelector(":scope > [data-action='close']");
  if (close) {
    close.className = "mp-close";
    close.innerHTML = icon("x", { "data-pen": "Close" });
    right.append(close);
  }
  // Core's own header buttons (the token's): the NPC sheet has them.
  for (const el of header.querySelectorAll(":scope > .header-control")) el.remove();
  header.append(right);
  return frame;
}

/** A deal side's plain reading beside its field (design Q6UvA): "10% off the shop's price". */
const dealReadingText = (side, value) => {
  const { key, percent } = dealReading(side, value);
  return game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.Deals.Form.Reading.${key}`, { percent });
};

/**
 * The deal form (#111, design Q6UvA): the shop's own dialog under the design's Window Bar. `ask`
 * resolves with the form's fields as typed, or null when it's closed without them.
 */
const DealForm = hasApplicationsApi && globalThis.foundry.applications.api.ApplicationV2 ? class DealForm extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  /** @override */
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["merchant-presets", "shop-sheet", "dnd5e2", "mp-deal-form"],
    position: { width: 360, height: "auto" },
    window: { minimizable: false },
    form: { handler: DealForm.#onSubmit, closeOnSubmit: true },
    actions: { cancel: DealForm.#onCancel }
  };

  /** @override */
  static PARTS = { form: { template: `${TEMPLATES}/deal-form.hbs` } };

  #context;
  #resolve;

  constructor({ context, resolve }) {
    super({ window: { title: context.title } });
    this.#context = context;
    this.#resolve = resolve;
  }

  /** Opens the form on `context` (ShopSheet#dealForm's) and waits for its answer. */
  static ask(context) {
    return new Promise(resolve => new DealForm({ context, resolve }).render({ force: true }));
  }

  /** @override */
  async _prepareContext() {
    return this.#context;
  }

  /** @override */
  async _renderFrame(options) {
    return windowBar(await super._renderFrame(options), { npcSheet: false });
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    // A select shows its choice in its own box; "After some days" asks how many.
    for (const select of this.element.querySelectorAll(".mp-select-native")) {
      select.addEventListener("change", () => {
        select.closest(".mp-select").querySelector(".mp-select-value").textContent = select.selectedOptions[0]?.text ?? "";
        if (select.name === "ends") this.element.querySelector(".mp-days-row").hidden = select.value !== "days";
      });
    }
    // Each side reads in words as it's typed.
    for (const input of this.element.querySelectorAll("input[data-side]")) {
      input.addEventListener("input", () => {
        input.closest(".mp-rate-row").querySelector(".mp-plain").textContent = dealReadingText(input.dataset.side, input.value);
      });
    }
  }

  static #onSubmit(_event, _form, formData) {
    const resolve = this.#resolve;
    this.#resolve = null;
    resolve?.(formData.object);
  }

  static #onCancel() {
    this.close();
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#resolve?.(null);
    this.#resolve = null;
  }
} : null;

const ShopSheet = hasApplicationsApi ? class ShopSheet extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.sheets.ActorSheetV2
) {
  /** @override */
  static DEFAULT_OPTIONS = {
    // "dnd5e2" isn't decorative: dnd5e.css scopes every --dnd5e-* custom property this
    // stylesheet builds on to `@scope (.theme-light/.theme-dark) { .dnd5e2 { ... } }` — without
    // this class none of those variables resolve, design/README.md's token table included.
    classes: ["merchant-presets", "shop-sheet", "dnd5e2"],
    position: { width: 920, height: 680 },
    window: { resizable: true, icon: "fa-solid fa-store" },
    actions: {
      npcSheet: ShopSheet.#onNpcSheet,
      inspect: ShopSheet.#onInspect,
      selectCategory: ShopSheet.#onSelectCategory,
      toggleBill: ShopSheet.#onToggleBill,
      addLine: ShopSheet.#onAddLine,
      stepLine: ShopSheet.#onStepLine,
      pickBuyer: ShopSheet.#onPickBuyer,
      seal: ShopSheet.#onSeal,
      keepShopping: ShopSheet.#onKeepShopping,
      settingsSection: ShopSheet.#onSettingsSection,
      togglePreview: ShopSheet.#onTogglePreview,
      setEvery: ShopSheet.#onSetEvery,
      addRule: ShopSheet.#onAddRule,
      removeRule: ShopSheet.#onRemoveRule,
      addDeal: ShopSheet.#onAddDeal,
      editDeal: ShopSheet.#onEditDeal,
      removeDeal: ShopSheet.#onRemoveDeal,
      restockNow: ShopSheet.#onRestockNow,
      resetToPreset: ShopSheet.#onResetToPreset,
      openTable: ShopSheet.#onOpenTable
    }
  };

  /** @override */
  static PARTS = {
    body: {
      template: `${TEMPLATES}/shop-sheet.hbs`,
      root: true,
      scrollable: [".shop-stock", ".sell-stock", ".settings-body", ".settings-preview"],
      templates: [
        `${TEMPLATES}/parts/bill-of-sale.hbs`,
        `${TEMPLATES}/parts/closed-card.hbs`,
        `${TEMPLATES}/parts/buyer-entry.hbs`,
        `${TEMPLATES}/parts/settings-tab.hbs`
      ]
    }
  };

  /** One tab group; the tab list itself is dynamic (GM-only Settings tab) — see `_getTabsConfig`. */
  static TABS = { primary: {} };

  /**
   * Whether this user may see the shop (#166), which core asks before every render: in reach mode
   * a player at the counter, with a token within 5 ft of the shop's on the scene they're viewing,
   * though the shop is None to them; from anywhere, core's own Limited. So a link, a macro or the
   * sidebar opens a shop only where the double-click would.
   * @override
   */
  get isVisible() {
    const scene = globalThis.canvas?.ready ? globalThis.canvas.scene : null;
    return canOpenOn(scene, this.document, game.user, accessModeOf(game.settings.get(MODULE, "shopAccess")), gridless());
  }

  constructor(options = {}) {
    super(options);
    /** One basket per trade kind: itemId -> quantity. Never persisted; client-only state, cleared on seal. */
    this._baskets = { buy: new Map(), sell: new Map() };
    /** One state per kind, so a Buy refusal never bleeds into the Sell tab's own seal button: "idle" | "sealing" | "sealed" | a `planTrade` refusal reason. */
    this._tradeState = { buy: "idle", sell: "idle" };
    /** Per kind, the bill a trade sealed (its priced lines, sum and receipt): shown under the stamp until the next edit, whatever the trade did to the live items and purses. */
    this._sealed = { buy: null, sell: null };
    /** Per kind, the item ids a `stock-changed` refusal re-priced, struck on the bill until the basket changes. */
    this._struck = { buy: new Set(), sell: new Set() };
    /** Per kind, lines that sold out while on the bill: struck off as "Sold out" until the next edit (design WNYhA, state 6). */
    this._gone = { buy: [], sell: [] };
    /** Per kind, each line as the bill last priced it, by item id: what a line that sells out is struck off as. */
    this._priced = { buy: new Map(), sell: new Map() };
    /** Per kind, the id of a trade that may still land (unconfirmed, or never answered): every seal resends it until one is answered (sealed or refused) or the buyer changes, so the GM's side can't carry it out twice. */
    this._tradeId = { buy: null, sell: null };
    /** Per kind, every priced line sent under the current `_tradeId`, by item id: what a sealed answer's own lines are named and pictured from. */
    this._sent = { buy: new Map(), sell: new Map() };
    this._activeCategory = "all";
    /** Whether a narrow window shows the whole bill over the list (its dock's chevron). */
    this._billOpen = false;
    /** The Sell tab's category, as `_activeCategory` is the Buy tab's. */
    this._sellCategory = "all";
    /** Per kind, the fewest of each line worth a coin (`buyRow`/`sellRow`'s `minQuantity`), from the last render. */
    this._minQuantity = { buy: new Map(), sell: new Map() };
    this._buyerUuid = game.user.character?.uuid ?? null;
    /** The GM Settings tab's open section (#110). */
    this._settingsSection = "terms";
    /** The section a nav click jumped to, marked until the GM scrolls by hand (#172, #173 review); null: follow the scroll. */
    this._pinnedSection = null;
    /** Whether a section change is waiting for scrolling to stop to re-render Players see (#172). */
    this._settlePending = false;
    /** Whether a narrow window shows Players see in place of the Settings form (its dock's chevron). */
    this._previewOpen = false;
    /** Whether the GM picked "Dice…" and the schedule's formula field is showing, before a formula is set. */
    this._everyDice = false;
  }

  /** The shop's name, as its own heading shows it: no "Non-Player Character:" and no tier (#145). */
  get title() {
    return titleParts(this.document.name).title;
  }

  /**
   * The design's own Window Bar (#145) on core's header (see `windowBar`), with the NPC sheet button.
   * @override
   */
  async _renderFrame(options) {
    return windowBar(await super._renderFrame(options), { npcSheet: game.user.isGM });
  }

  /**
   * Nothing here writes to the shop: a trade goes through `api.trade`, carried out by the GM. So
   * core's own gate, which disables every control for a user below `editPermission` (OWNER), would
   * only lock a Limited player out of a shop they're meant to trade with. The GM's Settings tab
   * (#110) is the one part that edits, and only a GM ever sees it.
   * @override
   */
  _toggleDisabled() {}

  /**
   * A re-render replaces the popovers, and one comes on every clock tick or buyer update (see
   * `register`): note which is open, and the GM's search, so `_onRender` can put them back.
   * @override
   */
  async _preRender(context, options) {
    await super._preRender?.(context, options);
    this._openPopover = this.element?.querySelector("[popover]:popover-open")?.id ?? null;
    const search = this.element?.querySelector(".buyer-search");
    this._buyerSearch = search?.value ?? "";
    // Its own document: a popped-out window (ApplicationV2#detachWindow) isn't the main one.
    this._searchFocus = search && search === search.ownerDocument?.activeElement ? search.selectionStart : null;
    // The Settings field the GM is in, and what they've typed there but not yet left: each save
    // re-renders the window, and tabbing on from a field saves it as the next one gains focus.
    const active = this.element?.ownerDocument?.activeElement;
    this._settingFocus = active && this.element.contains(active) && active.matches(".settings-tab [data-op]")
      // Only a typed field holds typing to carry over: a select has no defaultValue, and its
      // choice (a rule just added) may not be one of the new render's options.
      ? { selector: settingSelector(active), value: active.value, selection: selectionOf(active),
        // A value just refused goes back to the saved one: the field stays focused when the
        // browser window, not the field, lost focus, and would otherwise carry it over.
        dirty: this._resetTyping !== settingSelector(active) && isTypedField(active) && active.value !== active.defaultValue }
      : null;
    this._resetTyping = null;
    // From here until `_onRender`, a blur is the re-render removing a field, not the GM leaving it.
    this._settingsRendering = true;
  }

  /**
   * A render that throws between `_preRender` and `_onRender` still ends the re-render window:
   * otherwise every blur afterwards would read as one, and no typed field would ever save.
   * @override
   */
  async render(...args) {
    try { return await super.render(...args); }
    finally { this._settingsRendering = false; }
  }

  /** @override */
  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this._openPopover) this.element?.querySelector(`[id="${this._openPopover}"]`)?.showPopover();
    this.#observeLeaders();
    // A narrow window's category dropdown: a native select, which reports a change, not a click.
    for (const select of this.element?.querySelectorAll(".mp-category-native") ?? []) {
      select.addEventListener("change", () => {
        if (select.classList.contains("mp-section-native")) return this.#jumpToSection(select.value, { fromDropdown: true });
        if (select.dataset.kind === "sell") this._sellCategory = select.value;
        else this._activeCategory = select.value;
        this.render();
      });
    }
    // The Settings form scrolls as one page: its nav follows the section being read (#172).
    const settingsForm = this.element?.querySelector(".settings-body");
    if (settingsForm) {
      let frame = null;
      settingsForm.addEventListener("scroll", () => {
        // Scrolling still: the settled re-render waits for it to stop (#173 review).
        this.#deferSettle();
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          // A render may have replaced this form since: a detached one measures all zeros (#173 review).
          if (settingsForm.isConnected) this.#followScroll(settingsForm);
        });
      }, { passive: true });
      // The GM scrolling by hand lets go of a section a click pinned (#173 review).
      const unpin = () => { this._pinnedSection = null; };
      for (const type of ["wheel", "touchstart", "pointerdown"]) settingsForm.addEventListener(type, unpin, { passive: true });
      settingsForm.addEventListener("keydown", event => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) unpin();
      });
    }
    // The GM's Settings tab (#110). A field saves when it's left (Enter leaves it): a time input
    // fires `change` on each part typed, and saving 01:00 would re-render before the 9 of 19:00.
    // Boxes, radios and selects save on change. Enter would otherwise submit the sheet's form.
    this._settingsRendering = false;
    for (const control of this.element?.querySelectorAll(".settings-tab [data-op]") ?? []) {
      if (isTypedField(control)) {
        control.addEventListener("blur", () => {
          // Chromium blurs a focused field when a re-render takes it off the page, half-typed:
          // that isn't the GM leaving it. Its typing carries over to the new field (`_preRender`).
          if (this._settingsRendering || !control.isConnected) return;
          if (control.value !== control.defaultValue) this._onSettingChange(control);
        });
        control.addEventListener("keydown", event => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          control.blur();
        });
      } else control.addEventListener("change", () => this._onSettingChange(control));
    }
    const focus = this._settingFocus && this.element?.querySelector(this._settingFocus.selector);
    if (focus) {
      const { dirty, value, selection } = this._settingFocus;
      if (dirty) focus.value = value;
      focus.focus();
      // Exactly where the caret or selection was: a click into a field, or a triple-click on it.
      if (selection) focus.setSelectionRange?.(...selection);
    }
    // The GM's buyer search filters the picker by name. Enter would otherwise submit the sheet's
    // form, which has nothing to save.
    const search = this.element?.querySelector(".buyer-search");
    if (!search) return;
    const filter = () => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const entry of this.element.querySelectorAll(".buyer-picker .buyer-entry")) {
        const name = entry.querySelector(".buyer-entry-name")?.textContent.toLocaleLowerCase() ?? "";
        entry.hidden = !!query && !name.includes(query);
      }
      // A heading goes with its group: hidden once the search leaves nobody under it.
      for (const group of this.element.querySelectorAll(".buyer-picker .mp-picker-group")) {
        let shown = false;
        for (let next = group.nextElementSibling; next && !next.classList.contains("mp-picker-group"); next = next.nextElementSibling) {
          if (next.classList.contains("buyer-entry") && !next.hidden) shown = true;
        }
        group.hidden = !shown;
      }
    };
    search.value = this._buyerSearch ?? "";
    // Typing survives a clock tick's re-render: focus and caret go back where they were.
    if (this._searchFocus != null) {
      search.focus();
      search.setSelectionRange(this._searchFocus, this._searchFocus);
    }
    filter();
    search.addEventListener("keydown", event => { if (event.key === "Enter") event.preventDefault(); });
    search.addEventListener("input", filter);
  }

  /** Re-measures the bill's leaders whenever a bill line's box changes size; made at each render with a bill. */
  #leaderObserver = null;

  /** @override */
  _onClose(options) {
    super._onClose(options);
    this.#leaderObserver?.disconnect();
  }

  /**
   * A bill name that wraps keeps its box at full width: its leader starts where the last line
   * ends, not after that box (#198, design IeGac). The name is held at its wrapped width, or the
   * room the leader gives back would unwrap it. Measured once layout settles and again whenever a
   * line's box resizes (the window's width arrives after the first render; a resize). A web font
   * arriving late re-measures only if it changes a line's box.
   */
  #observeLeaders() {
    this.#leaderObserver?.disconnect();
    this.#leaderObserver = null;
    const entries = this.element?.querySelectorAll(".mp-entry") ?? [];
    if (!entries.length) return;
    // Its own window's observer: a popped-out window (ApplicationV2#detachWindow) isn't the main one.
    this.#leaderObserver = new entries[0].ownerDocument.defaultView.ResizeObserver(() => this.#pullLeaders());
    for (const entry of entries) this.#leaderObserver.observe(entry);
  }

  #pullLeaders() {
    for (const name of this.element?.querySelectorAll(".mp-line-name") ?? []) {
      const leader = name.nextElementSibling;
      if (!leader?.classList.contains("mp-leader")) continue;
      name.style.maxWidth = leader.style.marginLeft = "";
      const range = name.ownerDocument.createRange();
      range.selectNodeContents(name);
      const last = [...range.getClientRects()].at(-1);
      const box = name.getBoundingClientRect();
      const gap = last ? box.right - last.right : 0;
      if (gap <= 0.5) continue;
      name.style.maxWidth = `${box.width}px`;
      leader.style.marginLeft = `${-gap}px`;
    }
  }

  /* -------------------------------------------------------------- tabs */

  /** @override */
  _getTabsConfig(group) {
    if (group !== "primary") return super._getTabsConfig(group);
    const tabs = [
      { id: "buy", icon: "lucide:shopping-bag" },
      { id: "sell", icon: "lucide:hand-coins" }
    ];
    if (game.user.isGM) tabs.push({ id: "settings", icon: "lucide:settings-2", gm: true });
    return { tabs, initial: "buy", labelPrefix: "MERCHANT_PRESETS.Shop.Tabs" };
  }

  /* -------------------------------------------------------------- context */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.document;
    await learnSpells(actor.items.map(i => i));
    const currencies = CONFIG.DND5E.currencies;
    // Trading hours off, or shops not following the world clock (#149), means every shop is open
    // around the clock (the settings' own promise), so the window reads it as a shop with no hours:
    // always open, in the header too.
    const shop = shopConfigOf(actor);
    const config = keepsHours() ? shop : { ...shop, hours: null };
    const { title, tierFromName } = titleParts(actor.name);
    const tier = tierFromName ?? config.tier;

    // schedule.mjs's own convention (its header): every function there takes the world clock's
    // *plain numbers* — `{secondsPerMinute, minutesPerHour, hoursPerDay}` — not `game.time.calendar`
    // itself, so `.days` is what's passed through here, not the calendar object that owns it.
    const calendarDays = game.time.calendar.days;
    const minute = this.#minuteOfDay();
    const open = isOpen(config.hours, minute, calendarDays);
    const buyer = this.#resolveBuyer();
    const kind = this.tabGroups.primary;
    this.#pruneBaskets();

    const world = worldOf().rates;
    const chipSellsAt = effectiveRates(world, config.terms).sellsAt.rate;
    const chipBuysAt = effectiveRates(world, config.terms).buysAt.rate;
    const rates = {
      world, shopTerms: config.terms, chipSellsAt, chipBuysAt, deal: this.#dealOf(buyer)
    };
    const header = this.#headerContext(actor, title, tier, config, open, chipSellsAt, chipBuysAt, currencies, rates.deal);

    Object.assign(context, {
      appId: this.id,
      isGM: game.user.isGM,
      actor,
      config,
      open,
      header,
      buyerPicker: this.#buyerPickerContext(buyer, currencies),
      buyer,
      buyerInitial: buyer ? (buyer.name || "?").charAt(0).toUpperCase() : "",
      buyerPurse: buyer ? heldCoins(buyer.system.currency, currencies) : [],
      currencies,
      kind,
      billOpen: this._billOpen,
      // Every tab's content is built on every render, not only the active one: core's own
      // `changeTab` (application.mjs) just toggles which already-rendered `.tab` section is
      // visible, with no re-render in between, so a tab switched to cold would otherwise show
      // whatever it held (or didn't) at the last full render.
      buy: this.#buyContext(actor, config, rates, currencies, buyer, open),
      sell: this.#sellContext(actor, config, rates, currencies, buyer, open),
      // The shop's own config, not `config`: the world's trading-hours switch shows no hours, but
      // the GM edits the ones the shop keeps.
      settings: game.user.isGM ? await this.#settingsContext(actor, shop, world, header) : null,
      closed: !open ? this.#closedContext(actor, config, minute, calendarDays) : null
    });
    // Jumped to Won't buy, Players see is the buyer's Sell tab: a good it takes, one it refuses (design dYANz).
    if (context.settings && this._settingsSection === "wontBuy" && buyer && context.sell.preview.length) {
      context.settings.preview.wontBuy = {
        label: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Preview.SellTab", { name: buyer.name }),
        rows: context.sell.preview
      };
    }
    return context;
  }

  /** Minutes since local midnight on the world clock — see schedule.mjs's own convention. */
  #minuteOfDay() {
    const calendar = game.time.calendar;
    const c = calendar.timeToComponents(game.time.worldTime);
    return c.hour * calendar.days.minutesPerHour + c.minute;
  }

  #headerContext(actor, title, tier, config, open, chipSellsAt, chipBuysAt, currencies, deal) {
    const termsChip = game.i18n.localize("MERCHANT_PRESETS.Shop.TermsChip", { sells: chipWord(chipSellsAt), buys: rateFraction(chipBuysAt) });
    const closesAt = config.hours ? this.#formatTime(config.hours.close) : null;
    const opensAt = config.hours ? this.#formatTime(config.hours.open) : null;
    return {
      img: actor.img,
      title,
      tier,
      kindIcon: kindIcon(actor, config),
      // "Fresh stock today" until the shop closes after the restock (#152).
      // Not without a clock, which is what clears it (#149).
      fresh: worldFollowsClock() && isFresh(actor.flags?.[MODULE]?.restockedAt, game.time.worldTime, config.hours, game.time.calendar.days),
      // A flag any owner of the shop can write, so it's cleaned before it goes into the page raw.
      description: foundry.utils.cleanHTML(config.description ?? ""),
      open,
      // Without a clock, no hours to speak of: no chip at all (#149, design RRqQ7).
      hoursChip: worldFollowsClock(),
      openLabel: open
        ? (config.hours ? game.i18n.localize("MERCHANT_PRESETS.Shop.OpenUntil", { time: closesAt }) : game.i18n.localize("MERCHANT_PRESETS.Shop.AlwaysOpen"))
        : (config.hours ? game.i18n.localize("MERCHANT_PRESETS.Shop.ClosedOpensAt", { time: opensAt }) : game.i18n.localize("MERCHANT_PRESETS.Shop.Closed.Label")),
      // design/README.md's own mockup ("Sells at list · Buys at ½"): the chip reads sellsAt in
      // words but buysAt as the row-tag fraction glyph — an asymmetry the mockup draws on
      // purpose, unlike the Terms popover below, which spells both out in words.
      termsChip: dealChip(termsChip, deal, worldOf().rates, config.terms),
      // What everyone else sees: the Settings tab's preview (#110).
      termsChipBase: termsChip,
      // A narrow window's short chips (design r7HIUl): "Open until 19:00", "List · ½".
      shortOpen: open && config.hours ? game.i18n.localize("MERCHANT_PRESETS.Shop.OpenUntilShort", { time: closesAt }) : null,
      shortTerms: `${sentence(chipWord(chipSellsAt))} · ${rateFraction(chipBuysAt)}`,
      // The description, as text, behind a narrow window's info button.
      descriptionText: foundry.utils.cleanHTML(config.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      terms: this.#termsContext(config, chipSellsAt, chipBuysAt, currencies)
    };
  }

  /**
   * The Terms of Trade popover (design ChoNd): what the shop sells at and buys at, each worked on a
   * 15 gp longsword at its chip rates, and what it won't buy. A category rule adds a line of its own.
   */
  #termsContext(config, chipSellsAt, chipBuysAt, currencies) {
    const t = (key, data) => game.i18n.localize(`MERCHANT_PRESETS.Shop.Terms.${key}`, data);
    // "gp" is the worked example's fixed reference; a currency set without it shows no example.
    const example = rate => {
      try { return coinsText(coinBreakdown(itemPriceCp({ value: 15, denomination: "gp" }, rate, 1, currencies), currencies)); }
      catch { return null; }
    };
    const list = (words, joiner) => (words.length > 1 ? t(joiner, { items: words.slice(0, -1).join(", "), last: words.at(-1) }) : words[0]);
    const sells = example(chipSellsAt);
    const buys = example(chipBuysAt);
    const rows = [
      { pen: "Sells at", icon: "lucide:arrow-up-right", key: t("SellsAt"), value: termsWord(chipSellsAt, "sell"),
        detail: chipSellsAt === 1 ? t("ListPriceNote") : sells && t("SellsDetail", { price: sells }) },
      { pen: "Buys at", icon: "lucide:arrow-down-left", key: t("BuysAt"), value: termsWord(chipBuysAt, "buy"),
        detail: buys && t("BuysDetail", { price: buys }) }
    ];
    const typeWords = config.wontBuy.types.map(type => game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type).toLowerCase());
    const refused = wontBuyTerms(config.wontBuy.kinds, typeWords, kind => t(`Nouns.${kind}`));
    if (refused.lead.length) {
      rows.push({ pen: "Deals in", icon: "lucide:ban", key: t("WontBuy"), value: list(refused.lead, "ListOr"),
        detail: refused.rest.length ? t("AlsoTurnsAway", { list: list(refused.rest, "ListAnd") }) : null });
    }
    // What each rule's goods really trade at: the shop's own rate on a side it leaves unset, and never
    // paying more than it charges (pricing.mjs `effectiveRates`, as trades price them). No frame draws
    // these yet; they take the terms' own look.
    for (const rule of config.terms.categories) {
      const { sellsAt, buysAt } = effectiveRates(worldOf().rates, config.terms, rule.category);
      rows.push({ pen: `Rule ${rule.category}`, icon: "lucide:tag", key: rule.category,
        rule: { category: rule.category, sellsAt: sellsAt.rate, buysAt: buysAt.rate },
        value: t("RuleRates", { sells: termsWord(sellsAt.rate, "sell"), buys: termsWord(buysAt.rate, "buy") }), detail: null });
    }
    return { rows };
  }

  #formatTime(time) {
    return `${time.hour}:${String(time.minute).padStart(2, "0")}`;
  }

  #closedContext(actor, config, minute, calendarDays) {
    const { opensAt, inMinutes } = nextOpen(config.hours, minute, calendarDays);
    const perHour = calendarDays.minutesPerHour;
    const hours = perHour ? Math.floor(opensAt / perHour) : 0;
    const mins = perHour ? opensAt % perHour : 0;
    const untilHours = perHour ? Math.floor(inMinutes / perHour) : 0;
    const untilMins = perHour ? inMinutes % perHour : inMinutes;
    // #98's Localization has dropped the old format()/pluralization split (V14): `localize`
    // does the `{key}` substitution itself now, with no automatic singular/plural selection —
    // so the plural pick happens here instead of leaning on an `_plural` suffix that no longer exists.
    const duration = untilHours > 0
      ? game.i18n.localize(`MERCHANT_PRESETS.Shop.Closed.Hours${untilHours === 1 ? "" : "Plural"}`, { count: untilHours })
      : game.i18n.localize(`MERCHANT_PRESETS.Shop.Closed.Minutes${untilMins === 1 ? "" : "Plural"}`, { count: untilMins });
    // Only a restock the clock will run: scheduled restocks can be off for the whole world.
    const dueAt = game.settings.get(MODULE, "autoRestock") ? this.#nextRestockAt(actor, config) : null;
    return {
      opensAtLabel: this.#formatTime({ hour: hours, minute: mins }),
      duration,
      openLabel: config.hours ? this.#formatTime(config.hours.open) : null,
      closeLabel: config.hours ? this.#formatTime(config.hours.close) : null,
      nextRestock: dueAt != null ? game.i18n.localize("MERCHANT_PRESETS.Shop.Closed.NextRestockAt", { date: this.#dayMonth(dueAt) }) : null
    };
  }

  /**
   * When the shop's next scheduled restock falls, or null: only a date the shop will keep. One
   * counted for another schedule is recounted at the clock's next tick (`scheduleShop`), and a
   * shop with no table, or set never to restock, never does.
   */
  #nextRestockAt(actor, shop) {
    const schedule = actor.flags?.[MODULE]?.schedule;
    const { chip } = everyChoice(shop.restock);
    return chip !== "never" && shop.restock.table && schedule?.dueAt != null
      && (schedule.every === undefined || schedule.every === shop.restock.every) ? schedule.dueAt : null;
  }

  /** "21 Mirtul": a day of the month and its name (design x9IX9); the calendar's own date elsewhere. */
  #dayMonth(time) {
    try {
      const calendar = game.time.calendar;
      const c = calendar.timeToComponents(time);
      const month = calendar.months?.values?.[c.month];
      return month ? `${c.dayOfMonth + 1} ${game.i18n.localize(month.name)}` : this.#dateLabel(time);
    } catch { return this.#dateLabel(time); }
  }

  /* -------------------------------------------------------------- buyer */

  /**
   * Every actor this window could trade as: the user's own owned actors, or, for a GM, the world's
   * characters and whoever stands on the scene they're viewing (#201, `gmCandidates`). A player at
   * the counter (#166) trades as the characters standing there: only those with a token in reach
   * of this shop on the scene they're viewing.
   */
  #candidateBuyers() {
    if (game.user.isGM) return gmCandidates(game.actors, globalThis.canvas?.ready ? globalThis.canvas.scene : null, this.document);
    const shopId = this.document.id;
    // Merchants aren't buyers: a shop's own coin is its till.
    const owned = game.actors.filter(a => a.id !== shopId && !a.flags?.[MODULE]?.shop && a.testUserPermission(game.user, "OWNER"));
    const mode = accessModeOf(game.settings.get(MODULE, "shopAccess"));
    if (mode !== "reach" || canVisit({ ...accessOf(this.document, game.user, mode), reach: false })) return owned;
    const scene = globalThis.canvas?.ready ? globalThis.canvas.scene : null;
    return scene ? owned.filter(a => reachOnScene(scene, this.document, tokensOf(scene, a), gridless())) : [];
  }

  #resolveBuyer() {
    const candidates = this.#candidateBuyers();
    let buyer = candidates.find(a => a.uuid === this._buyerUuid);
    // A seal that's out is settled by its answer; the buyer (and the reset a new one brings) waits for it.
    if (this._tradeState.buy === "sealing" || this._tradeState.sell === "sealing") return buyer ?? null;
    // A GM owns every actor and seldom has a character: prefer a player character to whichever
    // actor (a goblin, another merchant) happens to come first.
    // The assigned character counts only if the user could trade as it (owned, and not this shop).
    const own = candidates.find(a => a === game.user.character);
    if (!buyer) buyer = own ?? candidates.find(a => a.type === "character") ?? candidates[0] ?? null;
    const previous = this._buyerUuid;
    this._buyerUuid = buyer?.uuid ?? null;
    // The buyer went out of reach (deleted, or no longer owned): the same reset as picking another.
    if (previous && this._buyerUuid !== previous) this.#buyerChanged();
    return buyer;
  }

  /** A new buyer: the sell basket held the old one's own items, and an unanswered trade id is the old one's trade. */
  #buyerChanged() {
    this._tradeId.buy = this._tradeId.sell = null;
    this._sent.buy.clear();
    this._sent.sell.clear();
    this._baskets.sell.clear();
    this.#basketChanged("buy");
    this.#basketChanged("sell");
  }

  /**
   * The Buyer Picker (design n9I5aQ): who this window can trade as, with a class or creature and what
   * they carry. A player sees what they own, their assigned character first; a GM sees every actor,
   * characters and then the rest. Merchants aren't buyers. Each group reads alphabetically.
   */
  #buyerPickerContext(buyer, currencies) {
    const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
    const candidates = this.#candidateBuyers().sort(byName);
    const entry = actor => {
      const cp = totalCp(actor.system.currency ?? {}, currencies);
      const purse = cp > 0 ? coinsText(coinBreakdown(cp, currencies)) : game.i18n.localize("MERCHANT_PRESETS.Shop.NoPurse");
      return {
        id: actor.id,
        uuid: actor.uuid,
        name: actor.name,
        initial: (actor.name || "?").charAt(0).toUpperCase(),
        subtitle: [actorSubtitle(actor), purse].filter(Boolean).join(" · "),
        hasPurse: cp > 0,
        current: actor.uuid === buyer?.uuid
      };
    };
    if (!game.user.isGM) {
      const own = game.user.character?.uuid;
      return { gm: false, actors: [...candidates.filter(a => a.uuid === own), ...candidates.filter(a => a.uuid !== own)].map(entry) };
    }
    const characters = candidates.filter(a => a.type === "character");
    const others = candidates.filter(a => a.type !== "character");
    return { gm: true, characters: characters.map(entry), others: others.map(entry) };
  }


  static #onPickBuyer(_event, target) {
    if (this._tradeState.buy === "sealing" || this._tradeState.sell === "sealing") return;
    const previous = this._buyerUuid;
    this._buyerUuid = target.dataset.actorUuid;
    if (this._buyerUuid !== previous) this.#buyerChanged();
    // Closed here, before the re-render: the render lands before the browser would act on a
    // popovertarget, and `_preRender` would see the picker still open and restore it.
    this.element?.querySelector(".buyer-picker")?.hidePopover();
    this.render({ parts: ["body"] });
  }

  /* -------------------------------------------------------------- categories */

  /**
   * A tab's nav and its list's sections (designs y6iNf, TGXBN): the groups in the rows' own order,
   * each with its count, and the rows under their group's heading, narrowed to the chosen one. A
   * group that emptied (its last line traded) drops out, and the tab falls back to all goods.
   */
  #grouped(kind, rows) {
    const key = kind === "sell" ? "_sellCategory" : "_activeCategory";
    if (this[key] !== "all" && !rows.some(r => r.group === this[key])) this[key] = "all";
    const active = this[key];
    const categories = groupCategories(rows.map(r => ({ category: r.group }))).map(c => {
      const first = rows.find(r => r.group === c.id);
      const label = first?.groupLabel ?? game.i18n.localize("MERCHANT_PRESETS.Shop.Category.All");
      return { ...c, active: c.id === active, label, icon: first?.groupIcon ?? "lucide:layout-grid", pen: groupPen(c.id, label) };
    });
    const sections = [];
    for (const row of active === "all" ? rows : rows.filter(r => r.group === active)) {
      let section = sections.find(s => s.group === row.group);
      if (!section) { section = { group: row.group, label: row.groupLabel, pen: groupPen(row.group, row.groupLabel), rows: [] }; sections.push(section); }
      section.rows.push(row);
    }
    return { categories, sections };
  }

  /* -------------------------------------------------------------- buy tab */

  /** The shop's goods players can see, in its own order: the one a GM sets by dragging on the NPC sheet. */
  #shelf(actor) {
    // Under the name dnd5e shows: an unidentified good's unidentified one, never its true one.
    const shopItems = actor.items.map(i => ({ ...i.toObject(), name: i.name })).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    return shopItems.map(data => ({ data, stock: safeStockOf(data) }))
      .filter(({ data, stock }) => stock && isVisibleStock(data, stock, shopItems));
  }

  /**
   * A row's details (#168): dnd5e's rich card on hover, as markup, and the uuid a click opens
   * (shop-view.mjs `inspectTargets`). `owner` holds the good: the shop on the Buy tab, the seller
   * on the Sell tab.
   */
  #inspect(data, kind, owner) {
    const uuid = owner?.items?.get?.(data._id)?.uuid ?? `${owner?.uuid}.Item.${data._id}`;
    const { tip, open } = inspectTargets(data, { kind, isGM: game.user.isGM, uuid });
    return { tooltip: itemTooltipHtml(tip), open };
  }

  /** A good's picture or name, clicked (#168): the page its row names, read-only unless it's yours to edit. */
  static async #onInspect(_event, target) {
    const uuid = target.dataset.uuid;
    if (!uuid) return;
    const doc = await fromUuid(uuid).catch(() => null);
    return doc?.sheet?.render({ force: true });
  }

  #buyContext(actor, config, rates, currencies, buyer, open) {
    const shelf = actor.flags?.[MODULE]?.shelf;
    const rows = this.#shelf(actor)
      .map(({ data, stock }) => {
        const row = buyRow(data, stock, rates, rates.deal, currencies, worldInfiniteStock(), bundleOf);
        // "New" until the shop closes after the restock that brought it back, while it's still in stock (#152).
        row.isNew = worldFollowsClock() && isNewGood(data, shelf, game.time.worldTime, config.hours, game.time.calendar.days);
        this._minQuantity.buy.set(row.id, row.minQuantity);
        return {
          ...row,
          // Its place on the list (design y6iNf): a category the GM named, as they wrote it, else
          // its kind of good. The pricing category (`row.category`) stays what rules key on.
          ...groupFields(data, stock),
          // A named spell by the spell alone (design IeGac).
          name: goodName(data),
          inspect: this.#inspect(data, "buy", actor),
          meta: itemMeta(data, metaLabels(), metaWords, { ...goodsWorld(), service: !!stock.service, spell: spellFacts(data) }),
          stockText: stockWords(row.stock),
          // A narrow window folds the stock into the meta line (design r7HIUl).
          metaShort: stock.service ? itemMeta(data, metaLabels(), metaWords, { ...goodsWorld(), service: true, spell: spellFacts(data) })
            : compactMeta(data, metaLabels(), metaWords, stockWords(row.stock)),
          // The Narrow layout shows a filled check instead of "+" for a line already on the bill
          // (design/README.md, "Narrow"). Wide layouts ignore the flag entirely.
          inBasket: this._baskets.buy.has(row.id),
          priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : [],
          listText: listText(row.listPriceCp, currencies)
        };
      });
    // A category that emptied (its last line bought) drops out of the nav; fall back to all goods.
    this.#keepOffered("buy", new Map(rows.filter(r => !r.unpriced && !r.worthless).map(r => [r.id, r.minQuantity])));
    const { categories, sections } = this.#grouped("buy", rows);
    const purseCp = buyer ? totalCp(buyer.system.currency ?? {}, currencies) : 0;
    const { lines, totals } = this.#bill("buy", purseCp, currencies);
    // A basket the purse can't cover reads as "cant-afford" the moment it goes over, the same
    // way the Sell tab derives "till-short" below — not only after a round trip to the GM
    // confirms it (#102 will refuse it too, but the client already has enough to say so first).
    const traded = this._tradeState.buy;
    const state = isSettled(traded) ? traded : !open ? "closed" : !buyer ? "no-buyer"
      : (totals.shortfallCp > 0 ? "cant-afford" : traded);
    const seal = sealState(state, lines.length > 0, { gmOnline: !!game.users?.activeGM });
    const sumText = coinsText(coinBreakdown(totals.sumCp, currencies));
    const basket = this.#billOfSale("buy", lines, totals, currencies, buyer, this._sealed.buy);
    const tillText = coinsText(coinBreakdown(totalCp(actor.system.currency ?? {}, currencies), currencies));
    return {
      kind: "buy",
      shopTitle: titleParts(actor.name).title,
      sections,
      categories,
      activeCategory: categories.find(c => c.active),
      // For a buy refused as till-short: the till couldn't make change.
      tillText,
      basket,
      slip: this.#slip("buy", state, seal, basket, buyer, { tillText }),
      // A seal that's out or stamped stays on screen past closing, so its answer is seen.
      showClosed: !open && !isSettled(this._tradeState.buy),
      seal: {
        ...seal,
        state,
        // A long price takes the short label, so it fits the button (designs mRg3y, IeGac).
        label: seal.labelKey === "MERCHANT_PRESETS.Shop.Seal.Bargain"
          ? game.i18n.localize(sealsShort(sumText, coinBreakdown(totals.sumCp, currencies).length) ? "MERCHANT_PRESETS.Shop.Seal.BargainShort" : seal.labelKey, { price: sumText })
          : game.i18n.localize(seal.labelKey)
      },
      open
    };
  }

  /** A narrow window's docked bill opens to the full slip above it, and closes again. */
  static #onToggleBill() {
    this._billOpen = !this._billOpen;
    this.render();
  }

  static #onSelectCategory(_event, target) {
    if (target.dataset.kind === "sell") this._sellCategory = target.dataset.category;
    else this._activeCategory = target.dataset.category;
    this.render({ parts: ["body"] });
  }

  static async #onAddLine(_event, target) {
    const kind = this.tabGroups.primary;
    // The bill that's out is the one the answer settles; changing it mid-flight would stamp a
    // different bill, or lose the id a retry needs.
    if (this._tradeState[kind] === "sealing") return;
    const itemId = target.dataset.itemId;
    const basket = this._baskets[kind];
    const current = basket.get(itemId) ?? 0;
    // #103: selling something worn or packed away asks first, once, as it goes on the bill.
    const question = kind === "sell" && !current ? this.#saleQuestion(itemId) : null;
    if (question && !(await this.#confirm(question))) return;
    // The question isn't modal: a seal may have gone out while it was open.
    if (question && this._tradeState[kind] === "sealing") return;
    const next = this.#nextQuantity(kind, itemId, current, 1);
    // A line already at its most changes nothing, so the bill (and its stamp or strikes) stands.
    if (next === current) return;
    if (next > 0) basket.set(itemId, next);
    this.#basketChanged(kind);
    this.render({ parts: ["body"] });
  }

  static #onStepLine(_event, target) {
    const kind = this.tabGroups.primary;
    const itemId = target.dataset.itemId;
    const delta = Number(target.dataset.delta);
    if (this._tradeState[kind] === "sealing") return;
    const basket = this._baskets[kind];
    const current = basket.get(itemId) ?? 0;
    // A buy steps by the bundle (and a sold-back part-bundle), the only quantities it accepts; a
    // sale steps one at a time, up to what the seller owns.
    const next = this.#nextQuantity(kind, itemId, current, Math.sign(delta));
    if (next === current) return;
    if (next <= 0) basket.delete(itemId);
    else basket.set(itemId, next);
    this.#basketChanged(kind);
    this.render({ parts: ["body"] });
  }

  /**
   * Drops basket lines the tab no longer offers: the GM hid or delisted one, or the shop stopped
   * buying it, or a trim left it below the fewest worth a coin (`offered` maps each line still on
   * offer to that minimum). The engine would refuse them anyway, and a hidden item's name shouldn't
   * stay on the player's bill. Left alone while a seal is out or its stamp is showing.
   */
  #keepOffered(kind, offered) {
    if (isSettled(this._tradeState[kind])) return;
    const basket = this._baskets[kind];
    const gone = [...basket].filter(([id, quantity]) => !(quantity >= offered.get(id))).map(([id]) => id);
    for (const id of gone) basket.delete(id);
    if (gone.length) this.#shelfChanged(kind);
  }

  /**
   * The shelf (or the seller's pack) changed a basket under the player: a new bill, like any edit.
   * If that emptied it, an unanswered trade has most likely landed and moved those very items, and
   * there's nothing left to resend: its id goes, so a later bill isn't answered as that trade.
   */
  #shelfChanged(kind) {
    if (!this._baskets[kind].size) {
      this._tradeId[kind] = null;
      this._sent[kind].clear();
    }
    this.#basketChanged(kind);
  }

  /** What to ask before selling `itemId`: only an equipped or contained item needs asking; otherwise null. */
  #saleQuestion(itemId) {
    const item = this.#itemOf("sell", itemId);
    const key = item?.system?.equipped ? "ConfirmEquipped" : item?.system?.container ? "ConfirmContained" : null;
    if (!key) return null;
    const name = foundry.utils.escapeHTML?.(item.name) ?? item.name;
    return game.i18n.localize(`MERCHANT_PRESETS.Shop.Sell.${key}`, { name });
  }

  /** Asks the seller `question`; resolves true for yes. */
  #confirm(question) {
    return foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("MERCHANT_PRESETS.Shop.Sell.ConfirmTitle") },
      content: `<p>${question}</p>`
    });
  }

  /** A line's quantity after one step, skipping below the fewest worth a coin, both ways. */
  #nextQuantity(kind, itemId, current, delta) {
    const shelf = this.#shelfOf(kind, itemId);
    const next = stepQuantity(current, delta, shelf);
    const min = this._minQuantity[kind].get(itemId) ?? 1;
    if (next <= 0 || next >= min) return next;
    return delta > 0 && (shelf.infinite || min <= shelf.available) ? min : 0;
  }

  /**
   * A basket edit starts a new bill: it clears the last trade's outcome, its stamped bill and the
   * lines it struck. It keeps an unanswered trade's id (and its "no GM" state): that trade may
   * have landed, and only a resend under the same id lets the GM's side answer it as a repeat.
   */
  #basketChanged(kind) {
    this._tradeState[kind] = this._tradeId[kind] ? "no-gm" : "idle";
    this._sealed[kind] = null;
    this._struck[kind].clear();
    this._gone[kind] = [];
  }

  /** The item a basket line of `kind` names: the shop's for a buy, the buyer's own for a sale. */
  #itemOf(kind, itemId) {
    return this.#docOf(kind, itemId)?.toObject() ?? null;
  }

  /** The item document a basket line of `kind` names; its `name` is the one dnd5e shows players. */
  #docOf(kind, itemId) {
    const owner = kind === "buy" ? this.document : this.#resolveBuyer();
    return owner?.items?.get(itemId) ?? null;
  }

  /**
   * Drops basket lines whose item has gone (bought out, sold, deleted), and cuts a line to what's
   * left when someone else took some, so neither is sent as it stands. What's left is always a
   * quantity a buy accepts: whole bundles plus the line's own odd remainder.
   */
  #pruneBaskets() {
    for (const kind of ["buy", "sell"]) {
      // A bill that's out is settled by its answer (the trade itself moves these very items), and
      // a stamped one stays as it is until the player's next edit.
      if (isSettled(this._tradeState[kind])) continue;
      const basket = this._baskets[kind];
      let changed = false;
      const gone = [];
      for (const [itemId, quantity] of basket) {
        const fit = this.#itemOf(kind, itemId) ? fitQuantity(quantity, this.#shelfOf(kind, itemId)) : 0;
        if (fit === quantity) continue;
        if (fit > 0) basket.set(itemId, fit);
        else {
          basket.delete(itemId);
          // Someone else bought the last of it: the bill strikes it off rather than dropping it unseen.
          // Not while a trade of ours may have landed (unanswered): that could be its own doing.
          const priced = this._priced[kind].get(itemId);
          if (kind === "buy" && priced && !this._tradeId[kind]) gone.push(priced);
        }
        changed = true;
      }
      // A changed basket is a new bill: the last refusal and unanswered trade id were the old one's.
      if (changed) this.#shelfChanged(kind);
      if (gone.length) {
        this._gone[kind] = gone;
        this._tradeState[kind] = "stock-changed";
      }
    }
  }

  /** The stepper's limits for a line: a shop line's bundle, count and whether it runs out; for a sale, what the seller owns, one at a time. */
  #shelfOf(kind, itemId) {
    if (kind === "sell") return { bundle: 1, available: this.#itemOf("sell", itemId)?.system?.quantity ?? 0, infinite: false };
    const item = this.#itemOf("buy", itemId);
    if (!item) return { bundle: 1, available: 0, infinite: false };
    const stock = stockConfigOf(item);
    return {
      bundle: bundleFor(item, item, bundleOf),
      available: item.system?.quantity ?? 0,
      infinite: stock.service || (stock.infinite ?? worldInfiniteStock())
    };
  }

  /* -------------------------------------------------------------- sell tab */

  #sellContext(actor, config, rates, currencies, buyer, open) {
    const shopItems = actor.items.map(i => i.toObject());
    // Goods only: spells, features and the like are never traded, so they aren't "won't buy" rows,
    // and a used-up item (quantity 0) has nothing to sell.
    // In the seller's own order, as their inventory sorts it.
    const items = (buyer?.items ?? []).map(i => i.toObject()).filter(i => !isFixedExcluded(i) && (i.system?.quantity ?? 1) > 0)
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const rows = items.map(item => {
      const line = matchingStockLine(item, shopItems);
      const matched = stockConfigOf(line);
      // Anything inside counts, gear included: the engine refuses a sale of any non-empty container.
      const hasContents = item.type === "container" && (buyer?.items ?? []).some(i => i.system?.container === item._id);
      let row = sellRow(item, config, matched, rates, rates.deal, currencies, { hasContents, bundle: bundleFor(item, line, bundleOf) });
      // A matching shelf line with broken flags: the engine refuses the sale as shop-misconfigured.
      if (line && !safeStockOf(line)) row = { ...row, refusal: "General", bundlePriceCp: null, ratio: null };
      if (row.minQuantity) this._minQuantity.sell.set(item._id, row.minQuantity);
      let worthCp = null;
      try { worthCp = bundlePriceCp(item, 1, currencies); } catch { /* unpriced: no worth to state */ }
      const worthText = worthCp > 0 ? coinsText(coinBreakdown(worthCp, currencies)) : null;
      return {
        ...row,
        // The shown name; the source data (true name) only prices and matches, as the engine does.
        name: buyer.items.get(item._id)?.name ?? row.name,
        inspect: this.#inspect(item, "sell", buyer),
        // Grouped as a shelf groups its goods (design TGXBN): by kind of good.
        ...groupFields(item, null),
        // A Buy row's line (#177): the worth is the ratio chip's tooltip, not repeated here.
        meta: row.refusal === "Unidentified" ? game.i18n.localize("MERCHANT_PRESETS.Shop.Sell.Reason.UnidentifiedNote")
          : sellRowMeta(item, metaLabels(), metaWords, goodsWorld()),
        reason: row.refusal ? this.#refusalText(row.refusal, item, config) : null,
        worthText,
        worthTip: sellWorth(item, metaWords, worthText, { deal: !!row.tag?.text }),
        inBasket: this._baskets.sell.has(item._id),
        priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : [],
        listText: listText(row.listPriceCp, currencies)
      };
    });
    const willBuy = rows.filter(r => !r.refusal);
    // Settings' Won't buy preview (design dYANz): the first good taken, at its price and worth,
    // and the first turned away for what it is, with the reason.
    const taken = willBuy[0];
    const refused = rows.find(r => r.refusal === "General");
    const preview = [
      taken && { ...taken, showStock: true, tag: { text: taken.tag?.text ?? taken.ratio, tone: taken.tag?.text ? "good" : "ratio" },
        meta: taken.worthText ? game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Preview.Worth", { price: taken.worthText }) : null },
      refused && { ...refused, showStock: true, meta: refused.reason, metaDanger: true, priceCoins: [], tag: null, listText: null }
    ].filter(Boolean);
    const { categories, sections } = this.#grouped("sell", rows);
    this.#keepOffered("sell", new Map(willBuy.map(r => [r.id, r.minQuantity ?? 1])));
    const tillCp = totalCp(actor.system.currency ?? {}, currencies);
    // Purse-after is the seller's own purse plus the sale; the till only decides till-short, and
    // not at all under unlimited merchant coin (the trade engine's bottomless till).
    const purseCp = buyer ? totalCp(buyer.system.currency ?? {}, currencies) : 0;
    const { lines, totals } = this.#bill("sell", purseCp, currencies);
    const tillShort = game.settings.get(MODULE, "merchantPurse") !== "unlimited" && totals.sumCp > tillCp;
    const traded = this._tradeState.sell;
    const state = isSettled(traded) ? traded : !open ? "closed" : !buyer ? "no-buyer"
      : (tillShort ? "till-short" : traded);
    const seal = sealState(state, lines.length > 0, { gmOnline: !!game.users?.activeGM });
    const sumText = coinsText(coinBreakdown(totals.sumCp, currencies));
    const tillCapsSales = game.settings.get(MODULE, "merchantPurse") !== "unlimited";
    // What the till holds once it has paid this bill exactly (the engine's payExact).
    const paidOut = tillCapsSales && totals.sumCp > 0 ? payExact(actor.system.currency ?? {}, totals.sumCp, currencies) : null;
    return {
      kind: "sell",
      preview,
      shopTitle: titleParts(actor.name).title,
      sections,
      categories,
      activeCategory: categories.find(c => c.active),
      empty: !rows.length,
      packLabel: buyer ? game.i18n.localize("MERCHANT_PRESETS.Shop.Sell.Pack", { name: buyer.name }) : null,
      // How much of the till this bill takes, for the offer card's meter.
      meterPercent: tillCapsSales && tillCp > 0 ? Math.min(100, (totals.sumCp / tillCp) * 100) : null,
      tillAfterText: paidOut?.ok ? coinsText(heldCoins(paidOut.remaining, currencies)) : null,
      tillCp,
      // The coins the merchant holds, as the hero shows a purse: not the total re-split.
      tillCoins: heldCoins(actor.system.currency ?? {}, currencies),
      tillText: coinsText(coinBreakdown(tillCp, currencies)),
      // Under unlimited merchant coin the till is bottomless (the engine's own rule), so it caps nothing.
      tillCapsSales,
      basket: this.#billOfSale("sell", lines, totals, currencies, buyer, this._sealed.sell),
      slip: this.#slip("sell", state, seal, null, buyer, {
        tillText: coinsText(coinBreakdown(tillCp, currencies)),
        tillAfterText: paidOut?.ok ? coinsText(heldCoins(paidOut.remaining, currencies)) : null
      }),
      // A seal that's out or stamped stays on screen past closing, so its answer is seen.
      showClosed: !open && !isSettled(this._tradeState.sell),
      seal: {
        ...seal,
        state,
        label: seal.labelKey === "MERCHANT_PRESETS.Shop.Seal.Bargain"
          ? game.i18n.localize("MERCHANT_PRESETS.Shop.Seal.BargainSell", { price: sumText })
          : game.i18n.localize(seal.labelKey)
      },
      open
    };
  }

  /* -------------------------------------------------------------- basket / bill of sale */

  /**
   * The bill a tab shows, and its totals against `purseCp` (the buyer's or seller's own purse):
   * the stamped bill after a seal, since the trade has already moved its items and coin (the
   * purse shown is then simply what's in it now), else the live basket.
   */
  #bill(kind, purseCp, currencies) {
    const sealed = this._sealed[kind];
    if (sealed) return { lines: sealed.lines, totals: { sumCp: sealed.sumCp, afterCp: purseCp, shortfallCp: 0 } };
    const lines = this.#pricedLines(kind, currencies);
    return { lines, totals: basketTotals(lines, purseCp, kind) };
  }

  /**
   * The basket's own lines, already priced — `quantity`, the sticker price for one bundle
   * (`unitCoins`) and the whole line's cost (`lineTotalCp`/`lineTotalCoins`), floored once over
   * the full quantity rather than per bundle and multiplied (trade-plan.mjs's header, "Bundle
   * pricing for quantity units, floored once" — the same rule #102 prices a trade by). Basket
   * totals (`basketTotals`, shop-view.mjs) are computed from *these* lines, never the raw
   * itemId/quantity pairs `this._baskets` holds — those carry no price at all on their own.
   */
  #pricedLines(kind, currencies) {
    const world = worldOf().rates;
    const config = shopConfigOf(this.document);
    const shopItems = kind === "sell" ? this.document.items.map(i => i.toObject()) : null;
    const deal = this.#dealOf(this.#resolveBuyer());
    const lines = [];
    for (const [itemId, quantity] of this._baskets[kind]) {
      const item = this.#itemOf(kind, itemId);
      if (!item || quantity <= 0) continue;
      // A shop item carries its own #98 stock flag; an item on the buyer's side (a sale) never
      // does (see trade-plan.mjs's `copyOf`), so its line reads the shop's matching shelf line
      // instead — the same rule #102 prices a sale by.
      const line = kind === "buy" ? item : matchingStockLine(item, shopItems);
      const stock = stockConfigOf(line);
      const rates = effectiveRates(world, config.terms, categoryFor(item, stock), deal);
      const rate = kind === "buy" ? rates.sellsAt.rate : rates.buysAt.rate;
      const list = effectiveRates(world, config.terms, categoryFor(item, stock));
      const listRate = kind === "buy" ? list.sellsAt.rate : list.buysAt.rate;
      // trade-plan's own chain and line total, so the bill shows exactly what the trade charges.
      const bundle = bundleFor(item, line, bundleOf);
      let lineTotal = 0, bundleCp = null, listTotal = 0;
      try {
        lineTotal = lineTotalCp(item, rate, bundle, quantity, currencies);
        bundleCp = bundlePriceCp(item, rate, currencies);
        listTotal = lineTotalCp(item, listRate, bundle, quantity, currencies);
      } catch { /* unpriced: the add button is disabled for these, but never trust that alone */ }
      lines.push({
        // The shown name (an unidentified good's unidentified one); the source data prices the line.
        itemId, name: goodName({ ...item, name: this.#docOf(kind, itemId)?.name ?? item.name }), img: item.img, quantity, lineTotalCp: lineTotal, bundlePriceCp: bundleCp,
        struck: this._struck[kind].has(itemId),
        // The buyer's deal moved this line's total: the bill marks it as theirs. Compared in coin,
        // since a small deal on cheap goods can floor to the same total (#142 review).
        dealt: lineTotal !== listTotal,
        // The deal's real effect on this line, as the row's tag says it ("−10%", design Q6UvA), and
        // what the line would cost without it, for what the deal saves.
        dealTag: lineTotal !== listTotal && listRate ? signedPercent(rate / listRate - 1) : null,
        listTotalCp: listTotal,
        // The sticker price per bundle ("4 cp per 20"): a unit price would floor cheap goods to nothing.
        bundle,
        unitCoins: coinBreakdown(bundleCp ?? 0, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
        // The same sticker in words, as the bill's detail line writes it ("15 gp each").
        unitText: coinsText(coinBreakdown(bundleCp ?? 0, currencies)),
        // A bundle that floors to nothing has no sticker worth showing beside a real line total.
        showUnit: (bundleCp ?? 0) > 0 || lineTotal === 0,
        // What a service line does, in place of its unit price (design mRg3y).
        ...(mountNote(kind, item, this.#resolveBuyer()) ?? serviceNote(kind, item, stock, this.#resolveBuyer())),
        // A sale's detail says what share of the good's worth that is: "(½ of 15 gp)".
        ofList: kind === "sell" ? this.#ofListText(item, rate, currencies) : null,
        lineTotalCoins: coinBreakdown(lineTotal, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }))
      });
    }
    this._priced[kind] = new Map(lines.map(l => [l.itemId, l]));
    return lines;
  }

  /** "(½ of 15 gp)": a sale's rate over one bundle's list value; null for a good with no price. */
  #ofListText(item, rate, currencies) {
    let listCp = 0;
    try { listCp = bundlePriceCp(item, 1, currencies); } catch { /* unpriced */ }
    return listCp > 0 ? game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.OfList", {
      ratio: rateFraction(rate), list: coinsText(coinBreakdown(listCp, currencies))
    }) : null;
  }

  /** A pack row's refusal in words; a good the shop turns away names what ("Won't buy food and drink"). */
  #refusalText(refusal, item, config) {
    const what = refusal === "General" ? wontBuyReason(item, config) : null;
    if (!what) return game.i18n.localize(`MERCHANT_PRESETS.Shop.Sell.Reason.${refusal}`);
    const label = what.kind ? game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.Kinds.${what.kind}`)
      : game.i18n.localize(CONFIG.Item.typeLabels?.[what.type] ?? what.type);
    return game.i18n.localize("MERCHANT_PRESETS.Shop.Sell.Reason.WontBuyWhat", { what: label.toLowerCase() });
  }

  /**
   * `buyer`'s deal at this shop now, or null: the one the GM's trade prices by (deals.mjs
   * `activeDeal`, at the same world time), so a bill with a deal seals at the price it shows.
   */
  #dealOf(buyer) {
    return activeDeal(shopConfigOf(this.document), buyer?.uuid ?? null, game.time.worldTime);
  }

  #billOfSale(kind, lines, totals, currencies, buyer, sealed) {
    const sumCoins = coinBreakdown(totals.sumCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    // The purse as the trade will leave it, coin by coin; a bill the engine would refuse falls
    // back to the total, and its seal already says why.
    const till = game.settings.get(MODULE, "merchantPurse") === "unlimited" ? null : this.document.system.currency ?? {};
    // A sealed bill's purse is the purse now: the trade has already moved its coins.
    const after = buyer ? (sealed ? buyer.system.currency ?? {} : purseAfter(kind, buyer.system.currency ?? {}, totals.sumCp, till, currencies)) : null;
    const afterCoins = after ? heldCoins(after, currencies) : purseCoins(totals.afterCp, currencies);
    const shortfallCoins = coinBreakdown(totals.shortfallCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    // Lines that sold out while on the bill, struck off at the top: "—" in place of their price.
    const gone = sealed ? [] : this._gone[kind].map(l => ({
      name: l.name, quantity: l.quantity,
      pen: l.lineTotalCoins[0] ? `${COIN_METALS[l.lineTotalCoins[0].denomination] ?? l.lineTotalCoins[0].denomination} ${l.lineTotalCoins[0].count}` : "Price"
    }));
    // What the buyer's deal saved them on a purchase, or added to a sale (design Q6UvA).
    const listCp = lines.reduce((sum, l) => sum + (l.listTotalCp ?? l.lineTotalCp ?? 0), 0);
    const dealCp = kind === "buy" ? listCp - totals.sumCp : totals.sumCp - listCp;
    const dealText = dealCp > 0 ? game.i18n.localize(`MERCHANT_PRESETS.Shop.Deal.${kind === "buy" ? "Saves" : "Adds"}`,
      { amount: coinsText(coinBreakdown(dealCp, currencies)) }) : null;
    return {
      lines, gone, dealText,
      sumCoins, afterCoins, shortfallCoins,
      sumText: coinsText(sumCoins),
      afterText: coinsText(afterCoins),
      shortfallText: coinsText(shortfallCoins),
      buyerName: buyer?.name ?? null,
      hasLines: lines.length > 0 || gone.length > 0,
      // The docked bill's one line in a narrow window (design r7HIUl).
      summary: billSummary(lines),
      // The opened dock's heading (design mVjRf): how many lines the bill holds.
      lineCount: game.i18n.localize(`MERCHANT_PRESETS.Shop.Bill.${lines.length === 1 ? "OneLine" : "Lines"}`, { count: lines.length }),
      // A stamped bill keeps the date it sealed on; a live one reads the clock.
      dateLabel: sealed?.dateLabel ?? this.#worldDateLabel()
    };
  }

  /**
   * What the Bill of Sale shows around its lines in each Trade State (design WNYhA): its kicker, the
   * purse block (after the bargain, now, or short by), a notice and where it sits, what was
   * delivered, the stamp's date, and the foot.
   */
  #slip(kind, state, seal, basket, buyer, { tillText = null, tillAfterText = null } = {}) {
    const i18n = (key, data) => game.i18n.localize(`MERCHANT_PRESETS.Shop.${key}`, data);
    const name = buyer?.name ?? null;
    const sealed = this._sealed[kind];
    const gmOnline = !!game.users?.activeGM;
    let notice = null;
    if (state === "no-gm") notice = { tone: "warning", icon: "lucide:wifi-off", text: i18n(gmOnline ? "Seal.NoAnswerNotice" : "Seal.NoGmNotice") };
    else if (state === "till-short") notice = { tone: "danger", icon: "lucide:coins", text: i18n(kind === "sell" ? "Seal.TillShortNotice" : "Seal.TillShortBuyNotice", { amount: tillText }) };
    else if (state === "stock-changed") {
      const gone = this._gone[kind];
      notice = { tone: "warning", icon: "lucide:triangle-alert", first: true,
        text: gone.length === 1 ? i18n("Seal.SoldOutNotice", { name: gone[0].name }) : i18n("Seal.StockChangedNotice") };
    }
    const purse = !name ? null : state === "sealed" ? "now" : state === "cant-afford" ? "short"
      : (!seal.disabled || state === "sealing" || state === "no-gm") ? "after" : null;
    const foot = state === "sealing" ? i18n("Seal.WaitingFoot") : state === "cant-afford" ? i18n("Seal.CantAffordFoot")
      : ["sealed", "no-gm", "till-short"].includes(state) ? null
        : kind === "sell" && tillAfterText ? `${i18n("Bill.TillDrops", { amount: tillAfterText })}.` : null;
    let delivered = null;
    if (state === "sealed" && sealed) {
      const goods = sealed.lines.map(l => `${l.quantity} × ${l.name}`);
      const list = goods.length > 1 ? i18n("Bill.ListLast", { rest: goods.slice(0, -1).join(", "), last: goods.at(-1) }) : goods[0] ?? "";
      const one = sealed.lines.length === 1 && sealed.lines[0].quantity === 1;
      delivered = kind === "buy" ? i18n(one ? "Bill.DeliveredBuyOne" : "Bill.DeliveredBuyMany", { goods: list, name })
        : i18n(one ? "Bill.DeliveredSellOne" : "Bill.DeliveredSellMany", { goods: list, shop: titleParts(this.document.name).title });
    }
    return {
      kicker: state === "sealed" ? i18n("Bill.TitleSealed") : i18n(kind === "sell" ? "Bill.TitleSell" : "Bill.TitleBuy"),
      totalLabel: state === "sealed" ? i18n(kind === "sell" ? "Bill.Received" : "Bill.Paid") : i18n(kind === "sell" ? "Bill.YouReceive" : "Bill.SumOwed"),
      purse,
      purseLabel: purse === "now" ? i18n("Bill.PurseNow", { name }) : purse === "short" ? i18n("Bill.ShortLabel", { name }) : i18n("Bill.PurseAfter", { name }),
      notice,
      delivered,
      // No date without a clock (#149, design band 13).
      stampDate: sealed?.at != null && worldFollowsClock() ? this.#dayMonth(sealed.at) : "",
      foot
    };
  }

  /** The bill's date now: "14th of Mirtul · mid-morning" (design y6iNf); none without a clock (#149). */
  #worldDateLabel() {
    return worldFollowsClock() ? this.#billDateLabel(game.time.worldTime) : "";
  }

  /** "14th of Mirtul · mid-morning"; a festival day, in no month, as the calendar writes it. */
  #billDateLabel(time) {
    try {
      const calendar = game.time.calendar;
      const c = calendar.timeToComponents(time);
      const month = calendar.months?.values?.[c.month];
      if (!month) return this.#dateLabel(time);
      const day = c.dayOfMonth + 1;
      const ordinal = new Intl.PluralRules(game.i18n.lang, { type: "ordinal" }).select(day);
      return game.i18n.localize("MERCHANT_PRESETS.Shop.Bill.Date", {
        day: game.i18n.localize(`MERCHANT_PRESETS.Shop.Ordinal.${ordinal}`, { n: day }),
        month: game.i18n.localize(month.name),
        part: game.i18n.localize(`MERCHANT_PRESETS.Shop.Day.${partOfDay(c.hour, calendar.days.hoursPerDay)}`)
      });
    } catch { return this.#dateLabel(time); }
  }

  #dateLabel(time) {
    try { return game.time.calendar.format(time, "timestamp"); }
    catch { return ""; }
  }

  /* -------------------------------------------------------------- sealing */

  static async #onSeal(_event, _target) {
    const kind = this.tabGroups.primary;
    // The button disables on the re-render, but a second click can land before that does.
    if (this._tradeState[kind] === "sealing") return;
    this.#pruneBaskets();
    const lines = this.#pricedLines(kind, CONFIG.DND5E.currencies);
    if (!lines.length) { this.render({ parts: ["body"] }); return; }
    this._tradeState[kind] = "sealing";
    this._struck[kind].clear();
    this._gone[kind] = [];
    this.render({ parts: ["body"] });

    // The GM's side resolves both actors by uuid (a shop can be an unlinked token's), and checks
    // each line against the bundle price this bill showed (#102: "stock-changed").
    const request = {
      tradeId: this._tradeId[kind] ??= foundry.utils.randomID(), kind, shopUuid: this.document.uuid, buyerUuid: this._buyerUuid,
      lines: lines.map(({ itemId, quantity, bundlePriceCp }) =>
        ({ itemId, quantity, ...(bundlePriceCp != null && { expectedBundlePriceCp: bundlePriceCp }) }))
    };
    for (const line of lines) this._sent[kind].set(line.itemId, line);
    const api = game.modules.get(MODULE).api;

    if (!api?.trade) {
      this._tradeState[kind] = "no-gm";
      this.render({ parts: ["body"] });
      return;
    }
    try {
      const result = await api.trade(request);
      // Sealed or refused, this trade is settled; only an unanswered one keeps its id for a retry.
      const sent = this._sent[kind];
      if (result.status === "sealed" || result.status === "refused") {
        this._tradeId[kind] = null;
        this._sent[kind] = new Map();
      }
      if (result.status === "sealed") {
        // A resent id is answered with the first outcome (#102), which can differ from this
        // request's lines: the stamp shows what the GM reports it carried out, and only those
        // lines leave the basket.
        const carried = Array.isArray(result.lines) ? this.#carriedLines(result.lines, sent) : lines;
        this._tradeState[kind] = "sealed";
        this._sealed[kind] = {
          lines: carried, sumCp: basketTotals(carried, 0, kind).sumCp, receipt: result.receipt ?? null,
          dateLabel: this.#worldDateLabel(), at: game.time.worldTime
        };
        for (const line of carried) {
          const left = (this._baskets[kind].get(line.itemId) ?? 0) - line.quantity;
          if (left > 0) this._baskets[kind].set(line.itemId, left);
          else this._baskets[kind].delete(line.itemId);
        }
      } else if (result.status === "refused") {
        this._tradeState[kind] = result.reason;
        // The bill re-prices from the live shop on the render below; strike what moved so the
        // player sees which lines they're now agreeing to at a new price.
        if (result.reason === "stock-changed" && Array.isArray(result.lines)) {
          const sent = new Map(request.lines.map(l => [l.itemId, l.expectedBundlePriceCp]));
          for (const fresh of result.lines) {
            if (sent.get(fresh.itemId) !== fresh.bundlePriceCp) this._struck[kind].add(fresh.itemId);
          }
        }
      } else {
        // "unconfirmed" (the query timed out) reads the same as no GM connected — the spike's
        // own finding (spike/FINDINGS.md, Q4): a timeout means "unconfirmed", never "failed".
        this._tradeState[kind] = "no-gm";
      }
    } catch (err) {
      console.error(`${MODULE} | trade request failed`, err);
      this._tradeState[kind] = "no-gm";
    }
    this.render({ parts: ["body"] });
  }

  /** The bill lines for what a sealed answer says was traded, named from the lines sent under its id. */
  #carriedLines(resultLines, sent) {
    const currencies = CONFIG.DND5E.currencies;
    return resultLines.map(({ itemId, quantity, lineTotalCp: totalCp }) => {
      const known = sent.get(itemId);
      const total = totalCp ?? known?.lineTotalCp ?? 0;
      return {
        ...known, itemId, quantity, lineTotalCp: total, name: known?.name ?? itemId, img: known?.img ?? "",
        unitCoins: known?.unitCoins ?? [], struck: false,
        lineTotalCoins: coinBreakdown(total, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }))
      };
    });
  }

  static #onKeepShopping(_event, _target) {
    const kind = this.tabGroups.primary;
    // The sealed lines already left the basket; anything still in it wasn't traded and stays.
    this.#basketChanged(kind);
    this.render({ parts: ["body"] });
  }

  /* -------------------------------------------------------------- settings tab (#110) */

  /**
   * The config the shop's preset merchant ships with: what Reset to preset puts back, and where a
   * shop that keeps hours again takes them from. The preset is the merchant an NPC was set up from
   * (`shop.source`, #57), else the pack entry the shop was imported from, which core records in
   * `_stats.compendiumSource` (a pack import leaves `source` null). Null when there's neither, or
   * it can't be found or read.
   */
  async #presetShop(shop) {
    return (await this.#preset(shop))?.shop ?? null;
  }

  /** The merchant this shop was made from, and its shop config: null when it has none, or it's gone or broken. */
  async #preset(shop) {
    const uuid = shop.source ?? this.document._stats?.compendiumSource;
    if (!uuid) return null;
    const merchant = await Promise.resolve(fromUuid(uuid)).catch(() => null);
    const preset = merchant?.flags?.[MODULE]?.shop;
    return validateShop(preset).ok ? { merchant, shop: shopFrom(preset) } : null;
  }

  /**
   * The Restock section's preset line (design aaJcp): "Preset default for a Town shop: 7 days
   * (Village: 14 days)". The other tiers are the same merchant's in its compendium, read off the
   * pack's index; a preset whose name carries no tier reads "Preset default: 7 days".
   */
  async #presetLine(merchant, preset, pillLabel) {
    const label = restock => pillLabel(restock?.onOpen === false ? "never" : restock?.every ?? "never");
    const { title, tierFromName: tier } = titleParts(merchant.name);
    let tiers = [];
    const pack = merchant.pack ? game.packs?.get(merchant.pack) : null;
    if (tier && pack) {
      try {
        const index = await pack.getIndex({ fields: [`flags.${MODULE}.shop.restock`] });
        tiers = [...index].map(e => ({ ...titleParts(e.name), restock: foundry.utils.getProperty(e, `flags.${MODULE}.shop.restock`) }))
          .filter(e => e.title === title && e.tierFromName && e.restock)
          .map(e => ({ tier: e.tierFromName, every: label(e.restock) }));
      } catch { /* the line names the preset's own schedule alone */ }
    }
    const line = presetSchedule({ tier, every: label(preset.restock) }, tiers);
    const key = "MERCHANT_PRESETS.Shop.Settings.Restock";
    const others = line.others.map(o => game.i18n.localize(`${key}.PresetOther`, o)).join(", ");
    return tier
      ? game.i18n.localize(`${key}.PresetTier`, { tier, every: line.every, others: others ? ` (${others})` : "" })
      : game.i18n.localize(`${key}.Preset`, { every: line.every });
  }

  /** "14 Mirtul at 7:00" (design aaJcp): the day, its month and the time of day. */
  #dayMonthTime(time) {
    try {
      const c = game.time.calendar.timeToComponents(time);
      return game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.At", { date: this.#dayMonth(time), time: this.#formatTime({ hour: c.hour, minute: c.minute }) });
    } catch { return this.#dateLabel(time); }
  }

  /** The GM's Settings tab: `shop` is the shop's own config, `world` the world's rates. */
  async #settingsContext(actor, shop, world, header) {
    const i18n = key => game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.${key}`);
    const presetOf = await this.#preset(shop);
    const preset = presetOf?.shop ?? null;
    const typeLabel = type => game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type);
    const effective = effectiveRates(world, shop.terms);
    const rate = side => ({
      percent: percentOf(shop.terms[side] ?? world[side]),
      worldDefault: shop.terms[side] === null
    });

    const ruleChoices = this.#ruleChoices(actor, shop);

    const table = shop.restock.table ? await Promise.resolve(fromUuid(shop.restock.table)).catch(() => null) : null;
    const { chip, formula } = everyChoice(shop.restock);
    // As the schedule's pills name it ("7 days"): the preset line (design aaJcp).
    const pillLabel = every => (every === "never" ? i18n("Restock.Never") : every === 1 ? i18n("Restock.Daily")
      : Number.isInteger(every) ? game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.Days", { days: every }) : String(every));
    const everyLabel = every => (every === "never" ? i18n("Restock.Never")
      : every === 1 ? i18n("Restock.Daily")
        : game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.EveryDays", { days: every }));
    const schedule = actor.flags?.[MODULE]?.schedule;
    // Whatever drew the shelf last, Restock now included, fresh stock or not; the schedule's own
    // record before #145.
    const lastRestock = actor.flags?.[MODULE]?.lastRestockAt ?? schedule?.lastRestock ?? null;
    // Players the GM gave their own level: the switch sets only the default, so they keep it.
    const visitOthers = Object.entries(actor.ownership ?? {}).filter(([id, level]) => {
      const user = id !== "default" && game.users?.get(id);
      return user && !user.isGM && level > NONE;
    }).length;
    const currencies = CONFIG.DND5E.currencies;
    const coins = cp => coinBreakdown(cp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    const unlimited = game.settings.get(MODULE, "merchantPurse") === "unlimited";
    // One coin's icon and name, for a field that holds a count of it.
    const coinsOf = denomination => {
      const c = currencies[denomination];
      return c ? { denomination, abbreviation: c.abbreviation ?? denomination, icon: c.icon, label: c.label } : null;
    };
    // The first good on the Buy list, the design's Longsword: the Terms example prices it, and
    // Players see shows it as everyone sees it and as each deal's character does.
    const sample = this.#previewRow(actor, shop, world, null, currencies);
    // With no good to price, the Terms popover's 15 gp longsword at the shop's own rates.
    const fixed = rate => {
      try { return coins(itemPriceCp({ value: 15, denomination: "gp" }, rate, 1, currencies)); }
      catch { return []; }
    };
    let example = { text: i18n("Terms.ExampleSells"), sell: fixed(effective.sellsAt.rate), buy: fixed(effective.buysAt.rate) };
    if (sample) {
      try {
        example = {
          text: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Terms.ExampleItem", { item: sample.name, price: listText(bundlePriceCp(sample.data, 1, currencies), currencies) }),
          sell: sample.priceCoins,
          buy: coins(bundlePriceCp(sample.data, effectiveRates(world, shop.terms, sample.category).buysAt.rate, currencies))
        };
      } catch { /* unpriced at list: the fixed example stands */ }
    }

    return {
      // A config that failed validation shows the defaults here; editing is refused (see `#edit`).
      broken: !safeShopOf(actor),
      // One page: the nav jumps to a section, and marks the one last jumped to.
      sections: SETTINGS_SECTIONS.map(s => ({ ...s, label: i18n(`Sections.${s.id}`), active: s.id === this._settingsSection })),
      // The narrow window's section dropdown shows the one jumped to (design bXBEW).
      get activeSection() { return this.sections.find(s => s.active) ?? this.sections[0]; },
      previewOpen: this._previewOpen,
      // Within reach (#166) the shop stays None and the switch is the GM's own flag, on until set
      // off; from anywhere it's the default ownership, as #110 wrote it.
      visit: accessModeOf(game.settings.get(MODULE, "shopAccess")) === "reach"
        ? actor.flags?.[MODULE]?.visibility !== false
        : (actor.ownership?.default ?? NONE) >= LIMITED,
      // "Entirely" holds only while no player has access of their own; then the hint says so.
      visitHint: i18n(visitOthers ? "Visit.Hint" : "Visit.HintAll"),
      visitOthers,
      terms: {
        // In words, what the shop actually charges and pays: capped, as the chip and trades are.
        sells: { ...rate("sellsAt"), word: termsWord(effective.sellsAt.rate, "sell") },
        buys: { ...rate("buysAt"), word: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Terms.OfValue", { fraction: rateFraction(effective.buysAt.rate) }) },
        example,
        rules: shop.terms.categories.map(c => {
          // A side the rule leaves to the shop shows blank, with what that side really trades at as
          // its placeholder: the shop's rate, capped as trades cap it.
          const traded = effectiveRates(world, shop.terms, c.category);
          return {
            category: c.category, label: WONT_BUY_TYPES.includes(c.category) ? typeLabel(c.category) : c.category,
            sellsPercent: c.sellsAt === null ? "" : percentOf(c.sellsAt), sellsFollows: percentOf(traded.sellsAt.rate),
            buysPercent: c.buysAt === null ? "" : percentOf(c.buysAt), buysFollows: percentOf(traded.buysAt.rate)
          };
        }),
        ruleChoices
      },
      // Three to a row, as the checks are drawn (design dYANz).
      wontBuy: {
        types: inRows(WONT_BUY_TYPES.map(value => ({ value, label: typeLabel(value), checked: shop.wontBuy.types.includes(value) })), 3),
        kinds: inRows(WONT_BUY_KINDS.map(value => ({ value, label: i18n(`Kinds.${value}`), checked: shop.wontBuy.kinds.includes(value) })), 3)
      },
      hours: {
        keeps: shop.hours !== null,
        open: shop.hours ? timeText(shop.hours.open) : "",
        close: shop.hours ? timeText(shop.hours.close) : "",
        length: this.#openLength(shop.hours),
        worldOff: !game.settings.get(MODULE, "tradingHours"),
        // Shops don't follow the world clock (#149, design RRqQ7): a note, and the controls dimmed.
        noClock: !worldFollowsClock()
      },
      restock: {
        table: table ? { name: table.name, uuid: table.uuid, meta: this.#tableMeta(table, shop) } : null,
        chips: [...EVERY_CHOICES.map(String), "dice", "never"].map(id => ({
          // "Dice…" just picked, no formula saved yet: it's the one lit.
          id, active: this._everyDice ? id === "dice" : id === chip,
          label: id === "dice" ? i18n("Restock.Dice") : id === "never" ? everyLabel("never")
            : id === "1" ? everyLabel(1) : game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.Days", { days: id })
        })),
        showFormula: chip === "dice" || this._everyDice,
        formula,
        current: chip === "never" ? everyLabel("never") : everyLabel(shop.restock.every),
        presetLine: presetOf ? await this.#presetLine(presetOf.merchant, preset, pillLabel) : null,
        reroll: shop.restock.mode === "reroll",
        purseGp: actor.flags?.[MODULE]?.purse ?? null,
        last: lastRestock != null ? this.#dayMonthTime(lastRestock) : null,
        next: this.#nextRestockAt(actor, shop) != null ? this.#nextLine(schedule.dueAt) : null,
        autoOff: !game.settings.get(MODULE, "autoRestock"),
        noClock: !worldFollowsClock()
      },
      // The coins the shop holds and what a restock refills them to (#147, design U0HcWc); under
      // unlimited merchant coin a note, the fields dimmed (design Yusa2).
      till: {
        unlimited,
        coins: Object.entries(currencies).map(([denomination, c]) => {
          const coin = { denomination, count: actor.system.currency?.[denomination] ?? 0, abbreviation: c.abbreviation ?? denomination, icon: c.icon, label: c.label };
          return { ...coin, aria: coinAriaLabel(coin) };
        }),
        purseGp: Number.isFinite(actor.flags?.[MODULE]?.purse) ? actor.flags[MODULE].purse : null,
        presetGp: Number.isFinite(presetOf?.merchant?.flags?.[MODULE]?.purse) ? presetOf.merchant.flags[MODULE].purse : null,
        gold: coinsOf("gp")
      },
      deals: { list: shop.deals.map(d => this.#dealCard(d)) },
      canReset: !!preset,
      // What players see at these terms: the header chip and its worked example, then each deal in
      // force as its own character sees it.
      preview: {
        // Jumped to Restock, Players see shows the shelf after one (design aaJcp); to Hours, the
        // header chip at an open hour and a closed one (design S2swP). Won't buy's is Aria's Sell
        // tab, added once that is built (_prepareContext).
        // Not without a world clock (#149): no badge or chip would show, so the terms do instead.
        restock: this._settingsSection === "restock" && worldFollowsClock() ? this.#restockPreview(actor, shop, world, currencies) : null,
        hours: this._settingsSection === "hours" ? this.#hoursPreview(shop.hours) : null,
        // The Sell tab's till card as players get it, with no bill on it: none under unlimited coin.
        till: this._settingsSection === "till" ? { card: unlimited ? null : { coins: heldCoins(actor.system.currency ?? {}, currencies) } } : null,
        chip: header.termsChipBase,
        // The narrow window's docked Players see, in one line: the chip, then each deal in force.
        line: [header.termsChipBase, ...shop.deals.filter(d => d.buy && activeDeal(shop, d.actor, game.time.worldTime))
          .map(d => `${d.name} ${signedPercent(d.buy)}`)].join(" · "),
        item: sample,
        example,
        // Only a deal that moves a Buy-list price: the preview's row is one (design: Aria's, not
        // Tomas's, whose deal is on what the shop pays him).
        deals: shop.deals.filter(d => d.buy && activeDeal(shop, d.actor, game.time.worldTime)).map(d => ({
          name: d.name,
          chip: dealChip(header.termsChipBase, d, world, shop.terms),
          item: this.#previewRow(actor, shop, world, d, currencies),
          exampleSell: this.#exampleSell(world, shop, d)
        }))
      }
    };
  }

  /** "12 hours a day" (design S2swP): how long the shop keeps open; null without hours. */
  #openLength(hours) {
    const minutes = openMinutes(hours, game.time.calendar.days);
    if (!minutes) return null;
    const perHour = game.time.calendar.days.minutesPerHour;
    const key = "MERCHANT_PRESETS.Shop.Settings.Hours";
    return minutes % perHour ? game.i18n.localize(`${key}.PerDayMinutes`, { hours: Math.floor(minutes / perHour), minutes: minutes % perHour })
      : game.i18n.localize(`${key}.PerDay`, { hours: minutes / perHour });
  }

  /** Players see, jumped to Hours (design S2swP): the open chip at an open hour, the closed chip at a closed one. */
  #hoursPreview(hours) {
    // No clock (#149, design RRqQ7): no chips to show, only the note.
    if (!worldFollowsClock()) return { samples: [], noClock: true };
    if (!hours) return null;
    const calendar = game.time.calendar.days;
    const { open, closed } = hoursSamples(hours, this.#minuteOfDay(), calendar);
    const at = minute => {
      const time = { hour: Math.floor(minute / calendar.minutesPerHour), minute: minute % calendar.minutesPerHour };
      return game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Preview.At", { time: timeText(time) });
    };
    const samples = [{ pen: "Open", state: "open", label: at(open),
      chip: game.i18n.localize("MERCHANT_PRESETS.Shop.OpenUntil", { time: this.#formatTime(hours.close) }) }];
    if (closed !== null) samples.push({ pen: "Closed", state: "closed", label: at(closed),
      chip: game.i18n.localize("MERCHANT_PRESETS.Shop.ClosedOpensAt", { time: this.#formatTime(hours.open) }) });
    return { samples };
  }

  /** What a new category rule can price: an item type, or a category the GM named on a shelf line, with no rule yet. */
  #ruleChoices(actor, shop) {
    const ruled = new Set(shop.terms.categories.map(c => c.category));
    const named = actor.items.map(i => safeStockOf(i)?.category).filter(Boolean);
    const typeLabel = type => game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type);
    return [...new Set([...WONT_BUY_TYPES, ...named])].filter(c => !ruled.has(c))
      .map(value => ({ value, label: WONT_BUY_TYPES.includes(value) ? typeLabel(value) : value }));
  }

  /**
   * The first good on the Buy list that has a price, as `deal`'s character sees it (everyone, with
   * no deal): the Settings preview's row. Null when the shelf has none.
   */
  #previewRow(actor, shop, world, deal, currencies) {
    const rates = { world, shopTerms: shop.terms, chipSellsAt: effectiveRates(world, shop.terms).sellsAt.rate };
    for (const { data, stock } of this.#shelf(actor)) {
      const row = buyRow(data, stock, rates, deal, currencies, worldInfiniteStock(), bundleOf);
      if (row.unpriced || row.worthless) continue;
      return {
        data, name: row.name, img: row.img, category: row.category, tag: row.tag,
        priceCoins: coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
        listText: listText(row.listPriceCp, currencies)
      };
    }
    return null;
  }

  /**
   * Players see, jumped to Restock (design aaJcp): the Fresh chip, how long it lasts, and the goods
   * marked New with the first good after them, each with its stock, as players see them after a
   * restock (#152).
   */
  #restockPreview(actor, shop, world, currencies) {
    const hours = closingHours(shop);
    // New as the last restock left the shelf: the goods it brought back, and any still New then.
    const at = actor.flags?.[MODULE]?.restockedAt ?? game.time.worldTime;
    const shelf = actor.flags?.[MODULE]?.shelf;
    const keepsHours = nextCloseAt(hours, game.time.worldTime, game.time.calendar.days) !== null;
    const rates = { world, shopTerms: shop.terms, chipSellsAt: effectiveRates(world, shop.terms).sellsAt.rate };
    const rows = [];
    for (const { data, stock } of this.#shelf(actor)) {
      const row = buyRow(data, stock, rates, null, currencies, worldInfiniteStock(), bundleOf);
      if (row.unpriced || row.worthless) continue;
      rows.push({
        name: row.name, img: row.img, meta: stockWords(row.stock), tag: row.tag,
        isNew: worldFollowsClock() && isNewGood(data, shelf, at, hours, game.time.calendar.days),
        priceCoins: coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
        listText: listText(row.listPriceCp, currencies)
      });
    }
    const shown = rows.filter(r => r.isNew).slice(0, 2);
    const first = rows[0];
    if (first && !shown.includes(first)) shown.push(first);
    const key = "MERCHANT_PRESETS.Shop.Settings.Preview";
    return {
      label: game.i18n.localize(`${key}.${keepsHours ? "AfterRestock" : "AfterRestockDay"}`),
      rows: shown,
      note: game.i18n.localize(`${key}.${keepsHours ? "RestockNote" : "RestockNoteDay"}`)
    };
  }

  /** The stock table card's second line (design aaJcp): how many goods it lists, and how many of each a restock stocks. */
  #tableMeta(table, shop) {
    const count = table.results?.size ?? table.results?.length ?? 0;
    const formula = commonFormula(shop.restock.quantities);
    const key = "MERCHANT_PRESETS.Shop.Settings.Restock";
    return formula ? game.i18n.localize(`${key}.TableMeta`, { count, formula }) : game.i18n.localize(`${key}.TableMetaOne`, { count });
  }

  /** "Next: 21 Mirtul at 7:00, in 7 days" (design aaJcp). */
  #nextLine(dueAt) {
    const days = daysUntil(game.time.worldTime, dueAt, game.time.calendar.days);
    const key = "MERCHANT_PRESETS.Shop.Settings.Restock";
    const when = days <= 0 ? game.i18n.localize(`${key}.Today`) : days === 1 ? game.i18n.localize(`${key}.Tomorrow`)
      : game.i18n.localize(`${key}.InDays`, { count: days });
    return game.i18n.localize(`${key}.Next`, { date: this.#dayMonthTime(dueAt), when });
  }

  /** One deal as the Deals section lists it (design v8ap9): who, what it changes, the note and its end. */
  #dealCard(deal) {
    const ended = !!deal.ends && deal.ends.at <= game.time.worldTime;
    return {
      actor: deal.actor,
      name: deal.name,
      initial: (deal.name || "?").charAt(0).toUpperCase(),
      badges: [
        deal.buy ? game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Deals.Buying", { percent: signedPercent(deal.buy) }) : null,
        deal.sell ? game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Deals.Selling", { percent: signedPercent(deal.sell) }) : null
      ].filter(Boolean),
      line: [deal.note, this.#endLabel(deal)].filter(Boolean).join(" · "),
      ended
    };
  }

  /** When a deal ends, in words: never, when the shop closes, on a date, or when it did (design Q6UvA). */
  #endLabel(deal) {
    const i18n = key => game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.Deals.${key}`);
    if (!deal.ends) return i18n("NoEnd");
    if (deal.ends.at <= game.time.worldTime) {
      return game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.Deals.${deal.ends.when === "close" ? "EndedClose" : "EndedOn"}`,
        { date: this.#dayMonth(deal.ends.at) });
    }
    if (deal.ends.when === "close") return i18n("UntilClose");
    return game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Deals.Until", { date: this.#dateLabel(deal.ends.at) });
  }

  /** The Terms example (a 15 gp longsword) at a deal's price, for the preview. */
  #exampleSell(world, shop, deal) {
    let cp = 0;
    try { cp = itemPriceCp({ value: 15, denomination: "gp" }, effectiveRates(world, shop.terms, null, deal).sellsAt.rate, 1, CONFIG.DND5E.currencies); }
    catch { /* no "gp" in this world's currencies */ }
    return coinBreakdown(cp, CONFIG.DND5E.currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
  }

  /**
   * One Settings-tab control changed (`control` is the input, select or checkbox; its `data-op`
   * names the edit). GM only: the tab never renders for a player, and a player's own client
   * couldn't write the shop anyway.
   */
  async _onSettingChange(control) {
    if (!game.user.isGM) return;
    const { op, side, list, end } = control.dataset;
    // Read now, while the control still holds what the GM set; applied when its turn comes.
    const value = control.value, checked = control.checked;
    if (op === "visit") {
      // The GM's own choice, which placing a token never overrides again (`makeVisitable`). Within
      // reach (#166) on is "at the counter", so the default stays None either way.
      const reach = accessModeOf(game.settings.get(MODULE, "shopAccess")) === "reach";
      await this.#queue(() => this.document.update({ "ownership.default": checked && !reach ? LIMITED : NONE, [`flags.${MODULE}.visibility`]: checked }));
      return;
    }
    if (op === "till" || op === "purse") return this.#setTill(op, control.dataset.denomination, value, settingSelector(control));
    const change = {
      rate: () => ({ op, side, percent: typedNumber(value) }),
      // Unticked, the rate keeps the figure it showed: the world's, now the shop's own.
      rateDefault: () => ({ op: "rate", side, percent: checked ? null : percentOf(worldOf().rates[side]) }),
      // Left blank, the rule's side follows the shop's rate again.
      ruleRate: () => ({ op, category: control.dataset.category, side, percent: value.trim() === "" ? null : typedNumber(value) }),
      wontBuy: () => ({ op, list, value: control.dataset.value, on: checked }),
      keepHours: async shop => ({ op, on: checked, fallback: (await this.#presetShop(shop))?.hours ?? SHOP_DEFAULTS.hours }),
      hour: () => ({ op, end, time: value }),
      every: () => ({ op, every: value.trim() }),
      mode: () => ({ op, mode: value })
    }[op];
    // The schedule's select (design aaJcp) offers what its pills do: the same choice.
    if (op === "everyChoice") return ShopSheet.#onSetEvery.call(this, null, { dataset: { every: value } });
    if (change) await this.#edit(change, settingSelector(control));
  }

  /**
   * A Till field left (#147): a count of one coin the shop holds, written to its own currency, or
   * what a restock refills the gold to (`flags.merchant-presets.purse`, schedule.mjs). A count that
   * isn't a whole number of coins is refused and the field put back; under unlimited merchant coin
   * the fields are disabled, and a write that gets through anyway is dropped.
   */
  #setTill(op, denomination, value, field) {
    return this.#queue(async () => {
      if (game.settings.get(MODULE, "merchantPurse") === "unlimited") return;
      const count = wholeCoins(value);
      const key = op === "purse" ? `flags.${MODULE}.purse`
        : denomination in CONFIG.DND5E.currencies ? `system.currency.${denomination}` : null;
      if (!key) return;
      if (count === null) {
        ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Till.Invalid"));
        this._resetTyping = field;
        this.render({ parts: ["body"] });
        return;
      }
      await this.document.update({ [key]: count });
    }, field);
  }

  /**
   * Queues one edit of the shop's config: `makeChange(shop)` gives the `applyChange` change, or
   * null for none. Each edit reads the config only once the edit before it has landed, so two
   * quick edits (leaving one field for a checkbox) can't each write over the other with what
   * they read before either saved (#140 review). A config that can't be read is left alone: the
   * edit would write the defaults over it, a 1.x shop's migration marker included.
   */
  #edit(makeChange, field = null) {
    return this.#queue(async () => {
      const shop = safeShopOf(this.document);
      if (!shop) {
        ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Broken"));
        return;
      }
      const change = await makeChange(shop);
      if (!change) return;
      const result = applyChange(shop, change);
      if (!result.ok) {
        ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Invalid", { errors: result.errors.join("; ") }));
        this._resetTyping = field;   // puts that field back, even one still focused (an alt-tab)
        this.render({ parts: ["body"] });
        return;
      }
      if (change.op === "every") this._everyDice = false;
      // Replaced, not merged: a merge would keep a removed rule's or quantity formula's old keys.
      await this.document.update({ [`flags.${MODULE}.shop`]: _replace(result.shop) });
    }, field);
  }

  /**
   * Runs `task`, a Settings-tab write, after every one queued before it. Never rejects: a write
   * the server refuses is said, and the control put back to what the shop still holds; the next
   * write still runs, and the control's listener has nothing to catch. `field` is the selector of
   * the typed field the write came from: only that one is put back, not another the GM has since
   * moved on to and is typing in.
   */
  #queue(task, field = null) {
    this._edits = (this._edits ?? Promise.resolve()).then(task).catch(err => {
      console.error(`${MODULE} | a shop setting wasn't saved`, err);
      ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.SaveFailed"));
      this._resetTyping = field;
      this.render({ parts: ["body"] });
    });
    return this._edits;
  }

  /** Settings is one page (design v8ap9): the nav scrolls its section into view and marks it. */
  static #onSettingsSection(_event, target) {
    this.#jumpToSection(target.dataset.section);
  }

  /** A narrow window's Players see, shown in place of the form or put back in its dock (design bXBEW). */
  static #onTogglePreview() {
    this._previewOpen = !this._previewOpen;
    this.render({ parts: ["body"] });
  }

  /**
   * The GM scrolled the Settings form (#172): mark the section now being read (shop-view.mjs
   * `currentSection`) in the nav and the narrow dropdown straight away, and once scrolling stops,
   * re-render so Players see shows that section's own view and the dropdown its icon. A section a
   * click pinned stays marked until the GM scrolls by hand: the jump's own scroll, and the scroll
   * a render puts back, mark nothing else (#173 review).
   */
  #followScroll(form) {
    if (this._pinnedSection) return;
    const pad = parseFloat(getComputedStyle(form).scrollPaddingTop) || 0;
    const formTop = form.getBoundingClientRect().top;
    const sections = [...form.querySelectorAll(".settings-section[data-section]")]
      .map(el => ({ id: el.dataset.section, top: el.getBoundingClientRect().top - formTop + form.scrollTop }));
    const id = currentSection(sections, { scrollTop: form.scrollTop, clientHeight: form.clientHeight, scrollHeight: form.scrollHeight, pad });
    if (!id || id === this._settingsSection) return;
    this._settingsSection = id;
    this.#markSection(id);
    this._settlePending = true;
    this.#deferSettle();
  }

  /**
   * (Re)starts the wait before the settled re-render (#172): every scroll event pushes it back, so
   * it runs once scrolling has stopped for 200 ms, never mid-momentum (#173 review). Nothing to
   * catch up, nothing to wait for.
   */
  #deferSettle() {
    if (!this._settlePending) return;
    clearTimeout(this._settleTimer);
    this._settleTimer = setTimeout(() => {
      this._settlePending = false;
      // Never under a GM's typing: the next render catches the preview up. Only a field counts: a nav
      // link still focused from its click isn't typing (#173 live check).
      const focused = document.activeElement;
      const typing = focused?.matches?.("input, select, textarea") && this.element.querySelector(".settings-tab")?.contains(focused);
      if (!this.rendered || typing) return;
      this.render({ parts: ["body"] });
    }, 200);
  }

  /** Marks `sectionId` in the side nav, and names it in the narrow window's dropdown. */
  #markSection(sectionId) {
    for (const link of this.element.querySelectorAll(".mp-nav-link")) link.classList.toggle("active", link.dataset.section === sectionId);
    const select = this.element.querySelector(".mp-section-native");
    if (!select) return;
    select.value = sectionId;
    const label = select.selectedOptions[0]?.textContent ?? "";
    select.setAttribute("aria-label", label);
    const shown = select.closest(".mp-category-select")?.querySelector(".mp-cat-value");
    if (shown) shown.textContent = label;
  }

  /** Scrolls the form to `section` and marks it in the nav and the narrow dropdown. */
  #jumpToSection(sectionId, { fromDropdown = false } = {}) {
    const previous = this._settingsSection;
    const changed = previous !== sectionId;
    this._settingsSection = sectionId;
    // Marked until the GM scrolls by hand, however long this jump's scroll and render take (#173 review).
    this._pinnedSection = sectionId;
    this._settlePending = false;
    clearTimeout(this._settleTimer);
    for (const link of this.element.querySelectorAll(".mp-nav-link")) link.classList.toggle("active", link.dataset.section === sectionId);
    // Only the form scrolls: scrollIntoView would scroll the window's own content too, and take
    // its bar and hero off the top.
    const form = this.element.querySelector(".settings-body");
    const section = form?.querySelector(`.settings-section[data-section="${this._settingsSection}"]`);
    if (section) {
      const pad = parseFloat(getComputedStyle(form).scrollPaddingTop) || 0;
      form.scrollTop += section.getBoundingClientRect().top - form.getBoundingClientRect().top - pad;
    }
    // Players see has its own view for some sections (design aaJcp, dYANz, S2swP), and the narrow
    // dropdown names the section it jumped to: either re-renders.
    if (changed && (fromDropdown || previewOf(previous) !== previewOf(sectionId))) this.render({ parts: ["body"] });
  }

  static async #onSetEvery(_event, target) {
    if (!game.user.isGM) return;
    const every = target.dataset.every;
    if (every === "dice") {
      this._everyDice = true;
      this.render({ parts: ["body"] });
      return;
    }
    await this.#edit(() => ({ op: "every", every }));
  }

  /** Adds a rule for a category the GM picks in a small form (a test passes it as `data-category`). */
  static async #onAddRule(_event, target) {
    if (!game.user.isGM) return;
    let category = target.dataset.category;
    if (!category) {
      const choices = this.#ruleChoices(this.document, shopConfigOf(this.document));
      if (!choices.length) return;
      const answer = await foundry.applications.api.DialogV2.input({
        window: { title: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Rules.AddTitle") },
        content: `<div class="form-group"><label>${escapeText(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Rules.Category"))}</label>`
          + `<select name="category">${choices.map(c => `<option value="${escapeText(c.value)}">${escapeText(c.label)}</option>`).join("")}</select></div>`,
        ok: { label: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Rules.Add") }
      });
      category = answer?.category;
      if (!category) return;
    }
    await this.#edit(() => ({ op: "addRule", category, world: worldOf().rates }));
  }

  static async #onRemoveRule(_event, target) {
    if (!game.user.isGM) return;
    await this.#edit(() => ({ op: "removeRule", category: target.dataset.category }));
  }

  /** Asks for a deal (the form, DealForm): its fields as typed, or null. A seam the tests replace. */
  static askDeal(context) {
    return DealForm.ask(context);
  }

  static async #onAddDeal() {
    if (!game.user.isGM) return;
    await this.#dealForm(null);
  }

  static async #onEditDeal(_event, target) {
    if (!game.user.isGM) return;
    const deal = safeShopOf(this.document)?.deals.find(d => d.actor === target.dataset.actor);
    if (deal) await this.#dealForm(deal);
  }

  static async #onRemoveDeal(_event, target) {
    if (!game.user.isGM) return;
    await this.#edit(() => ({ op: "removeDeal", actor: target.dataset.actor }));
  }

  /**
   * Asks the GM for a deal (#111): a new one, or `previous` edited. The form picks the character
   * only for a new deal; an edit is always for the character it opened on.
   */
  async #dealForm(previous) {
    const shop = safeShopOf(this.document);
    if (!shop) {
      ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Broken"));
      return;
    }
    const i18n = key => game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.Deals.${key}`);
    // Whoever the GM could trade as (#200): the world's characters, then an NPC on the scene for
    // roleplay; not the mounts, shops and summons players own elsewhere. Only those with no deal here yet.
    const offered = previous ? [] : gmCandidates(game.actors, globalThis.canvas?.ready ? globalThis.canvas.scene : null, this.document);
    const candidates = offered.filter(a => !shop.deals.some(d => d.actor === a.uuid));
    if (!previous && !candidates.length) {
      ui.notifications.warn(i18n(offered.length ? "NoCharacters" : "NoOne"));
      return;
    }
    const percent = factor => (factor ? percentOf(factor) : "");
    const buy = percent(previous?.buy);
    const sell = percent(previous?.sell);
    const characters = previous ? [{ uuid: previous.actor, name: previous.name, selected: true }]
      : candidates.map((a, i) => ({ uuid: a.uuid, name: a.name, selected: i === 0 }));
    const closes = nextCloseAt(closingHours(shop), game.time.worldTime, game.time.calendar.days) !== null;
    const ends = [
      previous?.ends ? { value: "keep", label: this.#endLabel(previous), selected: true } : null,
      { value: "never", label: i18n("NoEnd"), selected: !previous?.ends },
      { value: "close", label: i18n("Form.WhenCloses"), disabled: !closes },
      // Nor after some days where shops don't follow the world clock (#149): none would pass.
      { value: "days", label: i18n("Form.AfterDays"), disabled: !worldFollowsClock() }
    ].filter(Boolean);
    const answer = await ShopSheet.askDeal({
      title: i18n(previous ? "Form.EditTitle" : "Form.AddTitle"),
      submitLabel: i18n(previous ? "Form.Save" : "Form.Add"),
      edit: !!previous,
      characters, characterName: characters[0]?.name ?? "",
      buy, sell, buyReading: dealReadingText("buy", buy), sellReading: dealReadingText("sell", sell),
      ends, endsLabel: ends.find(e => e.selected)?.label ?? "",
      note: previous?.note ?? ""
    });
    if (!answer) return;
    // An edit stays with its own character, whatever the form sent back.
    const actor = previous?.actor ?? answer.actor;
    const name = game.actors.find(a => a.uuid === actor)?.name ?? previous?.name ?? "";
    await this.#edit(config => {
      const fields = dealFields({ ...answer, actor }, {
        name, worldTime: game.time.worldTime, hours: closingHours(config), calendar: game.time.calendar.days,
        previous: config.deals.find(d => d.actor === actor) ?? null, clock: worldFollowsClock()
      });
      if (fields.error) {
        ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Invalid", { errors: fields.error }));
        return null;
      }
      return { op: previous ? "editDeal" : "addDeal", ...fields };
    });
  }

  static async #onRestockNow() {
    if (!game.user.isGM) return;
    const answer = await game.modules.get(MODULE).api?.requestRestock?.(this.document);
    const status = answer?.status ?? "no-answer";
    if (status === "failed") ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.Failed"));
    else if (status === "no-answer") ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.NoAnswer"));
  }

  static async #onResetToPreset() {
    if (!game.user.isGM) return;
    const shop = safeShopOf(this.document);
    if (!shop) {
      ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Broken"));
      return;
    }
    const preset = await this.#presetShop(shop);
    if (!preset) return;
    const yes = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Reset.Title") },
      content: `<p>${game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Reset.Question")}</p>`
    });
    if (!yes) return;
    await this.#edit(() => ({ op: "reset", preset }));
  }

  static async #onOpenTable() {
    const uuid = shopConfigOf(this.document).restock.table;
    const table = uuid ? await Promise.resolve(fromUuid(uuid)).catch(() => null) : null;
    table?.sheet?.render(true);
  }

  /* -------------------------------------------------------------- header button */

  static #onNpcSheet() {
    // Open dnd5e's own sheet directly, bypassing this module's registration, per #104: "a
    // header button that opens the dnd5e NPC sheet for stats." `CONFIG.Actor.sheetClasses` is
    // the same registry `DocumentSheetConfig.registerSheet` writes into (document-sheet-config.mjs).
    const SheetClass = Object.values(CONFIG.Actor.sheetClasses?.[this.document.type] ?? {})
      .find(s => s.id?.startsWith("dnd5e."))?.cls;
    if (!SheetClass) { ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.NoNpcSheet")); return; }
    // An open copy is brought forward: a new one would share its id and open a duplicate window.
    const open = Object.values(this.document.apps ?? {}).find(app => app instanceof SheetClass);
    (open ?? new SheetClass({ document: this.document })).render(true);
  }

  /* -------------------------------------------------------------- registration */

  /** Registered at init (#104): never the default, so an ordinary NPC keeps its usual sheet until a shop's own `flags.core.sheetClass` opts it in. */
  static register() {
    // `{{mpIcon "scale" pen="Terms icon"}}`: a Lucide icon inline; `pen` is its design layer name
    // (#145). A script hands one over as "lucide:scale".
    Handlebars.registerHelper("mpIcon", (name, options) => {
      const pen = options?.hash?.pen;
      return new Handlebars.SafeString(icon(String(name).replace(/^lucide:/, ""), pen ? { "data-pen": pen } : {}));
    });
    // A good's picture or name (#168): dnd5e's rich card on hover, as dnd5e's own sheets mark it
    // up, and a click that opens its page when there's one to open.
    Handlebars.registerHelper("mpInspect", inspect => {
      const esc = Handlebars.escapeExpression;
      const attrs = [];
      if (inspect?.open) attrs.push(`data-action="inspect" data-uuid="${esc(inspect.open)}"`);
      if (inspect?.tooltip) attrs.push(`data-tooltip-html="${esc(inspect.tooltip)}"`,
        `data-tooltip-class="dnd5e2 dnd5e-tooltip item-tooltip document-tooltip"`, `data-tooltip-direction="LEFT"`);
      return new Handlebars.SafeString(attrs.join(" "));
    });
    // A coin's design layer name, which depends on where it shows: in a purse by its metal
    // ("gold"), in a worked example by its metal and count ("gold 15"), in a price by its place.
    Handlebars.registerHelper("mpCoinPen", (mode, coin, index) => {
      const metal = COIN_METALS[coin?.denomination] ?? game.i18n.localize(coin?.label ?? "").toLowerCase();
      if (mode === "price") return index ? "Price Minor" : "Price";
      return mode === "count" ? `${metal} ${coin?.count}` : metal;
    });
    foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE, ShopSheet, {
      types: ["npc"],
      makeDefault: false,
      label: "MERCHANT_PRESETS.Shop.SheetLabel"
    });
    // The bill reads the clock and the buyer, neither of which is this sheet's own document, so
    // core's own re-render on a document update doesn't cover them.
    Hooks.on("updateWorldTime", () => ShopSheet.#liveDataChanged(() => true));
    Hooks.on("updateActor", actor => ShopSheet.#liveDataChanged(app => app.document === actor || app._buyerUuid === actor.uuid));
    Hooks.on("deleteActor", actor => ShopSheet.#liveDataChanged(app => app._buyerUuid === actor.uuid));
    // The world's rates, stock and purse modes, trading hours, restock switch and whether shops
    // follow the world clock price and open every shop (#110, #149), as does dnd5e's calendar
    // switch, which Auto reads. Only those: the restock loop writes its own clock setting every tick.
    const shown = new Set([...["sellsAt", "buysAt", "stockMode", "merchantPurse", "tradingHours", "autoRestock", "followClock"]
      .map(k => `${MODULE}.${k}`), "dnd5e.calendarConfig"]);
    for (const hook of ["createSetting", "updateSetting"]) {
      Hooks.on(hook, setting => { if (shown.has(setting.key)) ShopSheet.#liveDataChanged(() => true); });
    }
    // A bill waiting for a GM (design WNYhA, state 4) can be sealed again once one connects.
    Hooks.on("userConnected", user => {
      if (user?.isGM) ShopSheet.#liveDataChanged(app => app._tradeState.buy === "no-gm" || app._tradeState.sell === "no-gm");
    });
    // Core re-renders this window for the shop's own items, but the Sell tab lists the buyer's.
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      Hooks.on(hook, item => ShopSheet.#liveDataChanged(app => !!item.parent && app._buyerUuid === item.parent.uuid));
    }
    // Reach (#166): a player's window stays open only while they may visit, so walking away from
    // the counter closes it, and "Buying as" follows whose tokens stand at it. A GM's "Buying as"
    // follows who stands on the scene they're viewing (#201).
    for (const hook of ["createToken", "updateToken", "deleteToken", "canvasReady", "updateActor"]) {
      Hooks.on(hook, doc => ShopSheet.#reachChanged(hook, doc));
    }
    Hooks.on("updateSetting", setting => { if (setting.key === `${MODULE}.shopAccess`) ShopSheet.#reachChanged("updateSetting"); });
  }

  /**
   * Open shop windows, after a token, the scene or access changed. A player's: out of reach closes,
   * in reach re-reads its buyers. A GM's re-reads its buyers only when someone came or went on the
   * scene they're viewing, or they switched scene: moves and actor updates change no one's place in it.
   */
  static #reachChanged(hook, doc) {
    if (game.user.isGM) {
      const onViewed = (hook === "createToken" || hook === "deleteToken") && doc?.parent === globalThis.canvas?.scene;
      if (hook !== "canvasReady" && !onViewed) return;
      for (const app of foundry.applications.instances.values()) {
        if (app instanceof ShopSheet && app.rendered) app.render({ parts: ["body"] });
      }
      return;
    }
    for (const app of foundry.applications.instances.values()) {
      if (!(app instanceof ShopSheet) || !app.rendered) continue;
      if (!app.isVisible) app.close();
      else app.render({ parts: ["body"] });
    }
  }

  /** Re-renders each open shop window `affected` picks, dropping a live refusal the change may have cleared. */
  static #liveDataChanged(affected) {
    for (const app of foundry.applications.instances.values()) {
      if (!(app instanceof ShopSheet) || !affected(app)) continue;
      for (const kind of ["buy", "sell"]) {
        if (LIVE_REFUSALS.includes(app._tradeState[kind])) app._tradeState[kind] = "idle";
      }
      app.render({ parts: ["body"] });
    }
  }
} : null;

// Self-registering on import, so merchant-presets.mjs only ever needs the one import line to
// wire this module in — `registerSheet` itself queues until `game.ready` when called this early
// (document-sheet-config.mjs), so this is equivalent to calling it from an "init" hook.
if (hasApplicationsApi) ShopSheet.register();

export default ShopSheet;
