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

Regenerating is a separate, rarer step than packing, because it needs the dnd5e
system's SRD compendium unpacked to JSON:

```
fvtt package unpack -n equipment24 --id dnd5e --type System \
  --in <dnd5e>/packs --out /tmp/equipment24
MP_SRD_DIR=/tmp/equipment24 python3 tools/build_srd.py
npm run pack
```

Document ids are content-derived hashes and the stock rolls are seeded per item,
so regenerating reproduces the same packs rather than churning them. A stock line
naming an item that is not in the SRD is reported and skipped, not guessed at.

Two constraints worth knowing before changing the generator:

- Everything must resolve against **SRD 5.2** (`dnd5e.equipment24`). CI fails the
  build if any reference to the paid Player's Handbook or Dungeon Master's Guide
  modules appears in `_source` or `data`.
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
