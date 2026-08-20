# Merchant Presets — Stores for D&D 2024

Seventeen ready-made shops as [Item Piles](https://github.com/fantasycalendar/FoundryVTT-ItemPiles)
merchants, in Village / Town / City sizes — **51 merchants, 1,185 stock lines.**

Built entirely from **SRD 5.2** (CC-BY-4.0) plus this module's own goods, so it
works in any `dnd5e` world and redistributes no paid content.

Stock lists adapted from the free homebrew *Stores for D&D 2024* by
[The Inspired Arcana](https://www.patreon.com/TheInspiredArcana).

> **Pre-release.** Versions stay below `1.0.0` until the module is ready to
> publish. Not yet cleared for release: permission from The Inspired Arcana for
> the shop composition.

## Requirements

| | |
|---|---|
| System | `dnd5e` 5.0.0+ |
| Required | `item-piles` 3.2.7+, `itempilesdnd5e` |

No book modules are needed, or used. The Player's Handbook and Dungeon Master's
Guide modules are not consulted even when installed.

## Compendiums

All three sit in a **Merchant Presets** compendium folder.

- **Merchants** (Actor) — 51 shopkeepers in `Village` / `Town` / `City` folders.
- **Shop Stock Tables** (RollTable) — one stock list per shop per size.
- **Merchant Goods** (Item) — 56 goods no 2024 book ships as items.

## Usage

Drag a merchant out of the compendium into the Actors sidebar, rename it to
whatever the local shopkeeper is called, and drop a token on the scene. Players
double-click the token to shop.

> **Drag it out first — don't open a merchant inside the compendium.** Module
> compendiums are locked, and Item Piles writes to a merchant as soon as you
> open its *Populate Items* tab, so opening one in place throws
> `You may not update documents in the locked compendium`. Nothing is broken;
> the sheet just has nowhere to save. Work on the world copy.

On import the module does two things to the world copy: it repoints the
merchant's populate configuration at a world copy of its stock table (created in
a `Merchant Stock` RollTable folder), and it rolls the shop's stock. The first
is necessary because Item Piles' *Populate Items* tab rebuilds its list from
world tables only and discards compendium entries. To fix merchants imported
before this module was enabled:

```js
game.modules.get("merchant-presets").api.rewireAll()
```

### The shops

Adventurers' Store · Alchemists & Apothecaries · Arcane Store · Armourer &
Blacksmiths · Criminal & Illicit Store · Dock · Druidic Store · Fletcher &
Woodworker · General Store · Inn & Tavern · Jeweler · Leatherworker · Musical
Store · Stable · Tailor & Textile Store · Temple & Faith Store · Tinkering Store

### Merchant Goods

56 items the 2024 rules describe in their *Food, Drink, and Lodging*,
*Spellcasting Services* and *Mounts and Vehicles* tables but never publish as
items — ale, bread, cheese, wine, meals, lodging, mounts, vehicles, saddles,
stabling, feed, ship passage and spellcasting services. Without them the Inn &
Tavern, Stable and Dock would have almost nothing to sell.

Prices and weights are the SRD's, verified line by line against those tables. 53
are marked `SRD 5.2 · CC-BY-4.0`. Three are this module's own, being neither in
the SRD nor in the 2024 rules at all: the two coach rides and the road toll,
carried over from the 2014 *Services* table because the shop guide sells them.

Ale, bread, cheese and wine are weighted consumables so Simple Nutrition 5e
counts them as meals; their weights are chosen for that (nutrition equals weight
in pounds) rather than taken from a table, since the SRD gives food no weight.
With the *Ale and wine slake thirst* setting on, ale and wine count towards
water instead — that module treats an item as food or water, never both. One
drink is a pint; a Medium creature needs a gallon a day.

## How stock behaves

- **Finite (default)** — the packs ship a rolled stock snapshot, so a merchant
  previewed in the compendium looks like a stocked shop rather than one of
  everything. Importing it re-rolls from the item's price and the settlement
  size, so two copies of the same shop differ, and expensive goods may not be in
  stock at all.
- **Unlimited** — shops never run out of ordinary goods.
- **Always limited either way** — poisons, spell scrolls, gunpowder and firearms,
  per the guide's *Limited Items* note. Sell out and they're gone until restock.
- **Containers are one-of.** dnd5e pins a container's quantity to exactly 1
  (`ContainerData` declares `quantity: new NumberField({min: 1, max: 1})`)
  because each is a distinct object holding its own contents, so a count of
  backpacks cannot be represented at all. The shop has one; it sells out and
  comes back on restock.
- **Restocking** — open the merchant, *Populate Items* tab, **Roll All Tables**.
  Each merchant is pre-wired to its own stock table in `addAll` mode, so this
  rebuilds the canonical list and re-rolls the counts.

### Trading hours and automatic restocking

Every merchant ships with hours set on Item Piles' *Merchant* tab — a jeweler
keeps 09:00–17:00, a dock opens at 05:00, the tavern runs 06:00 to 02:00, and
the fence trades 20:00 to 04:00 — along with `refreshItemsOnOpen`, so the shop
restocks each morning when the doors open.

**This module fires them, not Item Piles.** Item Piles has the same feature, but
only triggers it through its Simple Calendar plugin, and `BasePlugin.initialize()`
gates on that module being active *by id* — so no API shim helps, and neither
Foundry's built-in calendar nor Calendaria can drive it. Everything needed is
native in V14 (`game.time.components`, `game.time.calendar`) and
`game.itempiles.API.refreshMerchantInventory()` is public, so Merchant Presets
reads the same flags and calls the same refresh off `updateWorldTime`. Any
module that advances the world clock works, including Calendaria.

Turn it off with the *Restock shops when they open* setting. Only the designated
GM runs the pass, and the last processed world time is stored so a reload cannot
re-fire one. Winding the clock backwards never restocks.

Not supported: **closed days and holiday restocks**. Those are built on Simple
Calendar notes, which core has no equivalent for. The flags are shipped empty
and will work if you ever install Simple Calendar.

Merchants ship with status `open` rather than `auto` deliberately: with `auto`
and no Simple Calendar, Item Piles rewrites the flag on first render, which
throws on a locked module compendium.
- **Bundled goods** (Arrows ×20, Bolts ×20, Sling Bullets ×20, Needles ×50,
  Firearm Bullets ×10, Iron Spikes ×10) carry Item Piles' `quantityForPrice`,
  so a player pays the bundle price and receives the bundle. The Quantity column
  shows total *units* — that is what `system.quantity` means — so "Arrows (20)"
  at 460 is 23 bundles, and the buy dialog offers 23 purchases of 1 gp.
- **Services** — lodging, meals, ship passage, stabling, coach rides, tolls and
  spellcasting — are flagged `isService`: bought without an item changing hands,
  and never out of stock. They also carry `cantBeSoldToMerchants`, so nobody can
  sell a night's lodging back to the innkeeper.

## What a shop will buy, and with what

**Coin is finite.** Each merchant has a purse scaled to its trade and the
settlement — 40 gp for a village innkeeper, 12,500 gp for a city dock — and
cannot buy past it. Most shops pay **50%** of list; the Jeweler pays **60%**,
and the Criminal & Illicit Store pays **35%** while charging **125%**, the only
markup in the set. A merchant's coin depletes as it buys and only returns on
restock, so a party carrying 3,000 gp of loot has to find someone who can afford
it. Switch the *Merchant coin* setting to *Unlimited* to go back to shops that
can always pay.

**Shops only buy what they deal in.** Item Piles has no "only buys what it
sells" switch, but `overrideItemFilters` refuses items per merchant, so every
shop refuses each physical item type and each kind of this module's goods that
it does not itself stock. A fletcher takes weapons and ammunition but not plate
armour; a jeweler takes gems and jewellery but not a galley. The filters are
derived from each shop's own stock list at build time, so a merchant can never
refuse something it sells.

That last part needs a tag, because a ship and a gemstone are both dnd5e `loot`.
Every one of this module's goods carries `flags.merchant-presets.kind` —
`vehicle`, `mount`, `tack`, `drink`, `meal`, `lodging`, `service`,
`spellcasting`, `component` or `travel` — which the filters key on. SRD items
have no such flag, so those filters never touch them.

> Because `overrideItemFilters` **replaces** the global filter list rather than
> adding to it, each merchant also carries the `itempilesdnd5e` defaults
> (`background,class,facility,feat,race,spell,subclass` and `natural`).

## What the SRD costs you

Four stock lines have no SRD equivalent and are absent: **Carrion Crawler
Mucus** and **Lolth's Sting** (Criminal & Illicit Store), **Gunpowder Keg** and
**Gunpowder Powder Horn** (Tinkering Store). Everything else in the guide is
present.

One price is deliberately not the book's. The guide states its healing-potion
prices are lower than the published ones on purpose, so Potion of Healing
(Superior) is 1000 gp and (Supreme) is 5000 gp. Every other place the guide
disagreed with the rules was a 2014-era or typo'd figure (Shield 50 gp, Javelin
50 sp, Dart 5 gp) and the SRD wins.

## Building

`packs/` is generated and not tracked in git. `_source/` holds the JSON it is
compiled from, and `data/recipes.json` holds the shop composition.

```sh
npm install
npm run pack        # _source/*.json  ->  packs/*  (LevelDB)
```

That is all CI and the release workflow need — compiling the packs requires
nothing but this repository.

Regenerating `_source/` itself is a separate, rarer step. `tools/build_srd.py`
reads `data/recipes.json`, resolves each stock line against an unpacked copy of
the system's `dnd5e.equipment24` compendium, and writes the merchant and stock
table JSON. It needs the dnd5e system installed locally, and the paths at the
top of the script pointed at it.

Document ids are content-derived hashes and the stock rolls are seeded per item,
so a rebuild reproduces the same packs rather than churning them.

> **Close the world before building.** Foundry holds module packs open while a
> world is loaded and flushes its own in-memory copy over anything written
> underneath, silently reverting the build. `tools/build_srd.py` refuses to run
> in that case; `npm run pack` does not check.

## Legal

Unofficial fan content, not approved or endorsed by Wizards of the Coast.
Item statistics, prices and descriptions derive from System Reference Document
5.2, © Wizards of the Coast LLC, licensed under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
Shop composition adapted from The Inspired Arcana's free homebrew *Stores for
D&D 2024*.
