#!/usr/bin/env python3
"""Build the goods that come from SRD 5.2 spell text.

Spell components (#51): one good per component and price floor, not per
spell, so a single 100 GP diamond dust serves both Stoneskin and Greater
Restoration. The editorial half (names, kinds, which shops) lives in
data/components.json; the facts (which spells name a component, what it is
worth, whether the spell consumes it) are read from the spell text and checked
against it, so a row that disagrees with the SRD stops the build.

Spellcasting by name (#55): one service per spell with a costed component
that works without the caster, priced at its level service plus that
component, and hired out at each shop whose classes have the spell on their
SRD spell list. The prices come from the spell text and the hand-made level
services, the shops from the class lists in dnd5e.content24. Which spells a
buyer can't use without the caster along is editorial, in
data/spellcasting.json.

Run before tools/build_srd.py, which embeds the goods in the merchants:

  MP_SPELLS_DIR=/tmp/spells24 MP_CONTENT_DIR=/tmp/content24 \
    python3 tools/build_spell_goods.py [--check]

--check parses and validates without writing anything.
"""
import json, glob, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_srd import fid, is_valuable, SRD_SOURCE, VALUABLES

MOD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# An unpacked copy of the system's dnd5e.spells24 pack, unpacked like the others:
#   fvtt package unpack -n spells24 --id dnd5e --type System --in <dnd5e>/packs --out <dir>
SPELLS = os.environ.get("MP_SPELLS_DIR", "")
SPELLS_PACK = "dnd5e.spells24"

# ---------------------------------------------------------------- spell text

# "worth 300+ GP", "one 150+ GP black onyx stone": the SRD states every costed
# component as a floor with a trailing plus.
AMOUNT = re.compile(r"(\d{1,3}(?:,\d{3})+|\d+)\+ GP")
# "four ivory strips worth 50+ GP each": the floor is per piece, so the count
# has to come from the start of the same phrase.
COUNTS = {"a pair of": 2, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6}
# Components bought again for every target the spell takes.
PER = [("for each of the spell's targets", "target"), ("for each corpse", "corpse")]

class SpellTextError(Exception):
    pass

def plain(s):
    return (s or "").replace("’", "'")

def parse_materials(text):
    """Split a spell's material component text into its costed parts.

    Each part is {phrase, at, gp, count, consumed, per}: `phrase` is the text
    naming it, up to and including its price, and `at` where that price sits in
    the text; `gp` the floor per piece; `count` how many pieces one casting
    needs; `per` whether that repeats per target or corpse. Consumption is read
    from the text rather than the spell's `materials.consumed`, which is one
    value per spell (on Legend Lore it would cover the ivory strips the spell
    keeps) and is wrong on Sequester.

    Raises SpellTextError on a price it cannot account for, rather than
    guessing.
    """
    text = plain(text)
    matches = list(AMOUNT.finditer(text))
    if text.count(" GP") != len(matches):
        raise SpellTextError(f"a GP figure without the N+ GP form: {text!r}")
    per = next((p for phrase, p in PER if phrase in text), None)
    parts = []
    for i, m in enumerate(matches):
        before = text[matches[i - 1].end() if i else 0:m.end()]
        after = text[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(text)]
        # What precedes this part's own words is the previous part's trailing
        # clause (", which the spell consumes") and the conjunction.
        phrase = re.sub(r"^, which the spell consumes", "", before)
        phrase = re.sub(r"^(,? and |, )", "", phrase).strip()
        count = 1
        if after.startswith(" each"):
            word = next((w for w in COUNTS
                         if re.match(rf"(for each of the spell's targets, )?{w}\b", phrase)), None)
            if not word:
                raise SpellTextError(f"'each' with no count in {phrase!r}")
            count = COUNTS[word]
        parts.append({"phrase": phrase, "at": m.start(), "gp": int(m[1].replace(",", "")),
                      "count": count, "per": per,
                      "consumed": "which the spell consumes" in after})
    if "all of which the spell consumes" in text:
        for p in parts:
            p["consumed"] = True
    return parts

def load_spells():
    """name -> spell doc, for every spell in the unpacked SRD spell pack."""
    out = {}
    for f in glob.glob(os.path.join(SPELLS, "*.json")):
        d = json.load(open(f))
        if d.get("type") == "spell":
            out[plain(d["name"])] = d
    return out

def costed(spells):
    """name -> parts, for every spell whose material component has a price."""
    out = {}
    for name, d in sorted(spells.items()):
        parts = parse_materials(((d.get("system") or {}).get("materials") or {}).get("value"))
        if parts:
            out[name] = parts
    return out

# ---------------------------------------------------------------- components

KINDS = ("gem", "art", "trade", "material")

def tier_for(gp):
    """The settlement sizes that stock a component, by the Jeweler's old bands."""
    return "vtc" if gp <= 150 else "tc" if gp <= 500 else "c"

def claim(spells, parts, claimed, spell, phrase):
    """The costed part of `spell` that `phrase` names, marked as accounted for."""
    if spell not in parts:
        raise SpellTextError(f"{spell} has no costed material component")
    text = plain(spells[spell]["system"]["materials"]["value"])
    at = text.find(phrase)
    if at < 0:
        raise SpellTextError(f"{spell}: {phrase!r} is not in {text!r}")
    part = next((p for p in parts[spell] if at <= p["at"] < at + len(phrase)), None)
    if not part:
        raise SpellTextError(f"{spell}: {phrase!r} names no price")
    key = (spell, part["at"])
    if key in claimed:
        raise SpellTextError(f"{spell}: {part['phrase']!r} is claimed twice")
    claimed.add(key)
    return part

def validate_components(data, spells, parts, shop_ids):
    """Check every row against the spell text, and every costed part of every
    spell against the rows, so nothing is sold that the SRD does not describe
    and nothing the SRD prices is silently left out."""
    claimed = set()
    seen = set()
    for row in data["components"]:
        ident = row["identifier"]
        if ident in seen:
            raise SpellTextError(f"identifier {ident} is used twice")
        seen.add(ident)
        if not ident.endswith(f"-{row['price']}"):
            raise SpellTextError(f"{ident}: identifier does not end in its price {row['price']}")
        if row["tier"] != tier_for(row["price"]):
            raise SpellTextError(f"{ident}: tier {row['tier']} for {row['price']} GP, expected {tier_for(row['price'])}")
        if row["kind"] not in KINDS:
            raise SpellTextError(f"{ident}: kind {row['kind']} is not one of {KINDS}")
        for shop in row["shops"]:
            if shop not in shop_ids:
                raise SpellTextError(f"{ident}: no shop {shop} in data/recipes.json")
        for use in row["spells"]:
            part = claim(spells, parts, claimed, use["spell"], use["phrase"])
            if part["gp"] * part["count"] != row["price"]:
                raise SpellTextError(f"{ident}: {use['spell']} prices it at "
                                     f"{part['count']} x {part['gp']} GP, not {row['price']}")
    for skip in data["not_stocked"]:
        claim(spells, parts, claimed, skip["spell"], skip["phrase"])
    unclaimed = [(s, p["phrase"]) for s, ps in parts.items() for p in ps if (s, p["at"]) not in claimed]
    if unclaimed:
        raise SpellTextError("priced in the SRD but in neither components nor not_stocked: "
                             + "; ".join(f"{s}: {p}" for s, p in unclaimed))

# ---------------------------------------------------------------- writing

GOODS_DIR = os.path.join(MOD, "_source/goods")
GOODS_UUID = "Compendium.merchant-presets.goods.Item."
COMPONENT_FOLDER = "YCWErxQxP6JCSdKv"      # the goods pack's Spell Components folder
COMPONENT_CAT = "Spell Components"

def good_name(row):
    # Five diamonds and four incenses share a shop, and the runtime keys a
    # shop's item flags by name, so the price is part of it.
    return f"{row['name']} ({row['price']:,} GP)"

def good_id(row):
    return fid("component", row["identifier"])

def sentence(phrase):
    text = phrase.replace("+ GP", " GP")
    return text[0].upper() + text[1:] + "."

def use_note(part):
    each = {"target": "one for each target, ", "corpse": "one for each corpse, "}.get(part["per"], "")
    return each + ("consumed" if part["consumed"] else "not consumed")

def make_component(row, spells, parts):
    """One component good, described from the spell text that prices it."""
    uses = []
    for use in row["spells"]:
        spell = spells[use["spell"]]
        part = claim(spells, parts, set(), use["spell"], use["phrase"])
        link = f"@UUID[Compendium.{SPELLS_PACK}.Item.{spell['_id']}]{{{spell['name']}}}"
        uses.append(f"<li>{link}: {use_note(part)}</li>")
    desc = row.get("desc") or sentence(row["spells"][0]["phrase"])
    gid = good_id(row)
    doc = {
        "_id": gid, "_key": f"!items!{gid}", "name": good_name(row), "type": "loot",
        "img": row["img"], "folder": COMPONENT_FOLDER, "sort": 0,
        "system": {
            "description": {"value": f"<p>{desc}</p><p>Material component for:</p><ul>{''.join(uses)}</ul>",
                            "chat": ""},
            "quantity": 1, "weight": {"value": 0, "units": "lb"},
            "price": {"value": row["price"], "denomination": "gp"},
            "rarity": "", "identified": True, "container": None,
            "identifier": row["identifier"],
            # The name and the price are the SRD's, from its spell text, on
            # the same footing as the meals and the spellcasting services.
            "source": dict(SRD_SOURCE),
            "type": {"value": row["kind"], "subtype": ""}, "properties": []},
        "effects": [], "ownership": {"default": 0},
        "flags": {"merchant-presets": {"kind": "component"}}}
    # Filed where a shop's full-value price for valuables finds it, so a gem
    # dragged straight from the compendium sells like one bought over a counter.
    if is_valuable(doc):
        doc["flags"]["item-piles"] = {"item": {"customCategory": VALUABLES}}
    return doc

def mp_flags(d):
    return (d.get("flags") or {}).get("merchant-presets") or {}

def load_goods():
    return [json.load(open(f)) for f in glob.glob(os.path.join(GOODS_DIR, "*.json"))]

def write_goods(docs, ours):
    """Replace every good `ours` picks out with `docs`, leaving the others alone."""
    old = set()
    for f in glob.glob(os.path.join(GOODS_DIR, "*.json")):
        d = json.load(open(f))
        if ours(d):
            old.add(GOODS_UUID + d["_id"])
            os.remove(f)
    for doc in docs:
        safe = re.sub(r"[^A-Za-z0-9]+", "_", doc["name"]).strip("_")
        with open(os.path.join(GOODS_DIR, f"{safe}_{doc['_id']}.json"), "w") as out:
            json.dump(doc, out, indent=2, ensure_ascii=False)
            out.write("\n")
    return old

def place_lines(recipes, lines_for, ours, default_at):
    """Swap each shop's generated lines for `lines_for(shop)`, in place.

    Lines go where the shop's first line among the uuids `ours` was, or at
    `default_at(stock)` in a shop that had none.
    """
    for shop in recipes["shops"]:
        stock = shop["stock"]
        spots = [i for i, l in enumerate(stock) if l.get("uuid") in ours]
        at = spots[0] if spots else default_at(stock)
        kept = [l for l in stock if l.get("uuid") not in ours]
        shop["stock"] = kept[:at] + lines_for(shop) + kept[at:]

def component_lines(rows):
    """A shop's component lines, at the end of its stock unless already placed.

    Limited, not services: a component is an item the buyer carries away, sells
    out, and stays rolled in worlds on unlimited stock, like the poisons and
    scrolls.
    """
    return lambda shop: [{"n": good_name(r), "t": r["tier"], "cat": COMPONENT_CAT, "limited": True,
                          "uuid": GOODS_UUID + good_id(r)}
                         for r in rows if shop["id"] in r["shops"]]

# ---------------------------------------------------------------- spellcasting

# An unpacked copy of the system's dnd5e.content24 pack, for the SRD class spell
# lists: its Spells journal carries one page per class, listing spells24 uuids.
CONTENT = os.environ.get("MP_CONTENT_DIR", "")
SPELL_JOURNAL = "phbSpells0000000"

# Which shop hires out which classes' spells, by the spellcasting focus SRD 5.2
# gives each class: an Arcane Focus for the sorcerer, warlock and wizard, a
# Druidic Focus for the druid and ranger, a Holy Symbol for the cleric and
# paladin. The bard plays an instrument, and no shop here sells a bard's services.
SHOP_CLASSES = {"arcane-store": ("sorcerer", "warlock", "wizard"),
                "druidic-store": ("druid", "ranger"),
                "temple-faith": ("cleric", "paladin")}
LEVEL_SERVICE = re.compile(r"Spellcasting: Level (\d)(?:-(\d))?")
# Item Piles lists a shop window's headings by label and the items under each by
# name. Under one Service heading the level services sort in among the named
# spells, so the named spells get a heading of their own, saying what sets them
# apart. It sorts after the Service heading, whose label is its translation key.
NAMED_HEADING = "Spells, Components Included"

def load_class_lists(spells):
    """class identifier -> the names of the spells on its SRD spell list."""
    by_id = {d["_id"]: name for name, d in spells.items()}
    journal = next((d for d in (json.load(open(f)) for f in glob.glob(os.path.join(CONTENT, "*.json")))
                    if d.get("_id") == SPELL_JOURNAL), None)
    if not journal:
        raise SpellTextError(f"no Spells journal {SPELL_JOURNAL} in {CONTENT}")
    lists = {}
    for page in journal["pages"]:
        sysd = page.get("system") or {}
        if page.get("type") != "spells" or sysd.get("type") != "class":
            continue
        ids = [u.rsplit(".", 1)[-1] for u in sysd["spells"]]
        unknown = [i for i in ids if i not in by_id]
        if unknown:
            raise SpellTextError(f"{page['name']} lists spells not in {SPELLS_PACK}: {unknown}")
        lists[sysd["identifier"]] = {by_id[i] for i in ids}
    missing = [c for cls in SHOP_CLASSES.values() for c in cls if c not in lists]
    if missing:
        raise SpellTextError(f"no class spell list for {missing}")
    return lists

def sold_by_name(parts, not_sold):
    """The costed spells sold by name: every one not in data/spellcasting.json's
    not_sold, which names the spells a buyer cannot use without the caster
    along (#55). A listed spell must be a costed spell, listed once."""
    names = [row["spell"] for row in not_sold]
    for name in names:
        if name not in parts:
            raise SpellTextError(f"not_sold lists {name}, which has no costed material component")
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise SpellTextError(f"not_sold lists {twice} more than once")
    return {n: ps for n, ps in parts.items() if n not in names}

def level_services(goods):
    """spell level -> the hand-made level service good that prices it."""
    out = {}
    for d in goods:
        m = LEVEL_SERVICE.fullmatch(d.get("name", ""))
        if m and mp_flags(d).get("kind") == "spellcasting":
            for level in range(int(m[1]), int(m[2] or m[1]) + 1):
                out[level] = d
    if sorted(out) != list(range(1, 10)):
        raise SpellTextError(f"level services cover levels {sorted(out)}, not 1-9")
    return out

def service_id(spell):
    return fid("spellcasting", spell["system"]["identifier"])

def make_service(spell, parts, level_good):
    """One spell hired out by name, its component in the price (#55)."""
    link = f"@UUID[Compendium.{SPELLS_PACK}.Item.{spell['_id']}]{{{spell['name']}}}"
    component = sum(p["gp"] * p["count"] for p in parts)
    noun = "components" if len(parts) > 1 else "component"
    desc = (f"<p>A spellcaster casts {link} on your behalf and provides its material {noun}: "
            f"{spell['system']['materials']['value']}.</p>")
    # A component bought again for every target or corpse is priced for one,
    # as the bring-your-own buyer would be. None of the spells sold today needs
    # it; Astral Projection and Create Undead, which do, keep the caster.
    per = parts[0]["per"]
    if per:
        desc += f"<p>The price covers one {per}; each further {per} costs {component:,} GP more.</p>"
    sid = service_id(spell)
    return {
        "_id": sid, "_key": f"!items!{sid}", "name": f"Spellcasting: {spell['name']}", "type": "loot",
        "img": spell["img"], "folder": level_good["folder"], "sort": 0,
        "system": {
            "description": {"value": desc, "chat": ""},
            "quantity": 1, "weight": {"value": 0, "units": "lb"},
            "price": {"value": level_good["system"]["price"]["value"] + component, "denomination": "gp"},
            "rarity": "", "identified": True, "container": None, "identifier": "",
            "source": dict(SRD_SOURCE),
            "type": {"value": "", "subtype": ""}, "properties": []},
        "effects": [], "ownership": {"default": 0},
        # `spell` marks the goods this script owns, apart from the level
        # services, which are edited by hand.
        "flags": {"item-piles": {"item": {"isService": True, "customCategory": NAMED_HEADING}},
                  "merchant-presets": {"kind": "spellcasting",
                                       "spell": f"Compendium.{SPELLS_PACK}.Item.{spell['_id']}"}}}

def plan_services(spells, parts, lists, levels, recipes):
    """shop id -> [(level, spell name)] it hires out by name, checked so that
    every spell in `parts` has a shop and every shop the level line for it."""
    plan = {}
    homeless = set(parts)
    for shop in recipes["shops"]:
        classes = SHOP_CLASSES.get(shop["id"], ())
        names = sorted((spells[n]["system"]["level"], n) for n in parts
                       if any(n in lists[c] for c in classes))
        level_uuids = {GOODS_UUID + g["_id"] for g in levels.values()}
        have = {l["uuid"] for l in shop["stock"] if l.get("uuid") in level_uuids}
        for level, name in names:
            if GOODS_UUID + levels[level]["_id"] not in have:
                raise SpellTextError(f"{shop['id']} sells {name} by name but not its level {level} service")
            homeless.discard(name)
        plan[shop["id"]] = names
    if homeless:
        raise SpellTextError(f"no shop hires out {sorted(homeless)}")
    return plan

def service_lines(spells, plan, levels):
    """A shop's named spellcasting lines, by level then name, each available
    where the shop's level service for it is."""
    def lines(shop):
        tier = {l["uuid"]: l["t"] for l in shop["stock"] if l.get("uuid")}
        return [{"n": f"Spellcasting: {spells[name]['name']}",
                 "t": tier[GOODS_UUID + levels[level]["_id"]], "cat": "Services", "service": True,
                 "uuid": GOODS_UUID + service_id(spells[name])}
                for level, name in plan.get(shop["id"], [])]
    return lines

def after_level_services(levels):
    uuids = {GOODS_UUID + g["_id"] for g in levels.values()}
    def at(stock):
        spots = [i for i, l in enumerate(stock) if l.get("uuid") in uuids]
        return spots[-1] + 1 if spots else len(stock)
    return at

# ---------------------------------------------------------------- main

def main():
    check = "--check" in sys.argv
    if not SPELLS or not os.path.isdir(SPELLS):
        sys.exit("point MP_SPELLS_DIR at an unpacked dnd5e.spells24 directory")
    if not CONTENT or not os.path.isdir(CONTENT):
        sys.exit("point MP_CONTENT_DIR at an unpacked dnd5e.content24 directory")
    spells = load_spells()
    data = json.load(open(os.path.join(MOD, "data/components.json")))
    recipes = json.load(open(os.path.join(MOD, "data/recipes.json")))
    hired = json.load(open(os.path.join(MOD, "data/spellcasting.json")))
    try:
        parts = costed(spells)
        validate_components(data, spells, parts, {s["id"] for s in recipes["shops"]})
        sold = sold_by_name(parts, hired["not_sold"])
        levels = level_services(load_goods())
        plan = plan_services(spells, sold, load_class_lists(spells), levels, recipes)
    except SpellTextError as e:
        sys.exit(f"spell goods: {e}")

    n_parts = sum(len(ps) for ps in parts.values())
    print(f"components: {len(data['components'])} rows, {len(parts)} costed spells, "
          f"{n_parts} costed parts, all accounted for")
    print(f"spellcasting: {len(sold)} spells by name, {len(parts) - len(sold)} not sold, "
          + ", ".join(f"{shop} {len(names)}" for shop, names in plan.items() if names))
    if check:
        return

    docs = [make_component(row, spells, parts) for row in data["components"]]
    old = write_goods(docs, lambda d: mp_flags(d).get("kind") == "component")
    place_lines(recipes, component_lines(data["components"]),
                old | {GOODS_UUID + d["_id"] for d in docs}, len)

    services = [make_service(spells[n], sold[n], levels[spells[n]["system"]["level"]]) for n in sold]
    old_services = write_goods(services, lambda d: bool(mp_flags(d).get("spell")))
    place_lines(recipes, service_lines(spells, plan, levels),
                old_services | {GOODS_UUID + d["_id"] for d in services}, after_level_services(levels))

    with open(os.path.join(MOD, "data/recipes.json"), "w") as out:
        out.write(json.dumps(recipes))
    print(f"  wrote {len(docs)} component goods, replacing {len(old)}; "
          f"component lines in {sum(1 for s in recipes['shops'] if any(l.get('cat') == COMPONENT_CAT for l in s['stock']))} shops")
    print(f"  wrote {len(services)} spellcasting goods, replacing {len(old_services)}; "
          f"{sum(len(n) for n in plan.values())} named spellcasting lines")

if __name__ == "__main__":
    main()
