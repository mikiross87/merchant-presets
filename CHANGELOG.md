# Changelog

All notable changes to Merchant Presets are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is also the
body of its GitHub release.

Add an entry under **Unreleased** in the same pull request as the change, under
_Added_, _Changed_, _Fixed_ or _Removed_, written for players and GMs rather
than for the code. Reference the issue or PR it closes.

## [Unreleased]

### Upgrading from 1.x

2.0 drops Item Piles: each shop gets its own window, and the module carries
trades out itself. For GMs upgrading a world:

- **Back up the world first.** Going back to 1.x means restoring that backup:
  1.x can't read a 2.0 shop, and its *Set up as shop…* replaces a shop's data
  and re-rolls its stock.
- **What moves over on its own.** The first time a GM loads the world, every
  shop from this module (dragged in, or made with *Set up as shop…*), tokens
  included, keeps: its sell and buy rates and category price rules, its
  description, trading hours, the item types and kinds of goods it won't buy,
  its stock table and roll quantities, and each stock line's settings
  (unlimited or limited, service, not bought back, category, bundle size,
  hidden, not for sale). Other Item Piles merchants in the world are left
  exactly as they are.
- **What doesn't.** Only a shop's first stock table is carried; refusals by
  item subtype aren't; a setting that doesn't make sense is reset to the
  default. Each of these is logged in the browser console, naming the shop.
  Anything else Item Piles held, such as a custom per-item price list, is not
  read.
- **What changes for players.** Double-clicking a shop's token opens its shop
  window, from a token of theirs within 5 ft of it; shops no longer show in
  their Actors sidebar unless *Shop access* is *From anywhere*. A GM has to be
  logged in for a trade to go through; with none, the window says so and keeps
  the bill.
- **Restocking and the till.** Upgraded worlds keep restocking off until you
  turn *Shops restock on their schedule* on. A restock now tops the till up to
  the shop's starting purse and never takes coin away, where 1.x reset it to
  exactly the purse: a shop that did well keeps what it earned. Goods you added
  by hand survive a restock.
- **Keeping Item Piles installed** is fine; nothing here talks to it. If its
  *giving items* setting is on, a player dropping an item on a shop's token
  offers it as a gift the GM has to confirm, as with any token.
- **Macros** calling the module's Item Piles-era functions need removing; they
  are listed under *Removed*.

### Added

- 2.0: the service shops say what their goods do. At a temple, arcane or
  druidic store a named spell shows by name with its level and school
  ("Level 3 Necromancy"), a level service reads "any Level 1 spell", and the
  bill says who it's cast for. The receipt in chat names a bought spell the
  same way the shelf does. At the stable a mount "joins the buyer" (where
  bought animals arrive as actors) and the bill says so; saddles, carts and
  boats read as tack and vehicles, not loot. A long shop description stops at
  two lines, and long category names wrap. (#151)
- 2.0: a *Till* section in the shop window's Settings tab, where the GM sets
  the coins a shop holds, coin by coin, and the gold each restock refills it
  to, shown beside the preset's own amount. A restock tops the gold up to that
  amount and never takes coin away; set it to 0 and restocks leave the till
  alone. Under *Merchant coin: Unlimited* the till is bottomless and the
  section says so. (#147)
- 2.0: a world setting, *Shops follow the world clock*: *Auto* (the default),
  *Always* or *Never*. In a world that doesn't keep time, shops no longer sit
  closed for good at the hour the clock stopped: they're always open, restock
  only by hand, and put no date on a bill or a receipt. *Auto* follows the
  clock wherever anything keeps time: dnd5e's calendar is on, a calendar module
  runs it, or a whole day has passed on the clock. (#149)
- 2.0: after a restock, the goods that came back in stock wear a *New* badge
  and the shop shows *Fresh stock today*, until the shop next closes. A shop
  that doesn't close (no hours, open round the clock, or *Shops keep their
  trading hours* off) keeps them for a day. A restock while the shop is closed
  is fresh for its next opening. A good that sells out loses its badge. (#152)
- 2.0: each shop's own window — its portrait, hours, tier and terms of trade
  up top, a Buy tab with categories and stock, a Sell tab that shows what the
  shop deals in and what it won't touch, and a running Bill of Sale that
  totals the basket and what's left in the buyer's purse. Players pick which
  of their own characters (or other owned actors) they're buying as; GMs can
  buy or sell as anyone, and get a Settings tab and a button back to the
  NPC's own stat sheet. It opens like any other actor sheet — double-click
  the shop's token. (#103)
- 2.0: the shop window's GM-only Settings tab, where each shop's terms are
  changed: what it sells and buys at (or the world default), category rules,
  what it won't buy, its hours, and how often and how it restocks, with
  *Restock now*, *Players can visit* and *Reset to preset*. Changes save as
  you make them, and every open shop window reprices at once. Two new world
  settings, *Shops sell at (%)* and *Shops buy at (%)*, set the rates for any
  shop whose terms are on *World default*. Most shipped merchants import on
  *World default* (the few with their own rates keep them); shops already in
  your world keep the rates they have until you tick it. Shops that buy gems
  and art at full value sell them at their own rate, and never pay more for
  them than they charge: below 100% sells, they buy them back at that rate
  too. (#110, #141)
- 2.0: deals — give one character their own price at one shop, from the
  Settings tab: cheaper when they buy, more when they sell, or both, with an
  optional note and an end (when the shop next closes, after some days, or
  never). Only that character sees it: their shop window shows "Your price
  −10%" up top, the usual price struck beside theirs, tags each bill line the
  deal changed with its "−10%", and says what the deal saved them. An ended
  deal stays in the list, dimmed, saying when it ended, until you edit or
  remove it. No deal can make selling pay more than buying. The note is never
  shown to players, but it's saved on the shop, so a player could read it
  from the browser console. (#111, #145)
- 2.0: sealing a bargain in the shop window carries the trade out on the GM's
  side, with no Item Piles involved: the goods, the coin and the shop's stock
  all move at once, two players can't both buy the last one, and a trade sent
  twice over a flaky connection only happens once. A GM has to be logged in;
  with none, the window says so and keeps the bill. Each trade posts one
  receipt in chat, public or whispered to the GMs, or none, set by the new
  *Trades in chat* setting. The receipt shows the shop, the in-world date and
  who can see it, each good with its picture and price, the total, and a note
  on the coins: exact change or the change given, or for a sale the rate paid
  and what the till has left. Meals, bought animals and spellcasting work the
  same way they did through Item Piles. (#102, #145)
- 2.0: shops restock on their own schedule, now on by default: each kind every
  so many days (an inn daily, a general store every 3, a jeweler every 14),
  when its doors open on the due day. A restock redraws only what the shop's
  stock table put on the shelf. Goods you added by hand stay, and a line you
  hid or edited keeps your settings. Worlds upgrading from 1.x keep restocking
  off until you turn it on. (#105)
- 2.0: the shops run without Item Piles. Double-clicking a shop's token opens
  its shop window, for players and GMs alike. Every shop you drag in rolls its
  own shelf, and *Set up as shop…* works without Item Piles too. Shops already
  in your world move over on their own the first time you load, tokens
  included. (#104)
- 2.0: players shop at the counter. A shop stays out of players' Actors
  sidebar, and a player opens it by double-clicking its token while a token of
  theirs stands within 5 ft of it; too far, and they're told to step up.
  Walking away closes the window, *Buying as* lists only the characters
  standing there, and the GM checks the distance again for every trade. A
  player you give a permission of their own on a shop opens it from anywhere.
  For games without a map, the new *Shop access* setting's *From anywhere*
  opens a shop to every player once its token is placed. (#166)
- 2.0: rations and water count as food and drink. Shops that won't buy food
  and drink, the smith among them, now turn away a party's rations and water,
  and the shop window lists them under Food & drink. The general, adventurers'
  and druidic stores, which sell rations, now buy food and drink too, ale and
  bread included. (#150)
- Shops sell the spell components SRD 5.2 spells put a price on, as real items
  that go in the buyer's pack: 43 of them, from a Diamond (300 GP) for
  Revivify to the Diamonds (25,000 GP) for True Resurrection. The Jeweler
  carries the gems, art and trade goods; the Temple & Faith Store, Arcane
  Store, Alchemists & Apothecaries and city Druidic Store carry the incense,
  inks, powders, foci and oils their spellcasters use. Each component names
  the spells that use it and says whether casting uses it up. They are limited
  stock that sells out and restocks, and shops that sell no components won't
  buy them. Merchants already in your world keep their old stock list; drag in
  a fresh merchant from the compendium to get them. (#51)
- Gems, art objects and trade goods sell back at their full price, as SRD 5.2
  has it, instead of at the shop's rate: an unused Diamond (300 GP) returns
  300 GP at any shop that buys components, wherever it was bought. Everything
  else, incense and inks included, still sells at the shop's rate. The shop
  window lists them under their own *Valuables* heading. Merchants already in
  your world keep their old prices; drag in a fresh merchant to get this. (#53)
- Spells with expensive components are hired out by name, with the component
  in the price, so nobody has to work out the total at the table:
  *Spellcasting: Revivify* costs 600 GP, the level 3 service plus its 300 GP
  diamond. That's the 31 spells that work without the caster, sold wherever
  their class lists and level allow: the Arcane Store has 6 in a village, 15
  in a town and 22 in a city; the Druidic Store 2, 9 and 12; the Temple &
  Faith Store 2, 12 and 19. Spells a buyer can't use without the caster along,
  such as Warding Bond or Find Familiar, are still bought by level. They're
  listed under their own *Spells, Components Included* heading, below the
  level services. The level services now say to add the cost of any expensive
  components you don't bring for a spell that isn't listed. Merchants already
  in your world keep their old stock list; drag in a fresh merchant to get
  these. (#55)
- Buying spellcasting now shows in chat: the shop says which spell it casts
  and for whom, links the spell, and links any effects it puts on a creature,
  such as Raise Dead's Resurrection Sickness, for the GM to drag onto whoever
  it was cast on. A spell bought by level asks the buyer to tell the GM which
  one. Nothing is applied automatically. The message is whispered to the GMs
  when *Trades in chat* is, and the *Bought spellcasting is announced in chat*
  setting turns it off. (#70)
- Turn any NPC into one of the shops: right-click it in the Actors sidebar,
  choose *Set up as shop…*, pick a shop and a settlement size, and tick the
  items it keeps as its own. It becomes that merchant, with the stock, buying
  rules, prices, purse and trading hours, and keeps its own name, portrait,
  stat block and token. Handy for the shopkeepers a published adventure
  already gives you. Setting it up again with another shop or size keeps its
  gear and replaces the stock. (#57)

### Changed

- The Arcane Store's *Spell Scroll, Level 1* shows as Common on dnd5e 6, as
  the SRD has it, where it showed no rarity before. Its spell scrolls also
  record their spell level the way dnd5e 6.0.5's own do. A restock already
  drew its scrolls from dnd5e's own compendium, so this only changes the first
  stock of a merchant dragged in fresh. (#91)
- Verified on dnd5e 6.0.5. The oldest dnd5e it supports is now 5.3.0, the
  first 5.x release made for Foundry 14, where it has been tested; it used to
  say 5.0.0, which had never been tested. Nothing here needs dnd5e 6.
  (#86, #93)

### Removed

- 2.0: Item Piles and itempilesdnd5e are no longer required, and nothing here
  talks to Item Piles any more; a world that keeps it for its own merchants
  or loot can. Macros calling the module's Item Piles-era functions
  (`rewire`, `rewireAll`, `restockOnTimeChange`, `reapplyItemFlags`,
  `reconcileContainers`, `replenishPurse`, `syncOpenState`,
  `syncOpenStateAll`) need removing: the
  shops restock, open and close on their own now. (#106)
- The Jeweler's three *Spell Components (gems)* price bands. They were
  services, so paying for one left nothing in the pack, and each charged the
  top of its band. The named components above replace them. (#51)

### Fixed

- A merchant dragged in from the compendium after an update now stocks what
  that update sells. Until now, a world that had imported the same shop before
  restocked every later copy from the old stock list, so a change to what a
  shop sells never reached it. Merchants already in your world keep the list
  they have, along with any changes you made to it; drag in a fresh merchant
  to get the new stock. Its table appears in *Merchant Stock* beside the old
  one, with the version in its name, such as *Jeweler (Town) (v1.3.0)*. (#63)
- Dragging in a shop your world already has and choosing *Replace Actor*,
  Foundry's default, now gives a working merchant. The replaced merchant was
  left on the compendium's stock table: its stock was never rolled, and opening
  its *Populate Items* tab removed the table for good. A merchant replaced this
  way whose tab hasn't been opened is fixed when the world next loads; one
  whose tab was opened needs replacing again. (#66)
- Rope, Robe, Ink, Ink Pen, Bedroll, Blanket, Tinderbox, Caltrops, Crowbar,
  Waterskin and Perfume show up in the shop window again. Every release so far
  stocked them as copies taken out of the SRD's equipment packs, and each copy
  still said it was inside its pack. The merchant's sheet listed them, but the
  shop window hid them, so players couldn't buy them. 36 of the 51 shops were
  affected, the General Stores worst. Merchants already in your world are
  repaired when the world loads. A merchant dragged in fresh gets a new stock
  table with the version in its name. (#89)

## [1.2.4] - 2026-09-14

### Fixed

- Shops now open and close with the world clock once they are in the world.
  Every merchant dragged out of the compendium had its trading hours set once,
  at import, and then stayed open or shut however much time passed. Turning
  *Shop stock is not carried* on or off now also reaches merchants already in
  the world. Merchants you have already imported are fixed by reloading the
  world; their stock is left as it is. (#56)
- Spellcasting services at the Arcane Store, Druidic Store and Temple & Faith
  Store now say that a spell with expensive components costs those components
  on top, as the SRD's Spellcasting Services rule has it. Each service's
  description and the shop window both say so, and the service prices are
  unchanged: Revivify is the 300 GP level 3 service plus its 300 GP diamond.
  Merchants already in a world get the new service text on their next
  restock; the note in the shop window needs a fresh merchant from the
  compendium. (#52)

## [1.2.3] - 2026-09-13

### Changed

- The optional Simple Nutrition 5e support — meals that feed the buyer, and
  goods consumed from the sheet — now needs Simple Nutrition 1.0 or later.
  With an older version nothing is recorded and the GM sees a warning at load
  asking to update it. Without Simple Nutrition, merchants work as before. (#42)
- Verified on dnd5e 6.0.1. dnd5e 5.0.0 or later is still enough; nothing here
  needs 6.0. (#45)

### Fixed

- With Simple Nutrition 5e 1.0, meals eaten at an inn and ale, wine, bread or
  cheese consumed from the sheet credit the right share of a day for every
  creature size. Tiny, Large and bigger characters, and characters with a
  custom daily need, were credited as if they were Medium, and could stay
  Malnourished or Dehydrated after eating a full day's worth. (#42)
- Drinking ale or wine no longer clears Malnourished because the day's food was
  already eaten, and eating no longer clears Dehydrated because the day's water
  was already drunk; as in Simple Nutrition's own dialog, a meal only counts
  towards the condition for what it provides. (#42)
- Using ale, wine, bread or cheese from the sheet several times in quick
  succession now counts every one. Uses that landed before the previous one had
  saved could count as a single item, leaving a character short for the day.
  (#44)
- Buying a meal at an inn asks the buyer whether to eat it, and buying an
  animal at a stable adds it to the world, again. With Item Piles 3.3, both
  purchases went through but nothing else happened: no prompt, no credit, no
  animal. (#48)

## [1.2.2] - 2026-08-25

### Fixed

- Shopkeepers who can cast — the Temple, and the town and city Alchemist,
  Druidic, Arcane and Tinkering stores — now show their spells on the Spells
  tab. Their spells were copied with a link to the wrong feature, so the sheet
  hid them and casting through Divine Aid or Spellcasting left a stray copy on
  the merchant. Merchants already in a world keep the old links; drag a fresh
  one from the compendium. (#36)

## [1.2.1] - 2026-08-25

### Fixed

- Using the Consume activity on ale, wine, bread or cheese from the character
  sheet now counts towards Simple Nutrition 5e, the same as consuming it through
  Simple Nutrition's own dialog. New world setting *Eating from the sheet
  counts*, on by default (#19)

## [1.2.0] - 2026-08-23

### Added

- Buying an animal puts a copy of its SRD stat block in the world, ready to
  drop on a scene (#15)
- Buying a meal offers to eat it on the spot (#14)

### Changed

- Shopkeeper tokens are neutral rather than friendly; a shop recipe can set
  `disposition` to override (#16)

### Fixed

- Broken icons on the spell-component gems (#13)

## [1.1.0] - 2026-08-22

### Added

- Shops open and close on the world clock, driving Item Piles' own open/closed
  status from Foundry's world time. On by default; the setting hands every shop
  back to always-open (#5)
- Every shopkeeper carries an SRD 5.2 stat block that escalates with the
  settlement size. Gear is tagged so it never reaches the shelf and restocking
  never treats it as merchandise (#9)
- _Shop stock is not carried_ — an opt-in setting that cancels the weight of
  the stock so the Encumbrance variant rule only counts the shopkeeper's own
  kit (#8)

### Changed

- The `drink` goods kind is renamed `food-drink` (#6)
- The generator no longer indexes the SRD equipment pack's folders, so a stock
  line named "Potions" cannot resolve to a folder (#4)
- README: accurate Merchant Goods counts, status badges; build instructions
  moved to CONTRIBUTING (#3)
- Releases are gated on the CI validation (#10)

## [1.0.0] - 2026-08-20

### Added

- Fifty-one SRD 5.2 shops as Item Piles merchants — seventeen stores in
  Village, Town and City sizes, each pre-stocked and priced
- Opt-in restocking that preserves flags and refills the till
- Containers stocked as separate items, one each
- Original item descriptions and SRD prices throughout

[Unreleased]: https://github.com/mikiross87/merchant-presets/compare/v1.2.4...HEAD
[1.2.4]: https://github.com/mikiross87/merchant-presets/compare/v1.2.3...v1.2.4
[1.2.3]: https://github.com/mikiross87/merchant-presets/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/mikiross87/merchant-presets/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/mikiross87/merchant-presets/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mikiross87/merchant-presets/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mikiross87/merchant-presets/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mikiross87/merchant-presets/releases/tag/v1.0.0
