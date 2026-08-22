# Merchant Presets — Shops for 5e

![Foundry Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmikiross87%2Fmerchant-presets%2FHEAD%2Fmodule.json&query=%24.compatibility.verified&prefix=v&label=foundry&color=informational)
![System](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fmikiross87%2Fmerchant-presets%2FHEAD%2Fmodule.json&query=%24.relationships.systems%5B0%5D.compatibility.verified&prefix=dnd5e%20v&label=system&color=informational)
![Latest Release](https://img.shields.io/github/v/release/mikiross87/merchant-presets?label=version)
![Downloads](https://img.shields.io/github/downloads/mikiross87/merchant-presets/module.zip?label=downloads)
[![CI](https://github.com/mikiross87/merchant-presets/actions/workflows/ci.yml/badge.svg)](https://github.com/mikiross87/merchant-presets/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT%20code%20%7C%20CC%20BY%204.0%20content-informational)](LICENSE)

A module for **[Foundry Virtual Tabletop](https://foundryvtt.com/)** v14 and the
**dnd5e** system, built on
[Item Piles](https://github.com/fantasycalendar/FoundryVTT-ItemPiles).

Seventeen ready-made shops as Item Piles merchants, in Village / Town / City
sizes — **51 merchants, 1,351 stock lines.** Drag one out of the compendium,
drop a token, and your players can shop.

Built entirely from **SRD 5.2** (CC-BY-4.0) plus this module's own goods, so it
works in any `dnd5e` world and redistributes no paid content.

Inspired by the free homebrew *Stores for D&D 2024* by
[The Inspired Arcana](https://www.patreon.com/TheInspiredArcana) — worth your
time, and worth a follow.

## Install

Paste this manifest URL into Foundry's **Install Module** dialog:

```
https://github.com/mikiross87/merchant-presets/releases/latest/download/module.json
```

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

Prices and weights are the SRD's, verified line by line against those tables, so
50 of them are marked `SRD 5.2 · CC-BY-4.0` even though this module authors the
item document — the content is the SRD's, and CC-BY asks to be told so.

Six carry no source at all, being neither in the SRD nor in the 2024 rules: the
two coach rides and the road toll, carried over from the 2014 *Services* table
because the shop guide sells them, and the three spell-component price bands.

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
- **Always limited either way** — poisons, spell scrolls and other consumables
  a party would not find in unlimited supply. Sell out and they're gone until
  restock. A restock rebuilds items from the SRD compendium, which carries no
  Item Piles flags, so each merchant stores the intended per-item flags by name
  and the module re-applies them afterwards — otherwise limited stock would
  quietly become unlimited after the first restock.
- **Containers are stocked as separate items.** Backpacks, pouches, chests and
  the like can't carry a quantity in dnd5e — each container is its own object
  with its own contents, exactly as two pouches on a character sheet are two
  items. So a shop with four pouches lists four pouches, shown as separate rows
  with no quantity, bought one at a time. Counts are deliberately small (1d2 in
  a village, up to 1d4 in a city), because they are rows in the list rather than
  a number.
- **Restocking** — open the merchant, *Populate Items* tab, **Roll All Tables**.
  Each merchant is pre-wired to its own stock table in `addAll` mode, so this
  rebuilds the canonical list and re-rolls the counts.

### Trading hours and automatic restocking

Every merchant ships with hours set on Item Piles' *Merchant* tab — a jeweler
keeps 09:00–17:00, a dock opens at 05:00, the tavern runs 06:00 to 02:00, and
the fence trades 20:00 to 04:00 — along with `refreshItemsOnOpen`, so the shop
restocks each morning when the doors open.

**This module fires them, not Item Piles.** Item Piles has the same feature but
only triggers it through Simple Calendar, which it requires by name — so it will
not fire from Foundry's built-in calendar or from Calendaria. This module drives
the same restock off Foundry's own world clock instead, so anything that
advances time works.

**Off by default**, via the *Restock shops when they open* setting. A restock
rebuilds the shelf from the shop's stock table, and Item Piles clears the
merchant's existing items to do it — so anything you added to a shop by hand is
discarded. Turn it on once your shops hold nothing you would miss. Only the
designated GM runs the pass, the last processed world time is stored so a reload
cannot re-fire one, and winding the clock backwards never restocks.

To restock one shop by hand, with the flags and purse restored:

```js
game.modules.get("merchant-presets").api.restock(actor)
```

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
markup in the set. A merchant's coin depletes as it buys and is refilled to the shop's own purse on
restock, so a party carrying 3,000 gp of loot has to find someone who can afford
it — or come back another day. Switch the *Merchant coin* setting to *Unlimited* to go back to shops that
can always pay.

**Shops only buy what they deal in.** Every merchant refuses item types it does
not itself stock: a fletcher takes weapons and ammunition but not plate armour,
a jeweler takes gems and jewellery but not a galley. What each will accept is
derived from its own stock list, so a shop can never refuse something it sells.

Item type alone is not enough to tell a galley from a gemstone — dnd5e calls
both `loot` — so this module's goods each carry a kind (vehicle, mount, tack,
drink, meal, lodging, service, spellcasting, component, travel) that the filters
match on.

## Prices

Every price, weight and description is the SRD's, with no exceptions.

## Contributing

Building the packs, changing what the shops stock, and cutting releases are all
covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## Legal

Unofficial fan content, not approved or endorsed by Wizards of the Coast.
Item statistics, prices and descriptions derive from System Reference Document
5.2, © Wizards of the Coast LLC, licensed under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/legalcode).
