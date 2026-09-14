# Contributing

Thanks for your interest. Two halves to this repo, with different rules:

- **Code** — `scripts/merchant-presets.mjs` is the whole runtime, loaded
  directly by Foundry as an ES module. No bundler, no transpiler.
- **Content** — the compendiums in `packs/` are *generated*. They are not
  tracked in git. The tracked source is the JSON in `_source/`.

## Local development

1. Clone the repo, then `npm install` (this fetches the Foundry CLI, used to
   compile the packs, and ESLint).
2. Build the packs — nothing works without them, since they are not in git:
   ```
   npm run pack
   ```
3. Get it into Foundry, either by installing a release through the manifest URL
   and replacing the installed folder, or by pointing a copy of this directory
   at `<userdata>/Data/modules/merchant-presets`.
4. Enable the module in a `dnd5e` world alongside Item Piles and its dnd5e
   extension, and reload the browser after each change (`hotReload` is off).

Run `npm run lint` and `npm test` before pushing; CI runs both.

Two linters, and `npm run lint` runs both — `lint:js` and `lint:actions` run
them individually:

| Files | Tool | Config |
| --- | --- | --- |
| `scripts/*.mjs`, `tools/*.mjs` | ESLint | `eslint.config.mjs` |
| `.github/workflows/*.yml` | actionlint | — |

ESLint comes with `npm install`. It is configured for correctness rather than
house style — the formatting is left alone deliberately, and the config records
what it does *not* enforce and why, which is worth reading before adding a rule
or an `eslint-disable` comment. It splits the two halves of the repo, since
`scripts/` runs in Foundry's browser globals and `tools/` runs under plain Node;
when the runtime starts using a Foundry global the config does not list yet, add
it to `foundryGlobals` rather than suppressing the error.

actionlint earns its place less obviously. These workflows are mostly inline
`bash`, and none of it lives in a `.sh` file where a shell linter would find it.
actionlint checks the workflow schema, expressions and context properties *and*
pipes every `run:` block through ShellCheck, so a typo'd
`${{ github.event_name }}` or a broken heredoc fails a pull request instead of a
tag push — which is the only way you would otherwise find out, since a release
workflow cannot be run locally. CI uses the published image, which bundles
ShellCheck; for local runs install actionlint yourself (`brew install
actionlint`, or the install script in rhysd/actionlint) along with ShellCheck.
Without ShellCheck on your PATH actionlint drops that rule and still exits 0, so
the inline bash goes unchecked rather than unreported.

`tools/build_srd.py`, `tools/build_spell_goods.py` and `tools/check_icons.sh`
are not linted. They are maintainer scripts, run by hand and never shipped, and
they fail visibly in front of the person who just changed them.

> **Close the world before running `npm run pack`.** Foundry holds module packs
> open while a world is loaded and flushes its own in-memory copy over anything
> written underneath, so the build appears to succeed and is silently reverted.

## Changing what the shops sell

`data/recipes.json` holds the shop composition — for each shop, its stock lines
and which settlement sizes carry them — and `tools/build_srd.py` turns that into
`_source/merchants` and `_source/stock`.

Shopkeeper tokens are neutral — a tradesperson is on nobody's side — unless the
shop's recipe sets `disposition` (1 friendly, 0 neutral, -1 hostile, -2 secret).

`data/components.json` holds the spell components, and
`tools/build_spell_goods.py` turns it into their goods in `_source/goods` and
their lines in `data/recipes.json`. Don't edit either by hand: the next run
replaces every component good and line.

It also writes the spellcasting services sold by name (#55) and their lines.
The seven level services (`Spellcasting: Cantrip` to `Level 9`) are edited by
hand, and the named services take their prices from them.

Regenerating is a separate, rarer step than packing, because it needs five of
the dnd5e system's SRD compendiums unpacked to JSON — the equipment the shops
sell, the actors the shopkeepers are statted from, the monster features those
stat blocks reference, the spells whose material components the component
goods and named services come from, and the content pack whose class spell
lists decide which shop hires out which spell:

```
for p in equipment24 actors24 monsterfeatures24 spells24 content24; do
  fvtt package unpack -n "$p" --id dnd5e --type System \
    --in <dnd5e>/packs --out "/tmp/$p"
done
MP_SPELLS_DIR=/tmp/spells24 MP_CONTENT_DIR=/tmp/content24 \
  python3 tools/build_spell_goods.py
MP_SRD_DIR=/tmp/equipment24 MP_ACTORS_DIR=/tmp/actors24 \
  MP_FEATS_DIR=/tmp/monsterfeatures24 python3 tools/build_srd.py
npm run pack
```

`build_spell_goods.py --check` validates without writing anything.

Document ids are content-derived hashes and the stock rolls are seeded per item,
so regenerating reproduces the same packs rather than churning them. A stock line
naming an item that is not in the SRD is reported and skipped, not guessed at.

Constraints worth knowing before changing the generator:

- Everything must resolve against **SRD 5.2** (`dnd5e.equipment24`,
  `dnd5e.actors24`, `dnd5e.monsterfeatures24`). CI fails the build if any
  reference to the paid Player's Handbook, Dungeon Master's Guide or Monster
  Manual modules appears in `_source` or `data`. Stat block items are the easy
  way to trip this: they ship inside the system's own SRD packs but point at
  those modules. `make_gear` repairs the pointer rather than dropping it — a
  Monster Manual feature id is the same id `monsterfeatures24` ships, so only
  the pack changes, and physical gear falls back to the equipment item of the
  same name. Only what has no SRD document at all ends up sourceless.
- **`load_srd` skips folders.** The equipment pack ships 44 of them alongside its
  items, and 43 share no name with any item — `Wands`, `Potions`, `Rods`,
  `Scrolls`, `Tools`, `Holy Symbol`. Indexed by name they shadow the lookup, and
  a stock line naming one would resolve to the folder and be embedded as an item
  rather than being reported missing.
- **Shopkeeper gear is not stock.** `PROFILES` maps each shop and size to an SRD
  stat block, whose items ride along on the merchant tagged
  `flags.merchant-presets.kind: "gear"`. That kind is in every shop's refuse
  list, so it never reaches the shop window, and the three restock helpers in
  `scripts/merchant-presets.mjs` skip it via `isGear`. Gear is appended *after*
  the item filters are computed — inside the loop its own types would otherwise
  read as stocked and let a chain shirt onto the shelf.
- **`flags.merchant-presets.profile` is how the runtime recognises a merchant.**
  Import repoints the merchant's stock table from the compendium to a world
  copy, so the table only identifies a merchant until then; `profile` survives
  the import and the runtime never writes it. Keep emitting it on every
  merchant, or the trading-hours and stock-weight passes skip the world copies
  (#56). Stock is rolled only in the `rewire` call that wires a compendium
  table, so `rewireAll()` never re-rolls a shop already in the world.
  `rewire` runs on `createActor`, and on `updateActor` for a merchant still on
  its compendium table: Foundry's *Replace Actor*, the default when the world
  already holds that shop, imports as an update (#66). The `ready` pass wires
  any such merchant left over. `rewire` handles one pass per merchant at a
  time, since both hooks can arrive together.
- **World stock tables are stamped with the list they were copied from**
  (`flags.merchant-presets.stock`). An import reuses a world table only while
  its stamp still matches the compendium table, so changing a shop's stock
  lines reaches merchants dragged in afterwards and leaves the ones already in
  a world on their old list (#63). A recipe change that alters a shop's lines
  therefore needs its CHANGELOG line to tell GMs to drag in a fresh merchant.
- **Goods can carry behaviour flags** that the runtime acts on at purchase, via
  Item Piles' `tradeItems` hook: `flags.merchant-presets.actor` names the SRD
  stat block an animal good stands for, and buying it copies that actor into the
  world. The generator copies the whole goods document onto each merchant, so a
  flag set in `_source/goods` needs a regeneration to reach the shops that sell
  it.
- **Spell components are checked against the spell text, both ways.** Each row
  in `data/components.json` names the spells that use it and the exact text
  naming the component, and `build_spell_goods.py` stops if that text is not in
  the spell, prices it differently, or gives it a different tier. It also stops
  if any priced component of any SRD spell is neither a row nor listed under
  `not_stocked`. Consumption is read from the text ("which the spell
  consumes"), not from the spell's `materials.consumed`, which is one flag per
  spell and wrong on Sequester. An `identifier` is fixed once released: other
  modules and dnd5e's Material consumption find a component by it.
- **Spells with a priced component are also sold by name** (#55). Every
  costed spell becomes a service priced at its level service plus the sum of
  its costed parts, each multiple counted. Shops are assigned from the
  `dnd5e.content24` class spell lists, using the classes in `SHOP_CLASSES`.
  Each line's size comes from the shop's own level-service line for that
  level. The build stops if a spell lands in no shop, a class list names a
  spell not in `spells24`, or a shop would sell a named spell without its
  level service. Named services carry `flags.merchant-presets.spell`, which is
  how the script tells its own goods from the hand-made level services.
- **Valuables sell back at full value** (SRD 5.2 *Equipment*). A good of type
  `loot` whose `system.type.value` is `gem`, `art` or `trade` is filed under
  the Item Piles custom category *Valuables*: on the good, on each shop's
  copy, and in the shop's restock record. Every shop whose item filters let
  one in carries an `itemTypePriceModifiers` entry that overrides its rate
  for that category with 1. `is_valuable` in `build_srd.py` is the one
  definition. It checks the item type because dnd5e also files artisan's tools
  under `system.type.value: "art"`. Per-item `sellPriceModifier`s were
  rejected: they multiply the buying shop's rate, and the player's copy
  carries the factor of the shop it was bought at (#53).
- **Containers** cannot carry a quantity: dnd5e declares
  `quantity: new NumberField({min: 1, max: 1})`, because each container is a
  distinct object with its own contents. A shop with four pouches holds four
  documents, and `reconcileContainers()` restores them after a restock.

## Pull requests

- Target `main`. CI must pass: both linters, unit tests, manifest validation,
  JSON parse over `_source` and `data`, a full pack compile from source, and
  the paid-content check.
- One logical change per PR, with a subject line that would read well in release
  notes — commit subjects become release-note bullets.
- Open an issue first for anything beyond a typo, and put `Closes #N` in the PR
  body so merging closes it. Issues go through the forms; there are no blank
  issues.
- Add a line under `[Unreleased]` in `CHANGELOG.md` — _Added_, _Changed_,
  _Fixed_ or _Removed_ — written for the GM reading the release page. That
  section becomes the release notes verbatim.
- Don't bump `version` in `module.json`. `main` carries the version of the last
  release; the bump happens in a release PR (see [RELEASING.md](RELEASING.md)).

## Releases (maintainer)

`main` is the only long-lived branch, and it carries unreleased work. There is
no separate development branch, because what has been published is recorded by
tags rather than by a branch: releases are cut from `vX.Y.Z` tags, and installs
resolve a release asset, never a branch. `git log vX.Y.Z..main` is the
unreleased set, and several merged pull requests routinely go out in one
release.

To cut one:

1. Set `version` in `module.json` to the plain release version (drop the `-dev`
   suffix), commit, tag `vX.Y.Z`, push the tag.
2. Bump `version` to the next `-dev` (e.g. `1.2.0-dev`) and commit, so a clone
   of `main` never reports itself as the released version — issue triage labels
   a report `outdated` by comparing the version it names against the latest
   release.

Pushing the tag runs the CI validation against the tagged tree first; a release
is only built if that passes. The release job then compiles the packs, builds
the zip (excluding `_source`, `tools` and the npm files), publishes the GitHub
release with notes drawn from the commit subjects since the previous tag, and
registers the version with the Foundry package registry if
`FOUNDRY_RELEASE_TOKEN` is set.

### Prereleases

To let a change bake, use a semver prerelease version — e.g. `1.1.0-beta.1` in
`module.json`, tagged `v1.1.0-beta.1`. CI detects the hyphen and treats it
differently:

- Marked as a GitHub **prerelease** (won't show as the repo's "Latest release").
- **Not** registered with the Foundry package registry.
- **Not** picked up by the stable `releases/latest/download/module.json`
  manifest, so existing installs never auto-update to it.

Install one with that tag's own pinned manifest URL:
`https://github.com/mikiross87/merchant-presets/releases/download/vX.Y.Z-beta.N/module.json`.
Once confirmed, cut the real release: bump to the plain version, commit, tag,
push — that one does register normally.
