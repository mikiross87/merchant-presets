# Security policy

## Supported versions

Only the latest release gets security fixes. A fix ships as a patch release on
top of it.

## Reporting a vulnerability

Report it privately through
[GitHub's advisory form](https://github.com/mikiross87/merchant-presets/security/advisories/new),
not in a public issue, discussion or pull request. Include the Merchant
Presets, Foundry, dnd5e and Item Piles versions, and the steps that reproduce
it.

## Scope

In scope:

- `scripts/`, the JavaScript that runs in the browser of every GM and player in
  a world with the module enabled. For example: a purchase or chat message that
  lets one user act for another, or that renders script from item or actor
  data.
- The release workflow: anything that would let someone else publish a release
  or read the Foundry package registry token.

Report these upstream instead:

- Merchant windows, trading and currency handling:
  [Item Piles](https://github.com/fantasycalendar/FoundryVTT-ItemPiles).
- The game system: [dnd5e](https://github.com/foundryvtt/dnd5e).
- Foundry VTT itself.

A wrong price, stat or item in a shop is an ordinary bug. Use the bug report
form for it.
