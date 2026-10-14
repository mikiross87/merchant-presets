import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./prepare-release.mjs", import.meta.url));
const changelogLib = fileURLToPath(new URL("./changelog.mjs", import.meta.url));
// Isolate from the developer's git setup (signing, hooks, identity).
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const run = (cwd, ...args) => spawnSync("node", [join(cwd, "tools/prepare-release.mjs"), ...args], { cwd, env, encoding: "utf8" });

const changelog = `# Changelog

## [Unreleased]

### Fixed

- Something (#1)

## [1.0.0] - 2026-01-01

- First

[Unreleased]: https://github.com/o/r/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/o/r/releases/tag/v1.0.0
`;

// A clone with main and develop pushed to a bare origin, checked out on `branch`.
function repo(branch) {
  const root = mkdtempSync(join(tmpdir(), "prep-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  // Not `git clone`: an empty clone takes init.defaultBranch, which the
  // isolated config leaves at master.
  git(root, "init", "-q", "-b", "main", work);
  git(work, "remote", "add", "origin", origin);
  mkdirSync(join(work, "tools"), { recursive: true });
  writeFileSync(join(work, "tools/prepare-release.mjs"), readFileSync(script));
  writeFileSync(join(work, "tools/changelog.mjs"), readFileSync(changelogLib));
  writeFileSync(join(work, "module.json"), `{\n  "id": "r",\n  "version": "1.0.0",\n  "url": "https://github.com/o/r"\n}\n`);
  writeFileSync(join(work, "CHANGELOG.md"), changelog);
  git(work, "add", ".");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  git(work, "switch", "-q", "-c", "develop");
  git(work, "push", "-q", "origin", "develop");
  git(work, "switch", "-q", branch);
  return work;
}

test("stages a release from develop on release/vX.Y.Z", () => {
  const work = repo("develop");
  const r = run(work, "1.1.0");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(work, "branch", "--show-current"), "release/v1.1.0");
  assert.equal(git(work, "log", "-1", "--format=%s"), "chore(release): v1.1.0");
  assert.match(readFileSync(join(work, "module.json"), "utf8"), /"version": "1\.1\.0"/);
  assert.match(readFileSync(join(work, "CHANGELOG.md"), "utf8"), /^## \[1\.1\.0\] - /m);
  assert.match(r.stdout, /--base main/);
  assert.match(r.stdout, /--base develop --head main/);
});

test("refuses a release from main", () => {
  const r = run(repo("main"), "1.1.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /develop/);
});

test("opens a hotfix branch from main without committing", () => {
  const work = repo("main");
  const before = git(work, "rev-parse", "HEAD");
  const r = run(work, "1.0.1", "--hotfix");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(work, "branch", "--show-current"), "hotfix/v1.0.1");
  assert.equal(git(work, "rev-parse", "HEAD"), before);
  assert.match(r.stdout, /release:prepare -- 1\.0\.1/);
});

test("refuses a hotfix from develop", () => {
  const r = run(repo("develop"), "1.0.1", "--hotfix");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /from main/);
});

test("stages a hotfix in place on its own branch", () => {
  const work = repo("main");
  assert.equal(run(work, "1.0.1", "--hotfix").status, 0);
  const r = run(work, "1.0.1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(work, "branch", "--show-current"), "hotfix/v1.0.1");
  assert.equal(git(work, "log", "-1", "--format=%s"), "chore(release): v1.0.1");
  assert.match(r.stdout, /--base main/);
});

test("refuses a hotfix branch for another version", () => {
  const work = repo("main");
  assert.equal(run(work, "1.0.1", "--hotfix").status, 0);
  const r = run(work, "1.0.2");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hotfix\/v1\.0\.2/);
});

test("refuses when local develop is not at origin/develop", () => {
  const work = repo("develop");
  writeFileSync(join(work, "x"), "x");
  git(work, "add", "x");
  git(work, "commit", "-q", "-m", "local only");
  const r = run(work, "1.1.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /origin\/develop/);
});

test("refuses an existing tag", () => {
  const work = repo("develop");
  git(work, "tag", "v1.1.0");
  const r = run(work, "1.1.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
});

test("usage error on a bad version or an unknown flag", () => {
  const work = repo("develop");
  assert.equal(run(work, "1.1").status, 2);
  assert.equal(run(work, "1.1.0", "--hotifx").status, 2);
});
