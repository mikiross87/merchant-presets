/**
 * The shop window (#103): a merchant NPC's own actor sheet, registered per #104's decision
 * (`DocumentSheetConfig.registerSheet`, never the default — each shop opts in by setting its own
 * `flags.core.sheetClass` to `"merchant-presets.ShopSheet"`, which the #99 migration does). Core's
 * own double-click, the sidebar and the token HUD then open it with no patching.
 *
 * This class only ever *reads* Foundry data and turns it into the plain view-model
 * `scripts/shop-view.mjs` builds the pricing and formatting for; it never writes to the shop or
 * the buyer directly. A trade is carried out by calling
 * `game.modules.get("merchant-presets").api.trade(request)` — the #102 runtime, landing
 * separately (PR #122) — and applying whatever it reports back. Until that API exists, every seal
 * attempt reads as `"no-gm"`, which is exactly how the window should behave if #102 were merged
 * but no GM happened to be connected (design/README.md, "Trade states").
 */

import { effectiveRates, itemPriceCp, totalCp } from "./pricing.mjs";
import { shopFrom, stockFrom } from "./schema.mjs";
import { isOpen, nextOpen } from "./schedule.mjs";
import { bundleFor, categoryFor, lineTotalCp } from "./trade-plan.mjs";
import {
  basketTotals, buyRow, coinAriaLabel, coinBreakdown, groupCategories, isGearItem, isVisibleStock,
  matchingStockLine, rateFraction, sealState, sellRow, stepQuantity, titleParts
} from "./shop-view.mjs";

const MODULE = "merchant-presets";
const TEMPLATES = `modules/${MODULE}/templates`;

/**
 * World default rates (#110 hasn't shipped the Configure Settings entry yet). List price / half
 * value match every shipped preset's own starting terms, so an unconfigured world still prices
 * sensibly; #110 replaces this with a read of the real setting.
 */
const PLACEHOLDER_WORLD_RATES = Object.freeze({ sellsAt: 1, buysAt: 0.5 });
/** #110 hasn't shipped a world stock-mode setting for the 2.0 window either; finite is the safer placeholder — a shop that looks unlimited by accident is a bigger surprise than one that looks limited. */
const PLACEHOLDER_WORLD_INFINITE_STOCK = false;

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
      keepShopping: ShopSheet.#onKeepShopping
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
        `${TEMPLATES}/parts/buyer-entry.hbs`
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
    this._lastReceipt = { buy: null, sell: null };
    this._activeCategory = "all";
    this._buyerUuid = game.user.character?.uuid ?? null;
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
    const config = shopFrom(actor.flags?.[MODULE]?.shop ?? {});
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

    const chipSellsAt = effectiveRates(PLACEHOLDER_WORLD_RATES, config.terms).sellsAt.rate;
    const chipBuysAt = effectiveRates(PLACEHOLDER_WORLD_RATES, config.terms).buysAt.rate;
    const rates = {
      world: PLACEHOLDER_WORLD_RATES, shopTerms: config.terms, chipSellsAt, chipBuysAt
    };

    Object.assign(context, {
      appId: this.id,
      isGM: game.user.isGM,
      actor,
      config,
      open,
      header: this.#headerContext(actor, title, tier, config, open, chipSellsAt, chipBuysAt, currencies),
      buyerPicker: this.#buyerPickerContext(buyer, currencies),
      buyer,
      buyerPurse: buyer ? coinBreakdown(totalCp(buyer.system.currency ?? {}, currencies), currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : [],
      currencies,
      kind,
      // Every tab's content is built on every render, not only the active one: core's own
      // `changeTab` (application.mjs) just toggles which already-rendered `.tab` section is
      // visible, with no re-render in between, so a tab switched to cold would otherwise show
      // whatever it held (or didn't) at the last full render.
      buy: this.#buyContext(actor, config, rates, currencies, buyer, open),
      sell: this.#sellContext(actor, config, rates, currencies, buyer, open),
      settings: game.user.isGM ? {} : null,
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
      description: config.description,
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
    if (!buyer) buyer = game.user.character ?? candidates[0] ?? null;
    this._buyerUuid = buyer?.uuid ?? null;
    return buyer;
  }

  #buyerPickerContext(buyer, currencies) {
    const candidates = this.#candidateBuyers();
    const entry = actor => ({
      id: actor.id,
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      subtitle: actorSubtitle(actor),
      purse: coinBreakdown(totalCp(actor.system.currency ?? {}, currencies), currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
      hasPurse: totalCp(actor.system.currency ?? {}, currencies) > 0,
      current: actor.uuid === buyer?.uuid
    });
    if (!game.user.isGM) return { gm: false, actors: candidates.map(entry) };
    const characters = candidates.filter(a => a.type === "character");
    const others = candidates.filter(a => a.type !== "character");
    return { gm: true, characters: characters.map(entry), others: others.map(entry) };
  }

  static #onPickBuyer(_event, target) {
    this._buyerUuid = target.dataset.actorUuid;
    this._tradeState.buy = this._tradeState.sell = "idle";
    this.render({ parts: ["body"] });
  }

  /* -------------------------------------------------------------- buy tab */

  #buyContext(actor, config, rates, currencies, buyer, open) {
    const rows = actor.items
      .map(item => ({ data: item.toObject(), stock: stockFrom(item.flags?.[MODULE]?.stock ?? {}) }))
      .filter(({ data, stock }) => isVisibleStock(data, stock))
      .map(({ data, stock }) => {
        const row = buyRow(data, stock, rates, null, currencies, PLACEHOLDER_WORLD_INFINITE_STOCK);
        return {
          ...row,
          // A category the GM named is shown as they wrote it; buyRow's own fallback to
          // item.type (schema.mjs: "" files it under its item type") is a dnd5e type key like
          // "weapon", so it reads through CONFIG.Item.typeLabels for a real word instead.
          categoryLabel: stock.category || game.i18n.localize(CONFIG.Item.typeLabels?.[row.category] ?? row.category),
          // The Narrow layout shows a filled check instead of "+" for a line already on the bill
          // (design/README.md, "Narrow"). Wide layouts ignore the flag entirely.
          inBasket: this._baskets.buy.has(row.id),
          priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : []
        };
      });
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
    const lines = this.#pricedLines("buy", id => actor.items.get(id)?.toObject(), currencies);
    const purseCp = buyer ? totalCp(buyer.system.currency ?? {}, currencies) : 0;
    const totals = basketTotals(lines, purseCp, "buy");
    // A basket the purse can't cover reads as "cant-afford" the moment it goes over, the same
    // way the Sell tab derives "till-short" below — not only after a round trip to the GM
    // confirms it (#102 will refuse it too, but the client already has enough to say so first).
    const state = !open ? "closed" : (totals.shortfallCp > 0 ? "cant-afford" : this._tradeState.buy);
    const seal = sealState(state, lines.length > 0);
    const sumText = coinsText(coinBreakdown(totals.sumCp, currencies));
    return {
      kind: "buy",
      shopTitle: titleParts(actor.name).title,
      sections,
      categories,
      basket: this.#billOfSale(lines, totals, currencies, buyer),
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

  static #onAddLine(_event, target) {
    const kind = this.tabGroups.primary;
    const itemId = target.dataset.itemId;
    const basket = this._baskets[kind];
    const current = basket.get(itemId) ?? 0;
    const next = kind === "buy" ? stepQuantity(current, 1, this.#shelfOf(itemId)) : current + 1;
    if (next > 0) basket.set(itemId, next);
    this._tradeState[kind] = "idle";
    this.render({ parts: ["body"] });
  }

  static #onStepLine(_event, target) {
    const kind = this.tabGroups.primary;
    const itemId = target.dataset.itemId;
    const delta = Number(target.dataset.delta);
    const basket = this._baskets[kind];
    const current = basket.get(itemId) ?? 0;
    // A buy steps by the bundle (and a sold-back part-bundle), the only quantities it accepts.
    const next = kind === "buy" ? stepQuantity(current, Math.sign(delta), this.#shelfOf(itemId)) : current + delta;
    if (next <= 0) basket.delete(itemId);
    else basket.set(itemId, next);
    this._tradeState[kind] = "idle";
    this.render({ parts: ["body"] });
  }

  /** A shop line's bundle, count and whether it runs out, for the buy stepper. */
  #shelfOf(itemId) {
    const item = this.document.items.get(itemId)?.toObject();
    if (!item) return { bundle: 1, available: 0, infinite: false };
    const stock = stockFrom(item.flags?.[MODULE]?.stock ?? {});
    return {
      bundle: bundleFor(item, item),
      available: item.system?.quantity ?? 0,
      infinite: stock.service || (stock.infinite ?? PLACEHOLDER_WORLD_INFINITE_STOCK)
    };
  }

  /* -------------------------------------------------------------- sell tab */

  #sellContext(actor, config, rates, currencies, buyer, open) {
    const shopItems = actor.items.map(i => i.toObject());
    const items = (buyer?.items ?? []).map(i => i.toObject()).filter(i => !isGearItem(i));
    const rows = items.map(item => {
      const line = matchingStockLine(item, shopItems);
      const matched = stockFrom(line?.flags?.[MODULE]?.stock ?? {});
      const hasContents = item.type === "container" && items.some(i => i.system?.container === item._id);
      const row = sellRow(item, config, matched, rates, null, currencies, { hasContents, bundle: bundleFor(item, line) });
      return { ...row, priceCoins: row.bundlePriceCp != null ? coinBreakdown(row.bundlePriceCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })) : [] };
    });
    const willBuy = rows.filter(r => !r.refusal);
    const wontBuy = rows.filter(r => r.refusal);
    const lines = this.#pricedLines("sell", id => buyer?.items?.get(id)?.toObject(), currencies);
    const tillCp = totalCp(actor.system.currency ?? {}, currencies);
    const totals = basketTotals(lines, tillCp, "sell");
    const state = !open ? "closed" : (totals.sumCp > tillCp ? "till-short" : this._tradeState.sell);
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
      basket: this.#billOfSale(lines, totals, currencies, buyer),
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
   * The basket's own lines, already priced — `quantity`, the sticker price for one bundle
   * (`unitCoins`) and the whole line's cost (`lineTotalCp`/`lineTotalCoins`), floored once over
   * the full quantity rather than per bundle and multiplied (trade-plan.mjs's header, "Bundle
   * pricing for quantity units, floored once" — the same rule #102 prices a trade by). Basket
   * totals (`basketTotals`, shop-view.mjs) are computed from *these* lines, never the raw
   * itemId/quantity pairs `this._baskets` holds — those carry no price at all on their own.
   */
  #pricedLines(kind, resolveItem, currencies) {
    const world = PLACEHOLDER_WORLD_RATES;
    const config = shopFrom(this.document.flags?.[MODULE]?.shop ?? {});
    const shopItems = kind === "sell" ? this.document.items.map(i => i.toObject()) : null;
    const lines = [];
    for (const [itemId, quantity] of this._baskets[kind]) {
      const item = resolveItem(itemId);
      if (!item || quantity <= 0) continue;
      // A shop item carries its own #98 stock flag; an item on the buyer's side (a sale) never
      // does (see trade-plan.mjs's `copyOf`), so its line reads the shop's matching shelf line
      // instead — the same rule #102 prices a sale by.
      const line = kind === "buy" ? item : matchingStockLine(item, shopItems);
      const stock = stockFrom(line?.flags?.[MODULE]?.stock ?? {});
      const rates = effectiveRates(world, config.terms, categoryFor(item, stock));
      const rate = kind === "buy" ? rates.sellsAt.rate : rates.buysAt.rate;
      // trade-plan's own chain and line total, so the bill shows exactly what the trade charges.
      // No bundleOf resolver until the #102 runtime provides one.
      const bundle = bundleFor(item, line);
      let unitCp = 0, lineTotal = 0;
      try {
        unitCp = itemPriceCp(item.system.price, rate, bundle, currencies);
        lineTotal = lineTotalCp(item, rate, bundle, quantity, currencies);
      } catch { /* unpriced: the add button is disabled for these, but never trust that alone */ }
      lines.push({
        itemId, name: item.name, img: item.img, quantity, lineTotalCp: lineTotal,
        unitCoins: coinBreakdown(unitCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) })),
        lineTotalCoins: coinBreakdown(lineTotal, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }))
      });
    }
    return lines;
  }

  #billOfSale(lines, totals, currencies, buyer) {
    const sumCoins = coinBreakdown(totals.sumCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    const afterCoins = coinBreakdown(totals.afterCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    const shortfallCoins = coinBreakdown(totals.shortfallCp, currencies).map(c => ({ ...c, aria: coinAriaLabel(c) }));
    return {
      lines,
      sumCoins, afterCoins, shortfallCoins,
      sumText: coinsText(sumCoins),
      afterText: coinsText(afterCoins),
      shortfallText: coinsText(shortfallCoins),
      buyerName: buyer?.name ?? null,
      hasLines: lines.length > 0,
      dateLabel: this.#worldDateLabel()
    };
  }

  #worldDateLabel() {
    try { return game.time.calendar.format(game.time.worldTime, "timestamp"); }
    catch { return ""; }
  }

  /* -------------------------------------------------------------- sealing */

  static async #onSeal(_event, _target) {
    const kind = this.tabGroups.primary;
    const basket = this._baskets[kind];
    if (!basket.size) return;
    this._tradeState[kind] = "sealing";
    this.render({ parts: ["body"] });

    const lines = [...basket].map(([itemId, quantity]) => ({ itemId, quantity }));
    const request = { tradeId: foundry.utils.randomID(), kind, lines };
    const api = game.modules.get(MODULE).api;

    if (!api?.trade) {
      this._tradeState[kind] = "no-gm";
      this.render({ parts: ["body"] });
      return;
    }
    try {
      const result = await api.trade(request);
      if (result.status === "sealed") {
        this._tradeState[kind] = "sealed";
        this._lastReceipt[kind] = result.receipt ?? null;
      } else if (result.status === "refused") {
        this._tradeState[kind] = result.reason;
        if (result.reason === "stock-changed" && Array.isArray(result.lines)) {
          for (const fresh of result.lines) {
            if (basket.has(fresh.itemId)) basket.set(fresh.itemId, basket.get(fresh.itemId));
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

  static #onKeepShopping(_event, _target) {
    const kind = this.tabGroups.primary;
    this._baskets[kind].clear();
    this._tradeState[kind] = "idle";
    this._lastReceipt[kind] = null;
    this.render({ parts: ["body"] });
  }

  /* -------------------------------------------------------------- header button */

  static #onNpcSheet() {
    // Open dnd5e's own sheet directly, bypassing this module's registration, per #104: "a
    // header button that opens the dnd5e NPC sheet for stats." `CONFIG.Actor.sheetClasses` is
    // the same registry `DocumentSheetConfig.registerSheet` writes into (document-sheet-config.mjs).
    const SheetClass = Object.values(CONFIG.Actor.sheetClasses?.[this.document.type] ?? {})
      .find(s => s.id?.startsWith("dnd5e."))?.cls;
    if (!SheetClass) { ui.notifications.warn(game.i18n.localize("MERCHANT_PRESETS.Shop.NoNpcSheet")); return; }
    new SheetClass({ document: this.document }).render(true);
  }

  /* -------------------------------------------------------------- registration */

  /** Registered at init (#104): never the default, so an ordinary NPC keeps its usual sheet until a shop's own `flags.core.sheetClass` opts it in. */
  static register() {
    foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE, ShopSheet, {
      types: ["npc"],
      makeDefault: false,
      label: "MERCHANT_PRESETS.Shop.SheetLabel"
    });
  }
} : null;

// Self-registering on import, so merchant-presets.mjs only ever needs the one import line to
// wire this module in — `registerSheet` itself queues until `game.ready` when called this early
// (document-sheet-config.mjs), so this is equivalent to calling it from an "init" hook.
if (hasApplicationsApi) ShopSheet.register();

export default ShopSheet;
