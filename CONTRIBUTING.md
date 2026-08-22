# Contributing

Thanks for your interest. Two halves to this repo, with different rules:

- **Code** — `scripts/merchant-presets.mjs` is the whole runtime, loaded
  directly by Foundry as an ES module. No bundler, no transpiler.
- **Content** — the compendiums in `packs/` are *generated*. They are not
  tracked in git. The tracked source is the JSON in `_source/`.

## Local development

1. Clone the repo, then `npm install` (this only fetches the Foundry CLI, used
   to compile the packs).
2. Build the packs — nothing works without them, since they are not in git:
   ```
   npm run pack
   ```
3. Get it into Foundry, either by installing a release through the manifest URL
   and replacing the installed folder, or by pointing a copy of this directory
   at `<userdata>/Data/modules/merchant-presets`.
4. Enable the module in a `dnd5e` world alongside Item Piles and its dnd5e
   extension, and reload the browser after each change (`hotReload` is off).

> **Close the world before running `npm run pack`.** Foundry holds module packs
> open while a world is loaded and flushes its own in-memory copy over anything
> written underneath, so the build appears to succeed and is silently reverted.

## Changing what the shops sell

`data/recipes.json` holds the shop composition — for each shop, its stock lines
and which settlement sizes carry them — and `tools/build_srd.py` turns that into
`_source/merchants` and `_source/stock`.

Regenerating is a separate, rarer step than packing, because it needs two of
the dnd5e system's SRD compendiums unpacked to JSON — the equipment the shops
sell, and the actors the shopkeepers are statted from:

```
fvtt package unpack -n equipment24 --id dnd5e --type System \
  --in <dnd5e>/packs --out /tmp/equipment24
fvtt package unpack -n actors24 --id dnd5e --type System \
  --in <dnd5e>/packs --out /tmp/actors24
MP_SRD_DIR=/tmp/equipment24 MP_ACTORS_DIR=/tmp/actors24 python3 tools/build_srd.py
npm run pack
```

Document ids are content-derived hashes and the stock rolls are seeded per item,
so regenerating reproduces the same packs rather than churning them. A stock line
naming an item that is not in the SRD is reported and skipped, not guessed at.

Four constraints worth knowing before changing the generator:

- Everything must resolve against **SRD 5.2** (`dnd5e.equipment24` and
  `dnd5e.actors24`). CI fails the build if any reference to the paid Player's
  Handbook, Dungeon Master's Guide or Monster Manual modules appears in
  `_source` or `data`. Stat block items are the easy way to trip this: they ship
  inside the system's own SRD pack but carry `compendiumSource` pointers back at
  those modules, so `make_gear` drops any source that is not `Compendium.dnd5e.`.
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
- **Containers** cannot carry a quantity: dnd5e declares
  `quantity: new NumberField({min: 1, max: 1})`, because each container is a
  distinct object with its own contents. A shop with four pouches holds four
  documents, and `reconcileContainers()` restores them after a restock.

## Pull requests

- Target `main`. CI must pass: ES module syntax check, manifest validation,
  JSON parse over `_source` and `data`, a full pack compile from source, and the
  paid-content check.
- One logical change per PR, with a subject line that would read well in release
  notes — commit subjects become release-note bullets.
- Don't bump `version` in `module.json`; the maintainer versions and tags
  releases.

## Releases (maintainer)

Bump `version` in `module.json`, commit, tag `vX.Y.Z`, push the tag. CI compiles
the packs, builds the zip (excluding `_source`, `tools` and the npm files),
publishes the GitHub release, and registers the version with the Foundry package
registry if `FOUNDRY_RELEASE_TOKEN` is set.

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
