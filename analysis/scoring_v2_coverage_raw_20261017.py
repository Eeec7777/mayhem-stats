"""v2 規格覆蓋率盤點：原始 JSON 鍵是否存在、靜態目錄（items／cherry-augments／champions）能不能建功能表。唯讀。"""
import sqlite3, sys, json, zlib, re, collections
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
q = lambda s, *a: c.execute(s, a).fetchall()
p = lambda *a: print(*a)

# 1. raw_json key presence for valid games
keys = ["totalDamageDealtToChampions", "totalDamageTaken", "damageSelfMitigated", "timeCCingOthers", "totalTimeCrowdControlDealt",
        "totalDamageDealt", "damageDealtToObjectives", "damageDealtToTurrets", "damageDealtToBuildings", "totalHealsOnTeammates",
        "totalDamageShieldedOnTeammates"]
miss = collections.Counter(); zero = collections.Counter(); n = 0; neg_turret = 0; obj_vs_turret = collections.Counter()
for (raw,) in q("select raw_json from matches where queue_id=2400 and is_remake=0 and game_duration>=360"):
    g = json.loads(raw)
    for part in g.get("participants", []):
        st = part.get("stats", {})
        n += 1
        for k in keys:
            if k not in st or st[k] is None:
                miss[k] += 1
            elif st[k] == 0:
                zero[k] += 1
        if "damageDealtToTurrets" in st and "damageDealtToObjectives" in st:
            d = st["damageDealtToObjectives"] - st["damageDealtToTurrets"]
            obj_vs_turret["eq" if d == 0 else "obj>tur" if d > 0 else "obj<tur"] += 1
p("participants", n)
for k in keys:
    p(f"  {k}: missing {miss[k]}  zero {zero[k]}")
p("obj vs turret", dict(obj_vs_turret))
p("example stat keys:", sorted(json.loads(q("select raw_json from matches where queue_id=2400 limit 1")[0][0])["participants"][0]["stats"].keys()))

# 2. static catalogs
def load(endpoint):
    r = q("select raw_zlib from raw_payloads where endpoint=? order by last_seen desc limit 1", endpoint)
    return json.loads(zlib.decompress(r[0][0])) if r else None

items = load("/lol-game-data/assets/v1/items.json")
p("items.json entries", len(items), "keys", sorted(items[0].keys()))
used = {r[0]: r[1] for r in q("""select pi.item_id, count(*) from participant_items pi join matches m on m.platform_id=pi.platform_id and m.game_id=pi.game_id
    where m.queue_id=2400 and m.is_remake=0 and pi.slot<6 and pi.item_id>0 group by 1""")}
strip = lambda s: re.sub(r"<[^>]+>", " ", s or "")
AH = re.compile(r"重創")
AS = re.compile(r"(削弱|減少|降低|摧毀|破壞)[^。]{0,12}護盾|護盾[^。]{0,8}(削弱|減少|降低)")
ah, as_ = [], []
for it in items:
    d = strip(it.get("description"))
    if it["id"] in used:
        if AH.search(d): ah.append((it["id"], it["name"], used[it["id"]], d[d.find("重創")-40:d.find("重創")+30].strip()))
        if AS.search(d): as_.append((it["id"], it["name"], used[it["id"]], AS.search(d).group(0)))
p("\nused items mentioning 重創:")
for x in ah: p("  ", x)
p("used items with shield-reduction wording:")
for x in as_: p("  ", x)
p("placeholder-ish descriptions (0% / @ / {{) among used items:",
  sum(1 for it in items if it["id"] in used and re.search(r"\b0%|@\w+@|\{\{", it.get("description") or "")))

aug = load("/lol-game-data/assets/v1/cherry-augments.json")
p("\ncherry-augments entries", len(aug), "keys", sorted(aug[0].keys()))
used_aug = {r[0]: r[1] for r in q("""select pa.augment_id, count(*) from participant_augments pa join matches m on m.platform_id=pa.platform_id and m.game_id=pa.game_id
    where m.queue_id=2400 and m.is_remake=0 and m.game_duration>=360 group by 1""")}
byid = {a["id"]: a for a in aug}
desc_fields = [k for k in aug[0].keys() if "desc" in k.lower() or "tooltip" in k.lower()]
p("augment desc fields:", desc_fields)
has_desc = sum(v for k, v in used_aug.items() if k in byid and any((byid[k].get(f) or "").strip() for f in desc_fields))
p("augment rows with non-empty desc:", has_desc, "/", sum(used_aug.values()), " distinct used", len(used_aug), " in catalog", sum(1 for k in used_aug if k in byid))
for k in list(used_aug)[:3]:
    a = byid.get(k, {})
    p("  sample", k, {f: (a.get(f) or "")[:120] for f in desc_fields})
kw = {"heal_ally": r"治療|護盾", "anti_heal": r"重創", "tank": r"生命|護甲|魔法防禦|物理防禦|減傷|韌性", "dmg": r"傷害|攻擊|穿透|暴擊"}
cnt = collections.Counter()
for k, v in used_aug.items():
    a = byid.get(k)
    if not a: cnt["missing"] += v; continue
    d = strip(" ".join(a.get(f) or "" for f in desc_fields))
    hits = [name for name, rx in kw.items() if re.search(rx, d)]
    cnt[",".join(hits) or "none"] += v
p("augment keyword buckets (rows):", cnt.most_common(15))

# 3. champion spells mentioning heal/shield on allies or 重創
champs = q("select endpoint, raw_zlib from raw_payloads where endpoint like '/lol-game-data/assets/v1/champions/%'")
ally = 0; ah_ch = 0; total = 0; sample = None
for ep, z in champs:
    ch = json.loads(zlib.decompress(z)); total += 1
    text = " ".join(strip(s.get("description") or s.get("dynamicDescription")) for s in (ch.get("spells") or []))
    text += " " + strip((ch.get("passive") or {}).get("description"))
    if re.search(r"(友軍|隊友|盟友)[^。]{0,30}(治療|護盾|回復)|(治療|護盾)[^。]{0,30}(友軍|隊友|盟友)", text): ally += 1
    if "重創" in text: ah_ch += 1
    if sample is None: sample = sorted(ch.keys())
p("\nchampion files", total, "keys", sample)
p("champions whose spell text mentions ally heal/shield:", ally, " mention 重創:", ah_ch)
