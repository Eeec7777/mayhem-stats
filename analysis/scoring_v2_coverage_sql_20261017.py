"""v2 規格覆蓋率盤點（唯讀）：uv run python analysis/scoring_v2_coverage_sql_20261017.py mayhem.db"""
import sqlite3, sys
c = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
q = lambda s, *a: c.execute(s, a).fetchall()
p = lambda *a: print(*a)

p("raw catalog payloads", q("select endpoint,count(*) from raw_payloads where endpoint like '/lol-game-data/%' group by 1"))
p("queues", q("select queue_id,count(*),sum(is_remake) from matches group by 1"))
VALID = """select m.platform_id,m.game_id,m.game_duration from matches m where m.queue_id=2400 and m.is_remake=0 and m.game_duration>=360"""
p("2400 nonremake >=360:", q(f"select count(*) from ({VALID})"))
p("2400 nonremake <360:", q("select count(*) from matches where queue_id=2400 and is_remake=0 and game_duration<360"))
p("2400 remake:", q("select count(*) from matches where queue_id=2400 and is_remake=1"))
p("team sizes among valid:", q(f"""select n100,n200,count(*) from (select v.game_id,
   sum(mp.team_id=100) n100, sum(mp.team_id=200) n200 from ({VALID}) v join match_participants mp on mp.platform_id=v.platform_id and mp.game_id=v.game_id group by v.platform_id,v.game_id) group by 1,2"""))
p("dup participant ids:", q("select count(*) from (select platform_id,game_id,participant_id,count(*) n from match_participants group by 1,2,3 having n>1)"))
p("game_id collisions across platform:", q("select count(*) from (select game_id from matches group by game_id having count(distinct platform_id)>1)"))

PV = f"select mp.*, v.game_duration gd from ({VALID}) v join match_participants mp on mp.platform_id=v.platform_id and mp.game_id=v.game_id"
cols = ["dmg_to_champions", "dmg_taken", "dmg_mitigated", "time_ccing_others", "cc_duration", "total_damage", "dmg_to_objectives", "total_heal", "units_healed", "deaths"]
p("rows", q(f"select count(*) from ({PV})"))
for col in cols:
    p(col, q(f"select sum({col} is null), sum({col}=0), round(100.0*sum({col}=0)/count(*),2), min({col}), max({col}) from ({PV})"))
p("T partial (one null):", q(f"select sum((dmg_taken is null) <> (dmg_mitigated is null)) from ({PV})"))
p("W negative:", q(f"select sum(total_damage - dmg_to_champions - dmg_to_objectives < 0), min(total_damage - dmg_to_champions - dmg_to_objectives), sum(total_damage - dmg_to_champions - dmg_to_objectives = 0) from ({PV})"))
p("W neg games:", q(f"select count(distinct game_id) from ({PV}) where total_damage - dmg_to_champions - dmg_to_objectives < 0"))
p("obj zero by win:", q(f"select win, count(*), sum(dmg_to_objectives=0), round(avg(dmg_to_objectives*60.0/gd)) from ({PV}) group by win"))
p("games where whole-match C=0 (time_ccing_others):", q(f"select count(*) from (select game_id,sum(time_ccing_others) s from ({PV}) group by platform_id,game_id) where s=0"))
p("games where whole-match O=0:", q(f"select count(*) from (select game_id,sum(dmg_to_objectives) s from ({PV}) group by platform_id,game_id) where s=0"))
p("cc corr data (cc_duration vs time_ccing):", q(f"select sum(cc_duration>0 and time_ccing_others=0), sum(cc_duration=0 and time_ccing_others>0) from ({PV})"))

# eog coverage
E = f"""select v.platform_id, v.game_id, count(e.puuid) n_e, sum(e.heal_on_teammates is not null and e.shield_on_teammates is not null) n_ok,
          sum(coalesce(e.heal_on_teammates,0)+coalesce(e.shield_on_teammates,0)>0) n_pos
        from ({VALID}) v join match_participants mp on mp.platform_id=v.platform_id and mp.game_id=v.game_id
        left join eog_player_stats e on e.game_id=mp.game_id and e.puuid=mp.puuid group by 1,2"""
p("eog per-game n_ok distribution:", q(f"select n_ok,count(*) from ({E}) group by 1 order by 1"))
p("eog games any / full10 / pos persons:", q(f"select sum(n_e>0), sum(n_ok=10), sum(n_pos) from ({E})"))
p("eog full10 games with zero H all:", q(f"select count(*) from ({E}) where n_ok=10 and n_pos=0"))
p("eog full10 games with exactly one H provider / per team one:", q(f"select n_pos,count(*) from ({E}) where n_ok=10 group by 1"))
p("eog rows puuid unmatched:", q("select count(*) from eog_player_stats e where not exists (select 1 from match_participants mp where mp.game_id=e.game_id and mp.puuid=e.puuid)"))
p("eog first/last date:", q("select min(m.local_date),max(m.local_date) from eog_player_stats e join matches m on m.game_id=e.game_id"))
p("valid games since first eog date:", q(f"select count(*) from ({VALID}) v join matches m using(platform_id,game_id) where m.local_date >= (select min(m2.local_date) from eog_player_stats e join matches m2 on m2.game_id=e.game_id)"))

# per-team H providers among full games
p("per-team H provider count (full10):", q(f"""select npos,count(*) from (select mp.game_id, mp.team_id, sum(e.heal_on_teammates+e.shield_on_teammates>0) npos
  from ({E}) g join match_participants mp on mp.platform_id=g.platform_id and mp.game_id=g.game_id
  join eog_player_stats e on e.game_id=mp.game_id and e.puuid=mp.puuid where g.n_ok=10 group by 1,2) group by 1"""))

# items
IT = f"""select pi.*, di.price_total price, di.name from ({VALID}) v join participant_items pi on pi.platform_id=v.platform_id and pi.game_id=v.game_id
         left join dim_items di on di.id=pi.item_id where pi.slot<6 and pi.item_id>0"""
p("item rows slot0-5 nonzero / unmatched dim:", q(f"select count(*), sum(name is null), sum(price is null or price=0) from ({IT})"))
p("slot distribution:", q(f"select slot,count(*) from ({VALID}) v join participant_items pi on pi.platform_id=v.platform_id and pi.game_id=v.game_id group by 1"))
CL = """select di.id, di.price_total price,
  max(c.category in ('Damage','CriticalStrike','AttackSpeed','ArmorPenetration','LifeSteal','OnHit','SpellDamage','MagicPenetration','SpellVamp')) is_d,
  max(c.category in ('Health','Armor','SpellBlock','MagicResist')) is_t,
  di.id in (6617,4005,2530,3504,6621,3107,6616,3222,6620,2065,2526) is_h,
  max(c.category='Boots') is_boots, max(c.category in ('Consumable','Trinket')) is_cons
  from dim_items di left join dim_item_categories c on c.item_id=di.id group by di.id"""
p("participants: item classification", q(f"""select
   count(*),
   sum(npts>0), sum(npts=0 and nitems>0), sum(nitems=0),
   sum(nold>0)
  from (select mp.platform_id,mp.game_id,mp.participant_id,
     count(i.item_id) nitems,
     sum(case when (cl.is_d or cl.is_t or cl.is_h) and coalesce(cl.price,0)>0 and not cl.is_cons then 1 else 0 end) npts,
     sum(case when cl.price>=1500 and not cl.is_boots and (cl.is_d or cl.is_t or cl.is_h) then 1 else 0 end) nold
   from ({PV}) mp left join participant_items i on i.platform_id=mp.platform_id and i.game_id=mp.game_id and i.participant_id=mp.participant_id and i.slot<6 and i.item_id>0
   left join ({CL}) cl on cl.id=i.item_id group by 1,2,3)"""))
p("item rows by class (slot0-5):", q(f"""select cl.is_d,cl.is_t,cl.is_h,cl.is_boots,cl.is_cons,count(*), sum(cl.price<1500) from ({IT}) it left join ({CL}) cl on cl.id=it.item_id group by 1,2,3,4,5 order by 6 desc"""))
p("unclassified item names (top):", q(f"""select it.name, it.price, count(*) from ({IT}) it join ({CL}) cl on cl.id=it.item_id where not (cl.is_d or cl.is_t or cl.is_h) group by 1,2 order by 3 desc limit 25"""))
p("small defensive items (<1500, tank) rows:", q(f"""select count(*), count(distinct platform_id||game_id||':'||participant_id) from ({IT}) it join ({CL}) cl on cl.id=it.item_id where cl.is_t and cl.price<1500 and not cl.is_boots"""))
p("defensive boots rows:", q(f"""select it.name, count(*) from ({IT}) it join ({CL}) cl on cl.id=it.item_id where cl.is_boots and cl.is_t group by 1"""))

# anti-heal / anti-shield candidates by name
for kw in ["致死", "遺忘", "荊棘", "黑魔", "刺藤", "死刑", "鏈鋸", "巨蛇", "莫雷", "淵", "魔切", "破曉"]:
    pass
p("item names with 重創 candidates:", q("select id,name,price_total from dim_items where name like '%致死%' or name like '%遺忘%' or name like '%荊棘%' or name like '%黑魔%' or name like '%刺藤%' or name like '%死刑%' or name like '%鏈鋸%' or name like '%巨蛇%' or name like '%莫雷%' or name like '%熾炎%'"))

# augments
A = f"""select pa.*, da.name, da.rarity from ({VALID}) v join participant_augments pa on pa.platform_id=v.platform_id and pa.game_id=v.game_id left join dim_augments da on da.id=pa.augment_id"""
p("augment rows / null-name / zero id:", q(f"select count(*), sum(name is null), sum(augment_id=0) from ({A})"))
p("augment slots per person:", q(f"""select n,count(*) from (select mp.participant_id, count(pa.augment_id) n from ({PV}) mp left join participant_augments pa on pa.platform_id=mp.platform_id and pa.game_id=mp.game_id and pa.participant_id=mp.participant_id and pa.augment_id>0 group by mp.platform_id,mp.game_id,mp.participant_id) group by 1"""))
p("distinct augments used:", q(f"select count(distinct augment_id) from ({A}) where augment_id>0"), "dim_augments total", q("select count(*) from dim_augments"))
p("augment rarity:", q(f"select rarity,count(*) from ({A}) group by 1"))
