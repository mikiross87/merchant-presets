# Maintenance and releases

How work gets from "something is wrong" to a version GMs can install. The
contributor-facing half is in [CONTRIBUTING.md](CONTRIBUTING.md); this is the
maintainer's loop.

## The loop

```
issue ──► milestone ──► branch + PR (Closes #N) ──► main ──► release PR ──► tag ──► CI publishes
```

1. **Every problem or improvement is an issue** — even ones you fix yourself
   five minutes later. Issues are the record; commits are the implementation.
   Issues arrive through the forms, which label them `bug` or `enhancement`.
   Add one of the work-type labels when triaging:

   | label         | means                                                     |
   | ------------- | --------------------------------------------------------- |
   | `content`     | shops, stock, goods, prices — `data/` and `_source/`      |
   | `maintenance` | CI, tooling, docs, dependencies; nothing a GM would notice |
   | `regression`  | worked in a previous release; prioritise it               |

2. **A milestone is a planned release**, named after its tag `v1.2.0`, and holds *issues only* —
   PRs stay out of milestones (they say `Closes #N` instead), so the progress
   bar counts each piece of work once. Assign
   an issue to a milestone when you intend to ship it there; leave it
   unassigned while it is only a wish. The milestone's progress bar is the
   release plan, and a bug found after a release goes into the next patch
   milestone (`v1.2.1`) rather than back into the shipped one.

3. **One branch and PR per issue**, with `Closes #N` in the PR body so merging
   closes the issue and GitHub links the two. Add a line under `[Unreleased]`
   in `CHANGELOG.md` in the same PR — written for the GM reading the release
   page, not the developer reading `git log`.

4. **`main` is always last release + merged work.** `module.json` carries the
   version of the last release until the release PR bumps it; the unreleased
   work is visible in `CHANGELOG.md` and the open milestone, not in a
   pre-release version string that Foundry would show to players.

## Cutting a release

When the milestone is done (or you decide to ship what's there and move the
rest):

```sh
git checkout main && git pull
npm run release:prepare -- 1.2.0      # bumps module.json, rolls the changelog, commits on release/v1.2.0
git push -u origin release/v1.2.0
gh pr create --fill
```

Review the `[1.2.0]` section — it becomes the release body — and merge once
CI is green. Then tag **main's post-merge HEAD**, not the release branch:

```sh
git checkout main && git pull
git tag -a v1.2.0 -m "v1.2.0"
git push origin v1.2.0
```

The tag triggers `release.yml`, which re-runs CI on the tagged tree, checks the
tag matches `module.json`, refuses to run without a `[1.2.0]` changelog
section, builds the packs and `module.zip`, creates the GitHub release with the
changelog section as its body, publishes to the Foundry package registry, and
closes the `v1.2.0` milestone (warning if issues are still open in it).

Never `gh release create` by hand: it makes a lightweight tag, skips CI, and
since GitHub made releases immutable the tag name can never be reused if it
goes wrong. `gh release edit --notes` is fine for polishing the body afterwards.

## Versioning

- **patch** (`1.2.1`) — fixes only; no new shops, settings or behaviour
- **minor** (`1.3.0`) — new shops, goods, settings, or behaviour that is
  backwards compatible with existing worlds
- **major** (`2.0.0`) — existing merchants in a world need migrating, or the
  minimum Foundry / dnd5e / Item Piles version rises

Prereleases (`1.3.0-beta.1`) go through the same flow; CI marks them as
GitHub prereleases, skips the Foundry registry, and leaves the milestone open.

## Hotfixes

Branch from `main`, fix, PR, then release as a patch. There are no long-lived
release branches to backport to: a hotfix is just a small release.
