# Changelog

All notable changes to Merchant Presets are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Each release's section is also the
body of its GitHub release.

Add an entry under **Unreleased** in the same pull request as the change, under
_Added_, _Changed_, _Fixed_ or _Removed_, written for players and GMs rather
than for the code. Reference the issue or PR it closes.

## [Unreleased]

### Added

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

### Removed

- The Jeweler's three *Spell Components (gems)* price bands. They were
  services, so paying for one left nothing in the pack, and each charged the
  top of its band. The named components above replace them. (#51)

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
