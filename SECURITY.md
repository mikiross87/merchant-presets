# Security policy

## Supported versions

Only the latest release gets security fixes. A fix ships as a patch release on
top of it.

## Reporting a vulnerability

Report it privately through
[GitHub's advisory form](https://github.com/mikiross87/merchant-presets/security/advisories/new),
not in a public issue, discussion or pull request. Include the Merchant
Presets, Foundry and dnd5e versions, and the steps that reproduce it.

## Scope

In scope:

- `scripts/`, the JavaScript that runs in the browser of every GM and player in
  a world with the module enabled, including the shop window and the trades a
  player's client asks the GM's client to carry out. For example: a trade or
  chat message that lets one user act for another, such as buying as someone
  else's character, or that renders script from item or actor data.
- `.github/workflows/`: anything that would let someone else publish a release,
  read a repository secret, or run their own commands in a workflow, including
  through the text of an issue, which the triage workflow parses.

Report these upstream instead:

- The game system: [dnd5e](https://github.com/foundryvtt/dnd5e).
- Foundry VTT itself.

A wrong price, stat or item in a shop is an ordinary bug. Use the bug report
form for it.
