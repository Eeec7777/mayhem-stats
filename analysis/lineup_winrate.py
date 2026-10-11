# 陣容和勝率的關係：我們（自己加追蹤對象）這邊，什麼陣容比較會贏？
# 執行：uv run python -X utf8 -I analysis/lineup_winrate.py（唯讀 mayhem.db）
#
# 以「一場」為單位（追蹤對象不會出現在兩隊，一場的勝負就是這群人的勝負），特徵是我方與敵方各五人的出裝定位。
# 三層檢驗，由弱到強：
#   1. 單一因素的勝率與 Wilson 95% 區間，以及「從這麼多格裡挑最亮的」的排列檢定（多重比較）
#   2. 多因素合併的邏輯迴歸（L2），用重複交叉驗證看有沒有比「只猜整體勝率」預測得更準
#   3. 整組特徵的排列檢定：把勝負打亂，看交叉驗證的進步幅度是不是偶然
import math
import random
import sqlite3

random.seed(5)
c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)

ROLES = ["坦克", "鬥士", "刺客", "射手", "法師", "輔助"]
FRONT = {"坦克", "鬥士"}
# 物理／魔法看出裝的傷害類型（builds.damage_type），坦克、輔助不算
DAMAGE_ROLES = {"鬥士", "刺客", "射手", "法師"}

rows = c.execute(
    """
    SELECT p.platform_id, p.game_id, p.team_id, p.win, b.build_role, b.damage_type,
           EXISTS(SELECT 1 FROM accounts a WHERE a.puuid = p.puuid AND (a.is_me = 1 OR a.tracked = 1)) AS crew
      FROM match_participants p
      JOIN matches m USING (platform_id, game_id)
      JOIN mat_builds b ON b.participant_rowid = p.rowid
     WHERE m.queue_id = 2400
    """
).fetchall()

games = {}
DMG = {}
for plat, gid, team, win, role, dmg, crew in rows:
    g = games.setdefault((plat, gid), {"teams": {}, "crew_team": None, "crew_win": None})
    g["teams"].setdefault(team, []).append(role)
    g.setdefault("dmg", {}).setdefault(team, []).append(dmg if role in DAMAGE_ROLES else None)
    if crew:
        g["crew_team"] = team
        g["crew_win"] = win

data = []
for g in games.values():
    if g["crew_team"] is None or len(g["teams"]) != 2:
        continue
    mine = g["teams"][g["crew_team"]]
    theirs = next(v for k, v in g["teams"].items() if k != g["crew_team"])
    data.append((mine, theirs, g["crew_win"]))
    DMG[id(mine)] = g["dmg"][g["crew_team"]]
    DMG[id(theirs)] = next(v for k, v in g["dmg"].items() if k != g["crew_team"])
N = len(data)
BASE = sum(w for _, _, w in data) / N
print(f"{N} 場，整體勝率 {BASE:.1%}\n")


def team_feats(team):
    return {
        "front": sum(r in FRONT for r in team),
        "ad": sum(d == "AD" for d in DMG[id(team)]),
        "ap": sum(d == "AP" for d in DMG[id(team)]),
        "sup": sum(r == "輔助" for r in team),
    }


def wilson(x, n, z=1.96):
    if not n:
        return (0, 1)
    p = x / n
    d = 1 + z * z / n
    ctr = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return ctr - h, ctr + h


def bucket_front(n):
    return "3+" if n >= 3 else str(n)


def mix_of(t):
    f = team_feats(t)
    return "物理為主" if f["ad"] - f["ap"] >= 2 else "魔法為主" if f["ap"] - f["ad"] >= 2 else "混合"


# ── 1. 單一因素
factors = {
    "我方前排數": lambda m, e: bucket_front(team_feats(m)["front"]),
    "敵方前排數": lambda m, e: bucket_front(team_feats(e)["front"]),
    "我方輸出組成": lambda m, e: mix_of(m),
    "敵方輸出組成": lambda m, e: mix_of(e),
    "我方有輔助": lambda m, e: "有" if team_feats(m)["sup"] else "沒有",
    "敵方有輔助": lambda m, e: "有" if team_feats(e)["sup"] else "沒有",
    "前排差（我方−敵方）": lambda m, e: str(max(-2, min(2, team_feats(m)["front"] - team_feats(e)["front"]))),
    "我方陣容類型": lambda m, e: f"{bucket_front(team_feats(m)['front'])}前排・{mix_of(m)}",
}
cells = []
print("1. 單一因素（勝率 [95% 區間]  場數）")
for name, fn in factors.items():
    tab = {}
    for m, e, w in data:
        k = fn(m, e)
        n, x = tab.get(k, (0, 0))
        tab[k] = (n + 1, x + w)
    print(f" {name}")
    for k in sorted(tab):
        n, x = tab[k]
        lo, hi = wilson(x, n)
        flag = "  ◀ 區間不含整體勝率" if (lo > BASE or hi < BASE) and n >= 30 else ""
        print(f"   {k:14s} {x / n:6.1%} [{lo:5.1%}, {hi:5.1%}] n={n:3d}{flag}")
        if n >= 30:
            cells.append((name, k, n, x))


def max_z(labels_w):
    best = 0.0
    for _, _, n, x in labels_w:
        p0 = BASE
        z = abs(x / n - p0) / math.sqrt(p0 * (1 - p0) / n)
        best = max(best, z)
    return best


# 多重比較：把勝負打亂，每次重算所有格的最大 |z|，看真實資料的最大 |z| 有多罕見
real_max = max_z(cells)
ws = [w for _, _, w in data]
ge = 0
PERM = 1000
for _ in range(PERM):
    random.shuffle(ws)
    shuffled = [(m, e, w) for (m, e, _), w in zip(data, ws)]
    perm_cells = []
    for name, fn in factors.items():
        tab = {}
        for m, e, w in shuffled:
            k = fn(m, e)
            n, x = tab.get(k, (0, 0))
            tab[k] = (n + 1, x + w)
        perm_cells += [(name, k, n, x) for k, (n, x) in tab.items() if n >= 30]
    if max_z(perm_cells) >= real_max:
        ge += 1
print(f"\n 這 {len(cells)} 格（n≥30）裡最大的 |z| = {real_max:.2f}；打亂勝負 {PERM} 次，同樣大的比例 = {(ge + 1) / (PERM + 1):.3f}")
print("  （p 小 = 真的有一格比運氣會出現的更極端；p 大 = 看起來亮的格子在這麼多格裡本來就會出現）")

# ── 2. 多因素邏輯迴歸 + 交叉驗證


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for i in range(n):
        piv = max(range(i, n), key=lambda r: abs(M[r][i]))
        M[i], M[piv] = M[piv], M[i]
        for r in range(n):
            if r != i and M[i][i]:
                f = M[r][i] / M[i][i]
                for k in range(i, n + 1):
                    M[r][k] -= f * M[i][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def fit_lr(X, y, l2=3.0, iters=25):
    d = len(X[0]) + 1
    w = [0.0] * d
    for _ in range(iters):
        g = [0.0] * d
        H = [[0.0] * d for _ in range(d)]
        for xi, yi in zip(X, y):
            z = w[0] + sum(a * b for a, b in zip(w[1:], xi))
            p = 1 / (1 + math.exp(-max(-30, min(30, z))))
            r = p - yi
            v = [1.0] + list(xi)
            for i in range(d):
                g[i] += r * v[i]
                for j in range(d):
                    H[i][j] += p * (1 - p) * v[i] * v[j]
        for i in range(1, d):
            g[i] += l2 * w[i]
            H[i][i] += l2
        H[0][0] += 1e-6
        step = solve(H, g)
        w = [a - b for a, b in zip(w, step)]
        if max(abs(s) for s in step) < 1e-6:
            break
    return w


def predict(w, xi):
    z = w[0] + sum(a * b for a, b in zip(w[1:], xi))
    return 1 / (1 + math.exp(-max(-30, min(30, z))))


def feats_A(m, e):
    a, b = team_feats(m), team_feats(e)
    return [a["front"], b["front"], a["ad"] - a["ap"], b["ad"] - b["ap"], a["sup"], b["sup"]]


def feats_B(m, e):  # 每種出裝定位：我方人數 − 敵方人數
    return [sum(r == role for r in m) - sum(r == role for r in e) for role in ROLES]


def standardize(X, ref):
    cols = list(zip(*ref))
    mu = [sum(col) / len(col) for col in cols]
    sd = [math.sqrt(sum((v - m) ** 2 for v in col) / len(col)) or 1 for col, m in zip(cols, mu)]
    return [[(v - m) / s for v, m, s in zip(row, mu, sd)] for row in X]


def cv_loss(featfn, y, reps=10, folds=5, l2=3.0, shuffle_y=False):
    X = [featfn(m, e) for m, e, _ in data]
    idx = list(range(N))
    tot = tot0 = 0.0
    cnt = 0
    for _ in range(reps):
        random.shuffle(idx)
        for f in range(folds):
            te = idx[f::folds]
            te_set = set(te)
            tr = [i for i in idx if i not in te_set]
            Xtr = [X[i] for i in tr]
            ytr = [y[i] for i in tr]
            Xs = standardize(Xtr, Xtr)
            Xte = standardize([X[i] for i in te], Xtr)
            w = fit_lr(Xs, ytr, l2)
            base = sum(ytr) / len(ytr)
            for xi, i in zip(Xte, te):
                p = min(max(predict(w, xi), 1e-4), 1 - 1e-4)
                q = min(max(base, 1e-4), 1 - 1e-4)
                tot += -(y[i] * math.log(p) + (1 - y[i]) * math.log(1 - p))
                tot0 += -(y[i] * math.log(q) + (1 - y[i]) * math.log(1 - q))
                cnt += 1
    return tot / cnt, tot0 / cnt


y = [w for _, _, w in data]
print("\n2. 多因素邏輯迴歸（L2），重複 5 折交叉驗證的 log-loss；基準 = 只猜整體勝率")
res = {}
for name, fn in [("A 前排／輸出組成／輔助（我方與敵方各三個）", feats_A), ("B 八種出裝定位的人數差（我方−敵方）", feats_B)]:
    model, baseline = cv_loss(fn, y)
    res[name] = (model, baseline)
    print(f" {name}: 模型 {model:.4f}  基準 {baseline:.4f}  進步 {baseline - model:+.4f}（正 = 比亂猜準）")

# 係數：全資料擬合，bootstrap 看區間是否跨 0
print("\n   B 的係數（每多一個那種出裝、勝率的勾勒，標準化後；bootstrap 200 次的 90% 區間）")
XB = [feats_B(m, e) for m, e, _ in data]
Xs = standardize(XB, XB)
w0 = fit_lr(Xs, y)
boots = [[] for _ in ROLES]
for _ in range(200):
    ii = [random.randrange(N) for _ in range(N)]
    Xb = [XB[i] for i in ii]
    wb = fit_lr(standardize(Xb, Xb), [y[i] for i in ii])
    for j in range(len(ROLES)):
        boots[j].append(wb[1 + j])
for j, role in enumerate(ROLES):
    b = sorted(boots[j])
    lo, hi = b[int(len(b) * 0.05)], b[int(len(b) * 0.95)]
    sig = "  ◀ 區間不含 0" if lo > 0 or hi < 0 else ""
    print(f"   {role:8s} {w0[1 + j]:+.3f}  [{lo:+.3f}, {hi:+.3f}]{sig}")

# ── 3. 整組特徵的排列檢定
print("\n3. 排列檢定：把勝負打亂，交叉驗證的「進步幅度」有多少次和真實一樣大？")
for name, fn in [("A", feats_A), ("B", feats_B)]:
    key = [k for k in res if k.startswith(name)][0]
    real_gain = res[key][1] - res[key][0]
    ge = 0
    P = 40
    for _ in range(P):
        random.shuffle(y)
        m_, b_ = cv_loss(fn, y, reps=1)
        if b_ - m_ >= real_gain:
            ge += 1
    print(f" {name}: 真實進步 {real_gain:+.4f}；打亂 {P} 次，一樣大以上 = {ge} 次（p ≈ {(ge + 1) / (P + 1):.3f}）")
