import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import collector
import db


def timeline(frames=3):
    return {"frameInterval": 60000, "frames": [{"timestamp": i * 60000, "events": [], "participantFrames": {}} for i in range(frames)]}


def session(game_id=99, champs=(1, 2), bench=(), rerolls=1, phase="BAN_PICK"):
    return {
        "gameId": game_id,
        "localPlayerCellId": 0,
        "rerollsRemaining": rerolls,
        "timer": {"phase": phase, "adjustedTimeLeftInPhase": 12345},
        "myTeam": [{"cellId": i, "puuid": f"p{i}", "championId": c} for i, c in enumerate(champs)],
        "benchChampions": [{"championId": b} for b in bench],
        "trades": [],
    }


class DbCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = Path(self._tmp.name) / "test.db"
        db.init(self.path)
        self.conn = db.connect(self.path)
        self.addCleanup(self.conn.close)

    def add_match(self, game_id, ingested_at):
        self.conn.execute(
            "INSERT INTO matches (platform_id, game_id, queue_id, game_creation, game_duration, raw_json, ingested_at) VALUES ('TW2', ?, 2400, ?, 900, '{}', ?)",
            (game_id, game_id * 1000, ingested_at),
        )
        self.conn.commit()


class TimelineTests(DbCase):
    def test_stores_compressed_and_loads_back_once(self):
        tl = timeline()
        self.assertTrue(db.store_timeline(self.conn, "TW2", 1, tl))
        self.assertFalse(db.store_timeline(self.conn, "TW2", 1, tl))  # 同一場只存一份
        self.assertEqual(db.load_timeline(self.conn, "TW2", 1), tl)
        row = self.conn.execute("SELECT frames, length(raw_gz) FROM match_timelines").fetchone()
        self.assertEqual(row[0], 3)
        self.assertLess(row[1], len(json.dumps(tl)))

    def test_empty_or_frameless_payload_is_not_stored(self):
        self.assertFalse(db.store_timeline(self.conn, "TW2", 1, {}))
        self.assertFalse(db.store_timeline(self.conn, "TW2", 1, {"frames": []}))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM match_timelines").fetchone()[0], 0)

    def test_only_games_ingested_after_collection_started_are_retried(self):
        since = int(self.conn.execute("SELECT value FROM kv WHERE key = 'timeline_since'").fetchone()[0])
        self.add_match(1, since - 100)  # 開始收之前：不回補
        self.add_match(2, since + 10)
        self.add_match(3, since + 20)
        db.store_timeline(self.conn, "TW2", 3, timeline())
        self.assertEqual(db.games_missing_timeline(self.conn), [("TW2", 2)])

    def test_since_marker_is_not_moved_by_a_later_init(self):
        before = self.conn.execute("SELECT value FROM kv WHERE key = 'timeline_since'").fetchone()[0]
        time.sleep(1.1)
        db.init(self.path)
        after = self.conn.execute("SELECT value FROM kv WHERE key = 'timeline_since'").fetchone()[0]
        self.assertEqual(before, after)


class ChampSelectTests(DbCase):
    def snaps(self, game_id=99):
        row = self.conn.execute("SELECT snapshots FROM champ_select_sessions WHERE game_id = ?", (game_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def test_only_meaningful_changes_add_a_snapshot(self):
        self.assertTrue(db.store_champ_select(self.conn, session(), now=1))
        # 只有計時器在動：不新增
        s = session()
        s["timer"]["adjustedTimeLeftInPhase"] = 1
        self.assertFalse(db.store_champ_select(self.conn, s, now=2))
        # 從板凳換英雄、重抽次數變了：新增
        self.assertTrue(db.store_champ_select(self.conn, session(champs=(3, 2), bench=(1,), rerolls=0), now=3))
        snaps = self.snaps()
        self.assertEqual([x["t"] for x in snaps], [1, 3])
        self.assertEqual(snaps[0]["myTeam"][0]["champ"], 1)
        self.assertEqual(snaps[1]["myTeam"][0]["champ"], 3)
        self.assertEqual(snaps[1]["bench"], [1])
        self.assertEqual(snaps[1]["rerolls"], 0)
        row = self.conn.execute("SELECT started_at, updated_at FROM champ_select_sessions").fetchone()
        self.assertEqual(tuple(row), (1, 3))

    def test_session_without_game_id_is_skipped(self):
        self.assertFalse(db.store_champ_select(self.conn, session(game_id=0)))
        self.assertIsNone(self.snaps(0))


class FakeClient:
    def __init__(self, phase="Lobby", timeline_result=None, session_result=None):
        self.phase = phase
        self.timeline_result = timeline_result
        self.session_result = session_result
        self.eog_calls = 0
        self.timeline_calls = []

    def gameflow_phase(self):
        return self.phase

    def eog_stats_block(self):
        self.eog_calls += 1
        raise RuntimeError("404")

    def game_detail(self, game_id):
        return {"platformId": "TW2", "gameId": game_id, "queueId": 2400, "gameCreation": 1, "gameDuration": 900,
                "participants": [], "participantIdentities": [], "teams": []}

    def game_timeline(self, game_id):
        self.timeline_calls.append(game_id)
        if isinstance(self.timeline_result, Exception):
            raise self.timeline_result
        return self.timeline_result

    def champ_select_session(self):
        if isinstance(self.session_result, Exception):
            raise self.session_result
        return self.session_result


class CollectorTimelineTests(DbCase):
    def test_new_game_gets_its_timeline_and_a_failure_does_not_block_the_game(self):
        gatherer = collector.Collector()
        ok = FakeClient(timeline_result=timeline())
        seen, new = gatherer._ingest_games(self.conn, ok, [{"platformId": "TW2", "gameId": 7}])
        self.assertEqual((seen, new), (1, 1))
        self.assertEqual(ok.timeline_calls, [7])
        self.assertIsNotNone(db.load_timeline(self.conn, "TW2", 7))

        broken = FakeClient(timeline_result=RuntimeError("timeout"))
        seen, new = gatherer._ingest_games(self.conn, broken, [{"platformId": "TW2", "gameId": 8}])
        self.assertEqual(new, 1)  # 對局照樣存
        self.assertIsNone(db.load_timeline(self.conn, "TW2", 8))
        self.assertEqual(gatherer._timeline_failures[("TW2", 8)], 1)


class CollectorPhaseTests(unittest.IsolatedAsyncioTestCase):
    def make(self, phase):
        gatherer = collector.Collector()
        gatherer._was_connected = True
        gatherer.status["phase"] = phase
        gatherer._last_sweep = time.monotonic()
        gatherer.ingests = []

        async def record(trigger):
            gatherer.ingests.append(trigger)
            gatherer._last_sweep = time.monotonic()
            return 0

        gatherer._run_ingest = record
        return gatherer

    async def tick(self, gatherer, client):
        with mock.patch.object(collector.lcu.LCUClient, "connect", return_value=client):
            await gatherer._tick()

    def test_champ_select_polls_every_two_seconds(self):
        gatherer = self.make("ChampSelect")
        self.assertEqual(gatherer._poll_interval(), collector.CHAMP_SELECT_POLL_INTERVAL)

    def test_queue_and_lobby_poll_faster_so_champ_select_start_is_caught(self):
        for phase in ("Matchmaking", "ReadyCheck"):
            self.assertEqual(self.make(phase)._poll_interval(), collector.CHAMP_SELECT_POLL_INTERVAL)
        self.assertEqual(self.make("Lobby")._poll_interval(), collector.FAST_POLL_INTERVAL)
        self.assertEqual(self.make("None")._poll_interval(), collector.POLL_INTERVAL)

    async def test_champ_select_is_captured_and_errors_are_swallowed(self):
        gatherer = self.make("ChampSelect")
        with mock.patch.object(collector.db, "store_champ_select", return_value=True) as store, \
             mock.patch.object(collector.db, "connect"):
            await self.tick(gatherer, FakeClient("ChampSelect", session_result=session()))
            self.assertEqual(store.call_count, 1)
            await self.tick(gatherer, FakeClient("ChampSelect", session_result=RuntimeError("404")))
            self.assertEqual(store.call_count, 1)  # 抓不到就略過，不拋出
            await self.tick(gatherer, FakeClient("Lobby", session_result=session()))
            self.assertEqual(store.call_count, 1)  # 離開選角就不抓

    async def test_post_game_screen_keeps_being_polled_while_waiting_to_ingest(self):
        gatherer = self.make("InProgress")
        await self.tick(gatherer, FakeClient("InProgress"))
        clients = [FakeClient("EndOfGame") for _ in range(3)]
        for c in clients:  # 等待採集的 20 秒內，每輪都還在抓賽後統計，也還沒採集
            await self.tick(gatherer, c)
        self.assertEqual([c.eog_calls for c in clients], [1, 1, 1])
        self.assertEqual(gatherer.ingests, [])
        self.assertEqual(gatherer._poll_interval(), collector.FAST_POLL_INTERVAL)
        gatherer._ingest_due = time.monotonic() - 1  # 時間到
        await self.tick(gatherer, FakeClient("EndOfGame"))
        self.assertEqual(gatherer.ingests, ["realtime"])
        # 假的採集回傳 0 場新對局：排一分鐘後重試
        self.assertGreater(gatherer._ingest_due, time.monotonic() + collector.REALTIME_RETRY_DELAY - 5)

    async def test_realtime_ingest_retries_twice_when_history_is_not_ready(self):
        gatherer = self.make("Lobby")
        results = [0, 0, 0]

        async def record(trigger):
            gatherer.ingests.append(trigger)
            return results.pop(0)

        gatherer._run_ingest = record
        for _ in range(3):
            gatherer._ingest_due = time.monotonic() - 1
            await self.tick(gatherer, FakeClient("Lobby"))
        self.assertEqual(gatherer.ingests, ["realtime"] * 3)
        self.assertIsNone(gatherer._ingest_due)  # 第三次還是 0 就放棄，交給 5 分鐘的補掃
        self.assertEqual(gatherer._realtime_retries, 0)

    async def test_realtime_ingest_stops_retrying_once_the_game_is_in(self):
        gatherer = self.make("Lobby")

        async def record(trigger):
            gatherer.ingests.append(trigger)
            return 1

        gatherer._run_ingest = record
        gatherer._ingest_due = time.monotonic() - 1
        await self.tick(gatherer, FakeClient("Lobby"))
        self.assertIsNone(gatherer._ingest_due)


if __name__ == "__main__":
    unittest.main()
