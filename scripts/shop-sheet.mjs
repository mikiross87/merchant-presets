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

import { effectiveRates, itemPriceCp, totalCp } from "./pricing.mjs";
import { SHOP_DEFAULTS, STOCK_DEFAULTS, shopFrom, validateShop } from "./schema.mjs";
import {
  applyChange, EVERY_CHOICES, everyChoice, percentOf, timeText, WONT_BUY_KINDS, WONT_BUY_TYPES
} from "./shop-settings.mjs";
import { worldTerms } from "./trade-desk.mjs";
import { isOpen, nextOpen } from "./schedule.mjs";
import { bundleFor, bundlePriceCp, categoryFor, isFixedExcluded, lineTotalCp, safeShopOf, safeStockOf } from "./trade-plan.mjs";
import {
  basketTotals, buyRow, coinAriaLabel, coinBreakdown, groupCategories, isVisibleStock,
  fitQuantity, matchingStockLine, rateFraction, sealState, sellRow, stepQuantity, titleParts
} from "./shop-view.mjs";

const MODULE = "merchant-presets";
const TEMPLATES = `modules/${MODULE}/templates`;

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
  { id: "terms", icon: "fa-solid fa-scale-balanced" },
  { id: "deals", icon: "fa-solid fa-handshake" },
  { id: "wontBuy", icon: "fa-solid fa-ban" },
  { id: "hours", icon: "fa-solid fa-hourglass-half" },
  { id: "restock", icon: "fa-solid fa-rotate" }
];

/** CONST.DOCUMENT_OWNERSHIP_LEVELS: a shop players can visit is Limited to them by default. */
const NONE = 0, LIMITED = 1;

/** A Settings-tab field typed into (text, number, time), as opposed to a box, radio or select. */
const isTypedField = control => control.tagName === "INPUT" && !["checkbox", "radio"].includes(control.type);

/**
 * A selector that finds `control` again in the next render: its data-op and the data it edits,
 * and a radio's own value (the restock mode's two radios share everything else).
 */
const settingSelector = control => `.settings-tab ${["op", "side", "category", "list", "value", "end"]
  .filter(key => control.dataset[key] != null)
  .map(key => `[data-${key}="${CSS.escape(control.dataset[key])}"]`).join("")}${
  control.type === "radio" ? `[value="${CSS.escape(control.value)}"]` : ""}`;

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
    window: {
      resizable: true,
      icon: "fa-solid fa-store",
      controls: [{
        action: "npcSheet",
        icon: "fa-solid fa-address-card",
        label: "MERCHANT_PRESETS.Shop.NpcSheet",
        ownership: "OWNER",
        visible: () => game.user.isGM
      }]
    },
    actions: {
      npcSheet: ShopSheet.#onNpcSheet,
      selectCategory: ShopSheet.#onSelectCategory,
      addLine: ShopSheet.#onAddLine,
      stepLine: ShopSheet.#onStepLine,
      pickBuyer: ShopSheet.#onPickBuyer,
      seal: ShopSheet.#onSeal,
      keepShopping: ShopSheet.#onKeepShopping,
      settingsSection: ShopSheet.#onSettingsSection,
      setEvery: ShopSheet.#onSetEvery,
      addRule: ShopSheet.#onAddRule,
      removeRule: ShopSheet.#onRemoveRule,
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
      scrollable: [".shop-stock", ".sell-rows"],
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
    /** Per kind, the id of a trade that may still land (unconfirmed, or never answered): every seal resends it until one is answered (sealed or refused) or the buyer changes, so the GM's side can't carry it out twice. */
    this._tradeId = { buy: null, sell: null };
    /** Per kind, every priced line sent under the current `_tradeId`, by item id: what a sealed answer's own lines are named and pictured from. */
    this._sent = { buy: new Map(), sell: new Map() };
    this._activeCategory = "all";
    /** Per kind, the fewest of each line worth a coin (`buyRow`/`sellRow`'s `minQuantity`), from the last render. */
    this._minQuantity = { buy: new Map(), sell: new Map() };
    this._buyerUuid = game.user.character?.uuid ?? null;
    /** The GM Settings tab's open section (#110). */
    this._settingsSection = "terms";
    /** Whether the GM picked "Dice…" and the schedule's formula field is showing, before a formula is set. */
    this._everyDice = false;
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
        dirty: !this._resetTyping && isTypedField(active) && active.value !== active.defaultValue }
      : null;
    this._resetTyping = false;
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

  /* -------------------------------------------------------------- tabs */

  /** @override */
  _getTabsConfig(group) {
    if (group !== "primary") return super._getTabsConfig(group);
    const tabs = [
      { id: "buy", icon: "fa-solid fa-bag-shopping" },
      { id: "sell", icon: "fa-solid fa-hand-holding-dollar" }
    ];
    if (game.user.isGM) tabs.push({ id: "settings", icon: "fa-solid fa-gear", gm: true });
    return { tabs, initial: "buy", labelPrefix: "MERCHANT_PRESETS.Shop.Tabs" };
  }

  /* -------------------------------------------------------------- context */

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.document;
    const currencies = CONFIG.DND5E.currencies;
    // Trading hours off means every shop is open around the clock (the setting's own promise), so
    // the window reads it as a shop with no hours: always open, in the header too.
    const shop = shopConfigOf(actor);
    const config = game.settings.get(MODULE, "tradingHours") ? shop : { ...shop, hours: null };
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
      world, shopTerms: config.terms, chipSellsAt, chipBuysAt
    };
    const header = this.#headerContext(actor, title, tier, config, open, chipSellsAt, chipBuysAt, currencies);

    Object.assign(context, {
      appId: this.id,
      isGM: game.user.isGM,
      actor,
      config,
      open,
      header,
      buyerPicker: this.#buyerPickerContext(buyer, currencies),
      buyer,
      buyerPurse: buyer ? heldCoins(buyer.system.currency, currencies) : [],
      currencies,
      kind,
      // Every tab's content is built on every render, not only the active one: core's own
      // `changeTab` (application.mjs) just toggles which already-rendered `.tab` section is
      // visible, with no re-render in between, so a tab switched to cold would otherwise show
      // whatever it held (or didn't) at the last full render.
      buy: this.#buyContext(actor, config, rates, currencies, buyer, open),
      sell: this.#sellContext(actor, config, rates, currencies, buyer, open),
      // The shop's own config, not `config`: the world's trading-hours switch shows no hours, but
      // the GM edits the ones the shop keeps.
      settings: game.user.isGM ? await this.#settingsContext(actor, shop, world, header) : null,
      closed: !open ? this.#closedContext(config, minute, calendarDays) : null
    });
    return context;
  }

  /** Minutes since local midnight on the world clock — see schedule.mjs's own convention. */
  #minuteOfDay() {
    const calendar = game.time.calendar;
    const c = calendar.timeToComponents(game.time.worldTime);
    return c.hour * calendar.days.minutesPerHour + c.minute;
  }

  #headerContext(actor, title, tier, config, open, chipSellsAt, chipBuysAt, currencies) {
    const closesAt = config.hours ? this.#formatTime(config.hours.close) : null;
    const opensAt = config.hours ? this.#formatTime(config.hours.open) : null;
    return {
      img: actor.img,
      title,
      tier,
      // A flag any owner of the shop can write, so it's cleaned before it goes into the page raw.
      description: foundry.utils.cleanHTML(config.description ?? ""),
      open,
      openLabel: open
        ? (config.hours ? game.i18n.localize("MERCHANT_PRESETS.Shop.OpenUntil", { time: closesAt }) : game.i18n.localize("MERCHANT_PRESETS.Shop.AlwaysOpen"))
        : (config.hours ? game.i18n.localize("MERCHANT_PRESETS.Shop.ClosedOpensAt", { time: opensAt }) : game.i18n.localize("MERCHANT_PRESETS.Shop.Closed.Label")),
      // design/README.md's own mockup ("Sells at list · Buys at ½"): the chip reads sellsAt in
      // words but buysAt as the row-tag fraction glyph — an asymmetry the mockup draws on
      // purpose, unlike the Terms popover below, which spells both out in words.
      termsChip: game.i18n.localize("MERCHANT_PRESETS.Shop.TermsChip", { sells: termsWord(chipSellsAt, "sell"), buys: rateFraction(chipBuysAt) }),
      terms: this.#termsContext(config, chipSellsAt, chipBuysAt, currencies)
    };
  }

  /** The Terms of Trade popover's worked example: a 15 gp longsword, at the shop's own chip rates. */
  #termsContext(config, chipSellsAt, chipBuysAt, currencies) {
    // "gp" is a fixed reference point for the worked example, per design/README.md; a homebrew
    // currency config that dropped it entirely (unlikely, but itemPriceCp does throw on it)
    // just shows no worked example rather than breaking the whole popover.
    const example = { value: 15, denomination: "gp" };
    let sellCp = 0, buyCp = 0;
    try {
      sellCp = itemPriceCp(example, chipSellsAt, 1, currencies);
      buyCp = itemPriceCp(example, chipBuysAt, 1, currencies);
    } catch { /* no "gp" in this world's currencies */ }
    return {
      sellsAtLabel: termsWord(chipSellsAt, "sell"),
      buysAtLabel: termsWord(chipBuysAt, "buy"),
      exampleSell: coinBreakdown(sellCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
      exampleBuy: coinBreakdown(buyCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
      categories: config.terms.categories,
      // "food-drink" etc reads as a real word, not the generator's own hyphenated token
      // (tools/build_srd.py's GOODS_KINDS, per trade-plan.mjs's header) — item types
      // (CONFIG.Item.typeLabels) are already localized words with no hyphen to fix.
      wontBuyTypes: config.wontBuy.types.map(t => game.i18n.localize(CONFIG.Item.typeLabels?.[t] ?? t)),
      wontBuyKinds: config.wontBuy.kinds.map(k => k.replace(/-/g, " ")),
      hasWontBuy: config.wontBuy.types.length > 0 || config.wontBuy.kinds.length > 0
    };
  }

  #formatTime(time) {
    return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`;
  }

  #closedContext(config, minute, calendarDays) {
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
    return {
      opensAtLabel: `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`,
      duration,
      openLabel: config.hours ? this.#formatTime(config.hours.open) : null,
      closeLabel: config.hours ? this.#formatTime(config.hours.close) : null
    };
  }

  /* -------------------------------------------------------------- buyer */

  /** Every actor this window could trade as: the user's own owned actors, or, for a GM, every actor. */
  #candidateBuyers() {
    const shopId = this.document.id;
    return game.actors.filter(a => a.id !== shopId && a.testUserPermission(game.user, "OWNER"));
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

  #buyerPickerContext(buyer, currencies) {
    const candidates = this.#candidateBuyers();
    const entry = actor => ({
      id: actor.id,
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      subtitle: actorSubtitle(actor),
      purse: heldCoins(actor.system.currency, currencies),
      hasPurse: totalCp(actor.system.currency ?? {}, currencies) > 0,
      current: actor.uuid === buyer?.uuid
    });
    if (!game.user.isGM) return { gm: false, actors: candidates.map(entry) };
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

  /* -------------------------------------------------------------- buy tab */

  #buyContext(actor, config, rates, currencies, buyer, open) {
    const shopItems = actor.items.map(i => i.toObject());
    const rows = shopItems
      .map(data => ({ data, stock: safeStockOf(data) }))
      .filter(({ data, stock }) => stock && isVisibleStock(data, stock, shopItems))
      .map(({ data, stock }) => {
        const row = buyRow(data, stock, rates, null, currencies, worldInfiniteStock(), bundleOf);
        this._minQuantity.buy.set(row.id, row.minQuantity);
        return {
          ...row,
          // A category the GM named is shown as they wrote it; buyRow's own fallback to
          // item.type (schema.mjs: "" files it under its item type") is a dnd5e type key like
          // "weapon", so it reads through CONFIG.Item.typeLabels for a real word instead.
          categoryLabel: stock.category || game.i18n.localize(CONFIG.Item.typeLabels?.[row.category] ?? row.category),
          // The Narrow layout shows a filled check instead of "+" for a line already on the bill
          // (design/README.md, "Narrow"). Wide layouts ignore the flag entirely.
          inBasket: this._baskets.buy.has(row.id),
          priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : []
        };
      });
    // A category that emptied (its last line bought) drops out of the nav; fall back to all goods.
    this.#keepOffered("buy", new Map(rows.filter(r => !r.unpriced && !r.worthless).map(r => [r.id, r.minQuantity])));
    if (this._activeCategory !== "all" && !rows.some(r => r.category === this._activeCategory)) this._activeCategory = "all";
    const categories = groupCategories(rows).map(c => ({
      ...c,
      active: c.id === this._activeCategory,
      label: rows.find(r => r.category === c.id)?.categoryLabel ?? c.label
    }));
    const visibleRows = this._activeCategory === "all" ? rows : rows.filter(r => r.category === this._activeCategory);
    const sections = [];
    for (const row of visibleRows) {
      let section = sections.find(s => s.category === row.category);
      if (!section) { section = { category: row.category, categoryLabel: row.categoryLabel, rows: [] }; sections.push(section); }
      section.rows.push(row);
    }
    const purseCp = buyer ? totalCp(buyer.system.currency ?? {}, currencies) : 0;
    const { lines, totals } = this.#bill("buy", purseCp, currencies);
    // A basket the purse can't cover reads as "cant-afford" the moment it goes over, the same
    // way the Sell tab derives "till-short" below — not only after a round trip to the GM
    // confirms it (#102 will refuse it too, but the client already has enough to say so first).
    const traded = this._tradeState.buy;
    const state = isSettled(traded) ? traded : !open ? "closed" : !buyer ? "no-buyer"
      : (totals.shortfallCp > 0 ? "cant-afford" : traded);
    const seal = sealState(state, lines.length > 0);
    const sumText = coinsText(coinBreakdown(totals.sumCp, currencies));
    return {
      kind: "buy",
      shopTitle: titleParts(actor.name).title,
      sections,
      categories,
      // For a buy refused as till-short: the till couldn't make change.
      tillText: coinsText(coinBreakdown(totalCp(actor.system.currency ?? {}, currencies), currencies)),
      basket: this.#billOfSale(lines, totals, currencies, buyer, this._sealed.buy),
      // A seal that's out or stamped stays on screen past closing, so its answer is seen.
      showClosed: !open && !isSettled(this._tradeState.buy),
      seal: {
        ...seal,
        state,
        label: seal.labelKey === "MERCHANT_PRESETS.Shop.Seal.Bargain"
          ? game.i18n.localize(seal.labelKey, { price: sumText })
          : game.i18n.localize(seal.labelKey)
      },
      open
    };
  }

  static #onSelectCategory(_event, target) {
    this._activeCategory = target.dataset.category;
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
  }

  /** The item a basket line of `kind` names: the shop's for a buy, the buyer's own for a sale. */
  #itemOf(kind, itemId) {
    const owner = kind === "buy" ? this.document : this.#resolveBuyer();
    return owner?.items?.get(itemId)?.toObject() ?? null;
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
      for (const [itemId, quantity] of basket) {
        const fit = this.#itemOf(kind, itemId) ? fitQuantity(quantity, this.#shelfOf(kind, itemId)) : 0;
        if (fit === quantity) continue;
        if (fit > 0) basket.set(itemId, fit);
        else basket.delete(itemId);
        changed = true;
      }
      // A changed basket is a new bill: the last refusal and unanswered trade id were the old one's.
      if (changed) this.#shelfChanged(kind);
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
    const items = (buyer?.items ?? []).map(i => i.toObject()).filter(i => !isFixedExcluded(i) && (i.system?.quantity ?? 1) > 0);
    const rows = items.map(item => {
      const line = matchingStockLine(item, shopItems);
      const matched = stockConfigOf(line);
      // Anything inside counts, gear included: the engine refuses a sale of any non-empty container.
      const hasContents = item.type === "container" && (buyer?.items ?? []).some(i => i.system?.container === item._id);
      let row = sellRow(item, config, matched, rates, null, currencies, { hasContents, bundle: bundleFor(item, line, bundleOf) });
      // A matching shelf line with broken flags: the engine refuses the sale as shop-misconfigured.
      if (line && !safeStockOf(line)) row = { ...row, refusal: "General", bundlePriceCp: null, ratio: null };
      if (row.minQuantity) this._minQuantity.sell.set(item._id, row.minQuantity);
      return { ...row, priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.priceForCp ?? row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : [] };
    });
    const willBuy = rows.filter(r => !r.refusal);
    const wontBuy = rows.filter(r => r.refusal);
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
    const seal = sealState(state, lines.length > 0);
    const sumText = coinsText(coinBreakdown(totals.sumCp, currencies));
    return {
      kind: "sell",
      shopTitle: titleParts(actor.name).title,
      willBuy, wontBuy,
      ratioLabel: rateFraction(rates.chipBuysAt),
      tillCp,
      tillCoins: coinBreakdown(tillCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
      tillText: coinsText(coinBreakdown(tillCp, currencies)),
      // Under unlimited merchant coin the till is bottomless (the engine's own rule), so it caps nothing.
      tillCapsSales: game.settings.get(MODULE, "merchantPurse") !== "unlimited",
      basket: this.#billOfSale(lines, totals, currencies, buyer, this._sealed.sell),
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
    const lines = [];
    for (const [itemId, quantity] of this._baskets[kind]) {
      const item = this.#itemOf(kind, itemId);
      if (!item || quantity <= 0) continue;
      // A shop item carries its own #98 stock flag; an item on the buyer's side (a sale) never
      // does (see trade-plan.mjs's `copyOf`), so its line reads the shop's matching shelf line
      // instead — the same rule #102 prices a sale by.
      const line = kind === "buy" ? item : matchingStockLine(item, shopItems);
      const stock = stockConfigOf(line);
      const rates = effectiveRates(world, config.terms, categoryFor(item, stock));
      const rate = kind === "buy" ? rates.sellsAt.rate : rates.buysAt.rate;
      // trade-plan's own chain and line total, so the bill shows exactly what the trade charges.
      const bundle = bundleFor(item, line, bundleOf);
      let lineTotal = 0, bundleCp = null;
      try {
        lineTotal = lineTotalCp(item, rate, bundle, quantity, currencies);
        bundleCp = bundlePriceCp(item, rate, currencies);
      } catch { /* unpriced: the add button is disabled for these, but never trust that alone */ }
      lines.push({
        itemId, name: item.name, img: item.img, quantity, lineTotalCp: lineTotal, bundlePriceCp: bundleCp,
        struck: this._struck[kind].has(itemId),
        // The sticker price per bundle ("4 cp per 20"): a unit price would floor cheap goods to nothing.
        bundle,
        unitCoins: coinBreakdown(bundleCp ?? 0, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
        // A bundle that floors to nothing has no sticker worth showing beside a real line total.
        showUnit: (bundleCp ?? 0) > 0 || lineTotal === 0,
        lineTotalCoins: coinBreakdown(lineTotal, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }))
      });
    }
    return lines;
  }

  #billOfSale(lines, totals, currencies, buyer, sealed) {
    const sumCoins = coinBreakdown(totals.sumCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    const afterCoins = purseCoins(totals.afterCp, currencies);
    const shortfallCoins = coinBreakdown(totals.shortfallCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    return {
      lines,
      sumCoins, afterCoins, shortfallCoins,
      sumText: coinsText(sumCoins),
      afterText: coinsText(afterCoins),
      shortfallText: coinsText(shortfallCoins),
      buyerName: buyer?.name ?? null,
      hasLines: lines.length > 0,
      // A stamped bill keeps the date it sealed on; a live one reads the clock.
      dateLabel: sealed?.dateLabel ?? this.#worldDateLabel()
    };
  }

  #worldDateLabel() {
    return this.#dateLabel(game.time.worldTime);
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
          dateLabel: this.#worldDateLabel()
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
    const uuid = shop.source ?? this.document._stats?.compendiumSource;
    if (!uuid) return null;
    const merchant = await Promise.resolve(fromUuid(uuid)).catch(() => null);
    const preset = merchant?.flags?.[MODULE]?.shop;
    return validateShop(preset).ok ? shopFrom(preset) : null;
  }

  /** The GM's Settings tab: `shop` is the shop's own config, `world` the world's rates. */
  async #settingsContext(actor, shop, world, header) {
    const i18n = key => game.i18n.localize(`MERCHANT_PRESETS.Shop.Settings.${key}`);
    const preset = await this.#presetShop(shop);
    const typeLabel = type => game.i18n.localize(CONFIG.Item.typeLabels?.[type] ?? type);
    const effective = effectiveRates(world, shop.terms);
    const rate = side => ({
      percent: percentOf(shop.terms[side] ?? world[side]),
      worldDefault: shop.terms[side] === null
    });

    // A rule can price an item type, or a category the GM named on a shelf line.
    const ruled = new Set(shop.terms.categories.map(c => c.category));
    const named = actor.items.map(i => safeStockOf(i)?.category).filter(Boolean);
    const ruleChoices = [...new Set([...WONT_BUY_TYPES, ...named])].filter(c => !ruled.has(c))
      .map(value => ({ value, label: WONT_BUY_TYPES.includes(value) ? typeLabel(value) : value }));

    const table = shop.restock.table ? await Promise.resolve(fromUuid(shop.restock.table)).catch(() => null) : null;
    const { chip, formula } = everyChoice(shop.restock);
    const everyLabel = every => (every === "never" ? i18n("Restock.Never")
      : every === 1 ? i18n("Restock.Daily")
        : game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.EveryDays", { days: every }));
    const schedule = actor.flags?.[MODULE]?.schedule;

    return {
      // A config that failed validation shows the defaults here; editing is refused (see `#edit`).
      broken: !safeShopOf(actor),
      sections: SETTINGS_SECTIONS.map(s => ({ ...s, label: i18n(`Sections.${s.id}`), active: s.id === this._settingsSection })),
      section: Object.fromEntries(SETTINGS_SECTIONS.map(s => [s.id, s.id === this._settingsSection])),
      visit: (actor.ownership?.default ?? NONE) >= LIMITED,
      terms: {
        // In words, what the shop actually charges and pays: capped, as the chip and trades are.
        sells: { ...rate("sellsAt"), word: termsWord(effective.sellsAt.rate, "sell") },
        buys: { ...rate("buysAt"), word: termsWord(effective.buysAt.rate, "buy") },
        exampleSell: header.terms.exampleSell,
        exampleBuy: header.terms.exampleBuy,
        rules: shop.terms.categories.map(c => ({
          category: c.category, label: WONT_BUY_TYPES.includes(c.category) ? typeLabel(c.category) : c.category,
          sellsPercent: percentOf(c.sellsAt), buysPercent: percentOf(c.buysAt)
        })),
        ruleChoices
      },
      wontBuy: {
        types: WONT_BUY_TYPES.map(value => ({ value, label: typeLabel(value), checked: shop.wontBuy.types.includes(value) })),
        kinds: WONT_BUY_KINDS.map(value => ({ value, label: i18n(`Kinds.${value}`), checked: shop.wontBuy.kinds.includes(value) }))
      },
      hours: {
        keeps: shop.hours !== null,
        open: shop.hours ? timeText(shop.hours.open) : "",
        close: shop.hours ? timeText(shop.hours.close) : "",
        worldOff: !game.settings.get(MODULE, "tradingHours")
      },
      restock: {
        table: table ? { name: table.name, uuid: table.uuid } : null,
        chips: [...EVERY_CHOICES.map(String), "dice", "never"].map(id => ({
          // "Dice…" just picked, no formula saved yet: it's the one lit.
          id, active: this._everyDice ? id === "dice" : id === chip,
          label: id === "dice" ? i18n("Restock.Dice") : id === "never" ? everyLabel("never")
            : id === "1" ? everyLabel(1) : game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.Days", { days: id })
        })),
        showFormula: chip === "dice" || this._everyDice,
        formula,
        current: chip === "never" ? everyLabel("never") : everyLabel(shop.restock.every),
        presetEvery: preset ? everyLabel(preset.restock.onOpen ? preset.restock.every : "never") : null,
        reroll: shop.restock.mode === "reroll",
        purseGp: actor.flags?.[MODULE]?.purse ?? null,
        last: schedule?.lastRestock != null ? this.#dateLabel(schedule.lastRestock) : null,
        // Only a date the shop will keep: one counted for another schedule is recounted at the
        // clock's next tick (`scheduleShop`), and a shop with no table never restocks.
        next: chip !== "never" && shop.restock.table && schedule?.dueAt != null
          && (schedule.every === undefined || schedule.every === shop.restock.every)
          ? this.#dateLabel(schedule.dueAt) : null,
        autoOff: !game.settings.get(MODULE, "autoRestock")
      },
      canReset: !!preset,
      // What players see at these terms: the header chip, and its worked example.
      preview: { chip: header.termsChip, exampleSell: header.terms.exampleSell, exampleBuy: header.terms.exampleBuy }
    };
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
      // The GM's own choice, which placing a token never overrides again (`makeVisitable`).
      await this.#queue(() => this.document.update({ "ownership.default": checked ? LIMITED : NONE, [`flags.${MODULE}.visibility`]: checked }));
      return;
    }
    const change = {
      rate: () => ({ op, side, percent: typedNumber(value) }),
      // Unticked, the rate keeps the figure it showed: the world's, now the shop's own.
      rateDefault: () => ({ op: "rate", side, percent: checked ? null : percentOf(worldOf().rates[side]) }),
      ruleRate: () => ({ op, category: control.dataset.category, side, percent: typedNumber(value) }),
      wontBuy: () => ({ op, list, value: control.dataset.value, on: checked }),
      keepHours: async shop => ({ op, on: checked, fallback: (await this.#presetShop(shop))?.hours ?? SHOP_DEFAULTS.hours }),
      hour: () => ({ op, end, time: value }),
      every: () => ({ op, every: value.trim() }),
      mode: () => ({ op, mode: value })
    }[op];
    if (change) await this.#edit(change);
  }

  /**
   * Queues one edit of the shop's config: `makeChange(shop)` gives the `applyChange` change, or
   * null for none. Each edit reads the config only once the edit before it has landed, so two
   * quick edits (leaving one field for a checkbox) can't each write over the other with what
   * they read before either saved (#140 review). A config that can't be read is left alone: the
   * edit would write the defaults over it, a 1.x shop's migration marker included.
   */
  #edit(makeChange) {
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
        this._resetTyping = true;   // puts the field back, even one still focused (an alt-tab)
        this.render({ parts: ["body"] });
        return;
      }
      if (change.op === "every") this._everyDice = false;
      // Replaced, not merged: a merge would keep a removed rule's or quantity formula's old keys.
      await this.document.update({ [`flags.${MODULE}.shop`]: _replace(result.shop) });
    });
  }

  /**
   * Runs `task`, a Settings-tab write, after every one queued before it. Never rejects: a write
   * the server refuses is said, and the control put back to what the shop still holds; the next
   * write still runs, and the control's listener has nothing to catch.
   */
  #queue(task) {
    this._edits = (this._edits ?? Promise.resolve()).then(task).catch(err => {
      console.error(`${MODULE} | a shop setting wasn't saved`, err);
      ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.SaveFailed"));
      this._resetTyping = true;
      this.render({ parts: ["body"] });
    });
    return this._edits;
  }

  static #onSettingsSection(_event, target) {
    this._settingsSection = target.dataset.section;
    this.render({ parts: ["body"] });
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

  /** Adds a rule for the category picked beside the button (a test passes it as `data-category`). */
  static async #onAddRule(_event, target) {
    if (!game.user.isGM) return;
    const category = target.dataset.category ?? target.closest?.(".settings-add-rule")?.querySelector("select")?.value;
    await this.#edit(() => ({ op: "addRule", category, world: worldOf().rates }));
  }

  static async #onRemoveRule(_event, target) {
    if (!game.user.isGM) return;
    await this.#edit(() => ({ op: "removeRule", category: target.dataset.category }));
  }

  static async #onRestockNow() {
    if (!game.user.isGM) return;
    const restocked = await game.modules.get(MODULE).api?.restock?.(this.document);
    if (restocked == null) ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.Settings.Restock.Failed"));
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
    // The world's rates, stock and purse modes, trading hours and restock switch price and open
    // every shop (#110). Only those: the restock loop writes its own clock setting every tick.
    const shown = new Set(["sellsAt", "buysAt", "stockMode", "merchantPurse", "tradingHours", "autoRestock"].map(k => `${MODULE}.${k}`));
    for (const hook of ["createSetting", "updateSetting"]) {
      Hooks.on(hook, setting => { if (shown.has(setting.key)) ShopSheet.#liveDataChanged(() => true); });
    }
    // Core re-renders this window for the shop's own items, but the Sell tab lists the buyer's.
    for (const hook of ["createItem", "updateItem", "deleteItem"]) {
      Hooks.on(hook, item => ShopSheet.#liveDataChanged(app => !!item.parent && app._buyerUuid === item.parent.uuid));
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
