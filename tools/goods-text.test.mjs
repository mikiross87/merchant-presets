import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Goods descriptions against what the goods are (#242, #243): the built `_source`, both the goods
 * and the copies embedded in each merchant, since the copy is what a player reads in the shop.
 */

const load = sub => {
  const dir = new URL(`../_source/${sub}/`, import.meta.url);
  return readdirSync(dir).filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
};

const goods = load("goods").filter(d => d._key.startsWith("!items!"));
const embedded = load("merchants").filter(d => d._key.startsWith("!actors!"))
  .flatMap(m => m.items.map(i => ({ ...i, name: `${i.name} (in ${m.name})` })));

const unitOf = text => text.match(/\bper (day|mile|night|week|month)\b/)?.[1];

test("a good sold per one unit doesn't describe itself per another (#242)", () => {
  const wrong = [...goods, ...embedded].flatMap(item => {
    const named = unitOf(item.name);
    const described = unitOf(item.system?.description?.value ?? "");
    return named && described && named !== described ? [`${item.name}: per ${described}`] : [];
  });
  assert.deepEqual(wrong, []);
});

/* ------------------------------------------------- the SRD's own words (#243) */

const TOOLS = fileURLToPath(new URL(".", import.meta.url));

const page = (_id, name, content) => ({ _id, name, type: "text", text: { content } });
const CONTENT = {
  "mounts.json": { _id: "phbMountsAndVehi", name: "Mounts and Vehicles", pages: [
    page("cargoPage0000000", "Mounts and Cargo",
      "<h3>Saddles</h3><p>A saddle comes with a bit, a bridle, reins, and any other equipment needed to use the "
      + "saddle. A Military Saddle gives Advantage on any ability check you make to remain mounted.</p>"
      + "<table><tr><td>@UUID[Compendium.dnd5e.actors24.Actor.mmCamel000000000]{Camel}</td><td>450 lb.</td>"
      + "<td>50 GP</td></tr></table>")
  ] },
  "life.json": { _id: "phbServices00000", name: "Lifestyle Expenses", pages: [
    page("foodPage00000000", "Food, Drink, and Lodging", "<p>The Food, Drink, and Lodging table gives prices.</p>")
  ] }
};
const ACTORS = { "camel.json": { _id: "mmCamel000000000", name: "Camel", type: "npc" } };
const good = name => ({ _id: name.replace(/\W/g, ""), _key: `!items!${name.replace(/\W/g, "")}`, name,
  system: { description: { value: "<p>Our own words.</p>", chat: "" } } });

/** Runs `sync_goods_text` against a scratch module root holding `goods` and `entries`, with the
 *  fixture SRD packs above, and returns the exit status, stderr and the goods as it left them. */
function syncText(goods, entries) {
  const root = mkdtempSync(join(tmpdir(), "mp-text-"));
  try {
    const dirs = { goods: join(root, "_source", "goods"), content: join(root, "content24"), actors: join(root, "actors24") };
    for (const d of [...Object.values(dirs), join(root, "data")]) mkdirSync(d, { recursive: true });
    for (const g of goods) writeFileSync(join(dirs.goods, `${g._id}.json`), JSON.stringify(g));
    for (const [f, d] of Object.entries(CONTENT)) writeFileSync(join(dirs.content, f), JSON.stringify(d));
    for (const [f, d] of Object.entries(ACTORS)) writeFileSync(join(dirs.actors, f), JSON.stringify(d));
    writeFileSync(join(root, "data", "srd-text.json"), JSON.stringify({ goods: entries }));
    const run = spawnSync("python3", ["-c", [
      "import sys", `sys.path.insert(0, ${JSON.stringify(TOOLS)})`, "import build_srd",
      `build_srd.MOD = ${JSON.stringify(root)}`, `build_srd.CONTENT = ${JSON.stringify(dirs.content)}`,
      `build_srd.ACTORS = ${JSON.stringify(dirs.actors)}`, "print(build_srd.sync_goods_text())"
    ].join("\n")], { encoding: "utf8" });
    const out = Object.fromEntries(goods.map(g =>
      [g.name, JSON.parse(readFileSync(join(dirs.goods, `${g._id}.json`), "utf8")).system.description.value]));
    return { status: run.status, stderr: run.stderr, stdout: run.stdout.trim(), out };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SADDLE = { page: "Mounts and Vehicles / Mounts and Cargo", quotes: [
  "A saddle comes with a bit, a bridle, reins, and any other equipment needed to use the saddle.",
  "A Military Saddle gives Advantage on any ability check you make to remain mounted."
] };

test("a good's description becomes its SRD quotes, each a paragraph (#243)", () => {
  const r = syncText([good("Saddle, Military")], { "Saddle, Military": SADDLE });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out["Saddle, Military"], SADDLE.quotes.map(q => `<p>${q}</p>`).join(""));
});

test("a table cell and a stat block are read from the SRD, and links resolve to its ids", () => {
  const r = syncText([good("Camel"), good("Meal, Poor")], {
    Camel: { page: "Mounts and Vehicles / Mounts and Cargo", row: "Camel", cell: "450 lb.",
      label: "Carrying capacity", actor: "mmCamel000000000" },
    "Meal, Poor": { see: "Lifestyle Expenses / Food, Drink, and Lodging" }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.Camel, "<p>Carrying capacity: 450 lb.</p>"
    + "<p>Stat block: @UUID[Compendium.dnd5e.actors24.Actor.mmCamel000000000]{Camel}</p>");
  assert.equal(r.out["Meal, Poor"], "<p>See @UUID[Compendium.dnd5e.content24.JournalEntry.phbServices00000"
    + ".JournalEntryPage.foodPage00000000]{Food, Drink, and Lodging}</p>");
});

test("text the SRD page doesn't have stops the build, naming the good, and writes nothing", () => {
  const r = syncText([good("Saddle, Military"), good("Saddle, Riding")], {
    "Saddle, Riding": { page: SADDLE.page, quotes: [SADDLE.quotes[0]] },
    "Saddle, Military": { page: SADDLE.page, quotes: ["A Military Saddle is very comfortable."] }
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Saddle, Military/);
  assert.match(r.stderr, /very comfortable/);
  assert.equal(r.out["Saddle, Riding"], "<p>Our own words.</p>");
});

test("a listed good that doesn't exist, a link the packs don't have, or an entry with nothing to write stops the build", () => {
  for (const [entries, expect] of [
    [{ Unicorn: SADDLE }, /Unicorn/],
    [{ Camel: { actor: "mmNoSuchActor000" } }, /mmNoSuchActor000/],
    [{ Camel: { see: "Lifestyle Expenses / Hirelings" } }, /Hirelings/],
    [{ Camel: { page: "Mounts and Vehicles / Mounts and Cargo", row: "Camel", cell: "999 lb.", label: "Carrying capacity" } }, /999 lb\./],
    [{ Camel: { page: "Mounts and Vehicles / Mounts and Cargo", quote: ["A typo for quotes."] } }, /Camel: nothing to write/]
  ]) {
    const r = syncText([good("Camel")], entries);
    assert.notEqual(r.status, 0, JSON.stringify(entries));
    assert.match(r.stderr, expect);
  }
});

test("a lead sentence comes before the quotes, so goods quoting the same SRD text can still say what each is (#247)", () => {
  const r = syncText([good("Saddle, Military")], { "Saddle, Military": { ...SADDLE, lead: "A saddle for war." } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out["Saddle, Military"], "<p>A saddle for war.</p>" + SADDLE.quotes.map(q => `<p>${q}</p>`).join(""));
});

test("a second run changes nothing", () => {
  const goodsIn = [good("Saddle, Military")];
  const first = syncText(goodsIn, { "Saddle, Military": SADDLE });
  const again = syncText([{ ...goodsIn[0], system: { description: { value: first.out["Saddle, Military"], chat: "" } } }],
    { "Saddle, Military": SADDLE });
  assert.equal(first.stdout, "1");
  assert.equal(again.stdout, "0");
});

/* ---------------------------------------- spell components and level services (#247) */

const COMPONENTS = JSON.parse(readFileSync(new URL("../data/components.json", import.meta.url), "utf8")).components;
const SRD_TEXT = JSON.parse(readFileSync(new URL("../data/srd-text.json", import.meta.url), "utf8")).goods;

test("a spell component opens with its spell's phrase word for word, the + kept (#247)", () => {
  const wrong = COMPONENTS.flatMap(row => {
    const name = `${row.name} (${row.price.toLocaleString("en")} GP)`;
    const good = goods.find(g => g.name === name);
    const phrase = row.spells[0].phrase;
    const expected = `<p>${phrase[0].toUpperCase()}${phrase.slice(1)}.</p>`;
    return good?.system.description.value.startsWith(expected) ? [] : [`${name}: ${good?.system.description.value.slice(0, 80)}`];
  });
  assert.deepEqual(wrong, []);
  assert.deepEqual(COMPONENTS.filter(r => "desc" in r).map(r => r.name), [], "no row words its own description");
});

const LEVELS = {
  "Spellcasting: Cantrip": "a cantrip", "Spellcasting: Level 1": "a level 1 spell", "Spellcasting: Level 2": "a level 2 spell",
  "Spellcasting: Level 3": "a level 3 spell", "Spellcasting: Level 4-5": "a level 4 or 5 spell",
  "Spellcasting: Level 6-8": "a level 6, 7 or 8 spell", "Spellcasting: Level 9": "a level 9 spell"
};

test("the level spellcasting services name their level, then quote the SRD's Spellcasting page (#247)", () => {
  const levels = goods.filter(g => /^Spellcasting: (Cantrip|Level )/.test(g.name));
  assert.equal(levels.length, 7);
  for (const g of levels) {
    assert.ok(SRD_TEXT[g.name], `${g.name} is in data/srd-text.json`);
    assert.match(g.system.description.value, /If a spell has expensive components, add the cost of those components/, g.name);
    assert.ok(g.system.description.value.startsWith(`<p>A spellcaster casts ${LEVELS[g.name]} on your behalf.</p>`),
      `${g.name} names its level first`);
  }
});
