"""本場貢獻 v2 的獨立核對：不讀 contribution_v2.yml 的 SQL，直接從原始表用 Python 照規格重算，再和 mat_contribution_v2 逐筆比。
也印出回放摘要（分布、和舊分數的關係、規格第 13 節的幾項檢查）。只輸出聚合數字，不印玩家名稱或 puuid。

用法：uv run python analysis/scoring_v2_check.py [mayhem.db]
"""
import collections
import sqlite3
import statistics
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "mayhem.db"
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
c.row_factory = sqlite3.Row

SUP = {6617, 4005, 2530, 3504, 6621, 3107, 6616, 3222, 6620, 2065, 2526}
ADCAT = {"Damage", "CriticalStrike", "AttackSpeed", "ArmorPenetration", "LifeSteal", "OnHit"}
APCAT = {"SpellDamage", "MagicPenetration", "SpellVamp"}
DCAT = ADCAT | APCAT
TCAT = {"Health", "Armor", "SpellBlock", "MagicResist"}
EPS, K_EOG, K_FLAG = 0.05, 1250.0, 1100.0
# v2.1：模板（輸出、承傷、保人 → D, T, C, H）與裝備組成校正的係數
TPL = ((0.9, 0, 0.1, 0), (0, 0.7, 0.3, 0), (0, 0.2, 0.2, 0.6))
BETA = (39.434, 39.811, 39.228, 37.535, 12.399, 9.217)  # AD, AP, 承傷, 保人, AD×承傷, AP×承傷
SD0 = 6.706
MK = 0.85  # v2.2 射手加分：官方定位有射手的英雄，原始分加 MK × AD 裝比例
marksman = {r[0] for r in c.execute("SELECT champion_id FROM dim_champion_roles WHERE role = 'marksman'")}

cats = collections.defaultdict(set)
for r in c.execute("SELECT item_id, category FROM dim_item_categories"):
    cats[r[0]].add(r[1])
price = {r[0]: r[1] or 0 for r in c.execute("SELECT id, price_total FROM dim_items")}
pts = collections.defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])  # 輸出、承傷、保人、其中的 AD
for r in c.execute("SELECT platform_id, game_id, participant_id, item_id FROM participant_items WHERE slot < 6 AND item_id > 0"):
    iid, cs = r[3], cats.get(r[3], set())
    if iid not in price or cs & {"Consumable", "Trinket"}:
        continue
    p = pts[(r[0], r[1], r[2])]
    if iid in SUP:
        p[2] += price[iid]
        continue
    d, t = bool(cs & DCAT), bool(cs & TCAT)
    if d or t:
        p[0] += price[iid] * d / (d + t)
        p[1] += price[iid] * t / (d + t)
        if d:
            ad, ap = bool(cs & ADCAT), bool(cs & APCAT)
            p[3] += price[iid] * d / (d + t) * ad / (ad + ap)

eog = {(r[0], r[1]): r[2] + r[3] for r in c.execute("SELECT game_id, puuid, heal_on_teammates, shield_on_teammates FROM eog_player_stats")}
games = collections.defaultdict(list)
for r in c.execute("""SELECT mp.rowid rid, mp.*, m.game_duration gd FROM match_participants mp JOIN matches m USING (platform_id, game_id)
                      WHERE m.queue_id = 2400 AND m.is_remake = 0 AND m.game_duration >= 360"""):
    games[(r["platform_id"], r["game_id"])].append(r)

mine = {}
for key, ps in games.items():
    if len(ps) != 10 or sum(p["team_id"] == 100 for p in ps) != 5:
        continue
    mins = ps[0]["gd"] / 60
    use_eog = all((key[1], p["puuid"]) in eog for p in ps)
    rows = []
    for p in ps:
        pd, pt, ph, pad = pts.get((key[0], key[1], p["participant_id"]), [0, 0, 0, 0])
        tot = pd + pt + ph
        r = (1 / 3, 1 / 3, 1 / 3) if tot == 0 else (pd / tot, pt / tot, ph / tot)
        fad, fap = (1 / 6, 1 / 6) if tot == 0 else (pad / tot, (pd - pad) / tot)
        w = tuple(sum(r[j] * TPL[j][k] for j in range(3)) for k in range(4))
        expected = sum(b * x for b, x in zip(BETA, (fad, fap, r[1], r[2], fad * r[1], fap * r[1])))
        expected -= MK * fad if p["champion_id"] in marksman else 0  # 射手加分等於把期望分往下移
        h = eog[(key[1], p["puuid"])] / mins if use_eog else (p["total_heal"] / mins if p["units_healed"] >= 2 else 0.0)
        rows.append(dict(rid=p["rid"], w=w, x=(p["dmg_to_champions"] / mins, (p["dmg_taken"] + p["dmg_mitigated"]) / mins, p["time_ccing_others"] / mins),
                         h=h, wv=max(0, p["total_damage"] - p["dmg_to_champions"] - p["dmg_to_objectives"]) / mins, o=p["dmg_to_objectives"] / mins,
                         win=p["win"], deaths=p["deaths"], unknown=tot == 0, expected=expected))
    ref_w = sum(q["wv"] for q in rows) / 10
    ref_o = sum(q["o"] for q in rows) / 10
    for q in rows:
        P = []
        for k in range(3):
            others = [o for o in rows if o is not q]
            e = sum(o["x"][k] for o in others) * (EPS + q["w"][k]) / sum(EPS + o["w"][k] for o in others)
            x = q["x"][k]
            P.append(0.0 if x == 0 else 100.0 if e == 0 else 100 * x / (x + e))
        P.append(100 * q["h"] / (q["h"] + (K_EOG if use_eog else K_FLAG)))
        base = 80 * sum(q["w"][k] * P[k] for k in range(4)) / 100
        ks = range(4) if use_eog else range(3)
        cross = 10 * sum((1 - q["w"][k]) * max(0, (P[k] - 50) / 50) for k in ks) / sum(1 - q["w"][k] for k in ks)
        g = (2 * q["wv"] / (q["wv"] + ref_w) if ref_w else 0) + (4 * q["o"] / (q["o"] + ref_o) if ref_o else 0)
        raw = base + cross + g
        mine[q["rid"]] = dict(S=min(100, max(0, 50 + 20 * (raw - q["expected"]) / SD0)), P=P, base=base, cross=cross, g=g, raw=raw,
                              status="complete" if use_eog and not q["unknown"] else "estimate", win=q["win"], deaths=q["deaths"],
                              key=key, team=None)

mat = {r["participant_rowid"]: r for r in c.execute("SELECT * FROM mat_contribution_v2")}
diff = collections.Counter()
for rid, m in mine.items():
    t = mat.get(rid)
    if t is None or t["work_score_v2"] is None:
        diff["missing_in_mat"] += 1
        continue
    diff["max_S"] = max(diff["max_S"], abs(t["work_score_v2"] - m["S"]))
    for k, col in enumerate(("p_d", "p_t", "p_c", "p_h")):
        diff["max_P"] = max(diff["max_P"], abs(t[col] - m["P"][k]))
    for a, b in (("base_score", "base"), ("cross_role_bonus", "cross")):
        diff["max_" + b] = max(diff["max_" + b], abs(t[a] - m[b]))
    diff["max_G"] = max(diff["max_G"], abs((t["wave_bonus"] or 0) + (t["objective_bonus"] or 0) - m["g"]))
    diff["status_mismatch"] += t["score_status"] != m["status"]
extra = sum(1 for rid, t in mat.items() if t["work_score_v2"] is not None and rid not in mine)
print("逐筆比對（Python 獨立實作 vs mat_contribution_v2）：", len(mine), "人次", dict(diff), "mat 多出", extra)

S = [m["S"] for m in mine.values()]
q = statistics.quantiles(S, n=100)
print(f"分布：平均 {statistics.mean(S):.1f}、標準差 {statistics.pstdev(S):.1f}、P10 {q[9]:.1f}、P50 {q[49]:.1f}、P90 {q[89]:.1f}、P99 {q[98]:.1f}；"
      f"100 分 {sum(s >= 100 for s in S)}、0 分 {sum(s <= 0 for s in S)}")
for st in ("complete", "estimate"):
    v = [m["S"] for m in mine.values() if m["status"] == st]
    print(f"  {st}: {len(v)} 人次，平均 {statistics.mean(v):.1f}")


def corr(a, b):
    ma, mb = statistics.mean(a), statistics.mean(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    return num / (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5


old = {r[0]: (r[1], r[2]) for r in c.execute("SELECT participant_rowid, perf, score FROM mat_contribution")}
both = [(m["S"], old[rid][0], m["win"], m["deaths"]) for rid, m in mine.items() if rid in old and old[rid][0] is not None]
print(f"相關：v2~勝負 {corr([b[0] for b in both], [b[2] for b in both]):.3f}（perf {corr([b[1] for b in both], [b[2] for b in both]):.3f}）、"
      f"v2~死亡 {corr([b[0] for b in both], [b[3] for b in both]):.3f}（perf {corr([b[1] for b in both], [b[3] for b in both]):.3f}）、"
      f"v2~perf {corr([b[0] for b in both], [b[1] for b in both]):.3f}")

# 每隊最高分的出裝定位比、MVP 和舊 perf 同一人的比例
role = {r[0]: r[1] for r in c.execute("SELECT participant_rowid, build_role FROM mat_builds")}
team = collections.defaultdict(list)
for rid, m in mine.items():
    tid = c.execute("SELECT team_id FROM match_participants WHERE rowid = ?", (rid,)).fetchone()[0]
    team[(m["key"], tid)].append(rid)
same = 0
top_roles = collections.Counter()
for members in team.values():
    a = max(members, key=lambda r: mine[r]["S"])
    b = max(members, key=lambda r: old[r][0] if old.get(r) and old[r][0] is not None else -1)
    same += a == b
    top_roles[role[a]] += 1
pop = collections.Counter(role[r] for r in mine)
print(f"每隊最高分和舊 perf 同一人：{same / len(team):.1%}（{len(team)} 隊）")
print("每隊最高分的出裝定位比：", {k: round(top_roles[k] / len(team) / (pop[k] / len(mine)), 2) for k in pop})
by = collections.defaultdict(list)
for rid, m in mine.items():
    by[role[rid]].append(m["S"])
print("各出裝平均：", {k: (len(v), round(statistics.mean(v), 1)) for k, v in by.items()})
