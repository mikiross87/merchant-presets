# What does this PR change?

Closes #


## Checklist

- [ ] `npm run pack` succeeds, and the change was tested in a Foundry V14
      `dnd5e` world with Item Piles active
- [ ] If `_source` or `data/recipes.json` changed, the packs were regenerated
      and the world was closed while building
- [ ] Nothing references the paid Player's Handbook or Dungeon Master's Guide
      modules — everything resolves against SRD 5.2
- [ ] A line under `[Unreleased]` in `CHANGELOG.md`, written for GMs
- [ ] No version bump in `module.json` (that happens in the release PR)
