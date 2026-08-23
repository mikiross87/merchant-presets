import { test } from "node:test";
import assert from "node:assert/strict";
import { changelogSection, rollChangelog } from "./changelog.mjs";

const repo = "mikiross87/merchant-presets";
const sample = `# Changelog

## [Unreleased]

### Added

- Something new (#20)

## [1.1.0] - 2026-08-22

### Added

- Shops open and close

[Unreleased]: https://github.com/${repo}/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/${repo}/compare/v1.0.0...v1.1.0
`;

test("extracts a section body without its heading", () => {
  assert.equal(changelogSection(sample, "1.1.0"), "### Added\n\n- Shops open and close");
  assert.equal(changelogSection(sample, "Unreleased"), "### Added\n\n- Something new (#20)");
  assert.equal(changelogSection(sample, "9.9.9"), null);
});

test("rolls Unreleased into a dated section and repoints the footer links", () => {
  const out = rollChangelog(sample, "1.2.0", "2026-08-23", repo);
  assert.match(out, /^## \[Unreleased\]\n\n## \[1\.2\.0\] - 2026-08-23\n\n### Added\n\n- Something new \(#20\)\n\n## \[1\.1\.0\]/m);
  assert.equal(changelogSection(out, "Unreleased"), "");
  assert.match(out, new RegExp(`^\\[Unreleased\\]: https://github.com/${repo}/compare/v1\\.2\\.0\\.\\.\\.HEAD$`, "m"));
  assert.match(out, new RegExp(`^\\[1\\.2\\.0\\]: https://github.com/${repo}/compare/v1\\.1\\.0\\.\\.\\.v1\\.2\\.0$`, "m"));
  assert.match(out, /^\[1\.1\.0\]: /m);
});

test("refuses an empty Unreleased section", () => {
  const empty = sample.replace("### Added\n\n- Something new (#20)\n\n", "");
  assert.throws(() => rollChangelog(empty, "1.2.0", "2026-08-23", repo), /nothing to release/);
});

test("refuses to release a version that already has a section", () => {
  assert.throws(() => rollChangelog(sample, "1.1.0", "2026-08-23", repo), /already has/);
});

test("first release links to the tag when there is no previous version", () => {
  const first = `# Changelog\n\n## [Unreleased]\n\n- Initial\n`;
  const out = rollChangelog(first, "1.0.0", "2026-08-20", repo);
  assert.match(out, new RegExp(`^\\[1\\.0\\.0\\]: https://github.com/${repo}/releases/tag/v1\\.0\\.0$`, "m"));
});
