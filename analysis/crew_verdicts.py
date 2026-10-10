# 好友比較頁「適合／不適合」判斷的可靠度：現行固定門檻 vs 有誤差範圍的判斷
# 執行：uv run python -X utf8 -I analysis/crew_verdicts.py（唯讀 mayhem.db）
#
# 現行（web/src/pages/Crew.tsx 的 classify）：
#   貢獻 = 隊內貢獻 − 50（和「同類型」的中位數比），依場次收縮 n/(n+6)，|值| ≥ 6 就算數；
#   勝率 = 收縮後勝率 − 他自己的整體勝率，出裝 ≥ 3pp、英雄 ≥ 5pp 就算數。
# 問題：
#   1. 隊內貢獻是「隊內份額」，每隊平均 50；常和好友一起打、整體就比路人強的人，幾乎每個出裝都 > 56 → 全部「適合」，
#      反映的是他整體比路人強，不是哪個出裝適合他。
#   2. 門檻是固定數字，不管場次：5 場的英雄和 50 場的英雄用同一條線。
import math
import sqlite3
from collections import defaultdict

c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)
crew = [r[0] for r in c.execute("SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1")]
rows = c.execute(
    f"""SELECT mp.puuid, mb.build_role, dc.name, mp.win, mc.score
          FROM match_participants mp
          JOIN matches m USING (platform_id, game_id)
          LEFT JOIN mat_builds mb ON mb.participant_rowid = mp.rowid
          LEFT JOIN mat_contribution mc ON mc.participant_rowid = mp.rowid
          LEFT JOIN dim_champions dc ON dc.id = mp.champion_id
         WHERE m.queue_id = 2400 AND mp.puuid IN ({','.join('?' * len(crew))})""",
    crew,
).fetchall()
print(f"好友 {len(crew)} 人、{len(rows)} 筆參賽紀錄（只看 Mayhem、全部期間）")

# ── 單場隊內貢獻的標準差（前端註解寫約 29）
scores = [r[4] for r in rows if r[4] is not None]
mu = sum(scores) / len(scores)
sd = math.sqrt(sum((s - mu) ** 2 for s in scores) / (len(scores) - 1))
by_p = defaultdict(list)
for r in rows:
    if r[4] is not None:
        by_p[r[0]].append(r[4])
within = math.sqrt(
    sum(sum((s - sum(v) / len(v)) ** 2 for s in v) for v in by_p.values()) / (len(scores) - len(by_p))
)
print(f"單場隊內貢獻：平均 {mu:.1f}、標準差 {sd:.1f}；扣掉每個人自己的平均後 {within:.1f}")
SD = within

# ── 每個人、每個出裝 / 英雄
def agg(key_idx):
    d = defaultdict(lambda: {"n": 0, "w": 0, "sn": 0, "ss": 0.0})
    for r in rows:
        k = (r[0], r[key_idx])
        if r[key_idx] is None:
            continue
        x = d[k]
        x["n"] += 1
        x["w"] += r[3]
        if r[4] is not None:
            x["sn"] += 1
            x["ss"] += r[4]
    return d

overall = {}
for p in crew:
    pr = [r for r in rows if r[0] == p]
    if not pr:
        continue
    sc = [r[4] for r in pr if r[4] is not None]
    overall[p] = {"n": len(pr), "wr": 100 * sum(r[3] for r in pr) / len(pr), "score": sum(sc) / len(sc) if sc else None}

def norm_inv(p):
    # 二分法就夠了
    lo, hi = -10.0, 10.0
    for _ in range(100):
        mid = (lo + hi) / 2
        if 0.5 * (1 + math.erf(mid / math.sqrt(2))) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2

def sidak(k):
    return 1.96 if k <= 1 else norm_inv(1 - (1 - 0.95 ** (1 / k)) / 2)

def wilson(w, n, z):
    p = w / n
    den = 1 + z * z / n
    cen = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return 100 * (cen - half), 100 * (cen + half)

def report(name, d, min_n, wr_gap):
    print(f"\n== {name}（{min_n} 場以上） ==")
    tot = defaultdict(int)
    per_player = defaultdict(lambda: defaultdict(int))
    for p, o in overall.items():
        items = [(k[1], x) for k, x in d.items() if k[0] == p and x["n"] >= min_n and x["sn"]]
        k = len(items)
        z_k = sidak(k)
        for label, x in items:
            n, wr = x["n"], 100 * x["w"] / x["n"]
            sm = x["ss"] / x["sn"]
            # 現行
            shr_wr = (x["w"] + 6 * o["wr"] / 100) / (n + 6) * 100 - o["wr"]
            perf_adj = (sm - 50) * n / (n + 6)
            old = None
            if perf_adj >= 6:
                old = "pos"
            elif perf_adj <= -6:
                old = "neg"
            elif shr_wr >= wr_gap:
                old = "pos"
            elif shr_wr <= -wr_gap:
                old = "neg"
            tot["現行有標籤"] += old is not None
            per_player[p]["現行正面"] += old == "pos"
            per_player[p]["現行負面"] += old == "neg"
            # 新：和自己的平均比，有誤差範圍
            rel = sm - o["score"]
            for zname, z in [("95%", 1.96), ("Šidák", z_k)]:
                se = SD / math.sqrt(x["sn"])
                c_clear = abs(rel) > z * se
                lo, hi = wilson(x["w"], n, z)
                w_clear = lo > o["wr"] or hi < o["wr"]
                tot[f"新-{zname} 貢獻明顯"] += c_clear
                tot[f"新-{zname} 勝率明顯"] += w_clear
                tot[f"新-{zname} 任一明顯"] += c_clear or w_clear
            tot["項目數"] += 1
    for k, v in tot.items():
        print(f"  {k}: {v}")
    for p, v in per_player.items():
        o = overall[p]
        print(f"    整體貢獻 {o['score']:.0f}（{o['n']} 場）：現行正面 {v['現行正面']}、負面 {v['現行負面']}")

report("出裝定位", agg(1), 5, 3)
report("英雄", agg(2), 3, 5)
report("英雄", agg(2), 5, 5)


# ── 能下結論的是什麼：同一個出裝裡，每個人和「同類型的中位數 50」比（隊內貢獻本來就是同類型內的名次），
#    以及整體的勝率和 50% 比。這是「人和人之間」的比較，差距大、樣本也多。
print("\n== 每個人 × 出裝：隊內貢獻和 50 比（95% 區間）；整體勝率和 50% 比 ==")
d = agg(1)
roles = sorted({k[1] for k in d})
cells = clear95 = clear_sidak = lean = 0
for p, o in sorted(overall.items(), key=lambda x: -x[1]["n"]):
    items = [(k[1], x) for k, x in d.items() if k[0] == p and x["n"] >= 5 and x["sn"]]
    z_k = sidak(len(items) + 1)
    se_all = SD / math.sqrt(o["n"])
    lo, hi = wilson(round(o["wr"] * o["n"] / 100), o["n"], 1.96)
    line = f"  整體 {o['score']:.0f}±{1.96 * se_all:.1f} 勝率 {o['wr']:.1f}%（{lo:.0f}～{hi:.0f}）｜"
    for label, x in sorted(items, key=lambda i: -i[1]["n"]):
        sm = x["ss"] / x["sn"]
        se = SD / math.sqrt(x["sn"])
        cells += 1
        mark = ""
        if abs(sm - 50) > z_k * se:
            clear_sidak += 1
            mark = "**"
        elif abs(sm - 50) > 1.96 * se:
            clear95 += 1
            mark = "*"
        elif abs(sm - 50) >= 6:
            lean += 1
            mark = "~"
        line += f" {label}{sm:.0f}{mark}({x['n']})"
    print(line)
print(f"  格數 {cells}：Šidák 校正後仍明顯 {clear_sidak}、只有 95% 明顯 {clear95}、差 6 分以上但分不出 {lean}")
