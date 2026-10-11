import asyncio
import json
import sqlite3
import threading
import time
import unittest
import zlib
from unittest import mock

import collector
import db
import lcu
import raw_data


class OpenConnection:
    """採集器可以 close，而測試的記憶體資料庫保持開啟。"""
    def __init__(self, conn):
        self.conn = conn

    def __getattr__(self, key):
        return getattr(self.conn, key)

    def __enter__(self):
        return self.conn.__enter__()

    def __exit__(self, *args):
        return self.conn.__exit__(*args)

    def close(self):
        pass


class RawArchiveTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(db.SCHEMA)
        self.addCleanup(self.conn.close)

    def payloads(self, endpoint=None):
        rows = self.conn.execute("SELECT id FROM raw_payloads WHERE (? IS NULL OR endpoint=?) ORDER BY id",
                                 (endpoint, endpoint)).fetchall()
        return [raw_data.load(self.conn, row[0]) for row in rows]

    def test_roundtrip_unknown_fields_dedup_and_request_context(self):
        payload = {"newField": [None, 0, False, 1.25, "原文", {"unparsed": "<stats>5</stats>"}]}
        self.assertTrue(raw_data.save(self.conn, "lcu", "/test", payload, now=10))
        self.assertFalse(raw_data.save(self.conn, "lcu", "/test", payload, now=20))
        self.assertEqual(self.payloads(), [payload])
        row = self.conn.execute("SELECT first_seen,last_seen FROM raw_payloads").fetchone()
        self.assertEqual(tuple(row), (10, 20))
        raw_data.save(self.conn, "lcu", "/test", payload, params={"page": 2}, now=30)
        self.assertEqual(len(self.payloads()), 2)

    def test_recovery_preserves_existing_raw_and_is_idempotent(self):
        match = {"gameId": 1, "future": {"x": [1, 2]}}
        eog = {"gameId": 1, "teams": [], "futureStat": 9}
        timeline = {"frames": [{"unknown": True}]}
        session = {"gameId": 1, "timer": {"unknown": 1}}
        self.conn.execute(
            """INSERT INTO matches (platform_id,game_id,queue_id,game_creation,game_duration,raw_json,ingested_at)
               VALUES ('TW2',1,2400,1,1,?,10)""", (json.dumps(match),))
        self.conn.execute("INSERT INTO eog_snapshots VALUES (1,11,'[]',?)", (json.dumps(eog),))
        self.conn.execute("INSERT INTO match_timelines VALUES ('TW2',1,12,1,?)",
                          (zlib.compress(json.dumps(timeline).encode()),))
        self.conn.execute("INSERT INTO champ_select_sessions VALUES (1,13,14,'[]',?)", (json.dumps(session),))
        self.conn.commit()
        raw_data.recover_existing(self.conn)
        raw_data.recover_existing(self.conn)
        self.assertEqual(self.payloads(), [match, eog, timeline, session])
        self.assertEqual({r[0] for r in self.conn.execute("SELECT origin FROM raw_payloads")}, {"recovered"})
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM capture_health").fetchone()[0], 0)

    def test_eog_same_keys_new_values_and_poorer_versions_are_all_kept(self):
        def eog(heal):
            return {"gameId": 2, "teams": [{"players": [{"puuid": "fixture-player", "stats": {
                "totalHealsOnTeammates": heal, "totalDamageShieldedOnTeammates": 3, "future": 7}}]}]}
        first, latest = eog(0), eog(25)
        self.assertTrue(db.store_eog_snapshot(self.conn, first)[0])
        collector.features.rebuild(self.conn)
        self.assertFalse(collector.features.stale(self.conn))
        self.assertTrue(db.store_eog_snapshot(self.conn, latest)[0])
        self.assertTrue(collector.features.stale(self.conn))  # 相同玩家列數、不同數值仍刷新計分
        poor = {"gameId": 2, "teams": []}
        self.assertFalse(db.store_eog_snapshot(self.conn, poor)[0])
        self.assertEqual(self.payloads(), [first, latest, poor])
        self.assertEqual(self.conn.execute("SELECT heal_on_teammates FROM eog_player_stats").fetchone()[0], 25)
        self.assertEqual(json.loads(self.conn.execute("SELECT raw_json FROM eog_snapshots").fetchone()[0]), latest)
        # null 表示尚未算好，不能當成 0。
        self.assertEqual(db.eog_players(eog(None)), [])

    def test_early_champ_select_and_non_compact_changes_are_kept(self):
        first = {"gameId": 0, "future": "early"}
        self.assertFalse(db.store_champ_select(self.conn, first, now=1))
        full = {"gameId": 3, "future": {"newStat": 1}}
        db.store_champ_select(self.conn, full, now=2)
        changed = {"gameId": 3, "future": {"newStat": 2}}
        self.assertFalse(db.store_champ_select(self.conn, changed, now=3))  # 精簡資料沒變
        self.assertEqual(self.payloads(), [first, full, changed])

    def test_incomplete_timeline_and_all_versions_are_kept(self):
        short = {"frames": [{"timestamp": 0}]}
        full = {"frames": [{"timestamp": 0}, {"timestamp": 60000}], "future": 5}
        self.assertFalse(db.store_timeline(self.conn, "TW2", 1, {}))
        self.assertTrue(db.store_timeline(self.conn, "TW2", 1, short))
        self.assertTrue(db.store_timeline(self.conn, "TW2", 1, full))
        self.assertFalse(db.store_timeline(self.conn, "TW2", 1, short))
        self.assertEqual(db.load_timeline(self.conn, "TW2", 1), full)
        self.assertEqual(self.payloads(), [{}, short, full])

    def test_failed_timeline_does_not_starve_old_games_or_stop_after_three_attempts(self):
        for game in (1, 2):
            self.conn.execute(
                """INSERT INTO matches (platform_id,game_id,queue_id,game_creation,game_duration,raw_json,ingested_at)
                   VALUES ('TW2',?,2400,?,900,'{}',1)""", (game, game * 1000))
        self.conn.commit()
        broken = mock.Mock()
        broken.game_timeline.side_effect = RuntimeError("not ready")
        gatherer = collector.Collector()
        with mock.patch.object(collector.time, "time", return_value=1000):
            for _ in range(3):
                self.assertFalse(gatherer._fetch_timeline(self.conn, broken, "TW2", 2))
        self.assertEqual(db.games_missing_timeline(self.conn, now=1001), [("TW2", 1)])
        self.assertIn(("TW2", 2), db.games_missing_timeline(self.conn, now=5000))
        # 行程重啟後仍有退避紀錄，且仍能重試成功。
        ready = mock.Mock()
        ready.game_timeline.return_value = {"frames": [{"timestamp": 0}]}
        self.assertTrue(collector.Collector()._fetch_timeline(self.conn, ready, "TW2", 2))
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM timeline_fetch_attempts").fetchone()[0], 0)

    def test_lcu_archives_wrapper_before_reducing_match_list_and_never_archives_headers(self):
        response = mock.Mock()
        full = {"games": {"games": [{"gameId": 7}], "futurePagination": 88}, "unknown": [1, 2]}
        response.json.return_value = full
        client = lcu.LCUClient(1, "fixture-secret")
        collector.Collector()._attach_archive(client, self.conn)
        with mock.patch.object(lcu.requests, "get", return_value=response):
            self.assertEqual(client.recent_matches(), [{"gameId": 7}])
        self.assertEqual(self.payloads(), [full])
        row = dict(self.conn.execute("SELECT * FROM raw_payloads").fetchone())
        self.assertNotIn("fixture-secret", str(row))
        self.assertNotIn("Authorization", row)

    def test_recent_known_match_is_refetched_and_keeps_later_detail_fields(self):
        gatherer = collector.Collector()
        client = mock.Mock()
        created = int(time.time() * 1000)
        first = {"platformId": "TW2", "gameId": 7, "queueId": 2400, "gameCreation": created,
                 "gameDuration": 900, "participants": [], "participantIdentities": [], "teams": []}
        latest = {**first, "lateStat": {"futureValue": 88}}
        client.game_detail.side_effect = [first, latest]
        client.game_timeline.return_value = {"frames": [{"timestamp": 0}]}
        summaries = [{"platformId": "TW2", "gameId": 7, "gameCreation": created}]
        self.assertEqual(gatherer._ingest_games(self.conn, client, summaries), (1, 1))
        gatherer._refreshed_details.clear()  # 下一輪同步
        self.assertEqual(gatherer._ingest_games(self.conn, client, summaries), (1, 0))
        self.assertEqual(self.payloads("/lol-match-history/v1/games/7"), [first, latest])
        self.assertEqual(client.game_detail.call_count, 2)

    def test_catalog_same_content_is_preserved_for_each_client_version(self):
        client = lcu.LCUClient(1, "fixture-secret")
        gatherer = collector.Collector()
        gatherer._attach_archive(client, self.conn)
        response = mock.Mock()
        response.json.return_value = [{"id": 1, "newDescription": "完整原文"}]
        with mock.patch.object(lcu.requests, "get", return_value=response):
            for version in ("fixture-1", "fixture-2"):
                gatherer._client_versions[client.base] = version
                client.asset("items")
        contexts = {row[0] for row in self.conn.execute("SELECT context_key FROM raw_payloads")}
        self.assertEqual(contexts, {"client-version:fixture-1", "client-version:fixture-2"})
        self.assertEqual(len(self.payloads()), 2)

    def test_health_records_http_status_without_error_body_or_identifiers(self):
        response = mock.Mock(status_code=404)
        exc = lcu.requests.HTTPError("fixture-secret should not be stored", response=response)
        raw_data.failure(self.conn, "lcu", "/lol-match-history/v1/game-timelines/1234", exc, now=10)
        row = dict(self.conn.execute("SELECT * FROM capture_health").fetchone())
        self.assertEqual(row["http_status"], 404)
        self.assertEqual(row["endpoint"], "/lol-match-history/v1/game-timelines/{gameId}")
        self.assertNotIn("fixture-secret", str(row))
        self.assertEqual(raw_data.route("/lol-match-history/v1/products/lol/fixture-player/matches"),
                         "/lol-match-history/v1/products/lol/{player}/matches")

    def test_gameclient_eog_source_is_archived_independently(self):
        client = lcu.LCUClient(1, "fixture-secret")
        gatherer = collector.Collector()
        gatherer._attach_archive(client, self.conn, transient=True)
        eog = {"gameId": 7, "teams": []}
        extra = {"gameId": 7, "gameClientNewStat": {"value": 8}}
        def get(url, **kwargs):
            response = mock.Mock()
            response.json.return_value = (extra if "gameclient-eog" in url else
                                          {"gameData": {"gameId": 7}} if "gameflow" in url else eog)
            return response
        with mock.patch.object(lcu.requests, "get", side_effect=get), \
             mock.patch.object(db, "connect", return_value=OpenConnection(self.conn)):
            gatherer._sample_transient(client, "EndOfGame")
        self.assertEqual(self.payloads("/lol-end-of-game/v1/gameclient-eog-stats-block"), [extra])

    def test_event_stream_preserves_envelope_updates_and_deletions_but_filters_other_data(self):
        gatherer = collector.Collector()
        body = {"gameId": 17, "teams": [], "newStat": {"future": 3}}
        event = {"uri": "/lol-end-of-game/v1/eog-stats-block", "eventType": "Update", "data": body,
                 "futureEnvelopeField": 9}
        deleted = {"uri": event["uri"], "eventType": "Delete", "data": None}
        with mock.patch.object(db, "connect", return_value=OpenConnection(self.conn)):
            self.assertTrue(gatherer._capture_event(event))
            self.assertTrue(gatherer._capture_event(deleted))
            self.assertFalse(gatherer._capture_event({"uri": "/unrelated", "data": {"private": 1}}))
        ids = self.conn.execute("SELECT id FROM raw_payloads WHERE source='lcu-event' ORDER BY id").fetchall()
        self.assertEqual([raw_data.load(self.conn, row[0]) for row in ids], [event, deleted])
        self.assertEqual(json.loads(self.conn.execute("SELECT raw_json FROM eog_snapshots").fetchone()[0]), body)

    def test_full_live_data_is_saved_and_early_unknown_game_id_is_linked_later(self):
        gatherer = collector.Collector()
        first = {"gameData": {"gameTime": 0}, "events": {"futureEvent": [1]}, "activePlayer": {"unknown": 9}}
        with mock.patch.object(lcu, "live_game_raw", return_value=first), \
             mock.patch.object(db, "connect", return_value=OpenConnection(self.conn)):
            gatherer._capture_live()
            gatherer._live_game_id = 10
            gatherer._live_platform = "TW2"
            gatherer._capture_live()
        self.assertEqual(self.payloads(), [first])
        self.assertEqual(self.conn.execute("SELECT game_id FROM raw_payloads").fetchone()[0], 10)


class IndependentSamplingTests(unittest.IsolatedAsyncioTestCase):
    async def test_event_listener_subscribes_only_to_match_sources_and_cleans_up_on_cancel(self):
        gatherer = collector.Collector()
        delivered = asyncio.Event()
        loop = asyncio.get_running_loop()
        received = []
        event = {"uri": "/lol-gameflow/v1/gameflow-phase", "eventType": "Update", "data": "EndOfGame"}

        class Socket:
            def __init__(self):
                self.sent = []

            async def send(self, message):
                self.sent.append(json.loads(message))

            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                pass

            async def messages(self):
                yield ""  # 本機 LCU 的初始空白 frame，不能誤判 JSON 錯誤後重連。
                yield json.dumps([8, "fixture-topic", event])
                await asyncio.Event().wait()

            def __aiter__(self):
                return self.messages()

        socket = Socket()
        client = lcu.LCUClient(1, "fixture-secret")
        def record(body):
            received.append(body)
            loop.call_soon_threadsafe(delivered.set)
        with mock.patch.object(lcu.LCUClient, "connect", return_value=client), \
             mock.patch.object(collector, "websocket_connect", return_value=socket), \
             mock.patch.object(gatherer, "_record_event_connection"), \
             mock.patch.object(gatherer, "_capture_event", side_effect=record):
            task = asyncio.create_task(gatherer._event_loop())
            try:
                await asyncio.wait_for(delivered.wait(), 2)
                self.assertEqual(received, [event])
                self.assertEqual({message[1] for message in socket.sent},
                                 {"OnJsonApiEvent" + path.replace("/", "_") for path in collector.EVENT_ENDPOINTS})
                self.assertTrue(gatherer.status["eventConnected"])
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(gatherer.status["eventConnected"])

    async def test_sampler_keeps_running_during_blocked_bulk_ingest_and_stops_with_collector(self):
        gatherer = collector.Collector()
        blocked = asyncio.Event()
        sampled_twice = asyncio.Event()
        loop = asyncio.get_running_loop()
        calls = 0
        guard = threading.Lock()

        async def tick():
            blocked.set()
            await asyncio.Event().wait()  # 大量同步尚未完成

        async def events():
            await asyncio.Event().wait()

        def sample():
            nonlocal calls
            with guard:
                calls += 1
                if calls >= 2:
                    loop.call_soon_threadsafe(sampled_twice.set)

        with mock.patch.object(gatherer, "_tick", side_effect=tick), \
             mock.patch.object(gatherer, "_sample_once", side_effect=sample), \
             mock.patch.object(gatherer, "_event_loop", side_effect=events), \
             mock.patch.object(gatherer, "_poll_interval", return_value=0.01):
            task = asyncio.create_task(gatherer.run_forever())
            try:
                await asyncio.wait_for(blocked.wait(), 2)
                await asyncio.wait_for(sampled_twice.wait(), 2)
                self.assertTrue(gatherer.status["running"])
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertFalse(gatherer._sampling)
        self.assertFalse(gatherer.status["running"])


if __name__ == "__main__":
    unittest.main()
