"""SQLite 儲存層。

設計重點:舊對局在客戶端只保留最新 100 場,一旦被擠出視窗就永遠拿不回來,
所以每場都連同原始 JSON 一起存,將來想分析新欄位時不必(也無法)重抓。
"""

import datetime
import json
import sqlite3
import time
import zlib
from pathlib import Path

DB_PATH = Path(__file__).parent / "mayhem.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches (
  platform_id     TEXT    NOT NULL,
  game_id         INTEGER NOT NULL,
  queue_id        INTEGER NOT NULL,
  game_mode       TEXT,
  game_version    TEXT,
  map_id          INTEGER,
  game_creation   INTEGER NOT NULL,
  game_duration   INTEGER NOT NULL,
  ended_surrender INTEGER DEFAULT 0,
  -- 開打當下「你這台機器」的本地日期/星期/小時。
  -- 這三個值一定要在寫入時就用 Python 算好,不能留給查詢層。
  -- Cube 的 server 行程跑在 UTC 下,SQLite 的 'localtime' 在那裡等於 UTC,
  -- 時段分析會整個偏移 8 小時(實測「最常打 07:00」其實是下午 3 點)。
  local_date      TEXT,
  local_weekday   INTEGER,
  local_hour      INTEGER,
  raw_json        TEXT    NOT NULL,
  ingested_at     INTEGER NOT NULL,
  PRIMARY KEY (platform_id, game_id)
);

CREATE TABLE IF NOT EXISTS match_participants (
  platform_id        TEXT    NOT NULL,
  game_id            INTEGER NOT NULL,
  participant_id     INTEGER NOT NULL,
  puuid              TEXT    NOT NULL,
  riot_id            TEXT,
  team_id            INTEGER NOT NULL,
  win                INTEGER NOT NULL,
  champion_id        INTEGER NOT NULL,
  champ_level        INTEGER,
  kills              INTEGER, deaths INTEGER, assists INTEGER,
  gold_earned        INTEGER, gold_spent INTEGER,
  dmg_to_champions   INTEGER,
  dmg_physical       INTEGER, dmg_magic INTEGER, dmg_true INTEGER,
  dmg_taken          INTEGER, dmg_mitigated INTEGER,
  total_heal         INTEGER, cs INTEGER, vision_score INTEGER,
  time_ccing_others  INTEGER, largest_multi_kill INTEGER,
  spell1_id          INTEGER, spell2_id INTEGER,
  perk_primary_style INTEGER, perk_sub_style INTEGER,
  team_kills         INTEGER,
  team_dmg           INTEGER,
  team_gold          INTEGER,
  -- 敵方的團隊加總。要回答「是我們打不動還是被打爆」就得有對手的數字,
  -- 而那是同一場其他列的資料——先算好存下來,查詢層才不必為此自我 join。
  enemy_kills        INTEGER, enemy_dmg INTEGER, enemy_gold INTEGER,
  game_duration      INTEGER,
  double_kills       INTEGER, triple_kills INTEGER,
  quadra_kills       INTEGER, penta_kills INTEGER,
  first_blood        INTEGER, first_tower INTEGER,
  dmg_to_objectives  INTEGER, longest_time_living INTEGER,
  taken_physical     INTEGER, taken_magic INTEGER, taken_true INTEGER,
  total_damage       INTEGER, cc_duration INTEGER,
  largest_spree      INTEGER, killing_sprees INTEGER,
  turret_kills       INTEGER, largest_crit INTEGER, units_healed INTEGER,
  PRIMARY KEY (platform_id, game_id, participant_id),
  FOREIGN KEY (platform_id, game_id) REFERENCES matches(platform_id, game_id)
);

CREATE TABLE IF NOT EXISTS participant_augments (
  platform_id TEXT NOT NULL, game_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL, slot INTEGER NOT NULL,
  augment_id INTEGER NOT NULL,
  PRIMARY KEY (platform_id, game_id, participant_id, slot)
);

CREATE TABLE IF NOT EXISTS participant_items (
  platform_id TEXT NOT NULL, game_id INTEGER NOT NULL,
  participant_id INTEGER NOT NULL, slot INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  PRIMARY KEY (platform_id, game_id, participant_id, slot)
);

CREATE TABLE IF NOT EXISTS dim_champions (id INTEGER PRIMARY KEY, name TEXT, alias TEXT, icon_path TEXT);
CREATE TABLE IF NOT EXISTS dim_augments  (id INTEGER PRIMARY KEY, name TEXT, rarity TEXT, icon_path TEXT);
CREATE TABLE IF NOT EXISTS dim_items     (id INTEGER PRIMARY KEY, name TEXT, icon_path TEXT, price_total INTEGER);
CREATE TABLE IF NOT EXISTS dim_perks     (id INTEGER PRIMARY KEY, name TEXT, icon_path TEXT);
CREATE TABLE IF NOT EXISTS dim_spells    (id INTEGER PRIMARY KEY, name TEXT, icon_path TEXT);

CREATE TABLE IF NOT EXISTS accounts (
  puuid    TEXT PRIMARY KEY,
  riot_id  TEXT,
  is_me    INTEGER NOT NULL DEFAULT 1,
  tracked  INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  trigger     TEXT,
  games_seen  INTEGER DEFAULT 0,
  games_new   INTEGER DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_mp_puuid_champ ON match_participants(puuid, champion_id);
CREATE INDEX IF NOT EXISTS idx_mp_game        ON match_participants(platform_id, game_id);
CREATE INDEX IF NOT EXISTS idx_m_creation     ON matches(game_creation);
CREATE TABLE IF NOT EXISTS dim_champion_roles (
  champion_id INTEGER NOT NULL,
  role        TEXT    NOT NULL,
  PRIMARY KEY (champion_id, role)
);
-- 裝備類別（Damage、SpellDamage、Health、Armor、SpellBlock…），一件裝備可能有好幾個，長格式。
-- 用來依出裝判斷這場實際的定位，見 lcu.fetch_dimensions。
CREATE TABLE IF NOT EXISTS dim_item_categories (
  item_id  INTEGER NOT NULL,
  category TEXT    NOT NULL,
  PRIMARY KEY (item_id, category)
);
-- 裝備數值（AttackDamage、Lethality、CritChance…），從客戶端的裝備說明取出，鍵名見 lcu._STAT_KEYS。
-- 類別分不出刺客裝（穿甲類別同時貼在致命裝與暴擊裝上），出裝定位要靠這張表。
CREATE TABLE IF NOT EXISTS dim_item_stats (
  item_id INTEGER NOT NULL,
  stat    TEXT    NOT NULL,
  value   REAL    NOT NULL,
  PRIMARY KEY (item_id, stat)
);

-- 賽後統計擷取（實驗）：賽後畫面那一份統計的原始 JSON。
-- 對局明細端點沒有「治療／護盾隊友」的量；這一份的 stats 是通用的鍵值表，有沒有要打完一場才知道，
-- 所以先整份存下來，stat_keys 列出出現過的欄位名，不用解開 raw_json 就能看。
-- 只對採集器開著、剛好撞上賽後畫面的場次有效；raw_json 裡有其他玩家的名字，只留在本機資料庫，
-- 沒有任何 API 會讀這張表。
CREATE TABLE IF NOT EXISTS eog_snapshots (
  game_id     INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  stat_keys   TEXT    NOT NULL,
  raw_json    TEXT    NOT NULL
);

-- 賽後統計裡拆出來、計分要用的欄位（來源是 eog_snapshots 的原始 JSON，見 eog_players）。
-- 對局明細端點沒有治療隊友與護盾隊友的量，所以只有開始擷取之後的場次有資料，沒辦法回補舊場次；
-- 用 (game_id, puuid) 對回 match_participants。沒有 puuid 的玩家不存。
CREATE TABLE IF NOT EXISTS eog_player_stats (
  game_id             INTEGER NOT NULL,
  puuid               TEXT    NOT NULL,
  team_id             INTEGER,
  champion_id         INTEGER,
  heal_on_teammates   INTEGER NOT NULL,
  shield_on_teammates INTEGER NOT NULL,
  time_spent_dead     INTEGER,
  total_heal          INTEGER,
  PRIMARY KEY (game_id, puuid)
);

-- 逐幀時間軸（/lol-match-history/v1/game-timelines/{gameId}）：每分鐘的經濟、經驗、位置，
-- 以及擊殺、拆建築、買賣裝等帶時間戳的事件。一場幾百 KB，原始 JSON 用 zlib 壓縮後存（約十分之一），
-- 要分析時再拆。只收「開始收時間軸之後」新入庫的場次（kv.timeline_since），舊場次不回補。
CREATE TABLE IF NOT EXISTS match_timelines (
  platform_id TEXT    NOT NULL,
  game_id     INTEGER NOT NULL,
  fetched_at  INTEGER NOT NULL,
  frames      INTEGER,
  raw_gz      BLOB    NOT NULL,
  PRIMARY KEY (platform_id, game_id)
);

-- 選角過程（/lol-champ-select/v1/session）：選角時每次內容有變就記一筆精簡快照
-- （我方每人的英雄、板凳、重抽次數、交換），snapshots 是依時間排的 JSON 陣列；raw_last 是最後一份完整 session。
-- 只有站長自己參與、而且採集器開著的選角才有；用 game_id 對回 matches。raw 裡有隊友名字，只留在本機。
CREATE TABLE IF NOT EXISTS champ_select_sessions (
  game_id    INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  snapshots  TEXT    NOT NULL,
  raw_last   TEXT    NOT NULL
);

-- 雜項設定（例如從什麼時候開始收時間軸）
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_m_queue        ON matches(queue_id);
CREATE INDEX IF NOT EXISTS idx_pa_augment     ON participant_augments(augment_id);
CREATE INDEX IF NOT EXISTS idx_pi_item        ON participant_items(item_id);
"""


def connect(path=None):
    conn = sqlite3.connect(path or DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init(path=None):
    conn = connect(path)
    try:
        with conn:
            conn.executescript(SCHEMA)
        _migrate(conn)
    finally:
        conn.close()


# 後來才補拆的欄位 -> raw_json 裡 stats 的對應鍵。
# 舊對局在客戶端早就消失,能補回來完全是因為當初把原始 JSON 一起存了。
LATE_COLUMNS = {
    "double_kills": "doubleKills",
    "triple_kills": "tripleKills",
    "quadra_kills": "quadraKills",
    "penta_kills": "pentaKills",
    "first_blood": "firstBloodKill",
    "first_tower": "firstTowerKill",
    "dmg_to_objectives": "damageDealtToObjectives",
    "longest_time_living": "longestTimeSpentLiving",
    # 承受傷害的三種類型：能回答「我是被 AP 還是 AD 打死的」
    "taken_physical": "physicalDamageTaken",
    "taken_magic": "magicalDamageTaken",
    "taken_true": "trueDamageTaken",
    # 總輸出（含小兵與建築）。和對英雄傷害相比可看出清兵 vs 團戰取向
    "total_damage": "totalDamageDealt",
    "cc_duration": "totalTimeCrowdControlDealt",
    "largest_spree": "largestKillingSpree",
    "killing_sprees": "killingSprees",
    "turret_kills": "turretKills",
    "largest_crit": "largestCriticalStrike",
    "units_healed": "totalUnitsHealed",
}


def _migrate(conn):
    """補上舊資料庫缺少的欄位,並從 raw_json 回填。"""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(match_participants)")}

    # 對局長度反正規化到事實表,事實表才能自給自足算出每分鐘類的指標
    # (team_kills / team_dmg 也是同樣理由)。對局結束後資料不再變動,沒有一致性風險。
    if "game_duration" not in existing:
        with conn:
            conn.execute("ALTER TABLE match_participants ADD COLUMN game_duration INTEGER")
        with conn:
            conn.execute("""
                UPDATE match_participants AS mp
                SET game_duration = (
                    SELECT m.game_duration FROM matches m
                    WHERE m.platform_id = mp.platform_id AND m.game_id = mp.game_id
                )
                WHERE mp.game_duration IS NULL
            """)

    match_cols = {row["name"] for row in conn.execute("PRAGMA table_info(matches)")}
    if "local_date" not in match_cols:
        with conn:
            conn.execute("ALTER TABLE matches ADD COLUMN local_date TEXT")
            conn.execute("ALTER TABLE matches ADD COLUMN local_weekday INTEGER")
            conn.execute("ALTER TABLE matches ADD COLUMN local_hour INTEGER")
        _backfill_local_time(conn)

    item_cols = {row["name"] for row in conn.execute("PRAGMA table_info(dim_items)")}
    if "price_total" not in item_cols:
        # 值由下一次載入維度表時填上（服務啟動後第一次採集），不必從對局資料回填
        with conn:
            conn.execute("ALTER TABLE dim_items ADD COLUMN price_total INTEGER")

    account_cols = {row["name"] for row in conn.execute("PRAGMA table_info(accounts)")}
    if "tracked" not in account_cols:
        with conn:
            conn.execute("ALTER TABLE accounts ADD COLUMN tracked INTEGER NOT NULL DEFAULT 0")

    team_cols = ["team_gold", "enemy_kills", "enemy_dmg", "enemy_gold"]
    if any(col not in existing for col in team_cols):
        with conn:
            for col in team_cols:
                if col not in existing:
                    conn.execute(f"ALTER TABLE match_participants ADD COLUMN {col} INTEGER")
        _backfill_team_totals(conn)

    missing = [col for col in LATE_COLUMNS if col not in existing]
    if missing:
        with conn:
            for col in missing:
                conn.execute(f"ALTER TABLE match_participants ADD COLUMN {col} INTEGER")
        _backfill_from_raw(conn, missing)

    backfill_eog_players(conn)

    # 從第一次啟動新版開始收時間軸：記下時間點，之前入庫的場次不回補
    with conn:
        conn.execute("INSERT OR IGNORE INTO kv (key, value) VALUES ('timeline_since', ?)", (str(int(time.time())),))


def _backfill_local_time(conn):
    """用 game_creation 重算本地時間欄位。換過時區的話手動清空這三欄再跑一次就會重建。"""
    rows = conn.execute(
        "SELECT platform_id, game_id, game_creation FROM matches WHERE local_date IS NULL"
    ).fetchall()
    with conn:
        conn.executemany(
            """UPDATE matches SET local_date = ?, local_weekday = ?, local_hour = ?
               WHERE platform_id = ? AND game_id = ?""",
            [(*local_buckets(r["game_creation"]), r["platform_id"], r["game_id"]) for r in rows],
        )
    return len(rows)


def _backfill_team_totals(conn):
    """從 raw_json 重算每場的雙方團隊加總。

    這些是同一場其他列的合計,沒辦法用單列的欄位推回來——能補是因為當初
    連原始 JSON 一起存了。
    """
    import json as _json

    updates = []
    for row in conn.execute("SELECT platform_id, game_id, raw_json FROM matches"):
        game = _json.loads(row["raw_json"])
        participants = game.get("participants", [])
        kills, dmg, gold = {}, {}, {}
        for p in participants:
            team = p.get("teamId")
            stats = p.get("stats", {})
            kills[team] = kills.get(team, 0) + _num(stats, "kills")
            dmg[team] = dmg.get(team, 0) + _num(stats, "totalDamageDealtToChampions")
            gold[team] = gold.get(team, 0) + _num(stats, "goldEarned")
        for p in participants:
            team = p.get("teamId")
            other = lambda totals: sum(v for t, v in totals.items() if t != team)  # noqa: E731
            updates.append((
                gold.get(team, 0), other(kills), other(dmg), other(gold),
                row["platform_id"], row["game_id"], p.get("participantId"),
            ))
    with conn:
        conn.executemany(
            """UPDATE match_participants
               SET team_gold = ?, enemy_kills = ?, enemy_dmg = ?, enemy_gold = ?
               WHERE platform_id = ? AND game_id = ? AND participant_id = ?""",
            updates,
        )
    return len(updates)


def _backfill_from_raw(conn, columns):
    import json as _json

    updates = []
    for row in conn.execute("SELECT platform_id, game_id, raw_json FROM matches"):
        game = _json.loads(row["raw_json"])
        for participant in game.get("participants", []):
            stats = participant.get("stats", {})
            values = [int(stats.get(LATE_COLUMNS[col]) or 0) for col in columns]
            updates.append((*values, row["platform_id"], row["game_id"],
                            participant.get("participantId")))

    assignments = ", ".join(f"{col} = ?" for col in columns)
    with conn:
        conn.executemany(
            f"""UPDATE match_participants SET {assignments}
                WHERE platform_id = ? AND game_id = ? AND participant_id = ?""",
            updates,
        )


def local_buckets(game_creation_ms):
    """把對局開始時間換算成本地的 (日期, 星期, 小時)。星期 0 = 週日,和 strftime('%w') 一致。"""
    if not game_creation_ms:
        return None, None, None
    moment = datetime.datetime.fromtimestamp(game_creation_ms / 1000)
    return (
        moment.strftime("%Y-%m-%d"),
        (moment.weekday() + 1) % 7,   # Python 的 weekday() 週一=0,這裡改成週日=0
        moment.hour,
    )


def _num(stats, key, default=0):
    value = stats.get(key)
    return default if value is None else value


def existing_game_ids(conn, platform_id):
    rows = conn.execute(
        "SELECT game_id FROM matches WHERE platform_id = ?", (platform_id,)
    ).fetchall()
    return {row["game_id"] for row in rows}


def store_match(conn, game):
    """寫入一場對局。回傳 True 表示這是新對局,False 表示已存在。

    整場(表頭 + 10 名玩家 + 增幅 + 裝備)包在單一 transaction 裡,
    避免中途失敗留下半筆資料。
    """
    platform_id = game.get("platformId") or ""
    game_id = game.get("gameId")
    participants = game.get("participants", [])
    identities = {
        ident.get("participantId"): ident.get("player", {})
        for ident in game.get("participantIdentities", [])
    }

    team_kills, team_dmg, team_gold = {}, {}, {}
    for p in participants:
        team = p.get("teamId")
        stats = p.get("stats", {})
        team_kills[team] = team_kills.get(team, 0) + _num(stats, "kills")
        team_dmg[team] = team_dmg.get(team, 0) + _num(stats, "totalDamageDealtToChampions")
        team_gold[team] = team_gold.get(team, 0) + _num(stats, "goldEarned")

    def other_side(totals, team):
        """同一場裡不屬於這一隊的加總。"""
        return sum(v for t, v in totals.items() if t != team)

    first_stats = participants[0].get("stats", {}) if participants else {}

    with conn:
        cur = conn.execute(
            """INSERT OR IGNORE INTO matches
               (platform_id, game_id, queue_id, game_mode, game_version, map_id,
                game_creation, game_duration, ended_surrender,
                local_date, local_weekday, local_hour, raw_json, ingested_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                platform_id,
                game_id,
                game.get("queueId"),
                game.get("gameMode"),
                game.get("gameVersion"),
                game.get("mapId"),
                game.get("gameCreation"),
                game.get("gameDuration"),
                1 if _num(first_stats, "gameEndedInSurrender") else 0,
                *local_buckets(game.get("gameCreation")),
                json.dumps(game, ensure_ascii=False),
                int(time.time()),
            ),
        )
        if cur.rowcount == 0:
            return False

        for p in participants:
            pid = p.get("participantId")
            stats = p.get("stats", {})
            player = identities.get(pid, {})
            game_name = player.get("gameName") or player.get("summonerName") or ""
            tag = player.get("tagLine") or ""
            riot_id = f"{game_name}#{tag}" if tag else game_name
            team = p.get("teamId")

            conn.execute(
                """INSERT OR IGNORE INTO match_participants
                   (platform_id, game_id, participant_id, puuid, riot_id, team_id, win,
                    champion_id, champ_level, kills, deaths, assists,
                    gold_earned, gold_spent, dmg_to_champions,
                    dmg_physical, dmg_magic, dmg_true, dmg_taken, dmg_mitigated,
                    total_heal, cs, vision_score, time_ccing_others, largest_multi_kill,
                    spell1_id, spell2_id, perk_primary_style, perk_sub_style,
                    team_kills, team_dmg, team_gold,
                    enemy_kills, enemy_dmg, enemy_gold, game_duration,
                    double_kills, triple_kills, quadra_kills, penta_kills,
                    first_blood, first_tower, dmg_to_objectives, longest_time_living,
                    taken_physical, taken_magic, taken_true, total_damage, cc_duration,
                    largest_spree, killing_sprees, turret_kills, largest_crit, units_healed)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                           ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    platform_id, game_id, pid,
                    player.get("puuid") or "",
                    riot_id,
                    team,
                    1 if _num(stats, "win") else 0,
                    p.get("championId"),
                    _num(stats, "champLevel"),
                    _num(stats, "kills"), _num(stats, "deaths"), _num(stats, "assists"),
                    _num(stats, "goldEarned"), _num(stats, "goldSpent"),
                    _num(stats, "totalDamageDealtToChampions"),
                    _num(stats, "physicalDamageDealtToChampions"),
                    _num(stats, "magicDamageDealtToChampions"),
                    _num(stats, "trueDamageDealtToChampions"),
                    _num(stats, "totalDamageTaken"),
                    _num(stats, "damageSelfMitigated"),
                    _num(stats, "totalHeal"),
                    _num(stats, "totalMinionsKilled"),
                    _num(stats, "visionScore"),
                    _num(stats, "timeCCingOthers"),
                    _num(stats, "largestMultiKill"),
                    p.get("spell1Id"), p.get("spell2Id"),
                    _num(stats, "perkPrimaryStyle"), _num(stats, "perkSubStyle"),
                    team_kills.get(team, 0), team_dmg.get(team, 0), team_gold.get(team, 0),
                    other_side(team_kills, team), other_side(team_dmg, team),
                    other_side(team_gold, team),
                    game.get("gameDuration"),
                    _num(stats, "doubleKills"), _num(stats, "tripleKills"),
                    _num(stats, "quadraKills"), _num(stats, "pentaKills"),
                    1 if _num(stats, "firstBloodKill") else 0,
                    1 if _num(stats, "firstTowerKill") else 0,
                    _num(stats, "damageDealtToObjectives"),
                    _num(stats, "longestTimeSpentLiving"),
                    _num(stats, "physicalDamageTaken"), _num(stats, "magicalDamageTaken"),
                    _num(stats, "trueDamageTaken"), _num(stats, "totalDamageDealt"),
                    _num(stats, "totalTimeCrowdControlDealt"),
                    _num(stats, "largestKillingSpree"), _num(stats, "killingSprees"),
                    _num(stats, "turretKills"), _num(stats, "largestCriticalStrike"),
                    _num(stats, "totalUnitsHealed"),
                ),
            )

            for slot in range(1, 7):
                augment_id = _num(stats, f"playerAugment{slot}")
                if augment_id:
                    conn.execute(
                        """INSERT OR IGNORE INTO participant_augments
                           (platform_id, game_id, participant_id, slot, augment_id)
                           VALUES (?,?,?,?,?)""",
                        (platform_id, game_id, pid, slot, augment_id),
                    )

            for slot in range(0, 7):
                item_id = _num(stats, f"item{slot}")
                if item_id:
                    conn.execute(
                        """INSERT OR IGNORE INTO participant_items
                           (platform_id, game_id, participant_id, slot, item_id)
                           VALUES (?,?,?,?,?)""",
                        (platform_id, game_id, pid, slot, item_id),
                    )

    return True


def upsert_account(conn, puuid, riot_id):
    """記錄本機登入的帳號。名稱可能改，puuid 不會，所以用 puuid 當鍵。"""
    with conn:
        conn.execute(
            """INSERT INTO accounts (puuid, riot_id, is_me, added_at) VALUES (?,?,1,?)
               ON CONFLICT(puuid) DO UPDATE SET riot_id = excluded.riot_id, is_me = 1""",
            (puuid, riot_id, int(time.time())),
        )


def tracked_accounts(conn):
    """除了自己以外，還要一併採集戰績的對象。"""
    return [
        dict(row)
        for row in conn.execute(
            "SELECT puuid, riot_id FROM accounts WHERE tracked = 1 AND is_me = 0"
            " ORDER BY riot_id"
        )
    ]


def set_tracked(conn, puuid, riot_id, tracked):
    """加入或移除追蹤對象。重複呼叫結果相同——冪等。"""
    with conn:
        conn.execute(
            """INSERT INTO accounts (puuid, riot_id, is_me, tracked, added_at)
               VALUES (?,?,0,?,?)
               ON CONFLICT(puuid) DO UPDATE SET
                 tracked = excluded.tracked,
                 riot_id = COALESCE(excluded.riot_id, accounts.riot_id)""",
            (puuid, riot_id, 1 if tracked else 0, int(time.time())),
        )


def find_puuid_by_riot_id(conn, riot_id):
    """從既有對局裡把 Riot ID 換成 puuid。

    只找得到曾經和你同場過的人——客戶端沒有提供公開的名稱查詢，
    要追蹤完全沒同場過的對象目前做不到。
    """
    row = conn.execute(
        "SELECT puuid FROM match_participants WHERE riot_id = ? LIMIT 1", (riot_id,)
    ).fetchone()
    return row["puuid"] if row else None


def replace_dimension(conn, table, rows):
    """整表換掉維度資料(版本更新會有新英雄/新增幅)。"""
    columns = {
        "dim_champions": ("id", "name", "alias", "icon_path"),
        "dim_augments": ("id", "name", "rarity", "icon_path"),
        "dim_items": ("id", "name", "icon_path", "price_total"),
        "dim_perks": ("id", "name", "icon_path"),
        "dim_spells": ("id", "name", "icon_path"),
    }[table]
    placeholders = ",".join("?" * len(columns))
    with conn:
        conn.executemany(
            f"INSERT OR REPLACE INTO {table} ({','.join(columns)}) VALUES ({placeholders})",
            [tuple(row.get(c) for c in columns) for row in rows],
        )
        if table == "dim_champions":
            # 定位是長格式,一隻英雄可能有兩個。整批換掉,改版新增定位才跟得上。
            conn.execute("DELETE FROM dim_champion_roles")
            conn.executemany(
                "INSERT OR IGNORE INTO dim_champion_roles (champion_id, role) VALUES (?,?)",
                [(row["id"], role) for row in rows for role in (row.get("roles") or [])],
            )
        if table == "dim_items":
            # 類別同樣整批換掉：改版調整裝備屬性時，舊的類別不能留著
            conn.execute("DELETE FROM dim_item_categories")
            conn.executemany(
                "INSERT OR IGNORE INTO dim_item_categories (item_id, category) VALUES (?,?)",
                [(row["id"], cat) for row in rows for cat in (row.get("categories") or [])],
            )
            conn.execute("DELETE FROM dim_item_stats")
            conn.executemany(
                "INSERT OR IGNORE INTO dim_item_stats (item_id, stat, value) VALUES (?,?,?)",
                [(row["id"], k, v) for row in rows for k, v in (row.get("stats") or {}).items()],
            )


def eog_stat_keys(block):
    """賽後統計裡所有玩家與隊伍的 stats 出現過的欄位名（排序）。"""
    keys = set()
    for team in block.get("teams") or []:
        keys.update((team.get("stats") or {}).keys())
        for player in team.get("players") or []:
            keys.update((player.get("stats") or {}).keys())
    keys.update(((block.get("localPlayer") or {}).get("stats") or {}).keys())
    return sorted(keys)


def eog_players(block):
    """賽後統計裡每位玩家要拆進 eog_player_stats 的欄位。

    stats 缺了治療隊友或護盾隊友的鍵（客戶端早期還沒算完的版本）就略過那位玩家：
    缺值不能存成 0，0 會被當成「真的沒治療過隊友」。沒有 puuid 的也略過。"""
    out = []
    for team in block.get("teams") or []:
        for player in team.get("players") or []:
            stats = player.get("stats") or {}
            if not player.get("puuid") or "totalHealsOnTeammates" not in stats or "totalDamageShieldedOnTeammates" not in stats:
                continue
            out.append((
                block.get("gameId"), player["puuid"], player.get("teamId") or team.get("teamId"), player.get("championId"),
                int(stats["totalHealsOnTeammates"] or 0), int(stats["totalDamageShieldedOnTeammates"] or 0),
                stats.get("totalTimeSpentDead"), stats.get("totalHeal"),
            ))
    return out


def _store_eog_players(conn, block):
    conn.executemany(
        """INSERT OR REPLACE INTO eog_player_stats
           (game_id, puuid, team_id, champion_id, heal_on_teammates, shield_on_teammates, time_spent_dead, total_heal)
           VALUES (?,?,?,?,?,?,?,?)""",
        eog_players(block),
    )


def backfill_eog_players(conn):
    """把已存的賽後統計快照拆進 eog_player_stats（拆欄位的規則改了、或表是後來才建的時候補上）。"""
    have = {row[0] for row in conn.execute("SELECT DISTINCT game_id FROM eog_player_stats")}
    with conn:
        for game_id, raw in conn.execute("SELECT game_id, raw_json FROM eog_snapshots").fetchall():
            if game_id not in have:
                _store_eog_players(conn, json.loads(raw))


def store_eog_snapshot(conn, block):
    """存一份賽後統計的原始 JSON，回傳 (有沒有寫入, 欄位名清單)。

    賽後階段每輪都會抓一次，同一場只留一份；後來抓到的欄位比較多（客戶端一開始可能還沒算完）才覆蓋。"""
    game_id = block.get("gameId")
    keys = eog_stat_keys(block)
    if not game_id:
        return False, keys
    with conn:
        cur = conn.execute(
            """INSERT INTO eog_snapshots (game_id, captured_at, stat_keys, raw_json) VALUES (?,?,?,?)
               ON CONFLICT(game_id) DO UPDATE SET
                 captured_at = excluded.captured_at, stat_keys = excluded.stat_keys, raw_json = excluded.raw_json
               WHERE json_array_length(excluded.stat_keys) > json_array_length(eog_snapshots.stat_keys)""",
            (game_id, int(time.time()), json.dumps(keys, ensure_ascii=False), json.dumps(block, ensure_ascii=False)),
        )
        # 快照有寫入（新的、或欄位比較多的）才跟著更新玩家欄位，比較少的那份不能蓋掉
        if cur.rowcount > 0:
            _store_eog_players(conn, block)
    return cur.rowcount > 0, keys


def start_run(conn, trigger):
    with conn:
        cur = conn.execute(
            "INSERT INTO ingest_runs (started_at, trigger) VALUES (?,?)",
            (int(time.time()), trigger),
        )
    return cur.lastrowid


def finish_run(conn, run_id, seen, new, error=None):
    with conn:
        conn.execute(
            """UPDATE ingest_runs
               SET finished_at = ?, games_seen = ?, games_new = ?, error = ?
               WHERE id = ?""",
            (int(time.time()), seen, new, error, run_id),
        )


# ── 逐幀時間軸 ──────────────────────────────────────────────────────────────

def store_timeline(conn, platform_id, game_id, timeline):
    """存一場的時間軸（zlib 壓縮的原始 JSON）。已經有就不動，回傳有沒有寫入。"""
    if not game_id or not isinstance(timeline, dict) or not timeline.get("frames"):
        return False
    raw = zlib.compress(json.dumps(timeline, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 6)
    with conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO match_timelines (platform_id, game_id, fetched_at, frames, raw_gz) VALUES (?,?,?,?,?)",
            (platform_id or "", game_id, int(time.time()), len(timeline["frames"]), raw),
        )
    return cur.rowcount > 0


def load_timeline(conn, platform_id, game_id):
    row = conn.execute(
        "SELECT raw_gz FROM match_timelines WHERE platform_id = ? AND game_id = ?", (platform_id or "", game_id)
    ).fetchone()
    return json.loads(zlib.decompress(row[0])) if row else None


def games_missing_timeline(conn, limit=10):
    """開始收時間軸之後入庫、但還沒有時間軸的場次（新的在前），給採集器重試用。"""
    since = conn.execute("SELECT value FROM kv WHERE key = 'timeline_since'").fetchone()
    if not since:
        return []
    return [
        (row[0], row[1])
        for row in conn.execute(
            """SELECT m.platform_id, m.game_id FROM matches m
               WHERE m.ingested_at >= ? AND NOT EXISTS (
                 SELECT 1 FROM match_timelines t WHERE t.platform_id = m.platform_id AND t.game_id = m.game_id)
               ORDER BY m.game_creation DESC LIMIT ?""",
            (int(since[0]), limit),
        )
    ]


# ── 選角過程 ────────────────────────────────────────────────────────────────

def champ_select_compact(session):
    """選角 session 裡分析要用的部分。比對前後兩份有沒有變，只看這些欄位（計時器每秒都在變，不算）。"""
    timer = session.get("timer") or {}
    return {
        "phase": timer.get("phase"),
        "localCell": session.get("localPlayerCellId"),
        "rerolls": session.get("rerollsRemaining"),
        "myTeam": [
            {
                "cell": m.get("cellId"),
                "puuid": m.get("puuid") or None,
                "champ": m.get("championId") or 0,
                "intent": m.get("championPickIntent") or 0,
            }
            for m in sorted(session.get("myTeam") or [], key=lambda m: m.get("cellId") or 0)
        ],
        "bench": [b.get("championId") for b in session.get("benchChampions") or [] if b.get("championId")],
        "trades": sorted(
            ({"cell": t.get("cellId"), "state": t.get("state")} for t in session.get("trades") or []),
            key=lambda t: (t["cell"] or 0, t["state"] or ""),
        ),
    }


def store_champ_select(conn, session, now=None):
    """記一筆選角快照：和上一筆內容一樣就只更新時間與完整 session。回傳有沒有新增快照。
    gameId 還沒出現（0 或沒有）的 session 不存，下一輪再看。"""
    game_id = session.get("gameId")
    if not game_id:
        return False
    now = int(now if now is not None else time.time())
    snap = {"t": now, **champ_select_compact(session)}
    raw = json.dumps(session, ensure_ascii=False, separators=(",", ":"))
    with conn:
        row = conn.execute("SELECT snapshots FROM champ_select_sessions WHERE game_id = ?", (game_id,)).fetchone()
        if row is None:
            conn.execute(
                "INSERT INTO champ_select_sessions (game_id, started_at, updated_at, snapshots, raw_last) VALUES (?,?,?,?,?)",
                (game_id, now, now, json.dumps([snap], ensure_ascii=False), raw),
            )
            return True
        snaps = json.loads(row[0])
        last = {k: v for k, v in snaps[-1].items() if k != "t"} if snaps else None
        changed = last != {k: v for k, v in snap.items() if k != "t"}
        if changed:
            snaps.append(snap)
        conn.execute(
            "UPDATE champ_select_sessions SET updated_at = ?, snapshots = ?, raw_last = ? WHERE game_id = ?",
            (now, json.dumps(snaps, ensure_ascii=False), raw, game_id),
        )
    return changed
