"""背景採集器。

雙層保險:
1. 即時層 — 每 30 秒看一次 gameflow 狀態,偵測到「剛打完」就立刻採集。
2. 補漏層 — 每 5 分鐘固定掃一次最新 100 場清單補缺,兜住工具沒開、
   當機、客戶端重啟等所有意外。

短暫資料另外獨立輪詢；只能保存 API 實際提供且採集器觀測到的內容。
"""

import asyncio
import json
import ssl
import time
import uuid

from websockets.asyncio.client import connect as websocket_connect

import db
import features
import lcu
import raw_data

POLL_INTERVAL = 30          # 秒
# 對局中與賽後階段密集輪詢（本機 GET，很便宜）。賽後畫面通常很快就被關掉，30 秒一次只抓得到一半
# （實測 22 場只存到 11 場賽後統計），而治療／護盾隊友的量只有賽後統計有，漏一場就少一筆資料。
FAST_POLL_INTERVAL = 5
# 選角：大亂鬥的選角只有一分多鐘，板凳換英雄、交換都很快，2 秒一次才記得到中間的變化
CHAMP_SELECT_POLL_INTERVAL = 2
# 打完後的即時採集沒抓到新對局時，隔多久再試、最多試幾次
REALTIME_RETRY_DELAY = 60
REALTIME_RETRIES = 2
# 每輪補抓時間軸，包含所有已存舊場次；失敗使用持久化退避，避免卡住其他場次。
TIMELINE_RETRY_PER_RUN = 10
SWEEP_EVERY = 300           # 秒：補漏掃描固定每 5 分鐘；輪詢間隔會變，所以用時間算、不再數輪數
POST_GAME_DELAY = 20        # 打完後等客戶端寫完戰績再抓
DETAIL_REFRESH_WINDOW = 3600  # 最近一小時的已知對局再讀明細／時間軸，保留稍後補齊的版本

IN_GAME_PHASES = {"GameStart", "InProgress", "Reconnect", "WaitingForStats", "PreEndOfGame"}
# 賽後畫面存在的階段：這時才抓得到 /lol-end-of-game/v1/eog-stats-block（見 _capture_eog）
EOG_PHASES = {"WaitingForStats", "PreEndOfGame", "EndOfGame"}
CHAMP_SELECT_PHASES = {"ChampSelect"}
# 進選角之前的階段：閒置時 30 秒才看一次，常常進選角二三十秒後才發現，前面選英雄、換板凳的過程就漏了
# （2026-10-10 第一場的第一筆快照已經在 FINALIZATION）。排隊配對與接受對戰時用選角的間隔，大廳用 5 秒。
QUEUE_PHASES = {"Matchmaking", "ReadyCheck"}
LOBBY_PHASES = {"Lobby"}
EVENT_ENDPOINTS = frozenset({
    "/lol-gameflow/v1/gameflow-phase", "/lol-gameflow/v1/session",
    "/lol-champ-select/v1/session", "/lol-end-of-game/v1/eog-stats-block",
    "/lol-end-of-game/v1/gameclient-eog-stats-block",
})


class Collector:
    def __init__(self):
        self.status = {
            "running": False,
            "clientConnected": False,
            "phase": None,
            "lastRun": None,
            "lastError": None,
            "dimensionsLoaded": False,
            "eventConnected": False,
        }
        self._saw_in_game = False
        self._skipped = set()   # 抓明細失敗的對局,只記錄不重試到天荒地老
        self._dimensions_loaded = False
        self._dimensions_client_base = None
        self._catalog_version = None
        self._client_versions = {}
        self._refreshed_details = set()
        self._was_connected = False
        self._last_sweep = 0.0  # 上一次採集（任何觸發）的 time.monotonic()，補漏掃描從這裡起算
        # 剛打完一場時，「什麼時候該採集」的時間點。原本是在 _tick 裡整整 sleep 20 秒，
        # 那 20 秒內不會再抓賽後統計，賽後畫面還沒算完的話就漏掉了；改成記下時間，每輪照常抓、時間到再採集
        self._ingest_due = None
        self._realtime_retries = 0  # 打完後的即時採集沒抓到新對局，已經重試幾次
        self._timeline_failures = {}  # 本次行程的失敗次數，持久化退避另存 DB
        self._ingest_lock = asyncio.Lock()
        self._sampling = False
        self._capture_phase = None
        self._capture_wakeup = asyncio.Event()
        self._capture_session = uuid.uuid4().hex
        self._live_game_id = None
        self._live_platform = ""
        self.on_change = None

    def _attach_archive(self, client, conn=None, transient=False):
        """只啟用採集器讀取的 JSON 存檔，不保存請求 headers／lockfile。"""
        def save(path, params, payload):
            target = conn if conn is not None else db.connect()
            try:
                version = self._client_versions.get(getattr(client, "base", None))
                catalog = path == "/help" or path.startswith("/lol-game-data/assets/")
                context = self._capture_session if transient else f"client-version:{version}" if catalog and version else ""
                raw_data.save(target, "lcu", path, payload, params=params,
                              context_key=context)
            finally:
                if conn is None:
                    target.close()

        def failed(path, exc):
            self._record_capture_failure("lcu", path, exc, conn)

        client.on_response = save
        client.on_error = failed

    def _record_capture_failure(self, source, endpoint, exc, conn=None):
        target = None
        record_error = None
        try:
            target = conn if conn is not None else db.connect()
            raw_data.failure(target, source, endpoint, exc)
        except Exception as failed_record:
            record_error = type(failed_record).__name__
        finally:
            if target is not None and conn is None:
                target.close()
        # 404 是階段切換／資料尚未準備好的正常現象，完整記在健康表但不當成警報。
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status != 404 or record_error:
            self.status["lastCaptureError"] = {
                "at": int(time.time()), "source": source,
                "endpoint": raw_data.route(endpoint), "type": type(exc).__name__, "httpStatus": status,
            }
            if record_error:
                self.status["lastCaptureError"]["healthRecordError"] = record_error

    # ---------------------------------------------------------------- ingest

    def _ingest(self, trigger):
        """同步採集一次。回傳 (掃到幾場, 新增幾場)。"""
        client = lcu.LCUClient.connect()
        conn = db.connect()
        self._attach_archive(client, conn)
        self._refreshed_details.clear()
        if getattr(client, "base", None) != self._dimensions_client_base:
            self._dimensions_loaded = False
        dimensions_changed = False
        features_changed = False
        matches_before = conn.execute("SELECT MAX(rowid) FROM matches").fetchone()[0]
        try:
            try:
                version = client.get("/lol-patch/v1/game-version")
                if isinstance(version, str) and version:
                    self._client_versions[getattr(client, "base", None)] = version
                    if version != self._catalog_version:
                        self._dimensions_loaded = False
            except (lcu.LCUUnavailable, lcu.requests.RequestException, ValueError):
                pass  # 版本來源暫時不可用時仍保存其他回應，下一輪再取得版本。
            if not self._dimensions_loaded:
                try:
                    for table, rows in lcu.fetch_dimensions(client).items():
                        db.replace_dimension(conn, table, rows)
                    self._archive_catalog(conn, client)
                    self._dimensions_loaded = True
                    self._dimensions_client_base = getattr(client, "base", None)
                    self._catalog_version = self._client_versions.get(getattr(client, "base", None))
                    self.status["dimensionsLoaded"] = True
                    dimensions_changed = True  # 出裝定位看裝備類別與英雄定位，要跟著重算
                except Exception as exc:
                    # 維度表抓不到不該擋住對局採集,下輪再試——但要留下痕跡,
                    # 不然英雄/增幅名稱一片空白時完全查不到原因。
                    self.status["lastError"] = f"維度表載入失敗: {type(exc).__name__}: {exc}"

            summoner = client.current_summoner()
            puuid = summoner.get("puuid")
            name = summoner.get("gameName") or summoner.get("displayName") or ""
            tag = summoner.get("tagLine") or ""
            if puuid:
                db.upsert_account(conn, puuid, f"{name}#{tag}" if tag else name)

            run_id = db.start_run(conn, trigger)
            seen = new = 0
            error = None
            try:
                seen, new = self._ingest_games(conn, client, client.recent_matches())

                # 追蹤中的好友。清單一樣只回傳該玩家一個人,而且別人的紀錄
                # 只給最新 20 場(自己是 100),所以更容易漏——但漏掉的部分
                # 若是和你同場的對局,你自己的掃描本來就會收到。
                for account in db.tracked_accounts(conn):
                    try:
                        friend_games = client.matches_by_puuid(account["puuid"])
                    except Exception:
                        continue  # 單一好友抓失敗不該中斷整輪採集
                    friend_seen, friend_new = self._ingest_games(conn, client, friend_games)
                    seen += friend_seen
                    new += friend_new

                # 缺少時間軸的場次持續補抓；退避中的失敗場次不會擋住更舊的資料。
                for platform_id, game_id in db.games_missing_timeline(conn, TIMELINE_RETRY_PER_RUN):
                    self._fetch_timeline(conn, client, platform_id, game_id)
            except Exception as exc:
                error = str(exc)
                raise
            finally:
                db.finish_run(conn, run_id, seen, new, error)
                # 不看 new：採集中途失敗時 new 還是 0，但前面幾場已經 commit 了。
                # 改問衍生表是不是落後於對局資料，漏掉的下一輪也會自己補上。
                if dimensions_changed or features.stale(conn):
                    features_changed = self._rebuild_features(conn)

            return seen, new
        finally:
            # 採集紀錄每輪都會寫入；只有分析資料真的變了才通知畫面。
            # 用場次前後數量也能涵蓋「採到一半失敗，但前幾場已提交」的情況。
            try:
                matches_changed = conn.execute("SELECT MAX(rowid) FROM matches").fetchone()[0] != matches_before
            except Exception:
                matches_changed = False
            conn.close()
            if (matches_changed or dimensions_changed or features_changed) and self.on_change:
                self.on_change()

    def _rebuild_features(self, conn):
        """衍生表（出裝定位、貢獻分數…）整批重算，見 features.py。
        失敗不擋採集：對局已經存好了，下一輪會再試。"""
        try:
            ms = features.rebuild(conn)
            print(f"衍生表重建 {ms:.0f} ms")
            return True
        except Exception as exc:
            self.status["lastError"] = f"衍生表重建失敗: {type(exc).__name__}: {exc}"
            print(self.status["lastError"])
            return False

    def _archive_catalog(self, conn, client):
        """保存 API 定義與完整英雄檔（技能等資料不在 champion-summary 中）。"""
        paths = ["/help"] + [
            f"/lol-game-data/assets/v1/champions/{row[0]}.json"
            for row in conn.execute("SELECT id FROM dim_champions ORDER BY id")
        ]
        for path in paths:
            try:
                client.get(path)
            except lcu.LCUUnavailable:
                raise
            except (lcu.requests.RequestException, ValueError):
                continue  # 單一資源缺少時仍保存其他檔案，錯誤由 callback 記錄。

    def _ingest_games(self, conn, client, games):
        """把一批對局收進資料庫,回傳 (掃到幾場, 新增幾場)。

        冪等性由三層保證,重複執行不會產生重複資料:
        1. 先查已有 game_id；最近一小時的已知對局仍讀取，以保存稍後補齊的原文
        2. 寫入用 INSERT OR IGNORE,主鍵是 (platform_id, game_id)
        3. 整場包在單一 transaction 裡

        因此同一場對局不論從你自己還是從好友的清單掃到,都只會存在一份。
        """
        seen = new = 0
        by_platform = {}
        for game in games:
            by_platform.setdefault(game.get("platformId") or "", []).append(game)

        for platform_id, platform_games in by_platform.items():
            known = db.existing_game_ids(conn, platform_id)
            seen += len(platform_games)
            for game in platform_games:
                game_id = game.get("gameId")
                was_known = game_id in known
                recent = (game.get("gameCreation") or 0) >= (time.time() - DETAIL_REFRESH_WINDOW) * 1000
                key = (platform_id, game_id)
                if was_known and (not recent or key in self._refreshed_details):
                    continue
                try:
                    # 清單只回傳一名玩家,要拿全部 10 人得打明細
                    detail = client.game_detail(game_id)
                    self._refreshed_details.add(key)
                    if db.store_match(conn, detail):
                        new += 1
                        known.add(game_id)
                        self._fetch_timeline(conn, client, platform_id, game_id)
                    elif was_known:
                        self._fetch_timeline(conn, client, platform_id, game_id)
                except lcu.LCUUnavailable:
                    raise  # 客戶端關掉了,整輪停下來,下次再說
                except Exception as exc:
                    # 單一場抓不到就跳過。這裡若讓例外往上拋,那場之後的對局
                    # 全部不會被處理,而且每輪都會在同一場再死一次——等於永久卡住。
                    self.status["lastError"] = f"對局 {game_id} 略過: {type(exc).__name__}: {exc}"
        return seen, new

    def _fetch_timeline(self, conn, client, platform_id, game_id):
        """抓時間軸。失敗記入 DB，5 分鐘到 24 小時退避後繼續試，不永久放棄。"""
        error = None
        try:
            timeline = client.game_timeline(game_id)
            db.store_timeline(conn, platform_id, game_id, timeline)
            if isinstance(timeline, dict) and timeline.get("frames"):
                with conn:
                    conn.execute("DELETE FROM timeline_fetch_attempts WHERE platform_id=? AND game_id=?",
                                 (platform_id or "", game_id))
                self._timeline_failures.pop((platform_id, game_id), None)
                return True
            # 回來的內容沒有 frames（客戶端還沒準備好）：當成失敗，下一輪再試
        except lcu.LCUUnavailable:
            raise
        except Exception as exc:
            error = exc
        key = (platform_id, game_id)
        self._timeline_failures[key] = self._timeline_failures.get(key, 0) + 1
        row = conn.execute("SELECT attempts FROM timeline_fetch_attempts WHERE platform_id=? AND game_id=?",
                           (platform_id or "", game_id)).fetchone()
        attempts = (row[0] if row else 0) + 1
        now = time.time()
        with conn:
            conn.execute(
                """INSERT OR REPLACE INTO timeline_fetch_attempts
                   (platform_id,game_id,attempts,last_attempt,retry_after,error_type,http_status)
                   VALUES (?,?,?,?,?,?,?)""",
                (platform_id or "", game_id, attempts, now,
                 now + min(86400, SWEEP_EVERY * 2 ** min(attempts - 1, 9)),
                 type(error).__name__ if error else "EmptyFrames",
                 getattr(getattr(error, "response", None), "status_code", None)),
            )
        return False

    def _capture_champ_select(self, client):
        """選角過程：選角階段每輪記一次（內容有變才新增快照）。抓不到（404、剛好切換階段）一律靜靜略過。"""
        try:
            session = client.champ_select_session()
            conn = db.connect()
            try:
                return db.store_champ_select(conn, session)
            finally:
                conn.close()
        except Exception as exc:
            if getattr(client, "on_response", None) and not isinstance(exc, lcu.requests.RequestException):
                self._record_capture_failure("lcu", "/lol-champ-select/v1/session", exc)
            return False

    def _capture_eog(self, client):
        """賽後統計擷取（實驗）：把賽後畫面那一份統計存下來，看裡面有沒有治療／護盾隊友的欄位。

        賽後畫面關掉就沒了，所以賽後階段每輪都試；抓不到（404、客戶端剛好忙）一律靜靜略過，
        絕不能影響對局採集。欄位名會印在 log 裡，打完一場看 autostart.log 就知道。"""
        try:
            block = client.eog_stats_block()
            conn = db.connect()
            try:
                stored, keys = db.store_eog_snapshot(conn, block)
            finally:
                conn.close()
        except Exception as exc:
            if getattr(client, "on_response", None) and not isinstance(exc, lcu.requests.RequestException):
                self._record_capture_failure("lcu", "/lol-end-of-game/v1/eog-stats-block", exc)
            return False
        if stored:
            print(f"賽後統計已存 gameId={block.get('gameId')}，stats 欄位 {len(keys)} 個")
        return stored

    # ------------------------------------------------------------------ loop

    def _sample_transient(self, client, phase):
        """與大量戰績採集分開執行，優先保存有效時間很短的完整原文。"""
        playing = {"GameStart", "InProgress", "Reconnect"}
        if ((phase in CHAMP_SELECT_PHASES and self._capture_phase not in CHAMP_SELECT_PHASES)
                or (phase in playing and self._capture_phase not in (playing | CHAMP_SELECT_PHASES))):
            self._capture_session = uuid.uuid4().hex
            self._live_game_id = None
            self._live_platform = ""
        if phase in EOG_PHASES:
            self._capture_eog(client)
            try:
                client.gameclient_eog_stats_block()  # 原文由 on_response 保存
            except (lcu.LCUUnavailable, lcu.requests.RequestException, ValueError):
                pass
        if phase in CHAMP_SELECT_PHASES:
            self._capture_champ_select(client)

        self._capture_phase = phase
        if phase not in (playing | CHAMP_SELECT_PHASES | EOG_PHASES):
            return
        try:
            session = client.gameflow_session()
            game = session.get("gameData") or {}
            if game.get("gameId"):
                self._live_game_id = game["gameId"]
                self._live_platform = game.get("platformId") or ""
        except (lcu.LCUUnavailable, lcu.requests.RequestException, ValueError):
            pass
        if phase in playing:
            self._capture_live()

    def _capture_live(self):
        try:
            payload = lcu.live_game_raw()
        except (lcu.requests.RequestException, ValueError) as exc:
            self._record_capture_failure("live-client", "/liveclientdata/allgamedata", exc)
            return False
        conn = db.connect()
        try:
            return raw_data.save(conn, "live-client", "/liveclientdata/allgamedata", payload,
                                 context_key=self._capture_session,
                                 platform_id=self._live_platform, game_id=self._live_game_id)
        finally:
            conn.close()

    def _sample_once(self):
        client = lcu.LCUClient.connect()
        self._attach_archive(client, transient=True)
        phase = client.gameflow_phase()
        self.status["phase"] = phase
        self._sample_transient(client, phase)

    async def _capture_loop(self):
        while True:
            self._capture_wakeup.clear()
            try:
                await asyncio.to_thread(self._sample_once)
            except lcu.LCUUnavailable:
                self._capture_phase = None  # 客戶端重啟後重新識別對局；連線失敗由 callback 記錄。
            except Exception as exc:
                self.status["lastCaptureError"] = {"at": int(time.time()), "type": type(exc).__name__}
            try:
                await asyncio.wait_for(self._capture_wakeup.wait(), timeout=self._poll_interval())
            except TimeoutError:
                pass

    def _capture_event(self, event):
        """只保存五個對局端點的完整事件，不訂閱聊天／登入等無關資料。"""
        if not isinstance(event, dict) or event.get("uri") not in EVENT_ENDPOINTS:
            return False
        endpoint = event["uri"]
        data = event.get("data")
        game_id = platform_id = None
        if isinstance(data, dict):
            game = data.get("gameData") or {}
            if not isinstance(game, dict):
                game = {}
            game_id = data.get("gameId") or game.get("gameId")
            platform_id = data.get("platformId") or game.get("platformId")
        conn = db.connect()
        try:
            stored = raw_data.save(conn, "lcu-event", endpoint, event,
                                   game_id=game_id, platform_id=platform_id or "")
            if event.get("eventType") != "Delete":
                if endpoint == "/lol-end-of-game/v1/eog-stats-block" and isinstance(data, dict):
                    db.store_eog_snapshot(conn, data)
                elif endpoint == "/lol-champ-select/v1/session" and isinstance(data, dict):
                    db.store_champ_select(conn, data)
                elif endpoint == "/lol-gameflow/v1/gameflow-phase" and isinstance(data, str):
                    self.status["phase"] = data
            return stored
        finally:
            conn.close()

    async def _event_loop(self):
        """LCU JSON 事件推送，和 GET 輪詢互補；斷線後重新讀 lockfile 及訂閱。"""
        while True:
            try:
                client = await asyncio.to_thread(lcu.LCUClient.connect)
                async with websocket_connect(
                    client.base.replace("https://", "wss://").replace("http://", "ws://") + "/",
                    additional_headers=client.headers, ssl=ssl._create_unverified_context(),
                    proxy=None, open_timeout=5, close_timeout=2, max_size=16 * 1024 * 1024,
                ) as socket:
                    for endpoint in sorted(EVENT_ENDPOINTS):
                        await socket.send(json.dumps([5, "OnJsonApiEvent" + endpoint.replace("/", "_")]))
                    self.status["eventConnected"] = True
                    await asyncio.to_thread(self._record_event_connection)
                    self._capture_wakeup.set()  # 訂閱前的既有狀態用 GET 補一次
                    async for message in socket:
                        # LCU 連線開啟時會送一個空白文字 frame；它不是 JSON 事件。
                        if not message or not message.strip():
                            continue
                        try:
                            packet = json.loads(message)
                        except (ValueError, TypeError) as exc:
                            await asyncio.to_thread(self._record_capture_failure, "lcu-event", "websocket", exc)
                            continue
                        if isinstance(packet, list) and len(packet) == 3 and packet[0] == 8:
                            event = packet[2]
                            await asyncio.to_thread(self._capture_event, event)
                            if isinstance(event, dict) and event.get("uri") == "/lol-gameflow/v1/gameflow-phase":
                                self._capture_wakeup.set()  # 不等閒置階段的 30 秒輪詢
            except lcu.LCUUnavailable:
                pass
            except Exception as exc:
                await asyncio.to_thread(self._record_capture_failure, "lcu-event", "websocket", exc)
            finally:
                self.status["eventConnected"] = False
            await asyncio.sleep(FAST_POLL_INTERVAL)

    def _record_event_connection(self):
        conn = db.connect()
        try:
            with conn:
                raw_data.success(conn, "lcu-event", "websocket")
        finally:
            conn.close()

    async def _run_ingest(self, trigger):
        async with self._ingest_lock:
            return await self._run_ingest_locked(trigger)

    async def _run_ingest_locked(self, trigger):
        self._last_sweep = time.monotonic()
        try:
            seen, new = await asyncio.to_thread(self._ingest, trigger)
            self.status["lastRun"] = {
                "at": int(time.time()), "trigger": trigger,
                "seen": seen, "new": new,
            }
            self.status["lastError"] = None
            return new
        except lcu.LCUUnavailable as exc:
            self.status["clientConnected"] = False
            self.status["lastError"] = str(exc)
        except Exception as exc:
            self.status["lastError"] = f"{type(exc).__name__}: {exc}"
        return 0

    async def run_forever(self):
        self.status["running"] = True
        self._sampling = True
        sampler = asyncio.create_task(self._capture_loop())
        listener = asyncio.create_task(self._event_loop())
        try:
            while True:
                try:
                    await self._tick()
                except Exception as exc:
                    self.status["lastError"] = f"{type(exc).__name__}: {exc}"
                await asyncio.sleep(self._poll_interval())
        finally:
            sampler.cancel()
            listener.cancel()
            await asyncio.gather(sampler, listener, return_exceptions=True)
            self._sampling = False
            self.status["running"] = False

    def _poll_interval(self):
        """選角與排隊 2 秒；大廳、對局中與賽後階段 5 秒（抓得到賽後統計）；其餘時間 30 秒。"""
        phase = self.status.get("phase")
        if phase in CHAMP_SELECT_PHASES | QUEUE_PHASES:
            return CHAMP_SELECT_POLL_INTERVAL
        busy = self._saw_in_game or self._ingest_due is not None or phase in (IN_GAME_PHASES | EOG_PHASES | LOBBY_PHASES)
        return FAST_POLL_INTERVAL if busy else POLL_INTERVAL

    async def _tick(self):
        try:
            client = await asyncio.to_thread(lcu.LCUClient.connect)
            phase = await asyncio.to_thread(client.gameflow_phase)
            self.status["clientConnected"] = True
            self.status["phase"] = phase
        except lcu.LCUUnavailable as exc:
            # 客戶端沒開是常態,不是錯誤,靜靜等下一輪。
            # 客戶端關著時完全沒有辦法同步:LCU API 是客戶端行程自己託管的,
            # 沒有行程就沒有服務,戰績也沒有落地的快取可以讀。
            self.status["clientConnected"] = False
            self.status["phase"] = None
            self.status["lastError"] = str(exc)
            self._was_connected = False
            self._dimensions_loaded = False
            self.status["dimensionsLoaded"] = False
            return

        # 賽後統計要在賽後畫面還在的時候抓，放在最前面，不要被下面的等待或補掃拖到畫面被關掉
        if not self._sampling and phase in EOG_PHASES:
            await asyncio.to_thread(self._capture_eog, client)
        if not self._sampling and phase in CHAMP_SELECT_PHASES:
            await asyncio.to_thread(self._capture_champ_select, client)

        # 客戶端剛開起來就立刻補掃,不要等到下一個五分鐘的整點。
        # 這段空窗期正是最可能漏資料的時候——尤其追蹤好友只有 20 場的視窗,
        # 比自己的 100 場容易被擠掉。
        if not self._was_connected:
            self._was_connected = True
            await self._run_ingest("reconnect")
            return

        if phase in IN_GAME_PHASES:
            self._saw_in_game = True
        elif self._saw_in_game:
            # 剛打完一場：等客戶端寫完戰績再採集。不在這裡 sleep——等待期間每輪照常抓賽後統計
            self._saw_in_game = False
            self._ingest_due = time.monotonic() + POST_GAME_DELAY

        if self._ingest_due is not None and time.monotonic() >= self._ingest_due:
            self._ingest_due = None
            new = await self._run_ingest("realtime")
            # 打完 20 秒時客戶端的戰績常常還沒寫好（2026-10-10 實測要等到 5 分鐘後的補掃才進來），
            # 沒抓到新對局就隔一分鐘再試，最多再試兩次
            if new == 0 and self._realtime_retries < REALTIME_RETRIES:
                self._realtime_retries += 1
                self._ingest_due = time.monotonic() + REALTIME_RETRY_DELAY
            else:
                self._realtime_retries = 0
            return

        if time.monotonic() - self._last_sweep >= SWEEP_EVERY:
            await self._run_ingest("sweep")

    # ---------------------------------------------------------------- status

    def snapshot(self):
        conn = db.connect()
        try:
            # 追蹤好友之後，資料庫會包含「你沒參與的對局」，所以自己的場次
            # 要跟資料庫總數分開報，否則畫面上的數字會讓人以為自己打了那麼多。
            mine = conn.execute(
                """SELECT COUNT(*) AS n FROM matches m
                   WHERE EXISTS (
                     SELECT 1 FROM match_participants mp
                     WHERE mp.platform_id = m.platform_id AND mp.game_id = m.game_id
                       AND mp.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1)
                   ) AND m.queue_id = ? AND m.is_remake = 0""",
                (lcu.MAYHEM_QUEUE_ID,),
            ).fetchone()["n"]
            # 重開局不算（和各頁統計一致）
            total = conn.execute("SELECT COUNT(*) AS n FROM matches WHERE is_remake = 0").fetchone()["n"]
            mayhem = conn.execute(
                "SELECT COUNT(*) AS n FROM matches WHERE queue_id = ? AND is_remake = 0",
                (lcu.MAYHEM_QUEUE_ID,),
            ).fetchone()["n"]
            oldest = conn.execute("SELECT MIN(game_creation) AS t FROM matches").fetchone()["t"]
            newest = conn.execute("SELECT MAX(game_creation) AS t FROM matches").fetchone()["t"]
            tracked = db.tracked_accounts(conn)
            timelines = conn.execute("SELECT COUNT(*) AS n FROM match_timelines").fetchone()["n"]
            champ_selects = conn.execute("SELECT COUNT(*) AS n FROM champ_select_sessions").fetchone()["n"]
        finally:
            conn.close()
        return {
            **self.status,
            "myMayhemMatches": mine,
            "totalMatches": total,
            "mayhemMatches": mayhem,
            "oldestGame": oldest,
            "newestGame": newest,
            "trackedCount": len(tracked),
            "timelines": timelines,
            "champSelects": champ_selects,
        }
