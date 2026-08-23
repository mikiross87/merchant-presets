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

There are four linters, one per language, and `npm run lint` runs all four —
`lint:js`, `lint:py`, `lint:sh` and `lint:actions` run them individually.
ESLint comes with `npm install`; the rest you need on your PATH:

```
pip install -r requirements-dev.txt   # ruff
brew install shellcheck actionlint    # or apt-get install shellcheck, and see
                                      # rhysd/actionlint for its install script
```

| Files | Tool | Config |
| --- | --- | --- |
| `scripts/*.mjs`, `tools/*.mjs` | ESLint | `eslint.config.mjs` |
| `tools/build_srd.py` | Ruff | `ruff.toml` |
| `tools/*.sh` | ShellCheck | — |
| `.github/workflows/*.yml` | actionlint | — |

They are configured on the same principle: correctness rules that catch real
mistakes, not a house style. The generator's compact Python and the runtime's
formatting are both left alone deliberately, and each config records what it
does *not* enforce and why — read that before adding a rule or an ignore
comment.

actionlint is the one that earns its keep least obviously. These workflows are
mostly inline `bash`, and `lint:sh` never sees a line of it — it only reads
`tools/*.sh`. actionlint pipes every `run:` block through ShellCheck on top of
checking the workflow schema, expressions and context properties, so a typo in
`${{ github.event_name }}` fails a pull request rather than a push to `main`.
Its version and checksum are pinned in `ci.yml`; bump the two together.

It reaches for the same `shellcheck` binary as `lint:sh`, but the two do not
overlap: `lint:sh` reads `tools/*.sh` and never the workflows, actionlint reads
the workflows and never `tools/`. Install ShellCheck before trusting a green
`lint:actions` — without it actionlint drops that rule and still exits 0, so
the inline bash goes unchecked rather than unreported. CI asserts it is there.

The ESLint config splits the two halves of the repo, since `scripts/` runs in
Foundry's browser globals and `tools/` runs under plain Node. When the runtime
starts using a Foundry global the config does not list yet, add it to
`foundryGlobals` rather than reaching for an `eslint-disable` comment.

> **Close the world before running `npm run pack`.** Foundry holds module packs
> open while a world is loaded and flushes its own in-memory copy over anything
> written underneath, so the build appears to succeed and is silently reverted.

## Changing what the shops sell

`data/recipes.json` holds the shop composition — for each shop, its stock lines
and which settlement sizes carry them — and `tools/build_srd.py` turns that into
`_source/merchants` and `_source/stock`.

Shopkeeper tokens are neutral — a tradesperson is on nobody's side — unless the
shop's recipe sets `disposition` (1 friendly, 0 neutral, -1 hostile, -2 secret).

Regenerating is a separate, rarer step than packing, because it needs three of
the dnd5e system's SRD compendiums unpacked to JSON — the equipment the shops
sell, the actors the shopkeepers are statted from, and the monster features
those stat blocks reference:

```
for p in equipment24 actors24 monsterfeatures24; do
  fvtt package unpack -n "$p" --id dnd5e --type System \
    --in <dnd5e>/packs --out "/tmp/$p"
done
MP_SRD_DIR=/tmp/equipment24 MP_ACTORS_DIR=/tmp/actors24 \
  MP_FEATS_DIR=/tmp/monsterfeatures24 python3 tools/build_srd.py
npm run pack
```

Document ids are content-derived hashes and the stock rolls are seeded per item,
so regenerating reproduces the same packs rather than churning them. A stock line
naming an item that is not in the SRD is reported and skipped, not guessed at.

Four constraints worth knowing before changing the generator:

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
- **Goods can carry behaviour flags** that the runtime acts on at purchase, via
  Item Piles' `tradeItems` hook: `flags.merchant-presets.actor` names the SRD
  stat block an animal good stands for, and buying it copies that actor into the
  world. The generator copies the whole goods document onto each merchant, so a
  flag set in `_source/goods` needs a regeneration to reach the shops that sell
  it.
- **Containers** cannot carry a quantity: dnd5e declares
  `quantity: new NumberField({min: 1, max: 1})`, because each container is a
  distinct object with its own contents. A shop with four pouches holds four
  documents, and `reconcileContainers()` restores them after a restock.

## Pull requests

- Target `main`. CI must pass: the four linters, unit tests, manifest
  validation, JSON parse over `_source` and `data`, a full pack compile from
  source, and the paid-content check.
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
