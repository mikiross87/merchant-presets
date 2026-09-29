#!/usr/bin/env python3
"""Write the magic items the shops sell (#33) from SRD 5.2 only.

Two kinds, both read from data/magic.json:

- SRD magic items ready to use (a wand, a potion, a Sun Blade): only their
  recipe lines are written, each placed by the item's rarity.
- SRD enchantment templates (Flame Tongue, Mithral Armor, "Weapon, +1, +2, or
  +3"): dnd5e ships these as enchantments to put on a base item, not as items,
  and stocked as they are they have no damage and no AC. Each is flattened here
  onto the base items data/magic.json names: the enchantment's changes applied
  the way dnd5e applies them, its riders copied in, and the result written to
  _source/goods as this module's own good. dnd5e applies an enchantment only to
  an item's derived data, so shipping the base with the enchantment on would
  show and charge the base's name and price everywhere the shop reads stored
  data.

Runs before tools/build_srd.py, which embeds the goods and places the lines.
Needs MP_SRD_DIR, the unpacked dnd5e.equipment24 pack. `--check` resolves and
flattens everything without writing.
"""
import json, os, re, sys, copy
from build_srd import MOD, SRD, SRD_SOURCE, fid, load_srd, norm

SRD_PACK = "dnd5e.equipment24"
GOODS_DIR = os.path.join(MOD, "_source/goods")
GOODS_UUID = "Compendium.merchant-presets.goods.Item."
MAGIC_FOLDER = fid("goodsfolder", "Magic Items")
MAGIC_CAT = "Magic Items"
# Where a magic item is stocked, by its rarity (CONTRIBUTING.md): very rare and above never.
TIERS = {"common": "vtc", "uncommon": "tc", "rare": "c"}

class MagicError(Exception):
    pass

# ---------------------------------------------------------------- flattening

# Foundry applies an effect's changes in priority order, and a change with no
# priority takes its type's default (CONST.ACTIVE_EFFECT_MODES × 10).
PRIORITY = {"custom": 0, "multiply": 10, "add": 20, "subtract": 20, "downgrade": 30, "upgrade": 40, "override": 50}
# The item fields each change key targets, by the kind of field dnd5e declares
# there; a key not listed stops the build rather than being guessed at.
STRINGS = {"name", "img", "system.description.value", "system.unidentified.description",
           "system.unidentified.name", "system.rarity", "system.attunement", "system.price.denomination",
           "description.chatFlavor"}
SETS = {"system.properties", "system.damage.base.types"}
NUMBERS = {"system.price.value", "system.magicalBonus", "system.armor.magicalBonus", "system.proficient",
           "system.strength"}
FORMULAS = {"system.damage.base.bonus", "damage.critical.bonus"}
ARRAYS = {"system.damage.parts"}

def get(obj, path):
    for k in path.split("."):
        obj = obj.get(k) if isinstance(obj, dict) else None
    return obj

def put(obj, path, value):
    *head, last = path.split(".")
    for k in head:
        obj = obj.setdefault(k, {})
    obj[last] = value

def apply_change(target, key, kind, value):
    """One enchantment change on `target` (the item, or one of its activities),
    as dnd5e's ActiveEffect5e.applyChangeField does it."""
    current = get(target, key)
    if key in STRINGS:
        if kind == "override":
            put(target, key, value.replace("{}", current or "", 1) if "{}" in value else value)
        elif kind == "add":
            put(target, key, (current or "") + value)
        else:
            raise MagicError(f"{kind} on the text field {key}")
    elif key in SETS:
        if kind != "add":
            raise MagicError(f"{kind} on the set field {key}")
        values = list(current or [])
        for v in (value if isinstance(value, list) else str(value).split(",")):
            v = v.strip()
            neg = re.sub(r"^\s*-\s*", "", v)
            if neg != v:
                values = [x for x in values if x != neg]
            elif v not in values:
                values.append(v)
        put(target, key, values)
    elif key in NUMBERS:
        n = float(value)
        n = int(n) if n.is_integer() else n
        if current is None or kind == "override":
            put(target, key, n)
        elif kind == "add":
            put(target, key, current + n)
        elif kind == "upgrade":
            put(target, key, max(current, n))
        elif kind == "downgrade":
            put(target, key, min(current, n))
        else:
            raise MagicError(f"{kind} on the number field {key}")
    elif key in FORMULAS:
        if kind != "add":
            raise MagicError(f"{kind} on the formula field {key}")
        put(target, key, f"{current} + {value}" if current else str(value))
    elif key in ARRAYS:
        if kind != "add":
            raise MagicError(f"{kind} on the list field {key}")
        put(target, key, list(current or []) + list(value))
    else:
        raise MagicError(f"no rule for the change key {key!r}")

def changes_of(effect):
    changes = (effect.get("system") or {}).get("changes") or effect.get("changes") or []
    return sorted((c for c in changes if c.get("key")),
                  key=lambda c: c["priority"] if c.get("priority") is not None else PRIORITY.get(c["type"], 0))

def enchant_activities(doc):
    return [a for a in (doc["system"].get("activities") or {}).values() if a.get("type") == "enchant"]

def profiles_of(template):
    """The template's enchantment profiles: (effect, its riders), by effect id."""
    effects = {e["_id"]: e for e in template.get("effects") or []}
    out = []
    for activity in enchant_activities(template):
        for p in activity.get("effects") or []:
            e = effects.get(p["_id"])
            if e and e.get("type") == "enchantment":
                out.append((e, p.get("riders") or {}))
    return out

def rider_ids(template):
    """Every activity and effect any of the template's profiles adds as a rider."""
    acts, effs = set(), set()
    for _, riders in profiles_of(template):
        acts.update(riders.get("activity") or [])
        effs.update(riders.get("effect") or [])
    return acts, effs

def flatten(template, profile, riders, base, gid, problems):
    """`base` (or the template itself) with the enchantment `profile` applied and
    its riders copied in, as a plain item: no enchantment left to apply."""
    self_based = base is template
    item = copy.deepcopy(base)
    sysd = item["system"]
    t_effects = {e["_id"]: e for e in template.get("effects") or []}
    t_acts = template["system"].get("activities") or {}
    if self_based:
        # The template carries every profile's riders and its own enchant
        # activities; keep only what this profile brings.
        r_acts, r_effs = rider_ids(template)
        drop_acts = r_acts | {a["_id"] for a in enchant_activities(template)}
        sysd["activities"] = {k: a for k, a in (sysd.get("activities") or {}).items() if k not in drop_acts}
        item["effects"] = [e for e in item.get("effects") or [] if e["_id"] not in r_effs and e.get("type") != "enchantment"]
        (item.get("flags") or {}).get("dnd5e", {}).pop("riders", None)
    base_price = get(item, "system.price.value") or 0

    # Riders first: dnd5e adds them when the enchantment goes on, and an
    # `activities[attack]` change then reaches a rider attack too.
    effects = list(item.get("effects") or [])
    have = {e["_id"] for e in effects}
    for aid in riders.get("activity") or []:
        activity = t_acts.get(aid)
        if not activity:
            problems.append(f"{template['name']}: rider activity {aid} is not on the template, left out")
            continue
        a = copy.deepcopy(activity)
        a["_id"] = fid(gid, "activity", aid)
        (a.get("flags") or {}).get("dnd5e", {}).pop("dependentOn", None)
        sysd.setdefault("activities", {})[a["_id"]] = a
        for ref in a.get("effects") or []:
            e = t_effects.get(ref.get("_id"))
            if e and e["_id"] not in have:
                effects.append(copy.deepcopy(e)); have.add(e["_id"])
    for eid in riders.get("effect") or []:
        e = t_effects.get(eid)
        if not e:
            problems.append(f"{template['name']}: rider effect {eid} is not on the template, left out")
            continue
        e = copy.deepcopy(e)
        e["_id"] = fid(gid, "effect", eid)
        (e.get("flags") or {}).get("dnd5e", {}).pop("rider", None)
        effects.append(e); have.add(e["_id"])
    item["effects"] = effects

    changes = changes_of(profile)
    for c in changes:
        m = re.fullmatch(r"activities\[([^\]]+)\]\.(.+)", c["key"])
        if m:
            for a in (sysd.get("activities") or {}).values():
                if a.get("type") == m[1]:
                    apply_change(a, m[2], c["type"], c["value"])
        else:
            apply_change(item, c["key"], c["type"], c["value"])
    # Baked onto the template itself, the name its enchantment writes reads off
    # the umbrella ("Wand of the War Mage, +1, +2, or +3 of the War Mage, +1")
    # or hides what it does ("Ring of Resistance (pearl)"); the enchantment's own
    # name says it ("Ring of Resistance (Acid)", "Wand of the War Mage, +1").
    if self_based:
        item["name"] = profile["name"]
    # A template whose enchantment states no price or rarity keeps them on
    # itself (Giant Slayer: rare, 4,000 gp), where dnd5e's own enchanting would
    # leave the base's (none, 15 gp): the base's price plus the template's, and
    # the template's rarity.
    if not self_based:
        if not any(c["key"] == "system.price.value" for c in changes):
            sysd.setdefault("price", {"value": 0, "denomination": "gp"})
            sysd["price"]["value"] = base_price + (get(template, "system.price.value") or 0)
        if not any(c["key"] == "system.rarity" for c in changes):
            sysd["rarity"] = get(template, "system.rarity") or ""
    return item

# ---------------------------------------------------------------- goods

def make_good(template, profile, riders, base, problems):
    base_doc = base or template
    gid = fid("magic", template["_id"], profile["_id"], base_doc["_id"])
    it = flatten(template, profile, riders, base_doc, gid, problems)
    for k in ("_key", "folder", "sort", "ownership", "_stats"):
        it.pop(k, None)
    sysd = it["system"]
    for k in ("equipped", "proficient", "prepared", "container"):
        if k == "proficient" and any(c["key"] == "system.proficient" for c in changes_of(profile)):
            continue
        sysd.pop(k, None)
    sysd["attuned"] = False
    sysd["identified"] = True
    sysd["source"] = dict(SRD_SOURCE)
    it["_id"] = gid
    it["_key"] = f"!items!{gid}"
    it["folder"] = MAGIC_FOLDER
    it["sort"] = 0
    it["ownership"] = {"default": 0}
    for e in it.get("effects") or []:
        e["_key"] = f"!items.effects!{gid}.{e['_id']}"
        e["origin"] = None
    it["flags"] = {k: v for k, v in (it.get("flags") or {}).items() if k not in ("merchant-presets", "item-piles")}
    # Where it came from, for a reader and for the checks: the SRD template,
    # the enchantment baked, and the base it went on.
    it["flags"]["merchant-presets"] = {"magic": {
        "template": f"Compendium.{SRD_PACK}.Item.{template['_id']}",
        "enchantment": profile["_id"],
        "base": f"Compendium.{SRD_PACK}.Item.{base_doc['_id']}"}}
    return it

def make_priced(item, price):
    """An SRD magic item the SRD leaves unpriced (the Immovable Rod), as a good
    of this module's own at its rarity's value. A price on the recipe line would
    reach only the shipped snapshot: a shop rolls its shelf, and restocks, from
    its stock table, which draws the item as the SRD has it."""
    gid = fid("magic", "priced", item["_id"])
    it = copy.deepcopy(item)
    for k in ("_key", "folder", "sort", "ownership", "_stats"):
        it.pop(k, None)
    sysd = it["system"]
    for k in ("equipped", "proficient", "prepared", "container"):
        sysd.pop(k, None)
    sysd["price"] = {"value": price, "denomination": "gp"}
    sysd["attuned"] = False
    sysd["identified"] = True
    sysd["source"] = dict(SRD_SOURCE)
    it.update({"_id": gid, "_key": f"!items!{gid}", "folder": MAGIC_FOLDER, "sort": 0, "ownership": {"default": 0}})
    for e in it.get("effects") or []:
        e["_key"] = f"!items.effects!{gid}.{e['_id']}"
        e["origin"] = None
    uuid = f"Compendium.{SRD_PACK}.Item.{item['_id']}"
    it["flags"] = {k: v for k, v in (it.get("flags") or {}).items() if k not in ("merchant-presets", "item-piles")}
    it["flags"]["merchant-presets"] = {"magic": {"template": uuid, "enchantment": None, "base": uuid}}
    return it

def tier_of(item):
    rarity = (item.get("system") or {}).get("rarity") or ""
    if rarity not in TIERS:
        raise MagicError(f"{item['name']} is {rarity or 'without rarity'}: only common, uncommon and rare are stocked")
    return TIERS[rarity]

def line_for(item, uuid=None):
    # Every magic item is limited: it sells out and comes back with a restock,
    # as the scrolls and components do, in worlds on unlimited stock too.
    line = {"n": item["name"], "t": tier_of(item), "cat": MAGIC_CAT, "limited": True}
    if uuid:
        line["uuid"] = uuid
    return line

def resolve(srd, name):
    doc = srd.get(norm(name))
    if not doc:
        raise MagicError(f"{name!r} is not in {SRD_PACK}")
    return doc

def build(srd, data):
    """(goods, {shop id: [lines]}, problems)."""
    goods, lines, problems = [], {}, []
    for row in data["srd"]:
        item = resolve(srd, row["n"])
        sysd = item["system"]
        if not (sysd.get("rarity") or "mgc" in (sysd.get("properties") or [])):
            raise MagicError(f"{row['n']} is not a magic item")
        if enchant_activities(item) and not (sysd.get("type") or {}).get("baseItem") and sysd.get("type", {}).get("value") != "wondrous":
            problems.append(f"{row['n']}: an enchantment template, stocked as it is")
        unpriced = not (sysd.get("price") or {}).get("value")
        if unpriced != (row.get("price") is not None):
            raise MagicError(f"{row['n']}: give a price exactly when the SRD has none")
        uuid = None
        if unpriced:
            item = make_priced(item, row["price"])
            goods.append(item)
            uuid = GOODS_UUID + item["_id"]
        for shop in row["shops"]:
            lines.setdefault(shop, []).append(line_for(item, uuid=uuid))
    for row in data["bake"]:
        template = resolve(srd, row["template"])
        profiles = profiles_of(template)
        if row["profiles"] is not None:
            by_name = {e["name"]: (e, r) for e, r in profiles}
            missing = [n for n in row["profiles"] if n not in by_name]
            if missing:
                raise MagicError(f"{row['template']} has no enchantment {missing}")
            profiles = [by_name[n] for n in row["profiles"]]
        bases = [resolve(srd, b) for b in row["bases"]] if row["bases"] is not None else [None]
        for profile, riders in profiles:
            for base in bases:
                good = make_good(template, profile, riders, base, problems)
                goods.append(good)
                for shop in row["shops"]:
                    lines.setdefault(shop, []).append(line_for(good, uuid=GOODS_UUID + good["_id"]))
    names = [g["name"] for g in goods]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        # The runtime keys a shop's item settings by name.
        raise MagicError(f"two magic goods share a name: {sorted(dupes)}")
    for shop, ls in lines.items():
        seen = [l["n"] for l in ls]
        if len(seen) != len(set(seen)):
            raise MagicError(f"{shop} lists an item twice: {sorted({n for n in seen if seen.count(n) > 1})}")
    return goods, lines, problems

def folder_doc():
    return {"_id": MAGIC_FOLDER, "_key": f"!folders!{MAGIC_FOLDER}", "name": "Magic Items", "type": "Item",
            "sorting": "a", "folder": None, "description": "", "sort": 0, "color": "#5f4f9c", "flags": {}}

def is_ours(doc):
    return bool(((doc.get("flags") or {}).get("merchant-presets") or {}).get("magic")) or doc.get("_id") == MAGIC_FOLDER

def write(goods, lines, recipes):
    import glob
    for f in glob.glob(os.path.join(GOODS_DIR, "*.json")):
        if is_ours(json.load(open(f))):
            os.remove(f)
    for doc in [folder_doc()] + goods:
        safe = re.sub(r"[^A-Za-z0-9]+", "_", doc["name"]).strip("_")
        name = f"folder_{safe}_{doc['_id']}.json" if doc["_key"].startswith("!folders") else f"{safe}_{doc['_id']}.json"
        with open(os.path.join(GOODS_DIR, name), "w") as out:
            json.dump(doc, out, indent=2, ensure_ascii=False)
            out.write("\n")
    ids = {s["id"] for s in recipes["shops"]}
    unknown = set(lines) - ids
    if unknown:
        raise MagicError(f"no such shop: {sorted(unknown)}")
    for shop in recipes["shops"]:
        # Replace this generator's lines, at the end of the shop's stock.
        shop["stock"] = [l for l in shop["stock"] if l.get("cat") != MAGIC_CAT] + lines.get(shop["id"], [])

def main():
    if not SRD or not os.path.isdir(SRD):
        sys.exit("point MP_SRD_DIR at an unpacked dnd5e.equipment24 directory")
    srd = load_srd()
    data = json.load(open(os.path.join(MOD, "data/magic.json")))
    recipes = json.load(open(os.path.join(MOD, "data/recipes.json")))
    try:
        goods, lines, problems = build(srd, data)
        if "--check" not in sys.argv:
            write(goods, lines, recipes)
    except MagicError as e:
        sys.exit(f"magic goods: {e}")
    by_rarity = {}
    for ls in lines.values():
        for l in ls:
            by_rarity[l["t"]] = by_rarity.get(l["t"], 0) + 1
    print(f"magic: {len(data['srd'])} SRD items, {len(goods)} goods of our own, "
          f"{sum(len(l) for l in lines.values())} lines in {len(lines)} shops {by_rarity}")
    for p in problems:
        print(f"  {p}")
    if "--check" in sys.argv:
        return
    with open(os.path.join(MOD, "data/recipes.json"), "w") as out:
        out.write(json.dumps(recipes))

if __name__ == "__main__":
    main()
