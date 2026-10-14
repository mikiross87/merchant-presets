#!/usr/bin/env node
// Stage a release: bump module.json, roll CHANGELOG.md's [Unreleased] into a
// dated section, and commit, ready for a PR into main.
//
//   npm run release:prepare -- 1.2.0            # on develop: commits on release/v1.2.0
//   npm run release:prepare -- 1.2.1 --hotfix   # on main: opens hotfix/v1.2.1 for the fix
//   npm run release:prepare -- 1.2.1            # on hotfix/v1.2.1: commits there
//
// Tagging is a separate, deliberate step after the PR merges — see RELEASING.md.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { rollChangelog } from "./changelog.mjs";

const [version, flag] = process.argv.slice(2);
const hotfix = flag === "--hotfix";
if (!version || !/^\d+\.\d+\.\d+$/.test(version) || (flag !== undefined && !hotfix)) {
  console.error("usage: npm run release:prepare -- X.Y.Z [--hotfix]");
  console.error("a prerelease is tagged straight on develop, with nothing to stage — see RELEASING.md");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (git("status", "--porcelain") !== "") fail("working tree is not clean — commit or stash first");
if (git("tag", "-l", `v${version}`) !== "") fail(`tag v${version} already exists`);

const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const atOrigin = (name) => {
  git("fetch", "origin", name);
  if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${name}`)) {
    fail(`local ${name} is not at origin/${name} — pull first`);
  }
};
const unused = (name) => {
  if (git("branch", "--list", name) !== "") fail(`branch ${name} already exists — delete it or pick another version`);
};

const hotfixBranch = `hotfix/v${version}`;
if (hotfix) {
  if (branch !== "main") fail(`start a hotfix from main (currently on ${branch})`);
  atOrigin("main");
  unused(hotfixBranch);
  git("checkout", "-b", hotfixBranch);
  console.log(`
Opened ${hotfixBranch} from main. Commit the fix with its [Unreleased] line in
CHANGELOG.md, then stage the release on this branch:

  npm run release:prepare -- ${version}
`);
  process.exit(0);
}

let release;
if (branch === "develop") {
  atOrigin("develop");
  git("fetch", "origin", "main");
  if (spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]).status !== 0) {
    fail("develop does not contain origin/main — merge the last release or hotfix back into develop first (RELEASING.md)");
  }
  release = `release/v${version}`;
  unused(release);
} else if (branch === hotfixBranch) {
  release = hotfixBranch;
} else {
  fail(`run this from develop, or from ${hotfixBranch} (currently on ${branch})`);
}

const module_ = JSON.parse(readFileSync("module.json", "utf8"));
const repo = new URL(module_.url).pathname.slice(1);
const date = new Date().toISOString().slice(0, 10);

const changelog = rollChangelog(readFileSync("CHANGELOG.md", "utf8"), version, date, repo);

// Rewrite only the version field so the rest of module.json keeps its formatting.
const manifest = readFileSync("module.json", "utf8");
const bumped = manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
if (bumped === manifest) fail("could not find the version field in module.json");

if (branch !== release) git("checkout", "-b", release);
writeFileSync("CHANGELOG.md", changelog);
writeFileSync("module.json", bumped);
git("add", "CHANGELOG.md", "module.json");
git("commit", "-m", `chore(release): v${version}`);

console.log(`
Staged v${version} on ${release} (${module_.version} -> ${version}).

Review the [${version}] section of CHANGELOG.md, then:

  git push -u origin ${release}
  gh pr create --base main --fill

After the PR merges, tag main (never the ${release.split("/")[0]} branch) — see RELEASING.md:

  git checkout main && git pull
  git tag -a v${version} -m "v${version}" && git push origin v${version}

Then merge the release back into develop:

  gh pr create --base develop --head main --title "Merge v${version} back into develop" --body "Back-merge after v${version}."
`);
