import json
import sqlite3
import unittest

import db


def game(game_id, teams):
    return {"platformId": "TW2", "gameId": game_id, "queueId": 2400, "gameCreation": 1_700_000_000_000,
            "gameDuration": 900, "participants": [], "participantIdentities": [], "teams": teams}


BLUE = {"teamId": 100, "firstBlood": True, "firstTower": False, "firstInhibitor": True,
        "towerKills": 4, "inhibitorKills": 1}
RED = {"teamId": 200, "firstBlood": False, "firstTower": True, "firstInhibitor": False,
       "towerKills": 2, "inhibitorKills": 0}


class MatchTeamsTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(db.SCHEMA)
        self.addCleanup(self.conn.close)

    def rows(self):
        return [tuple(r) for r in self.conn.execute(
            "SELECT game_id, team_id, first_blood, first_tower, first_inhibitor, tower_kills, inhibitor_kills"
            " FROM match_teams ORDER BY game_id, team_id")]

    def test_store_match_splits_teams(self):
        self.assertTrue(db.store_match(self.conn, game(1, [BLUE, RED])))
        self.assertEqual(self.rows(), [(1, 100, 1, 0, 1, 4, 1), (1, 200, 0, 1, 0, 2, 0)])

    def test_missing_fields_count_as_zero(self):
        # 和原本語意層的 json_extract(...) = 1、COALESCE(..., 0) 一致：只有真的 true 才算
        db.store_match(self.conn, game(2, [{"teamId": 100, "firstBlood": "1"}]))
        self.assertEqual(self.rows(), [(2, 100, 0, 0, 0, 0, 0)])

    def test_backfill_fills_old_matches_only(self):
        db.store_match(self.conn, game(3, [BLUE]))
        # 模擬升級前就入庫、還沒有 match_teams 的舊場次
        self.conn.execute(
            "INSERT INTO matches (platform_id, game_id, queue_id, game_creation, game_duration, raw_json, ingested_at)"
            " VALUES ('TW2', 4, 2400, 0, 900, ?, 0)", (json.dumps(game(4, [BLUE, RED])),))
        self.assertEqual(db._backfill_match_teams(self.conn), 1)
        self.assertEqual([r[:2] for r in self.rows()], [(3, 100), (4, 100), (4, 200)])
        self.assertEqual(db._backfill_match_teams(self.conn), 0)


if __name__ == "__main__":
    unittest.main()
