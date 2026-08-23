// Keep a Changelog helpers shared by tools/prepare-release.mjs and its tests.
// Pure string transforms, so they can be unit-tested without git or a repo.

const UNRELEASED = "## [Unreleased]";

/** Text of the `## [version]` section, without its heading, or null. */
export function changelogSection(text, version) {
  const lines = text.split("\n");
  const heading = `## [${version}]`;
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.findIndex((l, i) => i > start && /^\[[^\]]+\]: /.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/**
 * Move everything under [Unreleased] into a new `## [version] - date`
 * section and repoint the footer compare links. Throws if there is nothing
 * to release or the version already has a section.
 */
export function rollChangelog(text, version, date, repo) {
  if (changelogSection(text, version) !== null) {
    throw new Error(`CHANGELOG.md already has a [${version}] section`);
  }
  const body = changelogSection(text, "Unreleased");
  if (body === null) throw new Error("CHANGELOG.md has no [Unreleased] section");
  if (body === "") throw new Error("[Unreleased] is empty — nothing to release");

  const previous = text.match(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/m)?.[1] ?? null;

  let out = text.replace(
    `${UNRELEASED}\n\n${body}`,
    `${UNRELEASED}\n\n## [${version}] - ${date}\n\n${body}`,
  );

  const base = `https://github.com/${repo}`;
  const unreleasedLink = `[Unreleased]: ${base}/compare/v${version}...HEAD`;
  const versionLink = previous
    ? `[${version}]: ${base}/compare/v${previous}...v${version}`
    : `[${version}]: ${base}/releases/tag/v${version}`;

  if (/^\[Unreleased\]: /m.test(out)) {
    out = out.replace(/^\[Unreleased\]: .*$/m, `${unreleasedLink}\n${versionLink}`);
  } else {
    out = `${out.trimEnd()}\n\n${unreleasedLink}\n${versionLink}\n`;
  }
  return out;
}
