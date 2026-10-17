"""v2 規格的唯讀原型回放（不是正式實作）：只用裝備職責、無增幅、能力表全 unknown、U 不算。
用法：uv run --with numpy --with pandas python analysis/scoring_v2_proto_20261017.py mayhem.db [epsilon]。只輸出聚合數字，不印玩家名稱或 puuid。"""
import sqlite3, sys, collections
import numpy as np, pandas as pd

c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
EPS = float(sys.argv[2]) if len(sys.argv) > 2 else 0.05
SUP = (6617, 4005, 2530, 3504, 6621, 3107, 6616, 3222, 6620, 2065, 2526)
DCAT = ('Damage','CriticalStrike','AttackSpeed','ArmorPenetration','LifeSteal','OnHit','SpellDamage','MagicPenetration','SpellVamp')
TCAT = ('Health','Armor','SpellBlock','MagicResist')

P = pd.read_sql(f"""
  select mp.rowid rid, mp.platform_id, mp.game_id, mp.participant_id, mp.team_id, mp.win, mp.deaths, m.game_duration gd,
    mp.dmg_to_champions D, mp.dmg_taken + mp.dmg_mitigated T, mp.time_ccing_others C,
    mp.total_damage - mp.dmg_to_champions - mp.dmg_to_objectives W, mp.dmg_to_objectives O,
    e.heal_on_teammates + e.shield_on_teammates H, b.build_role, mc.perf, mc.score
  from matches m join match_participants mp using(platform_id, game_id)
  left join eog_player_stats e on e.game_id = mp.game_id and e.puuid = mp.puuid
  join mat_builds b on b.participant_rowid = mp.rowid
  left join mat_contribution mc on mc.participant_rowid = mp.rowid
  where m.queue_id = 2400 and m.is_remake = 0 and m.game_duration >= 360""", c)
for k in "DTCWOH":
    P[k] = P[k] * 60.0 / P.gd

cats = collections.defaultdict(set)
for iid, cat in c.execute("select item_id, category from dim_item_categories"):
    cats[iid].add(cat)
price = dict(c.execute("select id, price_total from dim_items"))
pts = collections.defaultdict(lambda: np.zeros(3))
for pl, g, pid, iid in c.execute("select platform_id, game_id, participant_id, item_id from participant_items where slot < 6 and item_id > 0"):
    cs = cats.get(iid, set())
    if 'Consumable' in cs or 'Trinket' in cs: continue
    if iid in SUP:
        v = np.array([0, 0, 1.0])
    else:
        boots = 'Boots' in cs
        d = (not boots) and bool(cs & set(DCAT)); t = bool(cs & set(TCAT))
        if not (d or t): continue
        v = np.array([d, t, 0], float); v /= v.sum()
    pts[(pl, g, pid)] += v * (price.get(iid) or 0)
R = np.array([pts.get((r.platform_id, r.game_id, r.participant_id), np.zeros(3)) for r in P.itertuples()])
unknown = R.sum(1) == 0
R[unknown] = 1 / 3
R = R / R.sum(1, keepdims=True)
P[["rD", "rT", "rH"]] = R
P["role_unknown"] = unknown

TPL = np.array([[.8, 0, .2, 0], [0, .8, .2, 0], [0, .2, .3, .5]])  # rows: D,T,H templates; cols: D,T,C,H
W = R @ TPL
H_ok = P.groupby(["platform_id", "game_id"]).H.transform(lambda s: s.notna().all()).values
avail = np.column_stack([np.ones(len(P)), np.ones(len(P)), np.ones(len(P)), H_ok])
P["coverage"] = (W * avail).sum(1)
Wn = W * avail / (W * avail).sum(1, keepdims=True)
X = P[list("DTCH")].fillna(0).values

Pk = np.zeros_like(X)
key = P.platform_id + ":" + P.game_id.astype(str)
for _, idx in P.groupby(key).indices.items():
    a = EPS + Wn[idx]
    Xs, As = X[idx].sum(0), a.sum(0)
    E = Xs * a / As
    with np.errstate(divide="ignore", invalid="ignore"):
        pk = np.where(Xs > 0, 100 * X[idx] / (X[idx] + E), 0)
    Pk[idx] = pk
Pk[~avail.astype(bool)] = np.nan
B = 80 * np.nansum(Wn * Pk / 100, 1)
g = np.clip((Pk - 50) / 50, 0, None)
q = (1 - Wn) * avail
Xb = 10 * np.nansum(q * g, 1) / np.where(q.sum(1) > 0, q.sum(1), np.nan)
G = np.zeros(len(P))
for _, idx in P.groupby(key).indices.items():
    for col, cap in (("W", 2), ("O", 4)):
        x = P[col].values[idx]; Rk = x.sum() / 10
        G[idx] += cap * (np.where(Rk > 0, x / (x + Rk), 0))
P["B"], P["X"], P["G"] = B, Xb, G
P["S"] = np.clip(B + Xb + G, 0, 100)
for i, k in enumerate("DTCH"):
    P["P" + k] = Pk[:, i]; P["w" + k] = Wn[:, i]

pr = lambda *a: print(*a)
pr(f"epsilon={EPS} rows={len(P)} games={key.nunique()}")
pr("role_unknown:", int(unknown.sum()))
pr("r quantiles rD/rT/rH:", P[["rD", "rT", "rH"]].quantile([.1, .25, .5, .75, .9]).round(3).to_dict())
pr("share with 0<rT<1:", round(((P.rT > 0) & (P.rT < 1)).mean(), 3), " rT in [0.25,0.35]:", int(P.rT.between(.25, .35).sum()))
pr("S summary:", P.S.describe().round(1).to_dict())
pr("S quantiles:", P.S.quantile([.01, .1, .5, .9, .99]).round(1).to_dict(), " S>=90:", int((P.S >= 90).sum()))
pr("parts mean B/X/G:", round(P.B.mean(), 1), round(P.X.mean(), 2), round(P.G.mean(), 2), " X max", round(P.X.max(), 1), " X>=5:", int((P.X >= 5).sum()))
pr("by build_role mean S / B / X / perf:")
pr(P.groupby("build_role")[["S", "B", "X", "G", "perf"]].mean().round(1).assign(n=P.groupby("build_role").size()).to_string())
pr("corr S~win", round(np.corrcoef(P.S, P.win)[0, 1], 3), " perf~win", round(P[["perf", "win"]].dropna().corr().iloc[0, 1], 3),
   " S~perf", round(P[["S", "perf"]].dropna().corr().iloc[0, 1], 3), " S~score", round(P[["S", "score"]].dropna().corr().iloc[0, 1], 3))
pr("corr S~deaths", round(np.corrcoef(P.S, P.deaths)[0, 1], 3), " perf~deaths", round(P[["perf", "deaths"]].dropna().corr().iloc[0, 1], 3))
pr("mean S winners/losers:", P.groupby("win").S.mean().round(1).to_dict())
# off-role P: axes with planned weight <= 0.05
for i, k in enumerate("DTC"):
    low = Wn[:, i] <= 0.05
    pr(f"axis {k}: n low-weight={int(low.sum())} mean P(low-weight)={np.nanmean(Pk[low, i]):.1f}  mean P(weight>=0.4)={np.nanmean(Pk[Wn[:, i] >= .4, i]):.1f}")
# max attainable P for main-role (sole s)
# MVP agreement: per team top S vs top perf
P["team"] = key + ":" + P.team_id.astype(str)
topS = P.loc[P.groupby("team").S.idxmax(), "rid"]
topP = P.loc[P.groupby("team").perf.idxmax(), "rid"]
pr("teams:", P.team.nunique(), " MVP/ACE same as current perf:", round(np.isin(topS.values, topP.values).mean(), 3))
pr("top-S build_role share vs population share:")
pr((P.set_index("rid").loc[topS.values].build_role.value_counts(normalize=True) / P.build_role.value_counts(normalize=True)).round(2).to_dict())
# H: games with full eog
Hg = P[H_ok]
pr("H full games:", Hg.game_id.nunique(), " persons H>0:", int((Hg.H > 0).sum()))
nprov = Hg.groupby(key[H_ok]).H.apply(lambda s: (s > 0).sum())
pr("H providers per game:", nprov.value_counts().sort_index().to_dict())
sole = Hg[(Hg.H > 0) & (Hg.groupby(key[H_ok]).H.transform(lambda s: (s > 0).sum()) == 1)]
pr("sole-provider P_H (constant regardless of amount): ", sole.PH.round(1).describe().round(1).to_dict(), " H/min range", round(sole.H.min()), round(sole.H.max()))
pr("coverage<1 rows (H weight lost):", int((P.coverage < 0.999).sum()), " mean coverage among rH>0.3:", round(P.loc[P.rH > .3, "coverage"].mean(), 3))
pr("support-built (rH>0.3) in H-zero-games:", int(((P.rH > .3) & H_ok & (P.groupby(key).H.transform("sum") == 0)).sum()))
# O zero people G
pr("G for O=0 persons mean:", round(P.loc[P.O == 0, "G"].mean(), 2), " O>0:", round(P.loc[P.O > 0, "G"].mean(), 2))
# death invariance check: S does not depend on deaths by construction
# anti-heal holders
AH = (3033, 3075, 3076, 3123, 3165, 3916, 6609); AS = "(6695)"
hold = pd.read_sql(f"""select platform_id, game_id, participant_id, sum(item_id in {AH}) ah, sum(item_id in {AS}) ash
  from participant_items where slot < 6 group by 1, 2, 3""", c)
m = P.merge(hold, on=["platform_id", "game_id", "participant_id"], how="left").fillna({"ah": 0, "ash": 0})
pr("anti-heal holders:", int((m.ah > 0).sum()), " with 2+ items:", int((m.ah > 1).sum()), " anti-shield holders:", int((m.ash > 0).sum()))
th = m.groupby("team").ah.apply(lambda s: (s > 0).sum())
pr("anti-heal holders per team:", th.value_counts().sort_index().to_dict())
P.to_pickle(sys.argv[3]) if len(sys.argv) > 3 else None
pr("support-built (build_role 輔助) S by H availability:", P[P.build_role == "輔助"].groupby(H_ok[P.build_role == "輔助"]).S.agg(["mean", "count"]).round(1).to_dict())
pr("tank-built P_T mean / P_C mean:", round(P.loc[P.build_role == "坦克", "PT"].mean(), 1), round(P.loc[P.build_role == "坦克", "PC"].mean(), 1))
pr("max P bound check: max PD among rD=1:", round(P.loc[P.rD == 1, "PD"].max(), 1), " max PT among rT>=0.9:", round(P.loc[P.rT >= .9, "PT"].max(), 1))
