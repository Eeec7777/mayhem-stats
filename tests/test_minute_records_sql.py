"""單場紀錄（participants 的 best_* 指標）：用小型合成資料釘住兩件最容易悄悄壞掉的事。

1. 每個 best_* 的算式和同名的平均指標（dpm、gpm…）必須一字不差。
   紀錄榜的數字和每分鐘平均是同一條定義，中間多一份副本就會出現
   「卡片上 1,234、清單裡 1,187」這種沒有人發現的差異。
2. MAX 出來的值和獨立用 Python 算的一樣，包含兩個邊界：
   對局時間 0（NULLIF 之後整列不算，不是除以零）、沒有建築傷害的列（小兵傷害的 COALESCE）。

真實資料上的比對要連 Cube 一起跑（見 verify-change skill），這裡只負責算式本身。
"""
import sqlite3
import tempfile
import unittest
from pathlib import Path

import yaml

import db

YML = Path(__file__).parent.parent / "cube" / "model" / "cubes" / "participants.yml"
MEASURES = {m["name"]: m for m in yaml.safe_load(YML.read_text(encoding="utf-8"))["cubes"][0]["measures"]}

# best_* -> 同一條算式的平均指標。擊殺、死亡、助攻的每分鐘平均沒有對應的指標
# （死亡只有每 10 分鐘版本），所以不在這張表裡，改由下面的數值測試顧。
TWINS = {
    "max_dpm": "dpm",
    "max_gpm": "gpm",
    "best_cs_per_min": "cs_per_min",
    "best_taken_per_min": "taken_per_min",
    "best_mitigated_per_min": "mitigated_per_min",
    "best_heal_per_min": "heal_per_min",
    "best_cc_time_per_min": "cc_time_per_min",
    "best_objective_damage_per_min": "objective_damage_per_min",
    "best_minion_damage_per_min": "minion_damage_per_min",
}

# 合成資料：三場不同長度的對局，兩個人。最後一列是對局時間 0 的壞資料。
# 欄位先用 Python 寫出來，期望值直接從這裡算，不經過 yml 裡的那段 SQL。
ROWS = [
    # (game_id, participant_id, puuid, duration, kills, deaths, assists, gold, dmg, taken,
    #  mitigated, heal, cc, cs, objective, total_damage)
    (1, 1, "me", 600, 10, 2, 5, 6000, 12000, 9000, 4000, 3000, 30, 40, 2000, 30000),
    (1, 2, "pal", 600, 2, 8, 12, 4800, 6000, 18000, 12000, 9000, 90, 10, 500, 20000),
    (2, 1, "me", 1200, 15, 6, 9, 15000, 30000, 24000, 9000, 6000, 60, 120, None, 70000),
    (2, 2, "pal", 1200, 9, 3, 20, 13200, 21000, 30000, 18000, 24000, 240, 60, 9000, 48000),
    (3, 1, "me", 0, 99, 99, 99, 99999, 99999, 99999, 99999, 99999, 999, 999, 99999, 999999),
]
COLUMNS = (
    "game_id participant_id puuid game_duration kills deaths assists gold_earned dmg_to_champions "
    "dmg_taken dmg_mitigated total_heal time_ccing_others cs dmg_to_objectives total_damage"
).split()

# 每個指標的分子：從上面那張表算，和 yml 無關
NUMERATOR = {
    "best_kills_per_min": lambda r: r["kills"],
    "max_deaths_per_min": lambda r: r["deaths"],
    "best_assists_per_min": lambda r: r["assists"],
    "max_dpm": lambda r: r["dmg_to_champions"],
    "best_taken_per_min": lambda r: r["dmg_taken"],
    "best_mitigated_per_min": lambda r: r["dmg_mitigated"],
    "best_heal_per_min": lambda r: r["total_heal"],
    "best_cc_time_per_min": lambda r: r["time_ccing_others"],
    "max_gpm": lambda r: r["gold_earned"],
    "best_cs_per_min": lambda r: r["cs"],
    "best_objective_damage_per_min": lambda r: r["dmg_to_objectives"],
    "best_minion_damage_per_min": lambda r: r["total_damage"] - r["dmg_to_champions"] - (r["dmg_to_objectives"] or 0),
}


def expected(name, puuid=None):
    """獨立算一次：每場的「分子 × 60 ÷ 秒數」取最大。時間 0 的那一場不算（不是當成 0，而是整列不算）。"""
    values = [
        NUMERATOR[name](r) * 60.0 / r["game_duration"]
        for r in (dict(zip(COLUMNS, row)) for row in ROWS)
        if r["game_duration"] and NUMERATOR[name](r) is not None
        if puuid is None or r["puuid"] == puuid
    ]
    return max(values) if values else None


class MinuteRecordTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        path = Path(cls.dir.name) / "t.db"
        db.init(path)
        cls.conn = db.connect(path)
        for row in ROWS:
            r = dict(zip(COLUMNS, row))
            cls.conn.execute(
                f"""INSERT INTO match_participants
                    (platform_id, team_id, win, champion_id, {', '.join(COLUMNS)})
                    VALUES ('TW2', 100, 1, 1, {', '.join('?' * len(COLUMNS))})""",
                [r[c] for c in COLUMNS],
            )
        cls.conn.commit()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        cls.dir.cleanup()

    def measured(self, name, puuid=None):
        """把 yml 裡那一條 sql 原樣拿來跑 MAX，和 Cube 產生的 SQL 同形。"""
        sql = MEASURES[name]["sql"].replace("{CUBE}", "match_participants")
        where = " WHERE puuid = ?" if puuid else ""
        return self.conn.execute(
            f"SELECT MAX({sql}) FROM match_participants{where}", ([puuid] if puuid else [])
        ).fetchone()[0]

    def test_every_best_measure_is_a_max(self):
        for name in NUMERATOR:
            with self.subTest(name):
                self.assertEqual(MEASURES[name]["type"], "max")

    def test_formula_matches_the_average_twin(self):
        """紀錄和每分鐘平均共用同一條算式，不准各寫一份。"""
        for best, avg in TWINS.items():
            with self.subTest(best):
                self.assertEqual(MEASURES[best]["sql"].strip(), MEASURES[avg]["sql"].strip())

    def test_max_matches_an_independent_calculation(self):
        for name in NUMERATOR:
            with self.subTest(name):
                self.assertAlmostEqual(self.measured(name), expected(name), places=9)

    def test_max_per_player_matches(self):
        """紀錄榜是依玩家分組查的，分組之後也要對。"""
        for name in NUMERATOR:
            for puuid in ("me", "pal"):
                with self.subTest(name=name, puuid=puuid):
                    self.assertAlmostEqual(self.measured(name, puuid), expected(name, puuid), places=9)

    def test_zero_duration_row_is_dropped_not_divided(self):
        """對局時間 0 的那一列：NULLIF 讓它變成 NULL，MAX 會略過，而不是炸掉或變成最大值。"""
        row = self.conn.execute(
            "SELECT {} FROM match_participants WHERE game_duration = 0".format(
                MEASURES["best_kills_per_min"]["sql"].replace("{CUBE}", "match_participants")
            )
        ).fetchone()[0]
        self.assertIsNone(row)
        self.assertLess(self.measured("best_kills_per_min"), 2)  # 99/0 不會混進來

    def test_minion_damage_treats_missing_objective_damage_as_zero(self):
        """沒有建築傷害的那一場（NULL）要當成 0，不是整列變成 NULL。"""
        value = self.conn.execute(
            "SELECT {} FROM match_participants WHERE game_id = 2 AND participant_id = 1".format(
                MEASURES["best_minion_damage_per_min"]["sql"].replace("{CUBE}", "match_participants")
            )
        ).fetchone()[0]
        self.assertAlmostEqual(value, (70000 - 30000 - 0) * 60.0 / 1200)


if __name__ == "__main__":
    unittest.main()
