#!/usr/bin/env python3
"""Build the goods that come from SRD 5.2 spell text.

Spell components (#51): one good per component and price floor, not per
spell, so a single 100 GP diamond dust serves both Stoneskin and Greater
Restoration. The editorial half (names, kinds, which shops) lives in
data/components.json; the facts (which spells name a component, what it is
worth, whether the spell consumes it) are read from the spell text and checked
against it, so a row that disagrees with the SRD stops the build.

Run before tools/build_srd.py, which embeds the goods in the merchants:

  MP_SPELLS_DIR=/tmp/spells24 python3 tools/build_spell_goods.py [--check]

--check parses and validates without writing anything.
"""
import json, glob, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_srd import fid, norm

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

# ---------------------------------------------------------------- main

def main():
    check = "--check" in sys.argv
    if not SPELLS or not os.path.isdir(SPELLS):
        sys.exit("point MP_SPELLS_DIR at an unpacked dnd5e.spells24 directory")
    spells = load_spells()
    data = json.load(open(os.path.join(MOD, "data/components.json")))
    recipes = json.load(open(os.path.join(MOD, "data/recipes.json")))
    try:
        parts = costed(spells)
        validate_components(data, spells, parts, {s["id"] for s in recipes["shops"]})
    except SpellTextError as e:
        sys.exit(f"spell components: {e}")

    n_parts = sum(len(ps) for ps in parts.values())
    print(f"components: {len(data['components'])} rows, {len(parts)} costed spells, "
          f"{n_parts} costed parts, all accounted for")

if __name__ == "__main__":
    main()
