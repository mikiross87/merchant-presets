/**
 * tools/build_srd.py's `sync_goods_stock`, run for real under python3 against a scratch
 * `_source/goods`, so the build step's own rule is tested where CI runs the rest (#119).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = fileURLToPath(new URL(".", import.meta.url));

/** Writes `goods` (filename -> document) into a scratch module root, runs `sync_goods_stock`
 *  there, and returns the documents as it left them. */
function syncGoods(goods) {
  const root = mkdtempSync(join(tmpdir(), "mp-goods-"));
  try {
    mkdirSync(join(root, "_source", "goods"), { recursive: true });
    for (const [file, doc] of Object.entries(goods)) writeFileSync(join(root, "_source", "goods", file), JSON.stringify(doc));
    const run = spawnSync("python3", ["-c", [
      "import sys", `sys.path.insert(0, ${JSON.stringify(TOOLS)})`, "import build_srd",
      `build_srd.MOD = ${JSON.stringify(root)}`, "build_srd.sync_goods_stock()"
    ].join("\n")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return Object.fromEntries(Object.keys(goods).map(file =>
      [file, JSON.parse(readFileSync(join(root, "_source", "goods", file), "utf8"))]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const staleStock = { infinite: null, keep: true, service: false, noBuyback: false, category: "Old Category",
  bundle: 1, hidden: false, notForSale: false };

test("a good whose Item Piles flags are gone doesn't keep an old stock config (#119)", () => {
  const out = syncGoods({
    "gone.json": { name: "Gone", flags: { "merchant-presets": { stock: staleStock } } },
    "empty.json": { name: "Empty", flags: { "item-piles": { item: {} }, "merchant-presets": { stock: staleStock } } }
  });
  for (const file of ["gone.json", "empty.json"]) {
    assert.notEqual(out[file].flags["merchant-presets"].stock?.category, "Old Category", file);
  }
});

test("a good with Item Piles flags gets its stock config derived from them", () => {
  const out = syncGoods({
    "meal.json": { name: "Meal", flags: { "item-piles": { item: { customCategory: "Food" } } } }
  });
  assert.equal(out["meal.json"].flags["merchant-presets"].stock.category, "Food");
});
