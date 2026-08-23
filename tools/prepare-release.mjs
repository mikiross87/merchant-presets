#!/usr/bin/env node
// Stage a release: bump module.json, roll CHANGELOG.md's [Unreleased] into a
// dated section, and commit on a release/vX.Y.Z branch ready for a PR.
//
//   npm run release:prepare -- 1.2.0
//
// Tagging is a separate, deliberate step after the PR merges — see RELEASING.md.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rollChangelog } from "./changelog.mjs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: npm run release:prepare -- X.Y.Z[-prerelease]");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

if (git("status", "--porcelain") !== "") {
  console.error("working tree is not clean — commit or stash first");
  process.exit(1);
}
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "main") {
  console.error(`run this from main (currently on ${branch})`);
  process.exit(1);
}
git("fetch", "origin", "main");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
  console.error("local main is not at origin/main — pull first");
  process.exit(1);
}
if (git("tag", "-l", `v${version}`) !== "") {
  console.error(`tag v${version} already exists`);
  process.exit(1);
}

const module_ = JSON.parse(readFileSync("module.json", "utf8"));
const repo = new URL(module_.url).pathname.slice(1);
const date = new Date().toISOString().slice(0, 10);

const changelog = rollChangelog(readFileSync("CHANGELOG.md", "utf8"), version, date, repo);

// Rewrite only the version field so the rest of module.json keeps its formatting.
const manifest = readFileSync("module.json", "utf8");
const bumped = manifest.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
if (bumped === manifest) {
  console.error("could not find the version field in module.json");
  process.exit(1);
}

const release = `release/v${version}`;
if (git("branch", "--list", release) !== "") {
  console.error(`branch ${release} already exists — delete it or pick another version`);
  process.exit(1);
}
git("checkout", "-b", release);
writeFileSync("CHANGELOG.md", changelog);
writeFileSync("module.json", bumped);
git("add", "CHANGELOG.md", "module.json");
git("commit", "-m", `chore(release): v${version}`);

console.log(`
Staged v${version} on ${release} (${module_.version} -> ${version}).

Review the [${version}] section of CHANGELOG.md, then:

  git push -u origin ${release}
  gh pr create --fill --milestone v${version}

After the PR merges, tag main (never the release branch) — see RELEASING.md:

  git checkout main && git pull
  git tag -a v${version} -m "v${version}" && git push origin v${version}
`);
