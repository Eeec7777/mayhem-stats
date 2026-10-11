"""語意層衍生表的預先計算。

出裝定位、陣容情境、貢獻分數、遊玩情境這幾個 cube 都要對「全部參賽者」跑視窗函數
（同定位的百分位、同隊加總、前一場），篩選條件推不進去，每個查詢都得整張重算。
實測資料十倍時，好友比較一個查詢就要 12 秒，一頁的查詢加起來超過 30 秒。

所以改成入庫後算一次、存成實體表（mat_*），cube 直接讀表。
**規則仍然只寫在 cube/model 的 yml 裡**（各 cube 的 meta.materialize.sql），
這裡只負責「照著 yml 建表」，不抄任何分組界線——改規則只要改 yml，下次重建就生效。
改完 yml 想立刻看到結果：重啟服務，或 `uv run features.py`。

快取：Cube 的 refresh key 納入 mat_state.version（見 participants.yml），
重建完版本號一變，舊的查詢結果就不會再被沿用。
"""

import re
import sqlite3
import sys
import time
from pathlib import Path

import yaml

import db

MODEL_DIR = Path(__file__).parent / "cube" / "model"


def definitions() -> list[tuple[str, str, str]]:
    """[(表名, 主鍵欄位, SQL)]，依相依順序排好：SQL 用到別張 mat_ 表的排在後面。"""
    found = {}
    for path in sorted(MODEL_DIR.rglob("*.yml")):
        for cube in (yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("cubes", []):
            spec = (cube.get("meta") or {}).get("materialize")
            if spec:
                found[spec["table"]] = (spec.get("key", "participant_rowid"), spec["sql"])

    ordered: list[str] = []

    def visit(table, trail=()):
        if table in ordered:
            return
        if table in trail:
            raise ValueError(f"衍生表互相引用：{' -> '.join((*trail, table))}")
        for other in found:
            if other != table and re.search(rf"\b{other}\b", found[table][1]):
                visit(other, (*trail, table))
        ordered.append(table)

    for table in found:
        visit(table)
    return [(table, *found[table]) for table in ordered]


# 衍生表是照哪一份對局資料算的。對局只會新增（INSERT OR IGNORE、沒有刪除），
# 一場的參賽者、裝備、增幅在同一個 transaction 寫入，所以看參賽者表就夠了。
# 貢獻分數也讀 eog_player_stats（賽後統計拆出來的治療／護盾隊友），所以列數也算進去：
# 賽後統計若比對局明細晚幾秒到，或相同玩家列的值更新（kv.eog_revision），下一輪會重建。
SOURCE_SQL = (
    "SELECT COALESCE(MAX(rowid), 0) || ':' || COUNT(*) || ':' || (SELECT COUNT(*) FROM eog_player_stats)"
    " || ':' || COALESCE((SELECT value FROM kv WHERE key='eog_revision'),'0')"
    " FROM match_participants"
)


def stale(conn: sqlite3.Connection) -> bool:
    """衍生表是否落後於對局資料（或還沒建過）。"""
    try:
        built = conn.execute("SELECT source FROM mat_state").fetchone()
    except sqlite3.OperationalError:
        return True  # 還沒有 mat_state：第一次啟動，或從舊版升上來
    return built is None or built[0] != conn.execute(SOURCE_SQL).fetchone()[0]


def rebuild(conn: sqlite3.Connection | None = None) -> float:
    """整批重建，回傳毫秒。

    分兩段，因為計算很慢（資料十倍時 6 秒），不能整段拿著寫入鎖讓採集等：
    1. 在 temp schema 算好。同名的 temp 表會蓋過 main 的，所以 SQL 裡的 mat_builds
       自然指向剛算好的那份。整段在一個讀取 transaction 裡，對局資料是同一個時間點的快照，
       記下來的 source 和表的內容一定對得上。
    2. 短短的寫入 transaction 裡換上 main。讀的人（Cube、鏡像）在 commit 之前看到的
       都是舊的那一整套，不會看到一半新一半舊。
    """
    own = conn is None
    conn = conn or db.connect()
    start = time.perf_counter()
    specs = definitions()
    try:
        conn.execute("BEGIN")
        try:
            source = conn.execute(SOURCE_SQL).fetchone()[0]
            for table, _, sql in specs:
                conn.execute(f"DROP TABLE IF EXISTS temp.{table}")
                conn.execute(f"CREATE TEMP TABLE {table} AS {sql}")
            conn.commit()

            conn.execute("BEGIN IMMEDIATE")
            for table, key, _ in specs:
                conn.execute(f"DROP TABLE IF EXISTS main.{table}")
                conn.execute(f"CREATE TABLE main.{table} AS SELECT * FROM temp.{table}")
                conn.execute(f"CREATE UNIQUE INDEX main.{table}_key ON {table}({key})")
            # version 給 Cube 的 refresh key 用；source 給 stale() 判斷要不要重建
            conn.execute("DROP TABLE IF EXISTS main.mat_state")
            conn.execute("CREATE TABLE main.mat_state (version INTEGER NOT NULL, source TEXT NOT NULL)")
            conn.execute("INSERT INTO main.mat_state VALUES (?, ?)", (time.time_ns(), source))
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            # 不清掉的話，這條連線之後查 mat_* 都會查到 temp 那份
            for table, _, _ in specs:
                conn.execute(f"DROP TABLE IF EXISTS temp.{table}")
    finally:
        if own:
            conn.close()
    return (time.perf_counter() - start) * 1000


if __name__ == "__main__":
    ms = rebuild(sqlite3.connect(sys.argv[1]) if len(sys.argv) > 1 else None)
    print(f"衍生表重建完成：{ms:.0f} ms")
