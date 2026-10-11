"""本機對局資料的原始 JSON 存檔。只存回應內容，不存 HTTP 認證資訊。

保留所有不同版本（含未知欄位與不完整回應），相同內容去重並更新最後觀測時間。
壓縮只改儲存格式；解開後的 JSON 值與 API 回應完全相同。
"""

import hashlib
import json
import re
import time
import zlib


SCHEMA = """
CREATE TABLE IF NOT EXISTS raw_payloads (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_params TEXT NOT NULL,
  context_key TEXT NOT NULL DEFAULT '',
  platform_id TEXT NOT NULL DEFAULT '',
  game_id INTEGER,
  first_seen REAL NOT NULL,
  last_seen REAL NOT NULL,
  origin TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  raw_zlib BLOB NOT NULL,
  UNIQUE(source, endpoint, request_params, context_key, sha256)
);
CREATE INDEX IF NOT EXISTS idx_raw_game ON raw_payloads(game_id, source, endpoint);
CREATE INDEX IF NOT EXISTS idx_raw_source ON raw_payloads(source, endpoint, first_seen);
CREATE INDEX IF NOT EXISTS idx_raw_context ON raw_payloads(context_key);

CREATE TABLE IF NOT EXISTS capture_health (
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  last_success REAL,
  last_failure REAL,
  failures INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  http_status INTEGER,
  PRIMARY KEY(source, endpoint)
);

CREATE TABLE IF NOT EXISTS timeline_fetch_attempts (
  platform_id TEXT NOT NULL,
  game_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  last_attempt REAL NOT NULL,
  retry_after REAL NOT NULL,
  error_type TEXT,
  http_status INTEGER,
  PRIMARY KEY(platform_id, game_id)
);
"""


def route(endpoint):
    """健康狀態只用路由分組，避免每一場／每一位追蹤玩家各占一列。"""
    endpoint = re.sub(r"/(games|game-timelines)/\d+$", r"/\1/{gameId}", endpoint)
    endpoint = re.sub(r"(/assets/v1/champions/)\d+\.json$", r"\1{championId}.json", endpoint)
    return re.sub(r"(/products/lol/)([^/]+)(/matches)$", r"\1{player}\3", endpoint)


def success(conn, source, endpoint, *, now=None):
    """記錄成功（含事件連線）。交易由呼叫端提交。"""
    conn.execute(
        """INSERT INTO capture_health (source,endpoint,last_success) VALUES (?,?,?)
           ON CONFLICT(source,endpoint) DO UPDATE SET last_success=excluded.last_success""",
        (source, route(endpoint), time.time() if now is None else now),
    )


def save(conn, source, endpoint, payload, *, params=None, context_key="",
         platform_id="", game_id=None, now=None, origin="capture"):
    """完整存下 JSON 回應。回傳是否首次看見這個版本。

    context_key 用來識別沒有 gameId 的即時資料；不能放認證 token。
    now 可指定原有資料的保存時間，origin='recovered' 表示由舊資料庫搬入。
    """
    now = time.time() if now is None else now
    if isinstance(payload, dict):
        game_data = payload.get("gameData") or {}
        if not isinstance(game_data, dict):
            game_data = {}
        game_id = game_id or payload.get("gameId") or game_data.get("gameId")
        platform_id = platform_id or payload.get("platformId") or game_data.get("platformId") or ""
    match = re.search(r"/(?:games|game-timelines)/(\d+)$", endpoint)
    if not game_id and match:
        game_id = int(match[1])
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    digest = hashlib.sha256(encoded).hexdigest()
    request_params = json.dumps(params or {}, separators=(",", ":"), sort_keys=True)
    with conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO raw_payloads
               (source,endpoint,request_params,context_key,platform_id,game_id,
                first_seen,last_seen,origin,sha256,raw_bytes,raw_zlib)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (source, endpoint, request_params, context_key, platform_id, game_id,
             now, now, origin, digest, len(encoded), zlib.compress(encoded, 6)),
        )
        inserted = cur.rowcount > 0
        if not inserted:
            conn.execute(
                """UPDATE raw_payloads SET first_seen=MIN(first_seen,?), last_seen=MAX(last_seen,?),
                     game_id=COALESCE(game_id,?), platform_id=CASE WHEN platform_id='' THEN ? ELSE platform_id END
                   WHERE source=? AND endpoint=? AND request_params=? AND context_key=? AND sha256=?""",
                (now, now, game_id, platform_id, source, endpoint, request_params, context_key, digest),
            )
        if context_key and game_id:
            # 首次輪詢時可能還沒有 gameId；同一擷取 session 取得 ID 後把先前原文連回對局。
            conn.execute(
                """UPDATE raw_payloads SET game_id=?, platform_id=CASE WHEN platform_id='' THEN ? ELSE platform_id END
                   WHERE context_key=? AND game_id IS NULL""",
                (game_id, platform_id, context_key),
            )
        if origin == "capture":
            success(conn, source, endpoint, now=now)
    return inserted


def load(conn, payload_id):
    row = conn.execute("SELECT raw_zlib FROM raw_payloads WHERE id=?", (payload_id,)).fetchone()
    return json.loads(zlib.decompress(row[0])) if row else None


def failure(conn, source, endpoint, exc, *, now=None):
    """只記錯誤種類／HTTP 狀態，不記可能帶帳號或憑證的錯誤本文。"""
    now = time.time() if now is None else now
    response = getattr(exc, "response", None)
    http_status = getattr(response, "status_code", None)
    with conn:
        conn.execute(
            """INSERT INTO capture_health
               (source,endpoint,last_failure,failures,error_type,http_status) VALUES (?,?,?,1,?,?)
               ON CONFLICT(source,endpoint) DO UPDATE SET
                 last_failure=excluded.last_failure, failures=capture_health.failures+1,
                 error_type=excluded.error_type, http_status=excluded.http_status""",
            (source, route(endpoint), now, type(exc).__name__, http_status),
        )


def recover_existing(conn):
    """舊表已保存的完整原文匯入存檔；不能重建早已被覆蓋／沒抓到的內容。"""
    if conn.execute("SELECT 1 FROM kv WHERE key='raw_archive_recovered_v1'").fetchone():
        return
    for row in conn.execute("SELECT platform_id,game_id,ingested_at,raw_json FROM matches").fetchall():
        save(conn, "lcu", f"/lol-match-history/v1/games/{row[1]}", json.loads(row[3]),
             platform_id=row[0], game_id=row[1], now=row[2], origin="recovered")
    for row in conn.execute("SELECT game_id,captured_at,raw_json FROM eog_snapshots").fetchall():
        save(conn, "lcu", "/lol-end-of-game/v1/eog-stats-block", json.loads(row[2]),
             game_id=row[0], now=row[1], origin="recovered")
    for row in conn.execute("SELECT platform_id,game_id,fetched_at,raw_gz FROM match_timelines").fetchall():
        save(conn, "lcu", f"/lol-match-history/v1/game-timelines/{row[1]}", json.loads(zlib.decompress(row[3])),
             platform_id=row[0], game_id=row[1], now=row[2], origin="recovered")
    for row in conn.execute("SELECT game_id,updated_at,raw_last FROM champ_select_sessions").fetchall():
        save(conn, "lcu", "/lol-champ-select/v1/session", json.loads(row[2]),
             game_id=row[0], now=row[1], origin="recovered")
    with conn:
        conn.execute("INSERT OR IGNORE INTO kv (key,value) VALUES ('raw_archive_recovered_v1',?)", (str(time.time()),))
