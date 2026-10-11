# 陣容原型的依據：把兩隊都算（約 1100 隊）看原型勝率，以及「一場裡只有一邊是這種原型」的對決實測（說明見 docs/lineup-winrate.md）
# 執行：uv run python -X utf8 -I analysis/lineup_archetypes.py（唯讀 mayhem.db）
import math, random, sqlite3
random.seed(2)
c = sqlite3.connect("file:mayhem.db?mode=ro", uri=True)
rows = c.execute("""SELECT p.platform_id,p.game_id,p.team_id,MAX(p.win),b.build_role FROM match_participants p JOIN matches m USING(platform_id,game_id)
  JOIN mat_builds b ON b.participant_rowid=p.rowid WHERE m.queue_id=2400 GROUP BY p.platform_id,p.game_id,p.team_id,p.participant_id""").fetchall()
teams = {}
for plat,gid,tid,win,role in rows:
    t = teams.setdefault((plat,gid,tid), {"w":win,"r":[]}); t["r"].append(role)
CARRY={"射手","AD 近戰","AP 輸出","AD 刺客","AP 刺客"}; FRONT={"坦克","AD 鬥士","AP 鬥士"}
def wil(x,n,z=1.96):
    p=x/n; d=1+z*z/n; ctr=(p+z*z/(2*n))/d; h=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d; return ctr-h,ctr+h
T=[t for t in teams.values() if len(t["r"])==5]
print("隊伍數",len(T))
def tab(name,key):
    d={}
    for t in T:
        k=key(t["r"]); n,x=d.get(k,(0,0)); d[k]=(n+1,x+t["w"])
    print(name)
    for k in sorted(d):
        n,x=d[k]; lo,hi=wil(x,n); print(f"  {k!s:12s} {x/n:6.1%} [{lo:5.1%},{hi:5.1%}] n={n}")
tab("輸出核心數（輸出＋刺客）",lambda r:min(5,sum(x in CARRY for x in r)))
tab("前排數（坦克＋鬥士）",lambda r:min(4,sum(x in FRONT for x in r)))
tab("坦克數",lambda r:min(3,sum(x=="坦克" for x in r)))
def arch(r):
    c=sum(x in CARRY for x in r); f=sum(x in FRONT for x in r)
    if f>=3 and c<=1: return "A 坦克多・輸出不足"
    if f>=3: return "B 前排重・輸出尚可"
    if c>=4: return "D 輸出多・前排少"
    return "C 均衡"
tab("原型",arch)

# 配對檢驗：一場裡只有一邊符合條件，看符合的那邊贏幾場（每場只算一次，兩隊不獨立的問題就不存在）
from math import comb
def binom_p(x,n):
    # 雙尾精確二項檢定 p0=0.5
    pm=[comb(n,k)/2**n for k in range(n+1)]
    return min(1.0,sum(p for p in pm if p<=pm[x]+1e-12))
matches={}
for (plat,gid,tid),t in teams.items():
    if len(t["r"])==5: matches.setdefault((plat,gid),[]).append(t)
def paired(name,pred):
    n=x=0
    for ts in matches.values():
        if len(ts)!=2: continue
        a,b=ts
        pa,pb=pred(a["r"]),pred(b["r"])
        if pa!=pb:
            n+=1; x+= (a["w"] if pa else b["w"])
    lo,hi=wil(x,n)
    print(f"{name}: 符合條件的那邊贏 {x}/{n} = {x/n:.1%} [{lo:.1%},{hi:.1%}]，二項檢定 p = {binom_p(x,n):.4f}")
fr=lambda r:sum(x in FRONT for x in r)
ca=lambda r:sum(x in CARRY for x in r)
print()
paired("前排≥3（坦克＋鬥士）",lambda r:fr(r)>=3)
paired("前排≥3 且 輸出核心≤2",lambda r:fr(r)>=3 and ca(r)<=2)
paired("坦克多・輸出不足（前排≥3 且 輸出核心≤1）",lambda r:fr(r)>=3 and ca(r)<=1)
paired("輸出核心≤2",lambda r:ca(r)<=2)
paired("輸出核心≥4",lambda r:ca(r)>=4)
paired("坦克≥2",lambda r:sum(x=="坦克" for x in r)>=2)
