"""原始資料涵蓋率檢查及時間軸回補。預設唯讀，不印玩家名稱／對局 ID。

uv run python capture_audit.py
uv run python capture_audit.py --backfill-timelines --limit 0
"""

import argparse
import ast
import inspect
import json
import sqlite3

import db
import lcu
import raw_data


def audit(conn):
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    counts = {table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in
              ("matches", "match_participants", "eog_snapshots", "eog_player_stats", "match_timelines", "champ_select_sessions")}
    mayhem = conn.execute(
        """SELECT COUNT(*),
             SUM(EXISTS(SELECT 1 FROM eog_snapshots e WHERE e.game_id=m.game_id)),
             SUM(EXISTS(SELECT 1 FROM match_timelines t WHERE t.platform_id=m.platform_id AND t.game_id=m.game_id))
           FROM matches m WHERE queue_id=?""", (lcu.MAYHEM_QUEUE_ID,)).fetchone()
    result = {"counts": counts, "mayhem": {"matches": mayhem[0], "withEog": mayhem[1] or 0, "withTimeline": mayhem[2] or 0}}

    mapped = set(db.LATE_COLUMNS.values())
    for node in ast.walk(ast.parse(inspect.getsource(db.store_match))):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "_num"
                and len(node.args) > 1 and isinstance(node.args[1], ast.Constant)
                and isinstance(node.args[1].value, str)):
            mapped.add(node.args[1].value)
    mapped.update(f"item{i}" for i in range(7))
    mapped.update(f"playerAugment{i}" for i in range(1, 7))
    mapped.add("gameEndedInEarlySurrender")
    inventory = {}
    for (raw,) in conn.execute("SELECT raw_json FROM matches WHERE queue_id=?", (lcu.MAYHEM_QUEUE_ID,)):
        for participant in json.loads(raw).get("participants") or []:
            for key in (participant.get("stats") or {}):
                inventory[key] = inventory.get(key, 0) + 1
    result["historyStatsStoredInRawOnly"] = {k: n for k, n in sorted(inventory.items()) if k not in mapped}
    eog_keys = set()
    for (raw,) in conn.execute("SELECT raw_json FROM eog_snapshots"):
        eog_keys.update(db.eog_stat_keys(json.loads(raw)))
    result["eogStatKeys"] = sorted(eog_keys)
    if "raw_payloads" in tables:
        grouped = {}
        for source, endpoint, versions, size, compressed in conn.execute(
                """SELECT source,endpoint,COUNT(*),SUM(raw_bytes),SUM(length(raw_zlib))
                   FROM raw_payloads GROUP BY source,endpoint ORDER BY source,endpoint"""):
            key = source, raw_data.route(endpoint)
            item = grouped.setdefault(key, {"source": source, "endpoint": key[1], "versions": 0,
                                           "jsonBytes": 0, "compressedBytes": 0})
            item["versions"] += versions
            item["jsonBytes"] += size
            item["compressedBytes"] += compressed
        result["rawArchive"] = list(grouped.values())
        result["timelineRetryQueue"] = conn.execute("SELECT COUNT(*) FROM timeline_fetch_attempts").fetchone()[0]
        result["captureHealth"] = [dict(zip(
            ("source", "endpoint", "lastSuccess", "lastFailure", "failures", "errorType", "httpStatus"), row))
            for row in conn.execute("""SELECT source,endpoint,last_success,last_failure,failures,error_type,http_status
                                       FROM capture_health ORDER BY source,endpoint""")]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backfill-timelines", action="store_true")
    parser.add_argument("--limit", type=int, default=50, help="回補上限，0 代表所有目前可重試場次")
    parser.add_argument("--json", action="store_true", help="完整欄位清冊（不含玩家身分）")
    args = parser.parse_args()
    if args.limit < 0:
        parser.error("--limit 必須大於或等於 0")
    if args.backfill_timelines:
        import collector
        db.init()
        conn = db.connect()
        try:
            client = lcu.LCUClient.connect()
            gatherer = collector.Collector()
            gatherer._attach_archive(client, conn)
            games = db.games_missing_timeline(conn, args.limit or -1)
            succeeded = failed = 0
            for platform_id, game_id in games:
                if gatherer._fetch_timeline(conn, client, platform_id, game_id):
                    succeeded += 1
                else:
                    failed += 1
                if (succeeded + failed) % 25 == 0:
                    print(json.dumps({"attempted": succeeded + failed, "stored": succeeded, "failed": failed}), flush=True)
            print(json.dumps({"backfill": {"attempted": len(games), "stored": succeeded, "failed": failed}}), flush=True)
        finally:
            conn.close()
    conn = sqlite3.connect(db.DB_PATH.as_uri() + "?mode=ro", uri=True)
    try:
        result = audit(conn)
    finally:
        conn.close()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        summary = {"counts": result["counts"], "mayhem": result["mayhem"],
                   "historyRawOnlyStatKeys": len(result["historyStatsStoredInRawOnly"]),
                   "eogStatKeys": len(result["eogStatKeys"]),
                   "archivedVersions": sum(r["versions"] for r in result.get("rawArchive", [])),
                   "timelineRetryQueue": result.get("timelineRetryQueue", 0)}
        print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
