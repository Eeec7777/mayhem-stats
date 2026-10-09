"""本機 League 客戶端 (LCU) 存取層。

lockfile 每次客戶端重啟都會換 port 和 password,所以連線物件都是用完即棄,
每次採集重新建立,不做長連線快取。
"""

import base64
import glob
import os
import platform
import re
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

MAYHEM_QUEUE_ID = 2400
PAGE_SIZE = 100


class LCUUnavailable(Exception):
    """客戶端沒開、找不到 lockfile,或連不上本機 API。"""


def default_lockfile_candidates():
    system = platform.system()
    candidates = []
    if system == "Windows":
        candidates.append(r"C:\Riot Games\League of Legends\lockfile")
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        if local_appdata:
            candidates.append(os.path.join(local_appdata, "Riot Games", "League of Legends", "lockfile"))
        for drive in "DEFGH":
            candidates.append(rf"{drive}:\Riot Games\League of Legends\lockfile")
    elif system == "Darwin":
        candidates.append("/Applications/League of Legends.app/Contents/LoL/lockfile")
    else:
        candidates += glob.glob(os.path.expanduser("~/Games/league-of-legends/**/lockfile"), recursive=True)
    return candidates


def find_lockfile(override_path=None):
    if override_path:
        return override_path if os.path.isfile(override_path) else None
    for path in default_lockfile_candidates():
        if os.path.isfile(path):
            return path
    return None


def read_lockfile(path):
    content = Path(path).read_text(encoding="utf-8").strip()
    parts = content.split(":")
    if len(parts) != 5:
        raise ValueError(f"lockfile 格式不正確: {content!r}")
    _, _pid, port, password, protocol = parts
    return port, password, protocol


class LCUClient:
    def __init__(self, port, password, protocol="https"):
        self.base = f"{protocol}://127.0.0.1:{port}"
        token = base64.b64encode(f"riot:{password}".encode()).decode()
        self.headers = {"Authorization": f"Basic {token}"}

    @classmethod
    def connect(cls, override_path=None):
        path = find_lockfile(override_path)
        if not path:
            raise LCUUnavailable("找不到 lockfile,League 客戶端可能沒有執行。")
        port, password, protocol = read_lockfile(path)
        client = cls(port, password, protocol)
        client.lockfile_path = path
        return client

    def get(self, path, params=None, timeout=15):
        try:
            resp = requests.get(
                self.base + path, headers=self.headers, params=params,
                verify=False, timeout=timeout,
            )
        except requests.exceptions.RequestException as exc:
            raise LCUUnavailable(f"連不到本機客戶端 API: {exc}") from exc
        resp.raise_for_status()
        return resp.json()

    def current_summoner(self):
        return self.get("/lol-summoner/v1/current-summoner")

    def gameflow_phase(self):
        return self.get("/lol-gameflow/v1/gameflow-phase")

    def recent_matches(self):
        """最新 100 場。

        注意:這支 API 的 begIndex/endIndex 在目前的客戶端版本會被忽略,
        永遠回傳最新 100 場,所以這裡不做翻頁——翻頁拿到的是同一批資料。
        """
        data = self.get(
            "/lol-match-history/v1/products/lol/current-summoner/matches",
            params={"begIndex": 0, "endIndex": PAGE_SIZE - 1},
        )
        return data.get("games", {}).get("games", [])

    def matches_by_puuid(self, puuid):
        """查指定玩家的對戰紀錄。

        實測別人的紀錄只回傳最新 20 場(自己是 100),而且和自己的清單一樣
        只含該玩家本人;要拿到完整 10 人一樣得再打明細端點。
        """
        data = self.get(f"/lol-match-history/v1/products/lol/{puuid}/matches")
        return data.get("games", {}).get("games", [])

    def game_detail(self, game_id):
        """單場完整明細,包含全部 10 名玩家(清單 API 只給自己一個人)。"""
        return self.get(f"/lol-match-history/v1/games/{game_id}")

    def eog_stats_block(self):
        """賽後統計（賽後畫面那一份）。只有賽後畫面存在時才有，其他時候回 404（raise_for_status 的 HTTPError），
        呼叫端自己處理。對局明細端點沒有治療／護盾隊友的量，這一份有沒有，要打完一場才知道。"""
        return self.get("/lol-end-of-game/v1/eog-stats-block")

    def game_timeline(self, game_id):
        """逐幀時間軸：每分鐘一格（每位參賽者的經濟、經驗、位置），加上擊殺、拆建築、買賣裝等帶時間戳的事件。
        連很舊的場次都抓得到（2026-10 實測）；參賽者身上的 timeline 欄位是空的，要打這個端點。"""
        return self.get(f"/lol-match-history/v1/game-timelines/{game_id}", timeout=30)

    def champ_select_session(self):
        """選角階段的 session：雙方陣容、板凳英雄、重抽次數、交換請求。不在選角時回 404（HTTPError），呼叫端自己處理。"""
        return self.get("/lol-champ-select/v1/session")

    def asset(self, name):
        return self.get(f"/lol-game-data/assets/v1/{name}.json")


def _icon(row, *keys):
    for key in keys:
        if row.get(key):
            return row[key]
    return None


# 裝備說明 <stats> 區塊裡的數值名稱 → 固定的英文鍵。說明文字跟著客戶端語言走，
# 存成固定鍵，語意層的規則才不會因為換語言就失效。沒列到的數值（金錢、每 5 秒回復…）不存。
_STAT_KEYS = {
    "物理攻擊": "AttackDamage", "Attack Damage": "AttackDamage",
    "魔法攻擊": "AbilityPower", "Ability Power": "AbilityPower",
    "生命": "Health", "Health": "Health",
    "物理防禦": "Armor", "Armor": "Armor",
    "魔法防禦": "MagicResist", "Magic Resist": "MagicResist",
    "攻擊速度": "AttackSpeed", "Attack Speed": "AttackSpeed",
    "暴擊率": "CritChance", "Critical Strike Chance": "CritChance",
    "暴擊傷害": "CritDamage", "Critical Strike Damage": "CritDamage",
    "物理致命": "Lethality", "Lethality": "Lethality",
    "物理穿透": "ArmorPenetration", "Armor Penetration": "ArmorPenetration",
    "魔法穿透": "MagicPenetration", "Magic Penetration": "MagicPenetration",
    "技能加速": "AbilityHaste", "Ability Haste": "AbilityHaste",
    "跑速": "MoveSpeed", "Move Speed": "MoveSpeed",
    "魔力": "Mana", "Mana": "Mana",
    "普攻吸血": "LifeSteal", "Life Steal": "LifeSteal",
    "全能吸血": "Omnivamp", "Omnivamp": "Omnivamp",
    "治療及護盾強度": "HealShieldPower", "Heal and Shield Power": "HealShieldPower",
    "韌性": "Tenacity", "Tenacity": "Tenacity",
    "基礎魔力回復": "BaseManaRegen", "Base Mana Regen": "BaseManaRegen",
    "基礎生命回復": "BaseHealthRegen", "Base Health Regen": "BaseHealthRegen",
    "適性之力": "AdaptiveForce", "Adaptive Force": "AdaptiveForce",
}


def _item_stats(description):
    """從裝備說明的 <stats> 取出數值，例如妖夢 → {"AttackDamage": 55, "Lethality": 18, "MoveSpeed": 4}。"""
    m = re.search(r"<stats>(.*?)</stats>", description or "", re.S)
    stats = {}
    for part in (m.group(1).split("<br>") if m else []):
        text = re.sub(r"<[^>]+>", "", part).strip()
        mm = re.match(r"([\d.]+)%?\s*(.+)", text)
        if mm and mm.group(2).strip() in _STAT_KEYS:
            stats[_STAT_KEYS[mm.group(2).strip()]] = float(mm.group(1))
    return stats


def fetch_dimensions(client):
    """抓英雄/增幅/裝備/符文/召喚師技能的名稱對照表。"""
    champions = [
        {"id": c["id"], "name": c.get("name"), "alias": c.get("alias"),
         "icon_path": _icon(c, "squarePortraitPath"),
         # 一隻英雄可能同時是 mage 和 support,存成長格式(一列一個定位)。
         # 英雄層級的樣本太薄(57 隻攤 108 場),用定位分組才看得出差異。
         "roles": [r for r in (c.get("roles") or []) if r]}
        for c in client.asset("champion-summary") if c.get("id", -1) > 0
    ]
    augments = [
        {"id": a["id"], "name": a.get("nameTRA") or a.get("name"),
         "rarity": a.get("rarity"), "icon_path": _icon(a, "augmentSmallIconPath", "iconPath")}
        for a in client.asset("cherry-augments")
    ]
    # 裝備的類別（Damage、SpellDamage、Health、Armor…）與總價一起存：
    # 英雄的官方定位看不出這場實際怎麼出（「鬥士」有一半是出純輸出裝），
    # 出裝定位要靠這兩個欄位，依各類別花了多少錢來分。
    items = [
        {"id": i["id"], "name": i.get("name"), "icon_path": _icon(i, "iconPath"),
         "price_total": i.get("priceTotal"),
         "categories": [c for c in (i.get("categories") or []) if c],
         # 類別分不出刺客裝：ArmorPenetration 同時貼在妖夢（物理致命）與蒐集者（暴擊）上，要看實際數值
         "stats": _item_stats(i.get("description"))}
        for i in client.asset("items")
    ]
    perks = [
        {"id": p["id"], "name": p.get("name"), "icon_path": _icon(p, "iconPath")}
        for p in client.asset("perks")
    ]
    spells = [
        {"id": s["id"], "name": s.get("name"), "icon_path": _icon(s, "iconPath")}
        for s in client.asset("summoner-spells")
    ]
    return {
        "dim_champions": champions,
        "dim_augments": augments,
        "dim_items": items,
        "dim_perks": perks,
        "dim_spells": spells,
    }
