# 對局長度分組的依據：最佳單一切點的排列檢定，以及各種切法的交叉驗證比較（說明見 docs/duration-bucketing.md）
# 執行：uv run python -X utf8 -I analysis/duration_bins_cut.py（唯讀 mayhem.db；資料變多、改版後要重跑，再決定要不要動 cube 的界線）
import math, random, sqlite3

c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)
rows = c.execute(
    """SELECT m.game_duration, MAX(p.win) FROM matches m JOIN match_participants p USING(platform_id, game_id)
       WHERE m.queue_id=2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me=1 OR tracked=1)
       GROUP BY m.platform_id, m.game_id"""
).fetchall()
normal = [(d, w) for d, w in rows if d >= 480]
N = len(normal)


def ll(n, x):
    if n == 0 or x == 0 or x == n:
        return 0.0
    p = x / n
    return x * math.log(p) + (n - x) * math.log(1 - p)


def best_single_cut(games, min_n=30):
    g = sorted(games)
    pre = [0]
    for _, w in g:
        pre.append(pre[-1] + w)
    tot_ll = ll(len(g), pre[-1])
    best = (0.0, None)
    for i in range(min_n, len(g) - min_n + 1):
        if i < len(g) and g[i - 1][0] == g[i][0]:
            continue
        gain = ll(i, pre[i]) + ll(len(g) - i, pre[-1] - pre[i]) - tot_ll
        if gain > best[0]:
            best = (gain, g[i][0])
    return best


gain, cut = best_single_cut(normal)
print(f"最佳單一切點 {cut / 60:.2f} 分，概似比增益 {gain:.2f}（2×增益 = {2 * gain:.2f}）")
lo = [w for d, w in normal if d < cut]
hi = [w for d, w in normal if d >= cut]
print(f"  切點以前 n={len(lo)} 勝率 {100 * sum(lo) / len(lo):.1f}%；以後 n={len(hi)} 勝率 {100 * sum(hi) / len(hi):.1f}%")

# 排列檢定：把勝負打亂（長度不動），每次都重新找最佳切點，看「最大增益」有多罕見——
# 已經把「挑了最好的切點」這件事算進去，不是只檢定固定的 13.5
random.seed(11)
ws = [w for _, w in normal]
ds = [d for d, _ in normal]
ge = 0
PERMS = 2000
for _ in range(PERMS):
    random.shuffle(ws)
    g, _c = best_single_cut(list(zip(ds, ws)))
    if g >= gain:
        ge += 1
print(f"排列檢定（{PERMS} 次，含「挑最佳切點」的選擇）：p = {(ge + 1) / (PERMS + 1):.4f}")

# 分位數（等場數）分組：邊界只看長度、不看勝負，不會為了好看而過擬合
ds_sorted = sorted(ds)
for k in (3, 4, 5, 6):
    qs = [ds_sorted[int(N * i / k)] for i in range(1, k)]
    print(f"{k} 等分位數邊界（分鐘）：", [round(q / 60, 1) for q in qs])

# 交叉驗證：比較各種「怎麼切」的預測表現
def fold_loss(train, test, edges):
    stat = {}
    asg = lambda d: sum(1 for e in edges if d >= e)
    for d, w in train:
        n, x = stat.get(asg(d), (0, 0))
        stat[asg(d)] = (n + 1, x + w)
    base = sum(w for _, w in train) / len(train)
    out = 0.0
    for d, w in test:
        n, x = stat.get(asg(d), (0, 0))
        p = (x + 2 * base) / (n + 2)
        p = min(max(p, 1e-4), 1 - 1e-4)
        out += -(w * math.log(p) + (1 - w) * math.log(1 - p))
    return out


def qedges(train, k):
    s = sorted(d for d, _ in train)
    return [s[int(len(s) * i / k)] for i in range(1, k)]


schemes = {
    "不分段": lambda tr: [],
    "只切一刀（資料挑的最佳切點，每折重找）": lambda tr: [best_single_cut(tr, 24)[1]] if best_single_cut(tr, 24)[1] else [],
    "分位數 3 等分": lambda tr: qedges(tr, 3),
    "分位數 4 等分": lambda tr: qedges(tr, 4),
    "分位數 5 等分": lambda tr: qedges(tr, 5),
    "分位數 6 等分": lambda tr: qedges(tr, 6),
    "固定 2 分鐘（上一版 7 段）": lambda tr: [720, 840, 960, 1080, 1200, 1320],
    "固定 5 分鐘": lambda tr: [600, 900, 1200, 1500],
}
tot = {n: 0.0 for n in schemes}
cnt = 0
games = list(normal)
for r in range(30):
    random.shuffle(games)
    for f in range(5):
        test = games[f::5]
        train = [g for i, g in enumerate(games) if i % 5 != f]
        cnt += len(test)
        for name, fn in schemes.items():
            tot[name] += fold_loss(train, test, fn(train))
print("\n交叉驗證（30 × 5 折，每場平均 log-loss，越小越好）")
for name, v in sorted(tot.items(), key=lambda kv: kv[1]):
    print(f"  {v / cnt:.4f}  {name}")
