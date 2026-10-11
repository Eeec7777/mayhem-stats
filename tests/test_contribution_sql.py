"""貢獻分數 SQL：用小型合成資料釘住最容易悄悄壞掉的規則——治療護盾軸「哪一種場次走哪一種算法」，
以及當局表現分（perf）和隊內排名（score）的差別。

整套分數和獨立 Python 實作的逐筆比對是在真實資料上做的（見 docs/contribution-scoring.md 的驗證）。"""
import sqlite3
import statistics
import tempfile
import unittest
from pathlib import Path

import yaml

import db

YML = Path(__file__).parent.parent / "cube" / "model" / "cubes" / "contribution.yml"
SQL = yaml.safe_load(YML.read_text(encoding="utf-8"))["cubes"][0]["meta"]["materialize"]["sql"]


class Fixture:
    """幾場對局、每場十個人，全部是法師（同一個比較池）。"""

    def __init__(self, path):
        db.init(path)
        self.conn = db.connect(path)
        self.conn.execute("CREATE TABLE mat_builds (participant_rowid INTEGER PRIMARY KEY, build_role TEXT)")
        self.rows = {}  # (game_id, 序號) -> participant_rowid

    def game(self, game_id, units_healed=None, eog=None, minutes=15, dmg_mult=1.0):
        """units_healed：{序號: 值}；eog：{序號: (治療隊友, 護盾隊友)}，沒給的人這場沒有賽後統計；
        dmg_mult：這場所有人的傷害同乘一個倍數（隊伍傷害跟著變，所以份額不變）。"""
        units_healed, eog = units_healed or {}, eog or {}
        c = self.conn
        c.execute(
            """INSERT INTO matches
               (platform_id,game_id,queue_id,game_mode,game_version,map_id,game_creation,
                game_duration,ended_surrender,local_date,local_weekday,local_hour,raw_json,ingested_at)
               VALUES ('TW2',?,2400,'KIWI','16.19',12,1000,?,0,NULL,NULL,NULL,'{}',1)""",
            (game_id, minutes * 60),
        )
        dmg = {i: (10000 + i * 500) * dmg_mult for i in range(1, 11)}
        team_dmg = {100: sum(dmg[i] for i in range(1, 6)), 200: sum(dmg[i] for i in range(6, 11))}
        for i in range(1, 11):
            cur = c.execute(
                """INSERT INTO match_participants (platform_id, game_id, participant_id, puuid, team_id, win, champion_id,
                     kills, deaths, assists, dmg_to_champions, dmg_taken, dmg_mitigated, total_heal, time_ccing_others,
                     cc_duration, team_kills, team_dmg, units_healed)
                   VALUES ('TW2',?,?,?,?,?,1, 5+?, 3+?, 8, ?, 20000, 10000, 5000, 20+?, 100+?, 40, ?, ?)""",
                (game_id, i, f"p{game_id}-{i}", 100 if i <= 5 else 200, 1 if i <= 5 else 0, i, i % 4, dmg[i], i, i,
                 team_dmg[100 if i <= 5 else 200], units_healed.get(i, 1)),
            )
            self.rows[(game_id, i)] = cur.lastrowid
            c.execute("INSERT INTO mat_builds VALUES (?, '法師')", (cur.lastrowid,))
            if i in eog:
                c.execute(
                    "INSERT INTO eog_player_stats (game_id, puuid, team_id, champion_id, heal_on_teammates, shield_on_teammates) VALUES (?,?,?,1,?,?)",
                    (game_id, f"p{game_id}-{i}", 100 if i <= 5 else 200, eog[i][0], eog[i][1]),
                )
        c.commit()

    def result(self):
        cols = ["rid", "p_heal", "heal_src", "score", "perf", "pa_dmg", "pa_surv", "pa_kp", "pa_cc", "pa_soak", "pa_minion", "pa_obj"]
        out = {}
        for row in self.conn.execute(f"SELECT participant_rowid, p_heal, heal_src, score, perf, pa_dmg, pa_surv, pa_kp, pa_cc, pa_soak, pa_minion, pa_obj FROM ({SQL})"):
            out[row[0]] = dict(zip(cols, row))
        return out


class HealShieldTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(Path(self._tmp.name) / "t.db")
        self.addCleanup(self.fx.conn.close)

    def at(self, res, game_id, i):
        return res[self.fx.rows[(game_id, i)]]

    def test_providers_use_the_new_measure_once_the_pool_is_big_enough(self):
        # 三場、三十人都有賽後統計；前 22 人有治療或護盾隊友（量各不相同），其餘是 0
        for g in (1, 2, 3):
            self.fx.game(g, eog={i: ((g * 10 + i) * 100, 0) if (g - 1) * 10 + i <= 22 else (0, 0) for i in range(1, 11)})
        res = self.fx.result()
        providers = [r for g in (1, 2, 3) for i in range(1, 11) for r in [self.at(res, g, i)] if r["heal_src"] == "eog"]
        self.assertEqual(len(providers), 22)
        self.assertTrue(all(r["p_heal"] is not None for r in providers))
        # 排名在 0～100 之間，量越大排名越前面
        best = max(providers, key=lambda r: r["p_heal"])
        self.assertAlmostEqual(best["p_heal"], 100.0)
        # 有賽後統計但量是 0 的人：這個軸不適用，不扣分
        zero = [self.at(res, 3, i) for i in (3, 4, 5, 6, 7, 8, 9, 10)]
        self.assertTrue(all(r["heal_src"] is None and r["p_heal"] is None for r in zero))

    def test_zero_ally_support_is_not_applicable_even_if_the_old_flag_says_healer(self):
        for g in (1, 2, 3):
            self.fx.game(g, eog={i: (1000 + g * 10 + i, 0) for i in range(1, 11)})
        # 第四場：有賽後統計、量是 0，但舊旗標（units_healed ≥ 2）會說他治療過
        self.fx.game(4, units_healed={2: 5}, eog={i: (0, 0) for i in range(1, 11)})
        res = self.fx.result()
        r = self.at(res, 4, 2)
        self.assertIsNone(r["heal_src"])
        self.assertIsNone(r["p_heal"])

    def test_small_pool_falls_back_to_the_old_flag(self):
        # 只有 5 個人有量：池子不到 20 人，退回舊算法（units_healed ≥ 2 的才有軸）
        self.fx.game(1, units_healed={1: 3, 2: 3}, eog={1: (900, 0), 2: (800, 0), 3: (700, 0), 4: (600, 0), 5: (500, 0)})
        res = self.fx.result()
        self.assertEqual(self.at(res, 1, 1)["heal_src"], "flag")
        self.assertEqual(self.at(res, 1, 2)["heal_src"], "flag")
        self.assertIsNone(self.at(res, 1, 3)["heal_src"])  # 有量但不是旗標：池子太小，不排名也不退回

    def test_games_without_eog_stats_use_the_old_flag(self):
        self.fx.game(1, units_healed={1: 4, 2: 1})
        res = self.fx.result()
        self.assertEqual(self.at(res, 1, 1)["heal_src"], "flag")
        self.assertIsNone(self.at(res, 1, 2)["heal_src"])

    def test_incidental_support_barely_moves_the_score(self):
        """附帶一點護盾的人（量遠小於自己的傷害）權重很小：分數不會因為這個軸被拉低。"""
        for g in (1, 2, 3):
            self.fx.game(g, eog={i: ((g * 10 + i) * 100, 0) if (g - 1) * 10 + i <= 22 else (0, 0) for i in range(1, 11)})
        # 第四場：第 1 人只有一點點護盾（排名在池子最後面，但量只佔自己傷害的幾 %）
        self.fx.game(4, eog={1: (0, 120), **{i: (0, 0) for i in range(2, 11)}})
        with_axis = self.at(self.fx.result(), 4, 1)
        self.assertEqual(with_axis["heal_src"], "eog")
        self.assertLess(with_axis["p_heal"], 5)  # 排名很後面
        # 同一個人拿掉賽後統計（不適用這個軸）時的分數
        self.fx.conn.execute("DELETE FROM eog_player_stats WHERE game_id = 4")
        self.fx.conn.commit()
        without = self.at(self.fx.result(), 4, 1)
        self.assertIsNone(without["heal_src"])
        self.assertLess(abs(with_axis["score"] - without["score"]), 6)

    def test_short_games_are_not_scored(self):
        self.fx.game(1, minutes=5)
        self.assertEqual(self.fx.result(), {})


class PerformanceScoreTests(unittest.TestCase):
    """當局表現分（perf）：每分鐘的實際數值，和同時長帶的人比，不再重新排名。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.fx = Fixture(Path(self._tmp.name) / "t.db")
        self.addCleanup(self.fx.conn.close)

    def game_rows(self, res, game_id):
        return [res[self.fx.rows[(game_id, i)]] for i in range(1, 11)]

    def test_a_team_that_all_plays_well_can_all_score_above_50_while_the_rank_stays_around_50(self):
        for g in (1, 2, 3):
            self.fx.game(g)
        self.fx.game(4, dmg_mult=3.0)  # 這場十個人的每分鐘傷害都是別場的三倍，份額不變
        res = self.fx.result()
        strong = self.game_rows(res, 4)
        self.assertGreater(sum(r["perf"] for r in strong) / 10, 65)
        self.assertTrue(all(r["perf"] > 50 for r in strong))
        # 隊內排名看份額，份額和別場一樣，所以平均還是 50 附近：它分不出這場整體打得特別好
        self.assertLess(abs(sum(r["score"] for r in strong) / 10 - 50), 10)

    def test_players_are_only_compared_with_the_same_game_length_band(self):
        # 短局（10 分鐘）與長局（25 分鐘）各三場；長局的每分鐘傷害是短局的兩倍。
        # 不分時長帶的話，所有長局的人都會排在短局的人前面
        for g in (1, 2, 3):
            self.fx.game(g, minutes=10, dmg_mult=1 + g / 10)
        for g in (4, 5, 6):
            self.fx.game(g, minutes=25, dmg_mult=5 * (1 + g / 100))
        res = self.fx.result()
        short = [r["pa_dmg"] for g in (1, 2, 3) for r in self.game_rows(res, g)]
        long_ = [r["pa_dmg"] for g in (4, 5, 6) for r in self.game_rows(res, g)]
        self.assertAlmostEqual(max(short), 100.0)
        self.assertAlmostEqual(max(long_), 100.0)
        self.assertAlmostEqual(min(short), 0.0)
        self.assertAlmostEqual(min(long_), 0.0)

    def test_perf_calibrates_weighted_axes_within_the_comparison_pool(self):
        for g in (1, 2, 3):
            self.fx.game(g)
        res = self.fx.result()
        # 現行法師權重為輸出 45、清兵 15、推塔 20、控場 15（2026-10-11 起沒有存活、參團）；加權後依比較池校準到平均 50、標準差 20。
        # 全部合成玩家都屬同一比較池，使用獨立 Python 計算核對。
        raw = {}
        for rid, r in res.items():
            present = [(weight, r[key]) for weight, key in
                       ((45, "pa_dmg"), (0, "pa_soak"), (15, "pa_minion"), (20, "pa_obj"), (15, "pa_cc")) if r[key] is not None]
            raw[rid] = round(sum(weight * value for weight, value in present) / sum(weight for weight, _ in present), 9)
        mean = statistics.mean(raw.values())
        spread = statistics.pstdev(raw.values())
        for r in self.game_rows(res, 1):
            expected = min(100, max(0, 50 + 20 * (raw[r["rid"]] - mean) / spread))
            self.assertAlmostEqual(r["perf"], expected, places=6)
        # 加權平均不會被拉成 0～100 平均分布：最高分遠低於 100
        self.assertLess(max(r["perf"] for g in (1, 2, 3) for r in self.game_rows(res, g)), 95)


if __name__ == "__main__":
    unittest.main()
