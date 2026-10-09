# 對局長度分組的依據：動態規劃找最佳分段，BIC 與交叉驗證決定分幾段（說明見 docs/duration-bucketing.md）
# 執行：uv run python -X utf8 -I analysis/duration_bins_dp.py（唯讀 mayhem.db；資料變多、改版後要重跑，再決定要不要動 cube 的界線）
"""對局長度的最佳分組：以「一場」為單位（crew 從不在兩隊，一場的勝負就是 crew 的勝負）。

方法：
  1. 動態規劃找「Bernoulli 對數概似最大」的分段（optimal binning），每段至少 MIN_N 場。
  2. 用 BIC 與重複 K 折交叉驗證（out-of-fold log-loss）決定分幾段，並和固定寬度分組比較。
  3. Bootstrap：主要切點在重抽樣下有多穩。
"""
import math, random, sqlite3, sys

MIN_N = 30
c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)
rows = c.execute(
    """SELECT m.game_duration, MAX(p.win) FROM matches m JOIN match_participants p USING(platform_id, game_id)
       WHERE m.queue_id=2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me=1 OR tracked=1)
       GROUP BY m.platform_id, m.game_id"""
).fetchall()
# 8 分以前沒有任何投降結局：1.5～2.5 分的是重開／斷線，不是正常對局，先排除，單獨成一組
normal = sorted((d, w) for d, w in rows if d >= 480)
print(f"全部 {len(rows)} 場，8 分以前 {len(rows) - len(normal)} 場（排除），分析 {len(normal)} 場")

# 以 30 秒為格，累積場數與勝場，切點只落在格的邊界
GRID = 30
cells = {}
for d, w in normal:
    k = int(d // GRID)
    n, x = cells.get(k, (0, 0))
    cells[k] = (n + 1, x + w)
ks = sorted(cells)
# 補上空格，讓切點連續
lo, hi = ks[0], ks[-1]
seq = [cells.get(k, (0, 0)) for k in range(lo, hi + 1)]
pre_n = [0]
pre_w = [0]
for n, x in seq:
    pre_n.append(pre_n[-1] + n)
    pre_w.append(pre_w[-1] + x)


def ll(n, x):
    if n == 0 or x == 0 or x == n:
        return 0.0 if n else 0.0
    p = x / n
    return x * math.log(p) + (n - x) * math.log(1 - p)


def seg(i, j):  # 格 [i, j)
    return pre_n[j] - pre_n[i], pre_w[j] - pre_w[i]


def best_partition(idx_range, k_max):
    """dp[k][j] = 前 j 格切成 k 段的最大對數概似"""
    m = len(idx_range)
    NEG = -1e18
    dp = [[NEG] * (m + 1) for _ in range(k_max + 1)]
    back = [[0] * (m + 1) for _ in range(k_max + 1)]
    dp[0][0] = 0.0
    for k in range(1, k_max + 1):
        for j in range(1, m + 1):
            for i in range(0, j):
                if dp[k - 1][i] <= NEG / 2:
                    continue
                n, x = seg(i, j)
                if n < MIN_N:
                    continue
                v = dp[k - 1][i] + ll(n, x)
                if v > dp[k][j]:
                    dp[k][j] = v
                    back[k][j] = i
    return dp, back


def cuts_of(back, k, m):
    cuts = []
    j = m
    for kk in range(k, 0, -1):
        i = back[kk][j]
        cuts.append(i)
        j = i
    return sorted(cuts)[1:]  # 去掉起點 0


m = len(seq)
K_MAX = 9
dp, back = best_partition(range(m), K_MAX)
N = pre_n[-1]
print("\n段數  對數概似   BIC       切點（分鐘）")
res = {}
for k in range(1, K_MAX + 1):
    if dp[k][m] < -1e17:
        continue
    cuts = cuts_of(back, k, m)
    mins = [round((lo + c_) * GRID / 60, 1) for c_ in cuts]
    bic = -2 * dp[k][m] + (2 * k - 1) * math.log(N)  # k 個機率 + (k-1) 個切點
    res[k] = (dp[k][m], bic, mins)
    print(f"{k:3d}  {dp[k][m]:10.2f}  {bic:8.2f}  {mins}")
kbic = min(res, key=lambda k: res[k][1])
print("BIC 最小的段數：", kbic, res[kbic][2])

# ── 交叉驗證：K 折重複，out-of-fold log-loss
random.seed(7)
games = list(normal)


def fit_cuts(train, k):
    cl = {}
    for d, w in train:
        kk = int(d // GRID) - lo
        n, x = cl.get(kk, (0, 0))
        cl[kk] = (n + 1, x + w)
    s = [cl.get(i, (0, 0)) for i in range(m)]
    pn, pw = [0], [0]
    for n, x in s:
        pn.append(pn[-1] + n)
        pw.append(pw[-1] + x)
    NEG = -1e18
    mn = MIN_N * 0.8  # 訓練集少一份，門檻同比例縮
    dpk = [[NEG] * (m + 1) for _ in range(k + 1)]
    bk = [[0] * (m + 1) for _ in range(k + 1)]
    dpk[0][0] = 0
    for kk in range(1, k + 1):
        for j in range(1, m + 1):
            for i in range(j):
                if dpk[kk - 1][i] <= NEG / 2:
                    continue
                n = pn[j] - pn[i]
                x = pw[j] - pw[i]
                if n < mn:
                    continue
                v = dpk[kk - 1][i] + ll(n, x)
                if v > dpk[kk][j]:
                    dpk[kk][j] = v
                    bk[kk][j] = i
    if dpk[k][m] < -1e17:
        return None
    cuts = cuts_of(bk, k, m)
    return cuts


def edges_of(cuts):
    return [(lo + c_) * GRID for c_ in cuts]


def assign(d, edges):
    return sum(1 for e in edges if d >= e)


def fixed_edges(step):
    return [e for e in range(int(math.ceil(480 / step) * step), int(max(d for d, _ in normal)) + 1, step)]


def fold_loss(train, test, edges):
    stat = {}
    for d, w in train:
        b = assign(d, edges)
        n, x = stat.get(b, (0, 0))
        stat[b] = (n + 1, x + w)
    base = sum(w for _, w in train) / len(train)
    loss = 0.0
    for d, w in test:
        n, x = stat.get(assign(d, edges), (0, 0))
        p = (x + 2 * base) / (n + 2)  # 輕度平滑，空桶退回整體
        p = min(max(p, 1e-4), 1 - 1e-4)
        loss += -(w * math.log(p) + (1 - w) * math.log(1 - p))
    return loss


REPS, FOLDS = 20, 5
schemes = {"不分段（整體勝率）": ("none", None)}
for k in range(2, 8):
    schemes[f"最佳分段 k={k}"] = ("opt", k)
for step in (60, 120, 180, 300):
    schemes[f"固定 {step // 60} 分鐘"] = ("fixed", step)
tot = {name: 0.0 for name in schemes}
cnt = 0
for r in range(REPS):
    random.shuffle(games)
    for f in range(FOLDS):
        test = games[f::FOLDS]
        train = [g for i, g in enumerate(games) if i % FOLDS != f]
        cnt += len(test)
        for name, (kind, arg) in schemes.items():
            if kind == "none":
                edges = []
            elif kind == "fixed":
                edges = fixed_edges(arg)
            else:
                cuts = fit_cuts(train, arg)
                edges = edges_of(cuts) if cuts else []
            tot[name] += fold_loss(train, test, edges)
print("\n交叉驗證（%d 次 × %d 折，越小越好；單位 = 每場的平均 log-loss）" % (REPS, FOLDS))
for name, v in sorted(tot.items(), key=lambda kv: kv[1]):
    print(f"  {v / cnt:.4f}  {name}")

# ── Bootstrap：各段數的切點穩不穩
print("\nBootstrap 1000 次：k=3 與 k=4 的切點分布（分鐘）")
for k in (3, 4):
    pos = [[] for _ in range(k - 1)]
    for b in range(300):
        sample = [random.choice(games) for _ in games]
        cuts = fit_cuts(sample, k)
        if cuts:
            for i, c_ in enumerate(sorted(edges_of(cuts))):
                pos[i].append(c_ / 60)
    for i, p in enumerate(pos):
        p.sort()
        if p:
            print(f"  k={k} 第 {i + 1} 個切點：中位 {p[len(p) // 2]:.1f}，90% 區間 {p[int(len(p) * .05)]:.1f}～{p[int(len(p) * .95)]:.1f}")
