#!/usr/bin/env python3
"""Build the Merchant Presets packs from SRD 5.2 only.

Everything the merchants sell is either an SRD item (CC-BY-4.0, redistributable
with attribution) or one of this module's own goods. Nothing from the paid PHB
or DMG modules is touched, so the packs can be published.

Ids are content-derived hashes so a rebuild keeps every UUID stable.
"""
import json, glob, os, re, sys, hashlib, unicodedata, urllib.request, collections, random

MOD   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# An unpacked copy of the system's dnd5e.equipment24 pack. Not in this repo:
# unpack it from the installed system with
#   fvtt package unpack -n equipment24 --in <dnd5e>/packs --out <dir>
SRD   = os.environ.get("MP_SRD_DIR") or (sys.argv[1] if len(sys.argv) > 1 else "")
SRD_PACK = "dnd5e.equipment24"
# An unpacked copy of the system's dnd5e.actors24 pack, for the shopkeeper stat
# blocks. Same SRD 5.2 licence as the equipment, unpacked the same way.
ACTORS = os.environ.get("MP_ACTORS_DIR") or (sys.argv[2] if len(sys.argv) > 2 else "")
ACTORS_PACK = "dnd5e.actors24"
B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

def assert_world_closed():
    """Foundry holds module packs open while a world is loaded and flushes its
    own in-memory copy over anything written underneath it, silently reverting
    the build. Refuse rather than produce a pack that looks written and is not."""
    try:
        with urllib.request.urlopen("http://localhost:30000/api/status", timeout=4) as r:
            status = json.loads(r.read())
    except Exception:
        return                      # Foundry not running at all: safe
    if status.get("active"):
        sys.exit(f"REFUSING TO BUILD: world '{status.get('world')}' is loaded. Return to Setup first.")

def fid(*parts):
    h = int(hashlib.md5("|".join(map(str, parts)).encode()).hexdigest(), 16)
    out = ""
    while len(out) < 16:
        out += B62[h % 62]; h //= 62
    return out

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").replace("’", "'").lower()
    return re.sub(r"[^a-z0-9]+", "", s)

# ---------------------------------------------------------------- sources

def load_srd():
    """name -> doc, applying the bundle rule: for ammunition the priced unit is
    the bundle so take the largest quantity; for everything else the price is
    per unit so take the singular."""
    best = {}
    for f in glob.glob(os.path.join(SRD, "*.json")):
        d = json.load(open(f))
        # The pack ships its folders alongside its items, and 43 of them share
        # no name with any item — Wands, Potions, Rods, Scrolls, Tools, Holy
        # Symbol. Indexed by name they shadow the lookup: a stock line naming
        # one would resolve to the folder and be embedded as an item, instead
        # of being reported missing as this generator promises.
        if d.get("_key", "").startswith("!folders!"):
            continue
        k = norm(d["name"])
        sysd = d.get("system") or {}
        qty = sysd.get("quantity") or 1
        ammo = (sysd.get("type") or {}).get("value") == "ammo"
        cur = best.get(k)
        if not cur or (qty > cur[1] if ammo else qty < cur[1]):
            best[k] = (d, qty)
    return {k: v[0] for k, v in best.items()}

def load_actors():
    """name -> npc doc, from the unpacked SRD actor pack."""
    out = {}
    for f in glob.glob(os.path.join(ACTORS, "*.json")):
        d = json.load(open(f))
        if d.get("type") == "npc":
            out[norm(d["name"])] = d
    return out

def load_goods():
    out = {}
    for f in glob.glob(os.path.join(MOD, "_source/goods/*.json")):
        d = json.load(open(f))
        if not d.get("_key", "").startswith("!folders"):
            out[d["_id"]] = d
    return out

# ---------------------------------------------------------------- shape

TIERS = [("v", "Village", 0.4, 0), ("t", "Town", 1.0, 1), ("c", "City", 2.5, 2)]
# Settlement size reads at a glance: hamlet green, river-town blue, city gold.
TIER_COLOR = {"Village": "#4f7d5f", "Town": "#4f6a8c", "City": "#a8823c"}
STOCK_COLOR = "#6b4f7d"   # the module's own colour, as on the compendium folder
SRD_SOURCE = {"book": "SRD 5.2", "license": "CC-BY-4.0", "rules": "2024", "revision": 1}

# The shopkeeper behind the counter, as (village, town, city) SRD stat blocks.
# Everything here is from dnd5e.actors24 — SRD 5.2, CC-BY-4.0, the same licence
# as the stock — so the packs stay publishable. The ladder is the escalation:
# a village smith is a commoner with a hammer, a city smith is a veteran.
PROFILES = {
    "general-store":        ("Commoner",       "Commoner",         "Noble"),
    "tailor-textile":       ("Commoner",       "Commoner",         "Noble"),
    "jeweler":              ("Commoner",       "Noble",            "Noble"),
    "musical-store":        ("Commoner",       "Noble",            "Noble"),
    "alchemist-apothecary": ("Commoner",       "Priest Acolyte",   "Druid"),
    "druidic-store":        ("Commoner",       "Priest Acolyte",   "Druid"),
    "temple-faith":         ("Priest Acolyte", "Priest Acolyte",   "Priest"),
    "arcane-store":         ("Commoner",       "Priest Acolyte",   "Mage"),
    "armourer-blacksmith":  ("Commoner",       "Warrior Infantry", "Warrior Veteran"),
    "adventurers-store":    ("Guard",          "Scout",            "Warrior Veteran"),
    "leatherworker":        ("Commoner",       "Scout",            "Tough"),
    "fletcher-woodworker":  ("Commoner",       "Scout",            "Scout"),
    "stable":               ("Commoner",       "Scout",            "Knight"),
    "inn-tavern":           ("Commoner",       "Tough",            "Tough Boss"),
    "dock":                 ("Commoner",       "Pirate",           "Pirate Captain"),
    "criminal-illicit":     ("Bandit",         "Spy",              "Bandit Captain"),
    "tinkering-store":      ("Commoner",       "Noble",            "Mage"),
}

# Copied wholesale off the stat block. `attributes` carries ac/hp/senses/
# movement, and most profiles compute AC from equipped armour rather than a
# flat value, which is why make_gear leaves `equipped` alone.
STAT_KEYS    = ("abilities", "attributes", "bonuses", "skills", "traits")
STAT_DETAILS = ("cr", "type", "alignment")

# What a merchant will take off the party. Item Piles has no "only buys what it
# sells" switch, but `overrideItemFilters` refuses items per merchant, so each
# shop refuses every physical item type and every kind of our own goods that it
# does not itself stock. A fletcher will not take plate armour; a jeweler will
# not take a galley. Note this REPLACES the global filter list rather than
# adding to it, so the dnd5e defaults have to be carried along.
PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container"]
GOODS_KINDS = ["vehicle", "mount", "tack", "drink", "meal", "lodging",
               "service", "spellcasting", "component", "travel",
               # The shopkeeper's own kit. No stock line ever carries this kind,
               # so it lands in every shop's refuse list and the sword on the
               # smith's hip stays off the shelf.
               "gear"]
DND5E_ITEM_FILTERS = [
    {"path": "type", "filters": "background,class,facility,feat,race,spell,subclass"},
    {"path": "system.type.value", "filters": "natural"},
]

# Containers are stocked as separate documents, one each, so their count is the
# number of rows in the merchant list. Keep it small deliberately: the price
# bands would put forty pouches on a city shelf.
CONTAINER_COUNTS = ["1d2", "1d3", "1d4"]

STOCK_BANDS = [(1,["2d6+4","3d6+8","4d10+20"]), (10,["1d6+2","2d6+4","3d8+8"]),
               (50,["1d4+1","1d6+2","2d6+4"]), (250,["1d2","1d3+1","1d4+2"]),
               (1000,["1d2-1","1d2","1d3"]), (float("inf"),["1d3-2","1d2-1","1d2-1"])]
COIN = {"pp":10,"gp":1,"ep":0.5,"sp":0.1,"cp":0.01}

def band(gp, ti):
    for under, fs in STOCK_BANDS:
        if gp < under: return fs[ti]
    return STOCK_BANDS[-1][1][ti]

def roll(formula, seed):
    """Roll a stock count deterministically.

    The pack ships a rolled snapshot rather than a flat 1, so a merchant looks
    like a stocked shop when previewed in the compendium. Importing it into a
    world re-rolls, so two copies still differ. Seeded by the item so a rebuild
    reproduces the same pack byte for byte."""
    m = re.fullmatch(r"(\d+)d(\d+)([+-]\d+)?", formula)
    n, d, mod = int(m[1]), int(m[2]), int(m[3] or 0)
    rng = random.Random(seed)
    return max(0, sum(rng.randint(1, d) for _ in range(n)) + mod)

def make_item(src, line, actor_id, uuid, own, tier_index, copy=0):
    it = json.loads(json.dumps(src))
    iid = fid(actor_id, uuid, copy) if copy else fid(actor_id, uuid)
    for k in ("_id", "_key", "folder", "sort", "ownership"):
        it.pop(k, None)
    sysd = it.setdefault("system", {})
    for k in ("equipped", "proficient", "prepared"):
        sysd.pop(k, None)
    if "attunement" in sysd or "attuned" in sysd:
        sysd.setdefault("attunement", ""); sysd["attuned"] = False
    if line.get("price") is not None:
        sysd["price"] = {"value": line["price"], "denomination": "gp"}
    if not own:
        # Our own goods carry their own correct source block; SRD copies get one.
        sysd["source"] = dict(SRD_SOURCE)
    it["_stats"] = {"compendiumSource": uuid}

    bundle = line.get("bundle", 1)
    is_container = it.get("type") == "container"
    service = bool(line.get("service"))
    limited = bool(line.get("limited"))

    if service:
        infinite = "yes"
    elif is_container:
        # dnd5e pins a container's quantity to exactly 1 (ContainerData declares
        # `quantity: new NumberField({min: 1, max: 1})`), so a count of them
        # cannot be represented. One in stock, and it sells out.
        infinite = "no"
    else:
        infinite = "no" if limited else "default"

    if service or is_container:
        sysd["quantity"] = 1
    else:
        price = sysd.get("price") or {}
        gp = (price.get("value") or 0) * COIN.get(price.get("denomination"), 1)
        count = roll(band(gp, tier_index), f"{actor_id}|{uuid}")
        # A zero here would mean shipping a shop that is out of something for
        # everyone forever; the import re-roll is what makes things sell out.
        sysd["quantity"] = max(1, count) * bundle

    flags = it.setdefault("flags", {})
    flags["item-piles"] = {"item": {"infiniteQuantity": infinite,
                                    "keepOnMerchant": not limited,
                                    "isService": service,
                                    # You cannot sell a night's lodging back to
                                    # the innkeeper; this greys out the button.
                                    "cantBeSoldToMerchants": service}}
    if bundle > 1 and not is_container:
        flags["item-piles"]["system"] = {"quantityForPrice": bundle}
    it["_id"] = iid
    it["_key"] = f"!actors.items!{actor_id}.{iid}"

    # Effects arrive carrying their compendium keys (!items.effects!<itemId>.<id>).
    # Left alone, the same SRD item embedded in two merchants collides on pack.
    for eff in it.get("effects") or []:
        eid = fid(iid, eff.get("_id") or eff.get("name") or "")
        eff["_id"] = eid
        eff["_key"] = f"!actors.items.effects!{actor_id}.{iid}.{eid}"
        eff["origin"] = None
    return it, is_container

def make_gear(src, actor_id):
    """Copy one item off a stat block onto a merchant.

    Unlike make_item this keeps `equipped`/`proficient`/`prepared`: most
    profiles leave AC on `calc: "default"` and derive it from worn armour, so
    stripping the flag would quietly drop a veteran from AC 17 to AC 10."""
    it = json.loads(json.dumps(src))
    # Keyed on the source document id, not the name: a mage carries both the
    # Misty Step feature and the Misty Step spell, and hashing the name
    # collides the two into one item.
    iid = fid(actor_id, "gear", src.get("_id") or src.get("name") or "")
    for k in ("_id", "_key", "folder", "sort", "ownership"):
        it.pop(k, None)

    # The stat blocks ship in the system's SRD pack, but their items still carry
    # provenance pointers at the paid Monster Manual and Player's Handbook
    # modules. Those are dangling references for anyone without those modules,
    # and CI refuses a build that mentions them at all — so keep a source only
    # when it points back into the system itself.
    prior = (src.get("_stats") or {}).get("compendiumSource") or ""
    it["_stats"] = ({"compendiumSource": prior}
                    if prior.startswith("Compendium.dnd5e.") else {})
    it.setdefault("system", {})["source"] = dict(SRD_SOURCE)

    flags = it.setdefault("flags", {})
    flags.setdefault("merchant-presets", {})["kind"] = "gear"

    it["_id"] = iid
    it["_key"] = f"!actors.items!{actor_id}.{iid}"
    for eff in it.get("effects") or []:
        eid = fid(iid, eff.get("_id") or eff.get("name") or "")
        eff["_id"] = eid
        eff["_key"] = f"!actors.items.effects!{actor_id}.{iid}.{eid}"
        eff["origin"] = None
    return it

def statblock(npc):
    """The mechanical half of an SRD stat block, ready to merge into a merchant.

    Deliberately partial. The biography is left behind: it is an @Embed of the
    monster's rules entry, and copying it would overwrite the shop description
    the merchant already carries."""
    src = npc["system"]
    out = {k: json.loads(json.dumps(src[k])) for k in STAT_KEYS if k in src}
    out["details"] = {k: json.loads(json.dumps(src["details"][k]))
                      for k in STAT_DETAILS if k in src.get("details", {})}
    return out

def main():
    if not SRD or not os.path.isdir(SRD):
        sys.exit("point MP_SRD_DIR (or argv[1]) at an unpacked dnd5e.equipment24 directory")
    if not ACTORS or not os.path.isdir(ACTORS):
        sys.exit("point MP_ACTORS_DIR (or argv[2]) at an unpacked dnd5e.actors24 directory")
    assert_world_closed()
    srd = load_srd(); goods = load_goods(); actors = load_actors()
    recipes = json.load(open(os.path.join(MOD, "data/recipes.json")))

    actors_dir = os.path.join(MOD, "_source/merchants")
    tables_dir = os.path.join(MOD, "_source/stock")
    for d in (actors_dir, tables_dir):
        os.makedirs(d, exist_ok=True)
        for f in glob.glob(os.path.join(d, "*.json")): os.remove(f)

    fold_a = {}; fold_t = fid("stockfolder")
    docs_a = []; docs_t = []
    unresolved = collections.defaultdict(set)
    counts = collections.Counter(); gear_counts = collections.Counter()

    for key, label, purse_mul, ti in TIERS:
        fold_a[key] = fid("actorfolder", label)
        docs_a.append({"_id": fold_a[key], "_key": f"!folders!{fold_a[key]}", "name": label,
                       "type": "Actor", "sorting": "a", "folder": None, "sort": ti * 100000,
                       "color": TIER_COLOR[label], "flags": {}})
    docs_t.append({"_id": fold_t, "_key": f"!folders!{fold_t}", "name": "Shop Stock",
                   "type": "RollTable", "sorting": "a", "folder": None, "sort": 0,
                   "color": STOCK_COLOR, "flags": {}})

    for shop in recipes["shops"]:
        for key, label, purse_mul, ti in TIERS:
            lines = [l for l in shop["stock"] if key in l["t"]]
            if not lines: continue
            name = f"{shop['name']} ({label})"
            aid = fid("actor", shop["id"], label)
            tid = fid("table", shop["id"], label)

            items = []; results = []; containers = {}
            for line in lines:
                if line.get("uuid"):
                    gid = line["uuid"].rsplit(".", 1)[-1]
                    src = goods.get(gid); uuid = line["uuid"]; own = True
                    if not src: unresolved[line["n"]].add(shop["name"]); continue
                else:
                    src = srd.get(norm(line["n"])); own = False
                    if not src: unresolved[line["n"]].add(shop["name"]); continue
                    uuid = f"Compendium.{SRD_PACK}.Item.{src['_id']}"

                it, is_container = make_item(src, line, aid, uuid, own, ti)
                items.append(it); counts[label] += 1

                # dnd5e pins a container's quantity to exactly 1, because each
                # is a distinct object with its own contents — two pouches are
                # two items, exactly as on a character sheet. So stock them as
                # separate documents rather than one with a count.
                if is_container:
                    n = roll(CONTAINER_COUNTS[ti], f"{aid}|{uuid}|containers")
                    containers[src["name"]] = n
                    for c in range(1, n):
                        dup, _ = make_item(src, line, aid, uuid, own, ti, copy=c)
                        items.append(dup); counts[label] += 1

                price = (it["system"].get("price") or {})
                gp = (price.get("value") or 0) * COIN.get(price.get("denomination"), 1)
                bundle = line.get("bundle", 1)
                if line.get("service") or is_container:
                    formula = "1"
                else:
                    stock_roll = band(gp, ti)
                    formula = f"({stock_roll})*{bundle}" if bundle > 1 else stock_roll
                rid = fid(tid, uuid)
                if any(r["_id"] == rid for r in results):
                    continue
                results.append({"_id": rid, "_key": f"!tables.results!{tid}.{rid}",
                                "type": "document", "name": src["name"], "img": src.get("img"),
                                "documentUuid": uuid, "weight": 1,
                                "range": [len(results) + 1, len(results) + 1],
                                "drawn": False, "description": "", "flags": {}})
                it["flags"]["item-piles"]["__formula"] = formula

            if not items: continue

            # Derived from what this shop actually stocks, so nothing it sells
            # can ever be filtered out of its own inventory.
            stocked_types = {i.get("type") for i in items}
            stocked_kinds = {(i.get("flags", {}).get("merchant-presets") or {}).get("kind")
                             for i in items}
            refuse_types = [t for t in PHYSICAL_TYPES if t not in stocked_types]
            refuse_kinds = [k for k in GOODS_KINDS if k not in stocked_kinds]
            item_filters = [dict(f) for f in DND5E_ITEM_FILTERS]
            if refuse_types:
                item_filters.append({"path": "type", "filters": ",".join(refuse_types)})
            if refuse_kinds:
                item_filters.append({"path": "flags.merchant-presets.kind",
                                     "filters": ",".join(refuse_kinds)})

            by_uuid = {}
            for i in items:
                f = i["flags"]["item-piles"].pop("__formula", None)
                if f is not None:
                    by_uuid[i["_stats"]["compendiumSource"]] = f
            per_result = {r["_id"]: by_uuid.get(r["documentUuid"], "1") for r in results}

            # Item Piles rebuilds a restocked shelf straight from the source
            # compendium, and SRD items carry no Item Piles flags — so poisons
            # and scrolls would quietly stop being limited after the first
            # restock. Bake the intended flags in, keyed by name, for the
            # runtime to re-apply.
            item_flags = {}
            for i in items:
                f = dict(i["flags"]["item-piles"]["item"])
                q = (i["flags"]["item-piles"].get("system") or {}).get("quantityForPrice")
                if q:
                    f["quantityForPrice"] = q
                item_flags[i["name"]] = f

            docs_t.append({"_id": tid, "_key": f"!tables!{tid}", "name": name,
                           "img": shop["img"], "folder": fold_t,
                           "description": f"<p>{shop['desc']}</p><p><em>Stock list for a {label.lower()}.</em></p>",
                           "formula": f"1d{len(results)}", "replacement": True, "displayRoll": True,
                           "sort": 0, "ownership": {"default": 0}, "flags": {}, "results": results})

            # The shopkeeper behind the counter. Gear is appended after the item
            # filters are computed, not before: were it already in `items`, its
            # own types and kinds would read as stocked and the refuse list
            # would let a chain shirt onto the shelf.
            profile = PROFILES[shop["id"]][ti]
            npc = actors.get(norm(profile))
            if not npc:
                sys.exit(f"stat profile '{profile}' is not in {ACTORS_PACK}")
            gear = [make_gear(g, aid) for g in npc.get("items") or []]
            gear_counts[label] += len(gear)
            sysd = statblock(npc)
            sysd["currency"] = {"pp": 0, "gp": round(shop["purse"] * purse_mul),
                                "ep": 0, "sp": 0, "cp": 0}
            sysd["details"]["biography"] = {"value": f"<p>{shop['desc']}</p>"}

            docs_a.append({
                "_id": aid, "_key": f"!actors!{aid}", "name": name, "type": "npc",
                "img": shop["img"], "folder": fold_a[key], "sort": 0,
                "system": sysd,
                "prototypeToken": {"name": name, "actorLink": True, "texture": {"src": shop["img"]}},
                "items": items + gear, "effects": [], "ownership": {"default": 0},
                "flags": {
                    # The shop's own record of itself: what its purse should be
                    # refilled to, and the item flags a restock must restore.
                    "merchant-presets": {"purse": round(shop["purse"] * purse_mul),
                                         "profile": profile,
                                         "itemFlags": item_flags,
                                         "containers": containers},
                    "item-piles": {"data": {
                    "enabled": True, "type": "merchant",
                    "description": f"<p>{shop['desc']}</p>" + (f"<p><em>{shop['note']}</em></p>" if shop.get("note") else ""),
                    "merchantImage": shop["img"], "displayItemTypes": True, "canInspectItems": True,
                    # A finite purse: a village innkeeper cannot buy a suit of
                    # plate. Item Piles short-circuits the affordability check
                    # entirely when this is true, which made the purse decorative.
                    "infiniteQuantity": False, "infiniteCurrencies": False, "keepZeroQuantity": True,
                    "overrideItemFilters": item_filters,
                    "buyPriceModifier": shop["buy"], "sellPriceModifier": shop["sell"],
                    "tablesForPopulate": [{"uuid": f"Compendium.merchant-presets.stock.RollTable.{tid}",
                                           "addAll": True, "timesToRoll": "1", "customCategory": "",
                                           "items": per_result}],
                    # Trading hours, and a restock each morning when the doors
                    # open. Both are driven by Simple Calendar: without it
                    # Item Piles never fires the refresh, and `status: "auto"`
                    # would be rewritten to "open" on first sheet render — which
                    # throws on a locked compendium. So ship an explicit "open"
                    # and let the GM switch to auto once a calendar is present.
                    "openTimes": {"enabled": True, "status": "open",
                                  "open":  {"hour": shop["hours"][0], "minute": 0},
                                  "close": {"hour": shop["hours"][1], "minute": 0}},
                    "closedDays": [], "closedHolidays": [],
                    "refreshItemsOnOpen": True,
                    "refreshItemsDays": [], "refreshItemsHolidays": [],
                    "hideTokenWhenClosed": False},
                    "version": "3.3.4"}}})

    def write(docs, d):
        for doc in docs:
            safe = re.sub(r"[^A-Za-z0-9]+", "_", doc["name"]).strip("_")
            p = os.path.join(d, f"{safe}_{doc['_id']}.json")
            json.dump(doc, open(p, "w"), indent=2, ensure_ascii=False); open(p, "a").write("\n")
    write(docs_a, actors_dir); write(docs_t, tables_dir)

    print(f"merchants: {len([d for d in docs_a if d['_key'].startswith('!actors!')])}"
          f"  stock lines: {sum(counts.values())}  tables: {len([d for d in docs_t if d['_key'].startswith('!tables!')])}")
    print("  by tier:", dict(counts))
    print(f"  shopkeeper gear: {sum(gear_counts.values())}", dict(gear_counts))
    if unresolved:
        print(f"  not in SRD, left out ({len(unresolved)}):")
        for n, shops in sorted(unresolved.items()):
            print(f"     {n}  —  {', '.join(sorted(shops))}")

main()
