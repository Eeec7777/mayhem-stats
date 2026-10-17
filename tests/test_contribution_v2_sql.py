"""本場貢獻 v2 的 SQL：用小型合成資料釘住規格第 13 節的幾條性質——只和同場比、死亡不扣分、多做不會變少、
裝備比例連續、缺值不當 0、不完整的對局不計分。整套分數和獨立 Python 實作的逐筆比對見 analysis/scoring_v2_check.py。"""
import sqlite3
import tempfile
import unittest
from pathlib import Path

import yaml

import db

YML = Path(__file__).parent.parent / "cube" / "model" / "cubes" / "contribution_v2.yml"
SQL = yaml.safe_load(YML.read_text(encoding="utf-8"))["cubes"][0]["meta"]["materialize"]["sql"]

# 兩件輸出裝、一件坦裝、一件小坦裝、一件輔助裝（6617 在 11 件清單裡）、一件消耗品
ITEMS = {1: (3000, ["Damage"]), 2: (3000, ["SpellDamage"]), 3: (3000, ["Health", "Armor"]), 4: (800, ["Health"]),
         6617: (2300, ["SpellDamage", "ManaRegen"]), 9: (150, ["Consumable", "HealthRegen"])}


class Fixture:
    def __init__(self, path):
        db.init(path)
        self.conn = db.connect(path)
        for iid, (price, cats) in ITEMS.items():
            self.conn.execute("INSERT INTO dim_items (id, name, price_total) VALUES (?, ?, ?)", (iid, f"item{iid}", price))
            for cat in cats:
                self.conn.execute("INSERT INTO dim_item_categories VALUES (?, ?)", (iid, cat))
        self.rows = {}

    def game(self, game_id, *, players=10, minutes=15, queue=2400, over=None, items=None, eog=None):
        """over：{序號: {欄位: 值}} 改某人的數字；items：{序號: [裝備]}，沒給的人是兩件輸出裝；eog：{序號: (治療, 護盾)}。"""
        over, items, eog = over or {}, items or {}, eog or {}
        c = self.conn
        c.execute(
            """INSERT INTO matches (platform_id,game_id,queue_id,game_mode,game_version,map_id,game_creation,
                 game_duration,ended_surrender,raw_json,ingested_at) VALUES ('TW2',?,?,'KIWI','16.20',12,1000,?,0,'{}',1)""",
            (game_id, queue, minutes * 60),
        )
        for i in range(1, players + 1):
            v = dict(dmg_to_champions=20000 + i * 1000, dmg_taken=25000 + i * 500, dmg_mitigated=10000, time_ccing_others=20 + i,
                     total_damage=90000 + i * 2000, dmg_to_objectives=1000 * (i % 3), deaths=5, total_heal=3000, units_healed=1)
            v.update(over.get(i, {}))
            cur = c.execute(
                f"""INSERT INTO match_participants (platform_id, game_id, participant_id, puuid, team_id, win, champion_id,
                      kills, assists, {", ".join(v)}) VALUES ('TW2', ?, ?, ?, ?, ?, 1, 3, 5, {", ".join("?" * len(v))})""",
                (game_id, i, f"p{game_id}-{i}", 100 if i <= 5 else 200, 1 if i <= 5 else 0, *v.values()),
            )
            self.rows[(game_id, i)] = cur.lastrowid
            for slot, iid in enumerate(items.get(i, [1, 2])):
                c.execute("INSERT INTO participant_items VALUES ('TW2', ?, ?, ?, ?)", (game_id, i, slot, iid))
            if i in eog:
                c.execute("INSERT INTO eog_player_stats (game_id, puuid, team_id, champion_id, heal_on_teammates, shield_on_teammates) VALUES (?,?,?,1,?,?)",
                          (game_id, f"p{game_id}-{i}", 100 if i <= 5 else 200, *eog[i]))
        c.commit()

    def result(self):
        self.conn.row_factory = sqlite3.Row
        return {r["participant_rowid"]: dict(r) for r in self.conn.execute(SQL)}


class V2Tests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(Path(self._tmp.name) / "t.db")
        self.addCleanup(self.fx.conn.close)

    def at(self, res, g, i):
        return res[self.fx.rows[(g, i)]]

    def test_other_games_do_not_change_a_scored_game(self):
        self.fx.game(1)
        before = self.at(self.fx.result(), 1, 3)["work_score_v2"]
        self.fx.game(2, over={i: {"dmg_to_champions": 90000} for i in range(1, 11)})
        self.assertEqual(self.at(self.fx.result(), 1, 3)["work_score_v2"], before)

    def test_deaths_do_not_change_the_score(self):
        self.fx.game(1)
        self.fx.game(2, over={3: {"deaths": 15}})
        res = self.fx.result()
        self.assertAlmostEqual(self.at(res, 1, 3)["work_score_v2"], self.at(res, 2, 3)["work_score_v2"], places=6)

    def test_more_own_work_never_lowers_own_score(self):
        self.fx.game(1)
        base = self.at(self.fx.result(), 1, 3)["work_score_v2"]
        for g, field, value in ((2, "dmg_to_champions", 60000), (3, "dmg_taken", 90000), (4, "time_ccing_others", 120), (5, "dmg_to_objectives", 8000)):
            self.fx.game(g, over={3: {field: value}})
            self.assertGreaterEqual(self.at(self.fx.result(), g, 3)["work_score_v2"], base, field)

    def test_small_defensive_items_shift_weights_continuously(self):
        # 兩件輸出裝 → 再加一件 800 的小坦裝：承傷權重從 0 變成一點點，不是整套換公式
        self.fx.game(1)
        self.fx.game(2, items={3: [1, 2, 4]})
        res = self.fx.result()
        a, b = self.at(res, 1, 3), self.at(res, 2, 3)
        self.assertEqual(a["r_t"], 0)
        self.assertAlmostEqual(b["r_t"], 800 / 6800)
        self.assertAlmostEqual(b["w_t"], 0.8 * 800 / 6800)
        self.assertAlmostEqual(b["w_d"], 0.8 * 6000 / 6800)

    def test_consumables_and_support_items(self):
        self.fx.game(1, items={1: [9], 2: [6617, 3]})
        res = self.fx.result()
        self.assertEqual(self.at(res, 1, 1)["role_unknown"], 1)  # 只有消耗品：職責未知，各 1/3
        self.assertAlmostEqual(self.at(res, 1, 1)["r_d"], 1 / 3)
        sup = self.at(res, 1, 2)
        self.assertAlmostEqual(sup["r_h"], 2300 / 5300)  # 輔助裝整件算保人，不因為有 AP 類別被分去輸出
        self.assertAlmostEqual(sup["r_t"], 3000 / 5300)

    def test_heal_source_eog_needs_all_ten_players(self):
        self.fx.game(1, eog={i: (100 * i, 50) for i in range(1, 11)})
        self.fx.game(2, eog={i: (100 * i, 50) for i in range(1, 10)}, over={2: {"units_healed": 4}})
        res = self.fx.result()
        full = self.at(res, 1, 4)
        self.assertEqual((full["heal_src"], full["score_status"]), ("eog", "complete"))
        self.assertAlmostEqual(full["x_h"], 450 / 15)
        # 少一個人：整場退回舊算法（units_healed ≥ 2 才有量，其他人是 0），標暫估；缺的人不能當 0 混進 eog
        part = self.at(res, 2, 2)
        self.assertEqual((part["heal_src"], part["score_status"]), ("flag", "estimate"))
        self.assertAlmostEqual(part["x_h"], 3000 / 15)
        self.assertEqual(self.at(res, 2, 4)["x_h"], 0)

    def test_unscored_games_keep_a_row_with_a_reason(self):
        self.fx.game(1, minutes=5)
        self.fx.game(2, players=9)
        self.fx.game(3, queue=450)
        res = self.fx.result()
        reasons = {g: self.at(res, g, 1)["unscored_reason"] for g in (1, 2, 3)}
        self.assertEqual(reasons, {1: "remake_or_short_game", 2: "incomplete_5v5", 3: "other_queue"})
        self.assertTrue(all(self.at(res, g, 1)["work_score_v2"] is None for g in (1, 2, 3)))

    def test_bonuses_are_bounded(self):
        self.fx.game(1, over={1: {"dmg_to_objectives": 100000, "total_damage": 1000000}})
        r = self.at(self.fx.result(), 1, 1)
        self.assertLessEqual(r["wave_bonus"], 2)
        self.assertLessEqual(r["objective_bonus"], 4)
        self.assertLessEqual(r["cross_role_bonus"], 10)
        self.assertEqual(r["score_version"], "v2.0")


if __name__ == "__main__":
    unittest.main()
