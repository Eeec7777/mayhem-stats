"""背景採集器。

雙層保險:
1. 即時層 — 每 30 秒看一次 gameflow 狀態,偵測到「剛打完」就立刻採集。
2. 補漏層 — 每 5 分鐘固定掃一次最新 100 場清單補缺,兜住工具沒開、
   當機、客戶端重啟等所有意外。

只要在舊對局被擠出「最新 100 場」視窗之前跑過任一層,資料就不會遺失。
"""

import asyncio
import time

import db
import features
import lcu

POLL_INTERVAL = 30          # 秒
# 對局中與賽後階段密集輪詢（本機 GET，很便宜）。賽後畫面通常很快就被關掉，30 秒一次只抓得到一半
# （實測 22 場只存到 11 場賽後統計），而治療／護盾隊友的量只有賽後統計有，漏一場就少一筆資料。
FAST_POLL_INTERVAL = 5
# 選角：大亂鬥的選角只有一分多鐘，板凳換英雄、交換都很快，2 秒一次才記得到中間的變化
CHAMP_SELECT_POLL_INTERVAL = 2
# 每輪最多補抓幾場時間軸（新入庫的場次抓失敗時，下一輪再試；不回補開始收之前的舊場次）
TIMELINE_RETRY_PER_RUN = 10
SWEEP_EVERY = 300           # 秒：補漏掃描固定每 5 分鐘；輪詢間隔會變，所以用時間算、不再數輪數
POST_GAME_DELAY = 20        # 打完後等客戶端寫完戰績再抓

IN_GAME_PHASES = {"GameStart", "InProgress", "Reconnect", "WaitingForStats", "PreEndOfGame"}
# 賽後畫面存在的階段：這時才抓得到 /lol-end-of-game/v1/eog-stats-block（見 _capture_eog）
EOG_PHASES = {"WaitingForStats", "PreEndOfGame", "EndOfGame"}
CHAMP_SELECT_PHASES = {"ChampSelect"}


class Collector:
    def __init__(self):
        self.status = {
            "running": False,
            "clientConnected": False,
            "phase": None,
            "lastRun": None,
            "lastError": None,
            "dimensionsLoaded": False,
        }
        self._saw_in_game = False
        self._skipped = set()   # 抓明細失敗的對局,只記錄不重試到天荒地老
        self._dimensions_loaded = False
        self._was_connected = False
        self._last_sweep = 0.0  # 上一次採集（任何觸發）的 time.monotonic()，補漏掃描從這裡起算
        # 剛打完一場時，「什麼時候該採集」的時間點。原本是在 _tick 裡整整 sleep 20 秒，
        # 那 20 秒內不會再抓賽後統計，賽後畫面還沒算完的話就漏掉了；改成記下時間，每輪照常抓、時間到再採集
        self._ingest_due = None
        self._timeline_failures = {}  # (platform_id, game_id) -> 失敗次數；同一個行程裡失敗太多次就不再試
        self.on_change = None

    # ---------------------------------------------------------------- ingest

    def _ingest(self, trigger):
        """同步採集一次。回傳 (掃到幾場, 新增幾場)。"""
        client = lcu.LCUClient.connect()
        conn = db.connect()
        dimensions_changed = False
        features_changed = False
        matches_before = conn.execute("SELECT MAX(rowid) FROM matches").fetchone()[0]
        try:
            if not self._dimensions_loaded:
                try:
                    for table, rows in lcu.fetch_dimensions(client).items():
                        db.replace_dimension(conn, table, rows)
                    self._dimensions_loaded = True
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

                # 新入庫但時間軸沒抓到的（客戶端剛好忙、逾時），這裡補；只看開始收時間軸之後的場次
                for platform_id, game_id in db.games_missing_timeline(conn, TIMELINE_RETRY_PER_RUN):
                    if self._timeline_failures.get((platform_id, game_id), 0) < 3:
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

    def _ingest_games(self, conn, client, games):
        """把一批對局收進資料庫,回傳 (掃到幾場, 新增幾場)。

        冪等性由三層保證,重複執行不會產生重複資料:
        1. 先查資料庫已有哪些 game_id,已知的連明細都不用抓
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
                if game_id in known:
                    continue
                try:
                    # 清單只回傳一名玩家,要拿全部 10 人得打明細
                    detail = client.game_detail(game_id)
                    if db.store_match(conn, detail):
                        new += 1
                        known.add(game_id)
                        self._fetch_timeline(conn, client, platform_id, game_id)
                except lcu.LCUUnavailable:
                    raise  # 客戶端關掉了,整輪停下來,下次再說
                except Exception as exc:
                    # 單一場抓不到就跳過。這裡若讓例外往上拋,那場之後的對局
                    # 全部不會被處理,而且每輪都會在同一場再死一次——等於永久卡住。
                    self.status["lastError"] = f"對局 {game_id} 略過: {type(exc).__name__}: {exc}"
        return seen, new

    def _fetch_timeline(self, conn, client, platform_id, game_id):
        """抓一場的逐幀時間軸並存起來。失敗只記次數、不拋出：時間軸是加值資料，不能擋住對局採集。"""
        try:
            timeline = client.game_timeline(game_id)
            if db.store_timeline(conn, platform_id, game_id, timeline):
                return True
            # 回來的內容沒有 frames（客戶端還沒準備好）：當成失敗，下一輪再試
        except lcu.LCUUnavailable:
            raise
        except Exception:
            pass
        key = (platform_id, game_id)
        self._timeline_failures[key] = self._timeline_failures.get(key, 0) + 1
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
        except Exception:
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
        except Exception:
            return False
        if stored:
            print(f"賽後統計已存 gameId={block.get('gameId')}，stats 欄位 {len(keys)} 個")
        return stored

    # ------------------------------------------------------------------ loop

    async def _run_ingest(self, trigger):
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
        while True:
            try:
                await self._tick()
            except Exception as exc:
                self.status["lastError"] = f"{type(exc).__name__}: {exc}"
            await asyncio.sleep(self._poll_interval())

    def _poll_interval(self):
        """選角 2 秒；對局中與賽後階段 5 秒（抓得到賽後統計）；其餘時間 30 秒。"""
        phase = self.status.get("phase")
        if phase in CHAMP_SELECT_PHASES:
            return CHAMP_SELECT_POLL_INTERVAL
        busy = self._saw_in_game or self._ingest_due is not None or phase in (IN_GAME_PHASES | EOG_PHASES)
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
            return

        # 賽後統計要在賽後畫面還在的時候抓，放在最前面，不要被下面的等待或補掃拖到畫面被關掉
        if phase in EOG_PHASES:
            await asyncio.to_thread(self._capture_eog, client)
        if phase in CHAMP_SELECT_PHASES:
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
            await self._run_ingest("realtime")
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
                   ) AND m.queue_id = ?""",
                (lcu.MAYHEM_QUEUE_ID,),
            ).fetchone()["n"]
            total = conn.execute("SELECT COUNT(*) AS n FROM matches").fetchone()["n"]
            mayhem = conn.execute(
                "SELECT COUNT(*) AS n FROM matches WHERE queue_id = ?",
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
