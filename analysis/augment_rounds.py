# 增幅的選取時機：同一個增幅早拿和晚拿有沒有差、哪一輪的選擇最影響勝負
# 執行：uv run python -X utf8 -I analysis/augment_rounds.py（唯讀 mayhem.db）
#
# participant_augments.slot 就是選取順序（多數人 4 個；提早結束的局只拿到 3 個，平均 12 分鐘）。
# 陷阱：第 4 輪只有打得夠久才拿得到，長局本來就比較常輸，所以每一輪都要和「同一輪的平均」比。
import math
import random
import sqlite3
from collections import defaultdict

random.seed(4)
c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)
rows = c.execute(
    """SELECT pa.platform_id || ':' || pa.game_id || ':' || pa.participant_id AS who, pa.slot, pa.augment_id, mp.win
         FROM participant_augments pa
         JOIN matches m USING (platform_id, game_id)
         JOIN match_participants mp USING (platform_id, game_id, participant_id)
        WHERE m.queue_id = 2400 AND pa.slot <= 4"""
).fetchall()
print(f"{len(rows)} 次選取（第 1～4 輪，全部參賽者）")

# ── 1. 同一個增幅在不同輪拿，勝率有沒有差：每個增幅做「輪次 × 勝負」的卡方，加總，和打亂輪次的結果比
by_aug = defaultdict(list)
for who, slot, aug, win in rows:
    by_aug[aug].append((slot, win))
round_base = {}
for s in (1, 2, 3, 4):
    xs = [w for _, slot, _, w in rows if slot == s]
    round_base[s] = sum(xs) / len(xs)


def hetero(groups):
    """各增幅：每一輪的勝率減掉該輪基準，平方加權加總（像卡方）。只算該輪 ≥ 15 次的格。"""
    total = 0.0
    cells = 0
    for picks in groups.values():
        per = defaultdict(lambda: [0, 0])
        for slot, w in picks:
            per[slot][0] += 1
            per[slot][1] += w
        ok = {s: v for s, v in per.items() if v[0] >= 15}
        if len(ok) < 2:
            continue
        # 先扣掉輪次基準，再看這個增幅在各輪之間的差異
        adj = {s: v[1] / v[0] - round_base[s] for s, v in ok.items()}
        n = sum(v[0] for v in ok.values())
        mean = sum(adj[s] * ok[s][0] for s in ok) / n
        for s, v in ok.items():
            total += v[0] * (adj[s] - mean) ** 2 / 0.25
            cells += 1
    return total, cells


real, cells = hetero(by_aug)
ge = 0
PERM = 300
for _ in range(PERM):
    shuffled = {}
    for aug, picks in by_aug.items():
        slots = [s for s, _ in picks]
        random.shuffle(slots)
        shuffled[aug] = list(zip(slots, [w for _, w in picks]))
    if hetero(shuffled)[0] >= real:
        ge += 1
print(f"\n1. 同一個增幅早拿 vs 晚拿：異質性統計 {real:.1f}（{cells} 格），打亂輪次 {PERM} 次一樣大以上的比例 p = {(ge + 1) / (PERM + 1):.3f}")
print("   （p 大 = 看不出「同一個增幅在哪一輪拿」有差；p 小 = 有些增幅確實早拿或晚拿比較好）")

# ── 2. 哪一輪的選擇最影響勝負：每個增幅的「整體勝率 − 50%」當作它的強度（排除自己這一場，避免自己預測自己），
#    看每一輪拿到的增幅強度和這場勝負的相關
strength_sum = defaultdict(lambda: [0, 0])
for who, slot, aug, win in rows:
    strength_sum[aug][0] += 1
    strength_sum[aug][1] += win
print("\n2. 每一輪拿到的增幅『強度』（它在其他場的勝率）和這場勝負的相關（點二系列相關）")
for s in (1, 2, 3, 4):
    xs, ys = [], []
    for who, slot, aug, win in rows:
        if slot != s:
            continue
        n, x = strength_sum[aug]
        if n - 1 < 20:
            continue
        xs.append((x - win) / (n - 1) - 0.5)
        ys.append(win)
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxy = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    sxx = sum((a - mx) ** 2 for a in xs)
    syy = sum((b - my) ** 2 for b in ys)
    r = sxy / math.sqrt(sxx * syy)
    z = r * math.sqrt(len(xs))
    print(f"   第 {s} 輪：r = {r:+.3f}（n = {len(xs)}，z ≈ {z:.1f}）")

# ── 3. 增幅本身的強弱有沒有訊號：整體勝率的離散程度 vs 純運氣該有的離散
picks = [(n, x) for n, x in strength_sum.values() if n >= 50]
obs = sum(n * (x / n - 0.5) ** 2 for n, x in picks) / len(picks)
print(f"\n3. 選過 50 次以上的增幅 {len(picks)} 個：勝率的加權離散 {obs:.3f}，純運氣的期望 ≈ 0.25；比值 {obs / 0.25:.2f}（>1 代表增幅之間真的有強弱）")
