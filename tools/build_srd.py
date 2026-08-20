#!/usr/bin/env python3
"""Build the Merchant Presets packs from SRD 5.2 only.

Everything the merchants sell is either an SRD item (CC-BY-4.0, redistributable
with attribution) or one of this module's own goods. Nothing from the paid PHB
or DMG modules is touched, so the packs can be published.

Ids are content-derived hashes so a rebuild keeps every UUID stable.
"""
import json, glob, os, re, sys, hashlib, unicodedata, urllib.request, collections, random

MOD   = "/Users/miguelross/Foundry VTT/Data/modules/merchant-presets"
SRD   = "/private/tmp/claude-501/-Users-miguelross-Foundry-VTT/699030c9-30ea-42a1-8ee0-f2a3e3992ebf/scratchpad/unpack/sys-equipment24"
SRD_PACK = "dnd5e.equipment24"
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
        k = norm(d["name"])
        sysd = d.get("system") or {}
        qty = sysd.get("quantity") or 1
        ammo = (sysd.get("type") or {}).get("value") == "ammo"
        cur = best.get(k)
        if not cur or (qty > cur[1] if ammo else qty < cur[1]):
            best[k] = (d, qty)
    return {k: v[0] for k, v in best.items()}

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

# What a merchant will take off the party. Item Piles has no "only buys what it
# sells" switch, but `overrideItemFilters` refuses items per merchant, so each
# shop refuses every physical item type and every kind of our own goods that it
# does not itself stock. A fletcher will not take plate armour; a jeweler will
# not take a galley. Note this REPLACES the global filter list rather than
# adding to it, so the dnd5e defaults have to be carried along.
PHYSICAL_TYPES = ["weapon", "equipment", "consumable", "tool", "loot", "container"]
GOODS_KINDS = ["vehicle", "mount", "tack", "drink", "meal", "lodging",
               "service", "spellcasting", "component", "travel"]
DND5E_ITEM_FILTERS = [
    {"path": "type", "filters": "background,class,facility,feat,race,spell,subclass"},
    {"path": "system.type.value", "filters": "natural"},
]

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

def make_item(src, line, actor_id, uuid, own, tier_index):
    it = json.loads(json.dumps(src))
    iid = fid(actor_id, uuid)
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

def main():
    assert_world_closed()
    srd = load_srd(); goods = load_goods()
    recipes = json.load(open(os.path.join(MOD, "data/recipes.json")))

    actors_dir = os.path.join(MOD, "_source/merchants")
    tables_dir = os.path.join(MOD, "_source/stock")
    for d in (actors_dir, tables_dir):
        os.makedirs(d, exist_ok=True)
        for f in glob.glob(os.path.join(d, "*.json")): os.remove(f)

    fold_a = {}; fold_t = fid("stockfolder")
    docs_a = []; docs_t = []
    unresolved = collections.defaultdict(set)
    counts = collections.Counter()

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

            items = []; results = []
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

                price = (it["system"].get("price") or {})
                gp = (price.get("value") or 0) * COIN.get(price.get("denomination"), 1)
                bundle = line.get("bundle", 1)
                if line.get("service") or is_container:
                    formula = "1"
                else:
                    roll = band(gp, ti)
                    formula = f"({roll})*{bundle}" if bundle > 1 else roll
                rid = fid(tid, uuid)
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

            per_result = {r["_id"]: i["flags"]["item-piles"].pop("__formula")
                          for r, i in zip(results, items)}

            docs_t.append({"_id": tid, "_key": f"!tables!{tid}", "name": name,
                           "img": shop["img"], "folder": fold_t,
                           "description": f"<p>{shop['desc']}</p><p><em>Stock list for a {label.lower()}.</em></p>",
                           "formula": f"1d{len(results)}", "replacement": True, "displayRoll": True,
                           "sort": 0, "ownership": {"default": 0}, "flags": {}, "results": results})

            docs_a.append({
                "_id": aid, "_key": f"!actors!{aid}", "name": name, "type": "npc",
                "img": shop["img"], "folder": fold_a[key], "sort": 0,
                "system": {"currency": {"pp": 0, "gp": round(shop["purse"] * purse_mul),
                                        "ep": 0, "sp": 0, "cp": 0},
                           "details": {"biography": {"value": f"<p>{shop['desc']}</p>"},
                                       "type": {"value": "humanoid"}, "cr": 0},
                           "attributes": {"hp": {"value": 10, "max": 10}}},
                "prototypeToken": {"name": name, "actorLink": True, "texture": {"src": shop["img"]}},
                "items": items, "effects": [], "ownership": {"default": 0},
                "flags": {"item-piles": {"data": {
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
    if unresolved:
        print(f"  not in SRD, left out ({len(unresolved)}):")
        for n, shops in sorted(unresolved.items()):
            print(f"     {n}  —  {', '.join(sorted(shops))}")

main()
