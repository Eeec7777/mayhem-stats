"""測試用的獨立對照：直接讀 mayhem.db 算數字，不經過 Cube（verify-change：數字要和獨立手寫的 SQL 對）。
從 stdin 讀 {"sql": ..., "params": [...]}，輸出 JSON 列。資料庫以唯讀開啟，不會干擾採集器。"""
import json
import sqlite3
import sys
from pathlib import Path

# Windows 的預設編碼是 cp950：不指定的話，中文的 Riot ID 進出都會變亂碼
sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
req = json.load(sys.stdin)
db = Path(__file__).resolve().parent.parent.parent / "mayhem.db"
conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True, timeout=30)
conn.row_factory = sqlite3.Row
rows = [dict(r) for r in conn.execute(req["sql"], req.get("params", []))]
print(json.dumps(rows, ensure_ascii=False))
