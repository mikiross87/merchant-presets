/**
 * Every icon the shop window names (#145): `{{mpIcon "name" …}}` in a template, a
 * `"lucide:name"` string a script hands one (a section's icon, a seal state's), or a script's own
 * `icon("name")` or `iconSlot("name", …)` (a trade receipt's, drawn in when it renders).
 */
import { readFileSync, readdirSync } from "node:fs";

const files = (dir, ext) => readdirSync(dir, { recursive: true }).filter(f => f.endsWith(ext)).map(f => new URL(f, dir));

/** @returns {Set<string>} */
export function iconsUsed() {
  const used = new Set();
  for (const file of files(new URL("../templates/", import.meta.url), ".hbs")) {
    for (const m of readFileSync(file, "utf8").matchAll(/mpIcon\s+"([a-z0-9-]+)"/g)) used.add(m[1]);
  }
  for (const file of files(new URL("../scripts/", import.meta.url), ".mjs")) {
    for (const m of readFileSync(file, "utf8").matchAll(/(?:"lucide:|\b(?:icon|iconSlot)\(")([a-z0-9-]+)"/g)) used.add(m[1]);
  }
  return used;
}
