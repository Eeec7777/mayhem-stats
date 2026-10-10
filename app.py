"""ARAM: Mayhem 個人戰績採集 + BI 分析

在本機執行,持續把 League 客戶端的對戰紀錄收進 SQLite,並提供多維度分析前端。

為什麼要「持續採集」:客戶端的本機 API 只回傳最新 100 場(begIndex/endIndex
在目前版本會被忽略),而 Mayhem 的資料被 Riot 排除在公開 API 之外,
所以一旦對局被擠出那 100 場的視窗,就永遠拿不回來了。

用法:
    uv sync
    uv run app.py
    開瀏覽器到 http://127.0.0.1:5057
"""

import asyncio
import hashlib
import html
import json
import os
import urllib.parse
import secrets
import sqlite3
import sys
import time
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import Optional

import requests
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import collector as collector_module
from change_events import ChangeEvents
import cube_process
import db
import features
import icons
import lcu

BASE_DIR = Path(__file__).parent
collector = collector_module.Collector()
change_events = ChangeEvents()

# ── 對外開放模式 ────────────────────────────────────────────────────
# 服務本身只綁 127.0.0.1,外面要連進來一定是透過通道(Tailscale / ngrok /
# Cloudflare Tunnel)。通道那頭「拿到網址的人就是你」,所以對外開放前打開這個:
#
#     set MAYHEM_PUBLIC=1  &&  uv run app.py        (PowerShell: $env:MAYHEM_PUBLIC=1)
#
# 它做兩件事:
#   1. 全站唯讀——採集與追蹤對象這兩個寫入端點一律回 403。採集照常在本機自動跑,
#      要改追蹤對象就在這台電腦上開 127.0.0.1:5057。
#   2. 其他玩家的 Riot ID 換成穩定代號(預設開,見 MAYHEM_MASK_NAMES)。
#
#   3. 設了 MAYHEM_PASSWORD 的話,外面要先輸入密碼才看得到任何東西。
#      這一層是必要的:免費的通道服務(ngrok 免費版、Cloudflare Quick Tunnel、
#      Tailscale Funnel)都給你一個「誰拿到網址誰就能看」的公開網址,
#      沒有自己的網域就掛不上它們的身分驗證,所以驗證只能做在這裡。
#
# 沒設這個變數時行為完全不變,本機使用不受影響。
PUBLIC = os.environ.get("MAYHEM_PUBLIC", "").strip().lower() in {"1", "true", "yes", "on"}
PASSWORD = os.environ.get("MAYHEM_PASSWORD", "").strip()

# 鏡像實例:和本機那份共用同一個資料庫,但只讀。
#
#     $env:MAYHEM_PUBLIC="1"; $env:MAYHEM_PASSWORD="…"; $env:MAYHEM_PORT="5058"
#     $env:MAYHEM_MIRROR="1"; uv run app.py
#
# 這樣就能「對外唯讀＋代號、本機照舊可寫＋真名」同時成立——通道只指向鏡像那個埠。
# 公開模式的旗標是整個行程的(通道進來的請求來源也是 127.0.0.1,分不出誰是誰),
# 所以要兩種行為就得跑兩個行程。
#
# 鏡像不做這三件事,那些都是本機那份的工作:
#   1. 採集迴圈——兩份同時採集只是重複打客戶端,而且寫入會互相卡。
#   2. 建表與遷移——同時跑 schema 變更是自找麻煩。
#   3. 啟動與關閉 Cube——它會沿用 4000 埠上現有的那份;若由鏡像管理,
#      鏡像一關就把本機那份的語意層也一起帶走。
# 要不要把其他玩家的 Riot ID 換成代號。預設跟著公開模式走:
# 同場玩家的名稱是別人的遊戲帳號,不該因為網址被開出去就一起公開,所以預設遮。
#
# 但如果這個站台是給「同一群一起打的人」看的——他們要用名字查自己的戰績——
# 遮了反而沒得用。那種情況設 MAYHEM_MASK_NAMES=0 關掉,
# 前提是你已經用密碼把站台鎖起來:看得到名字的只有拿到密碼的人。
_mask_env = os.environ.get("MAYHEM_MASK_NAMES", "").strip().lower()
MASK_NAMES = PUBLIC if _mask_env == "" else _mask_env in {"1", "true", "yes", "on"}

MIRROR = os.environ.get("MAYHEM_MIRROR", "").strip().lower() in {"1", "true", "yes", "on"}
PORT = int(os.environ.get("MAYHEM_PORT", "5057"))

# 代號要跨重啟穩定,否則同一個人每次重開都換一個名字,隊友分析就沒得看了。
# 隨機鹽只存在本機(不進版控),換掉它等於把所有代號重新洗一次。
_SALT_FILE = BASE_DIR / ".public_salt"
_my_names_cache: Optional[set] = None


def _name_salt() -> bytes:
    if not _SALT_FILE.is_file():
        _SALT_FILE.write_bytes(secrets.token_bytes(16))
    return _SALT_FILE.read_bytes()


def _my_names() -> set:
    """本機帳號的名稱不遮——那是你自己的資料,你自己決定要不要露出來。"""
    global _my_names_cache
    if _my_names_cache is None:
        conn = db.connect()
        try:
            _my_names_cache = {
                row["riot_id"]
                for row in conn.execute("SELECT riot_id FROM accounts WHERE is_me = 1")
                if row["riot_id"]
            }
        finally:
            conn.close()
    return _my_names_cache


def mask_name(riot_id):
    """公開模式下把別人的 Riot ID 換成「玩家 A1B2」這種穩定代號。

    用帶鹽的雜湊而不是流水號:流水號要另外維護對照表,而且換個查詢順序就會變。
    六位十六進位不是密碼學等級的匿名——知道鹽又剛好猜中某個 Riot ID 的人可以自己算來對照——
    但它做到最重要的事:回應裡不再帶著別人的遊戲帳號。真的不能外流就別用公開模式。
    """
    if not MASK_NAMES or not riot_id or riot_id in _my_names():
        return riot_id
    # 三個位元組(六位十六進位)：資料庫裡已經有一千七百多個玩家，
    # 兩位元組只有 65536 種，依生日問題會撞出二十幾組同名代號，隊友分析就會把兩個人混成一個。
    digest = hashlib.blake2s(riot_id.encode("utf-8"), key=_name_salt(), digest_size=3).hexdigest().upper()
    return f"玩家 {digest}"


# Cube 回應裡會帶名稱的成員。公開模式下在代理這一層換掉,
# 前端和語意層都不用改——語意層本來就該回真名,遮不遮是對外開放的決定。
MASKED_MEMBERS = (".riot_id", ".player")


def mask_cube(payload):
    if not MASK_NAMES:
        return payload
    if isinstance(payload, dict):
        return {
            k: (mask_name(v) if isinstance(v, str) and k.endswith(MASKED_MEMBERS) else mask_cube(v))
            for k, v in payload.items()
        }
    if isinstance(payload, list):
        return [mask_cube(x) for x in payload]
    return payload


# ── 登入 ────────────────────────────────────────────────────────────
# 兩種方式,都只在公開模式下生效:
#   1. Discord 登入(.public_oauth):每個人是獨立身分,踢人就是把名字從白名單拿掉。
#   2. 共用密碼(MAYHEM_PASSWORD):沒有個別身分,外流就得全體換。留著當備援用。
# session 存在 .public_state.db(不進版控),重啟鏡像不必重新登入。
# 磁碟上只放 token 的 SHA-256:檔案外流也拿不到能塞進 cookie 的東西。
#
# session 會活很久,所以「踢人」不能只在登入那一刻生效——每次請求都重新對照設定檔:
#   - 靠白名單進來的:名字或 ID 從 allow 拿掉,下一個請求就進不來。
#   - 靠群組進來的:離開群組這件事只有 Discord 知道,不存他的 Discord token 就問不到,
#     所以 session 只給 GUILD_SESSION_MAX_AGE,到期重按一次 Discord 登入(會重新檢查群組)。
#   - 寫進 deny 的:不管怎麼進來的,立刻失效。
SESSION_COOKIE = "mayhem_session"
SESSION_MAX_AGE = 30 * 86400
GUILD_SESSION_MAX_AGE = 7 * 86400
# 每個人最多綁幾個 Riot 帳號(大號、小號)。只是防表無限長,不是安全邊界。
MAX_LINKS = 5
STATE_DB = BASE_DIR / ".public_state.db"


_state_ready = False


def _state_db():
    """獨立的小資料庫,不放進 mayhem.db:鏡像不動主資料庫的 schema,也不寫它。"""
    global _state_ready
    conn = sqlite3.connect(STATE_DB, timeout=5)
    conn.row_factory = sqlite3.Row
    if not _state_ready:
        conn.executescript(
            """CREATE TABLE IF NOT EXISTS sessions (
                   token_hash TEXT PRIMARY KEY,
                   issued REAL NOT NULL,
                   discord_id TEXT,          -- 共用密碼登入時是 NULL
                   name TEXT,
                   username TEXT,            -- Discord 的唯一使用者名稱,對照白名單用
                   via TEXT);                -- list / guild:當初憑什麼放行
               CREATE TABLE IF NOT EXISTS links (
                   discord_id TEXT NOT NULL,
                   puuid TEXT NOT NULL,
                   PRIMARY KEY (discord_id, puuid));"""
        )
        # 舊版建的表少這兩欄。舊 session 的 via 是 NULL,當成群組放行處理(期限較短的那種)。
        have = {r["name"] for r in conn.execute("PRAGMA table_info(sessions)")}
        for col in ("username", "via"):
            if col not in have:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")
        conn.commit()
        _state_ready = True
    return conn


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _save_session(
    token: str,
    discord_id: Optional[str] = None,
    name: Optional[str] = None,
    username: Optional[str] = None,
    via: Optional[str] = None,
):
    now = time.time()
    with closing(_state_db()) as conn, conn:
        conn.execute("DELETE FROM sessions WHERE issued < ?", (now - SESSION_MAX_AGE,))
        conn.execute(
            "INSERT INTO sessions (token_hash, issued, discord_id, name, username, via)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (_hash_token(token), now, discord_id, name, username, via),
        )


def _still_allowed(row: dict) -> bool:
    """Discord 登入的 session 在這一刻還該不該放行。說明見本節開頭。"""
    cfg = oauth_config()
    if not cfg:
        return False  # 設定檔被拿掉或壞掉:寧可全部登出,也不要沿用舊的放行
    ident = {"id": row["discord_id"], "username": row["username"] or ""}
    if _matches(cfg.get("deny", []), ident):
        return False
    if _matches(cfg.get("allow", []), ident):
        return True
    return (
        row["via"] != "list"
        and bool(str(cfg.get("allow_guild") or "").strip())
        and time.time() - row["issued"] <= GUILD_SESSION_MAX_AGE
    )


def _session(request: Request) -> Optional[dict]:
    """目前這個請求的登入身分;沒登入、過期或已被踢掉回 None。"""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    with closing(_state_db()) as conn:
        row = conn.execute(
            "SELECT issued, discord_id, name, username, via FROM sessions WHERE token_hash = ?",
            (_hash_token(token),),
        ).fetchone()
    if row is None or time.time() - row["issued"] > SESSION_MAX_AGE:
        return None
    row = dict(row)
    if row["discord_id"] and not _still_allowed(row):
        return None
    return row


def _viewer_links(request: Request) -> Optional[set]:
    """公開模式下用 Discord 登入的人自己綁定的 puuid。
    不是這種情況(本機、共用密碼)回 None,呼叫端沿用 accounts.is_me。"""
    if not PUBLIC:
        return None
    who = _session(request)
    if not who or not who["discord_id"]:
        return None
    with closing(_state_db()) as conn:
        return {r["puuid"] for r in conn.execute(
            "SELECT puuid FROM links WHERE discord_id = ?", (who["discord_id"],)
        )}

# 通道後面的請求來源一律是 127.0.0.1(通道程式自己),所以按來源 IP 限制沒有意義,
# 改成全域的失敗計數:連續失敗到上限就整站冷卻,把線上暴力猜解壓到不可行。
LOGIN_MAX_FAILS = 10
LOGIN_COOLDOWN = 300
_login_fails: list = []

# Discord OAuth。設定檔不進版控,格式:
#   { "client_id": "...", "client_secret": "...",
#     "allow": ["朋友的discord帳號", "另一個", "123456789012345678"],
#     "deny": ["123456789012345678"],     ← 立刻踢掉,連群組放行也不算(可省略)
#     "allow_guild": "伺服器ID",          ← 這個群的成員都放行(可省略)
#     "allow_roles": ["身分組ID", ...],   ← 再限定到某些身分組(可省略)
#     "redirect_uri": "https://…/auth/callback"   ← 可省略,省略時依請求的網域推出來
#   }
# allow / deny 可以寫 Discord 的使用者名稱(username,全站唯一)或數字 ID。
# 不比對顯示名稱(global_name):那是誰都能改成一樣的字,拿來放行等於沒鎖。
# 被擋下來的人畫面上會直接顯示他的 ID,你複製進白名單就好。
#
# allow_guild 用的是 guilds.members.read 而不是 guilds:前者只問「他在不在這一個群」,
# 後者會把他加入的所有伺服器清單都拿回來——放行一個群不需要知道他還加了哪些群。
OAUTH_FILE = BASE_DIR / ".public_oauth"
DISCORD_AUTH = "https://discord.com/oauth2/authorize"
DISCORD_TOKEN = "https://discord.com/api/oauth2/token"
DISCORD_ME = "https://discord.com/api/users/@me"
DISCORD_GUILD_MEMBER = "https://discord.com/api/users/@me/guilds/{guild}/member"
# state 防的是「別人把他自己的授權碼塞給你的瀏覽器」。存在記憶體、十分鐘過期。
# 另外設一個上限:/auth/start 不需要登入,有人反覆打它就會一直長,
# 十分鐘的過期時間擋不住高速的請求(實測外部可以打到每秒 175 次)。
#
# state 同時寫進發起登入那個瀏覽器的 cookie,回來時兩邊要對得上。
# 只存在伺服器的話,任何人拿到的 state 都通用:別人可以自己跑完授權,
# 再把 /auth/callback?code=…&state=… 丟給你點,讓你的瀏覽器登入成他的身分。
STATE_MAX_AGE = 600
MAX_STATES = 500
STATE_COOKIE = "mayhem_oauth_state"
_states: dict = {}
_oauth_cache: tuple = (None, {})


def oauth_config() -> dict:
    """依檔案修改時間快取:加一個朋友只要改檔案,不必重啟服務;
    但每個請求都要對照白名單,所以不能每次都重新解析。"""
    global _oauth_cache
    try:
        mtime = OAUTH_FILE.stat().st_mtime_ns
    except OSError:
        return {}
    if _oauth_cache[0] == mtime:
        return _oauth_cache[1]
    try:
        cfg = json.loads(OAUTH_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        print(f"讀不到 {OAUTH_FILE.name}: {exc}")
        cfg = {}
    cfg = cfg if isinstance(cfg, dict) and cfg.get("client_id") and cfg.get("client_secret") else {}
    _oauth_cache = (mtime, cfg)
    return cfg


OAUTH_ENABLED = bool(oauth_config())

# 公開模式卻沒有任何登入方式時,require_login 會整個放行——那就是一個誰都能看的公開網址。
# 最常見的成因不是故意的:.public_oauth 的 JSON 少了一個逗號,讀檔失敗就等於沒設。
# 所以直接拒絕啟動,讓錯誤出現在 mirror.log 裡,而不是悄悄把資料開出去。
if PUBLIC and not (PASSWORD or OAUTH_ENABLED):
    raise SystemExit(
        f"公開模式需要登入方式:{OAUTH_FILE.name} 讀不到(檔案不存在或 JSON 格式錯誤),"
        "也沒有設 MAYHEM_PASSWORD。不啟動。"
    )


def _matches(entries, user: dict) -> bool:
    """名單比對:使用者名稱或數字 ID,大小寫不計。刻意不含顯示名稱,見上面的說明。"""
    wanted = {str(x).strip().lower() for x in entries if str(x).strip()}
    candidates = {str(user.get("id") or "").lower(), str(user.get("username") or "").lower()}
    return bool(wanted & (candidates - {""}))


def _on_list(cfg: dict, user: dict) -> bool:
    return _matches(cfg.get("allow", []), user)


def _guild_ok(cfg: dict, member: Optional[dict]) -> bool:
    """群組放行:是那個群的成員就算過;有指定身分組時還要有其中一個。"""
    if member is None:
        return False
    roles = {str(r) for r in cfg.get("allow_roles", []) if str(r).strip()}
    return not roles or bool(roles & {str(r) for r in member.get("roles", [])})


def _fetch_member(cfg: dict, token: str) -> Optional[dict]:
    """問 Discord「這個人在不在指定的那個群」。不在(403/404)就回 None。"""
    guild = str(cfg.get("allow_guild") or "").strip()
    if not guild:
        return None
    resp = requests.get(
        DISCORD_GUILD_MEMBER.format(guild=guild),
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    if resp.status_code in (403, 404):
        return None
    resp.raise_for_status()
    return resp.json()


def _redirect_uri(request: Request, cfg: dict) -> str:
    if cfg.get("redirect_uri"):
        return cfg["redirect_uri"]
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", f"127.0.0.1:{PORT}")
    return f"{proto}://{host}/auth/callback"

LOGIN_PAGE = """<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mayhem 戰績</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100dvh; display:grid; place-items:center;
         background:#0e1420; color:#eef1f8;
         font-family:-apple-system,"Segoe UI","PingFang TC","Noto Sans TC",sans-serif }
  form { width:min(320px,90vw); display:grid; gap:12px }
  h1 { font-size:18px; margin:0 0 4px }
  p { margin:0; font-size:13px; color:#8d96ac }
  input,button { font:inherit; padding:10px 12px; border-radius:8px; border:1px solid #2a3446 }
  input { background:#161d2c; color:inherit }
  button { background:#22d3ee; color:#0e1420; font-weight:600; border:0; cursor:pointer }
  a.btn { display:block; text-align:center; text-decoration:none;
          background:#5865F2; color:#fff; font-weight:600; padding:10px 12px; border-radius:8px }
  .err { color:#ff6b6b; font-size:13px; min-height:18px }
  .hint { font-size:12px; color:#8d96ac; word-break:break-all }
</style></head>
<body><form id="f">
  <h1>Mayhem 戰績</h1>
  __INTRO__
  __DISCORD__
  __PASSWORD__
  <div class="err" id="e"></div>
</form>
<script>
const form = document.getElementById("f")
const pw = document.getElementById("p")
if (pw) form.addEventListener("submit", async (ev) => {
  ev.preventDefault()
  const e = document.getElementById("e")
  e.textContent = ""
  const res = await fetch("/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: pw.value }),
  })
  if (res.ok) location.replace("/")
  else e.textContent = (await res.json()).error || "登入失敗"
})
</script></body></html>"""


def login_page(note: str = "") -> str:
    """依目前設定組出登入頁:有 Discord 就放按鈕,有密碼就放輸入框。"""
    discord = '<a class="btn" href="/auth/start">用 Discord 登入</a>' if OAUTH_ENABLED else ""
    password = (
        '<input id="p" type="password" autocomplete="current-password" placeholder="密碼">'
        '<button>進入</button>'
        if PASSWORD else ""
    )
    intro = note or (
        "<p>用 Discord 登入。只有白名單上的帳號進得來。</p>" if OAUTH_ENABLED
        else "<p>這個站台需要密碼。</p>"
    )
    return (
        LOGIN_PAGE.replace("__INTRO__", intro)
        .replace("__DISCORD__", discord)
        .replace("__PASSWORD__", password)
    )


def _logged_in(request: Request) -> bool:
    return _session(request) is not None


def readonly_error():
    return JSONResponse(
        status_code=403,
        content={"error": "這個站台目前是對外開放的唯讀模式,不接受寫入。請在本機開 127.0.0.1:5057 操作。"},
    )


def _normal_priority():
    """把自己的優先權拉回「正常」。要在啟動 Cube 之前做，Cube 才會跟著繼承。

    排程工作預設的優先權是 7，行程會以「低於正常」執行，由它帶起來的 Cube 也一樣。
    只要有正常優先權的程式在吃 CPU——瀏覽器正在畫圖表、英雄聯盟客戶端——
    Python 和 Cube 就會被晾著：實測開頁面時 Cube 的主執行緒被卡住 40 次、合計 32 秒，
    最長 5.4 秒，同一頁的請求（連不經過 Cube 的 /api/status）全部跟著排隊。
    拉回正常之後同樣的測試是 0 次。改在這裡而不是改排程工作的設定：設定不在版控裡，
    重建排程工作就會回到預設值。"""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    # 要宣告成 HANDLE：預設的 int 會把 GetCurrentProcess() 的 -1 截成 32 位元，
    # 傳回去就變成無效的 handle（錯誤碼 6），而且是靜靜地失敗
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    NORMAL_PRIORITY_CLASS = 0x20
    if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), NORMAL_PRIORITY_CLASS):
        print(f"調整行程優先權失敗（錯誤碼 {kernel32.GetLastError()}），分析頁面在電腦忙碌時可能會卡住")


@asynccontextmanager
async def lifespan(app: FastAPI):
    _normal_priority()
    await change_events.start(mirror=MIRROR)
    if MIRROR:
        # 只讀的鏡像:不建表、不採集、不碰 Cube 的生命週期,查詢直接用 4000 埠上那份。
        print(f"鏡像模式(唯讀):埠 {PORT},共用本機的資料庫與 Cube")
        if not cube_process.port_open(cube_process.CUBE_PORT):
            print("  注意:Cube 沒在跑,分析頁面會查不到東西——請先啟動本機那份服務。")
        try:
            yield
        finally:
            change_events.stop()
        return

    db.init()
    # 衍生表（出裝定位、貢獻分數…）要在 Cube 起來之前就緒，cube 直接讀這些表。
    # 啟動時一律重建：yml 的規則改了、或上次重建失敗，重啟就會生效。見 features.py。
    try:
        print(f"衍生表重建 {await asyncio.to_thread(features.rebuild):.0f} ms")
    except Exception as exc:
        print(f"衍生表重建失敗（出裝定位、貢獻分數等頁面會查不到）: {type(exc).__name__}: {exc}")
    # Cube 由這裡一併拉起來：開機自動啟動只有一個排程工作，
    # 若要另外顧 Cube，重開機後分析頁面會壞掉而使用者不會馬上發現。
    print(await asyncio.to_thread(cube_process.start))

    async def warm_icons():
        # 背景暖快取，不擋啟動；客戶端沒開就直接跳過。
        # 連線必須開在工作執行緒裡——SQLite 預設不允許跨執行緒使用同一條連線。
        def run():
            conn = db.connect()
            try:
                return icons.warm(conn)
            finally:
                conn.close()

        try:
            warmed = await asyncio.to_thread(run)
            print(f"圖示快取已補 {warmed} 張" if warmed else "圖示快取已是最新")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # 不要靜默失敗：暖快取壞掉會讓人以為「圖就是很慢」而查不到原因
            print(f"圖示暖快取失敗: {type(exc).__name__}: {exc}")

    async def warm_cube():
        # 和圖示暖快取同樣的用意：把第一次查詢的成本挪到啟動時，
        # 使用者開頁面時就不必等 Cube 編譯 join 路徑。
        try:
            ok, total = await asyncio.to_thread(cube_process.warm)
            print(f"Cube 暖機完成 {ok}/{total} 條查詢路徑")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            print(f"Cube 暖機失敗: {type(exc).__name__}: {exc}")

    warm_task = asyncio.create_task(warm_icons())
    cube_warm_task = asyncio.create_task(warm_cube())
    collector.on_change = change_events.publish
    task = asyncio.create_task(collector.run_forever())
    try:
        yield
    finally:
        collector.on_change = None
        task.cancel()
        warm_task.cancel()
        cube_warm_task.cancel()
        cube_process.stop()
        change_events.stop()


app = FastAPI(title="ARAM: Mayhem 戰績 BI", lifespan=lifespan)


OPEN_PATHS = {"/login", "/auth/start", "/auth/callback"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """公開模式且設了 Discord 或密碼時,沒登入就什麼都看不到——包含前端本身與圖示。"""
    if not (PUBLIC and (PASSWORD or OAUTH_ENABLED)):
        return await call_next(request)
    if request.url.path in OPEN_PATHS or _logged_in(request):
        return await call_next(request)
    if request.url.path.startswith("/api/"):
        return JSONResponse(status_code=401, content={"error": "請先登入"})
    return HTMLResponse(login_page(), status_code=401)


# 回應壓縮，只給對外的鏡像。加在登入檢查之後＝包在最外層。
# 朋友是從外網經 Funnel 連進來的：圖表、表格套件各 1.1MB，玩家清單 267KB，原本全部原樣傳送，
# 壓完是 372KB、302KB、88KB。本機走 127.0.0.1 沒有頻寬問題，壓縮只是多花 CPU（1MB 約 40ms），所以不開。
# PNG 圖示在 Starlette 的預設排除清單裡，不會白壓一次。等級 6：和預設的 9 大小差不到 1%，稍快一些。
if PUBLIC:
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)


def _start_session(request: Request, who: str, discord_id: str, name: str, username: str, via: str):
    token = secrets.token_urlsafe(32)
    _save_session(token, discord_id, name, username, via)
    print(f"登入成功: {who}")
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(STATE_COOKIE)
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_MAX_AGE, httponly=True, samesite="lax",
        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https",
    )
    return response


@app.get("/auth/start")
async def auth_start(request: Request):
    cfg = oauth_config()
    if not cfg:
        return HTMLResponse(login_page("<p>這個站台沒有啟用 Discord 登入。</p>"), status_code=404)
    now = time.time()
    for old, issued in [(k, v) for k, v in _states.items() if now - v > STATE_MAX_AGE]:
        _states.pop(old, None)
    # 還是太多就從最舊的丟起(dict 保留插入順序)。被丟掉的人重按一次登入即可。
    while len(_states) >= MAX_STATES:
        _states.pop(next(iter(_states)), None)
    state = secrets.token_urlsafe(24)
    _states[state] = now
    params = urllib.parse.urlencode({
        "client_id": cfg["client_id"],
        "redirect_uri": _redirect_uri(request, cfg),
        "response_type": "code",
        # identify 只拿到 id / 使用者名稱 / 頭像,不要 email——白名單用不到,少拿一樣少一樣。
        # 有設群組放行才多要 guilds.members.read(只問指定的那一個群)。
        "scope": "identify guilds.members.read" if cfg.get("allow_guild") else "identify",
        "state": state,
    })
    response = RedirectResponse(f"{DISCORD_AUTH}?{params}", status_code=303)
    # Lax:從 Discord 導回來是頂層 GET 導覽,cookie 會帶上;別的網站在背景發的請求不會
    response.set_cookie(
        STATE_COOKIE, state,
        max_age=STATE_MAX_AGE, httponly=True, samesite="lax",
        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https",
    )
    return response


@app.get("/auth/callback")
async def auth_callback(request: Request, code: str = "", state: str = ""):
    cfg = oauth_config()
    if not cfg:
        return HTMLResponse(login_page("<p>這個站台沒有啟用 Discord 登入。</p>"), status_code=404)
    issued = _states.pop(state, None) if state else None
    mine = request.cookies.get(STATE_COOKIE) or ""
    if (
        issued is None
        or time.time() - issued > STATE_MAX_AGE
        or not secrets.compare_digest(mine.encode(), state.encode())
    ):
        # state 對不上:可能是別人把他的授權碼塞給你的瀏覽器,也可能只是放太久
        return HTMLResponse(login_page("<p>登入逾時或連結不對,請再試一次。</p>"), status_code=400)
    if not code:
        return HTMLResponse(login_page("<p>Discord 沒有回傳授權碼。</p>"), status_code=400)

    def exchange():
        token = requests.post(
            DISCORD_TOKEN,
            data={
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(request, cfg),
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=15,
        )
        token.raise_for_status()
        access = token.json()["access_token"]
        me = requests.get(DISCORD_ME, headers={"Authorization": f"Bearer {access}"}, timeout=15)
        me.raise_for_status()
        return me.json(), _fetch_member(cfg, access)

    try:
        user, member = await asyncio.to_thread(exchange)
    except (requests.exceptions.RequestException, KeyError, ValueError) as exc:
        print(f"Discord 登入失敗: {type(exc).__name__}: {exc}")
        return HTMLResponse(login_page("<p>和 Discord 交換憑證時失敗,請再試一次。</p>"), status_code=502)

    name = user.get("global_name") or user.get("username") or "?"
    by_list = _on_list(cfg, user)
    by_guild = _guild_ok(cfg, member)
    if not (by_list or by_guild):
        why = "不在指定的 Discord 群組裡" if cfg.get("allow_guild") else "不在白名單上"
        if cfg.get("allow_guild") and member is not None:
            why = "在那個群組裡,但沒有被允許的身分組"
        print(f"擋下 {name} (id {user.get('id')}): {why}")
        return HTMLResponse(
            login_page(
                f"<p>這個 Discord 帳號{why}。</p>"
                # 顯示名稱是對方自己取的,可以是 <script>——不跳脫就是一個在本站執行的 XSS
                f'<p class="hint">帳號：{html.escape(name)}<br>ID：{html.escape(str(user.get("id")))}</p>'
                "<p>把上面的帳號或 ID 給站長，或請他把你加進群組。</p>"
            ),
            status_code=403,
        )
    return _start_session(
        request,
        f"{name} (id {user.get('id')}) 透過 Discord（{'白名單' if by_list else '群組成員'}）",
        str(user.get("id")),
        name,
        str(user.get("username") or ""),
        "list" if by_list else "guild",
    )


@app.get("/logout")
async def logout(request: Request):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        with closing(_state_db()) as conn, conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(SESSION_COOKIE)
    return response


@app.post("/login")
async def login(request: Request):
    if not (PUBLIC and PASSWORD):
        return JSONResponse(status_code=404, content={"error": "這個站台沒有啟用密碼"})
    now = time.time()
    _login_fails[:] = [t for t in _login_fails if now - t < LOGIN_COOLDOWN]
    if len(_login_fails) >= LOGIN_MAX_FAILS:
        return JSONResponse(status_code=429, content={"error": "嘗試太多次,請等幾分鐘再試。"})
    try:
        supplied = (await request.json()).get("password") or ""
    except ValueError:
        supplied = ""
    # 定時比較:一般的 == 會因為提前返回而洩漏「前幾個字元對了」
    if not secrets.compare_digest(str(supplied), PASSWORD):
        _login_fails.append(now)
        return JSONResponse(status_code=401, content={"error": "密碼不對"})
    _login_fails.clear()
    token = secrets.token_urlsafe(32)
    _save_session(token)
    print("登入成功: 共用密碼")
    response = JSONResponse({"ok": True})
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_MAX_AGE, httponly=True, samesite="lax",
        # 通道那端是 HTTPS,但本機直連是 HTTP;跟著實際協定走,否則本機登入的 cookie 會被瀏覽器丟掉
        secure=request.headers.get("x-forwarded-proto", request.url.scheme) == "https",
    )
    return response


WEB_DIST = BASE_DIR / "web" / "dist"

if (WEB_DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")


@app.get("/")
def index():
    """優先送 React 的建置產物;沒有建置過就退回舊的單檔前端。

    dist/ 有一起進版控,所以執行期只需要 uv run app.py,不需要裝 npm。
    只有要改前端時才需要進 web/ 跑 npm run build。
    """
    built = WEB_DIST / "index.html"
    if built.is_file():
        return FileResponse(built)
    return FileResponse(BASE_DIR / "index.html")


# dist 根目錄的圖示（index.html 的分頁圖示引用 /favicon.svg）。只開這兩個固定檔名，
# 不把整個 dist 掛成靜態目錄——那樣 /index.html 之類的路徑會繞過下面頁面路由的白名單。
@app.get("/favicon.svg")
@app.get("/icons.svg")
def root_icon(request: Request):
    path = WEB_DIST / request.url.path.lstrip("/")
    if not path.is_file():
        return Response(status_code=404)
    return FileResponse(path, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


@app.get("/{page}")
def page_index(page: str):
    if page not in {"dashboard", "matches", "champions", "augments", "lineups", "players", "crew",
                    "time", "tilt", "losses", "explore", "recap", "tracked", "calc"}:
        return Response(status_code=404)
    return index()


@app.get("/api/status")
def status():
    return {**collector.snapshot(), "iconCache": icons.stats(), "public": PUBLIC}


@app.get("/api/calc/catalog")
def calc_catalog():
    """出裝計算機的候選裝備：大亂鬥裡實際有人買過（≥5 次）、有價格的裝備，附上數值與購買次數；
    另附增幅的名稱與圖示（計算機只用其中有寫規則的幾個）。

    用「有人買過」當作這個模式買得到的依據：裝備資料本身沒有標哪張地圖能買。"""
    conn = db.connect()
    try:
        rows = conn.execute(
            """SELECT i.id, i.name, i.icon_path, i.price_total, COUNT(*) AS buys
                 FROM participant_items pi
                 JOIN matches m USING (platform_id, game_id)
                 JOIN dim_items i ON i.id = pi.item_id
                WHERE m.queue_id = ? AND m.is_remake = 0 AND i.price_total > 0
                  -- 20 萬以上的編號是增幅給的道具（究極九頭蛇、烏莉特的法帽、黃金鍋鏟…），商店買不到
                  AND i.id < 200000
                GROUP BY i.id
               HAVING buys >= 5""",
            (lcu.MAYHEM_QUEUE_ID,),
        ).fetchall()
        stats = {}
        for r in conn.execute("SELECT item_id, stat, value FROM dim_item_stats"):
            stats.setdefault(r["item_id"], {})[r["stat"]] = r["value"]
        boots = {r[0] for r in conn.execute("SELECT item_id FROM dim_item_categories WHERE category = 'Boots'")}
        augments = [dict(r) for r in conn.execute("SELECT id, name, icon_path AS icon FROM dim_augments")]
    finally:
        conn.close()
    items = [
        {"id": r["id"], "name": r["name"], "icon": r["icon_path"], "price": r["price_total"],
         "buys": r["buys"], "boots": r["id"] in boots, "stats": stats.get(r["id"], {})}
        for r in rows
    ]
    return {"items": items, "augments": augments}


@app.get("/api/calc/live")
async def calc_live():
    """對局中的即時面板（遊戲本身的 2999 埠）。只在本機有意義：公開鏡像連到的會是站長正在打的那場，所以關掉。"""
    if PUBLIC:
        return readonly_error()
    game = await asyncio.to_thread(lcu.live_game)
    if game:
        conn = db.connect()
        try:
            icons_by_alias = {r["alias"]: r["icon_path"] for r in conn.execute("SELECT alias, icon_path FROM dim_champions")}
        finally:
            conn.close()
        for p in game["players"]:
            p["icon"] = icons_by_alias.get(p["champion"])
    return {"inGame": game is not None, **(game or {})}


@app.get("/api/events")
async def data_events():
    """資料寫入後直接推送；閒置時不查詢 SQLite。"""
    return StreamingResponse(change_events.stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache", "X-Accel-Buffering": "no",
    })


@app.post("/api/ingest")
async def ingest_now():
    if PUBLIC:
        return readonly_error()
    new = await collector._run_ingest("manual")
    return {"new": new, **collector.snapshot()}


@app.get("/api/players")
def list_players(request: Request):
    """資料庫裡出現過的所有玩家，給帳號快速切換用。本機帳號排最前面。

    公開模式下用 Discord 登入的人，「我」是他自己綁定的帳號，不是站長的——
    否則每個朋友打開都在看站長的數據，看自己的反而被標成「他人」。"""
    links = _viewer_links(request)
    conn = db.connect()
    try:
        rows = [dict(r) for r in conn.execute(
            """SELECT mp.puuid, mp.riot_id, COUNT(DISTINCT mp.game_id) AS games,
                      COALESCE(a.is_me, 0) AS is_me, COALESCE(a.tracked, 0) AS tracked
               FROM match_participants mp
               LEFT JOIN accounts a ON a.puuid = mp.puuid
               -- 重開局不算（matches.is_remake）
               WHERE NOT EXISTS (SELECT 1 FROM matches rm WHERE rm.platform_id = mp.platform_id AND rm.game_id = mp.game_id AND rm.is_remake = 1)
               GROUP BY mp.puuid
               ORDER BY is_me DESC, tracked DESC, games DESC"""
        )]
    finally:
        conn.close()
    # crew:好友比較頁要並排的那一群人——站長自己的帳號、追蹤中的好友、
    # 以及公開模式下登入者自己綁定的帳號。要在下面改寫 is_me 之前算:
    # 鏡像上 is_me 會換成登入者自己,站長的帳號就變成 0,不另外記會被漏掉。
    for row in rows:
        row["crew"] = int(bool(row["is_me"] or row["tracked"]) or (links is not None and row["puuid"] in links))
    if links is not None:
        for row in rows:
            row["is_me"] = int(row["puuid"] in links)
        rows.sort(key=lambda r: -r["is_me"])  # 穩定排序:其餘維持原本順序
    return {"players": [{**row, "riot_id": mask_name(row["riot_id"])} for row in rows]}


@app.get("/api/me")
def whoami(request: Request):
    """前端用來決定要不要顯示「這是我」:只有公開模式的 Discord 登入才能綁定。"""
    who = _session(request) if PUBLIC else None
    discord_id = who["discord_id"] if who else None
    return {
        "public": PUBLIC,
        "name": who["name"] if who else None,
        "canLink": bool(discord_id),
        "linked": sorted(_viewer_links(request) or []),
    }


class LinkBody(BaseModel):
    puuid: str
    linked: bool = True


@app.post("/api/me/link")
def link_account(body: LinkBody, request: Request):
    """把一個 Riot 帳號標成「我」。寫的是 .public_state.db,不是 mayhem.db,
    所以唯讀的鏡像也能用;影響範圍只有這個 Discord 使用者自己看到的畫面。"""
    who = _session(request) if PUBLIC else None
    if not who or not who["discord_id"]:
        return JSONResponse(status_code=403, content={"error": "只有用 Discord 登入時才能綁定帳號"})
    conn = db.connect()
    try:
        known = conn.execute(
            "SELECT 1 FROM match_participants WHERE puuid = ? LIMIT 1", (body.puuid,)
        ).fetchone()
    finally:
        conn.close()
    if not known:
        return JSONResponse(status_code=404, content={"error": "資料庫裡沒有這個玩家"})
    with closing(_state_db()) as state, state:
        if body.linked:
            count = state.execute(
                "SELECT COUNT(*) FROM links WHERE discord_id = ?", (who["discord_id"],)
            ).fetchone()[0]
            if count >= MAX_LINKS:
                return JSONResponse(status_code=400, content={"error": f"最多綁 {MAX_LINKS} 個帳號"})
            state.execute(
                "INSERT OR IGNORE INTO links (discord_id, puuid) VALUES (?, ?)",
                (who["discord_id"], body.puuid),
            )
        else:
            state.execute(
                "DELETE FROM links WHERE discord_id = ? AND puuid = ?", (who["discord_id"], body.puuid)
            )
    print(f"{who['name']} {'綁定' if body.linked else '解除'}帳號 {body.puuid[:8]}…")
    return whoami(request)


def _resolve_puuid(conn, puuid: Optional[str]) -> Optional[str]:
    """沒指定就用本機帳號。所有頁面預設看自己，但可以切換到別人。"""
    if puuid:
        return puuid
    row = conn.execute("SELECT puuid FROM accounts WHERE is_me = 1 LIMIT 1").fetchone()
    return row["puuid"] if row else None


# 下鑽路徑走到最後一層時一次送出的場次上限。對局 id 放在網址裡,
# 對局 id 目前是 9 位數,1000 個約 10KB——uvicorn(h11)整個請求標頭的上限是 16KB。
MAX_GAME_IDS = 1000
# /api/matches 一次可以指定幾位玩家(英雄頁的「追蹤對象」)
MAX_SUBJECTS = 50


@app.get("/api/matches")
def recent_matches(
    limit: int = 30,
    offset: int = 0,
    queue: Optional[int] = None,
    puuid: Optional[str] = None,
    date: Optional[str] = None,
    weekday: Optional[int] = None,
    hour_from: Optional[int] = None,
    hour_to: Optional[int] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    with_puuid: Optional[str] = None,
    relation: Optional[str] = None,
    champion: Optional[str] = None,
    augment: Optional[str] = None,
    game_ids: Optional[str] = None,
    participants: Optional[str] = None,
):
    """指定帳號的對局清單，預設是本機帳號。

    列表與單場明細都直接讀 SQLite,不經過 Cube——語意層是為了聚合而存在,
    逐列的鑽取用它反而綁手綁腳。

    date / weekday / hour_from~hour_to 是給圖表下鑽用的,查的是 matches 裡存好的
    本地時間欄位（hour 是區間,因為熱力圖可以切成「下午」這種粗分組）,
    和 Cube 那邊的分桶是同一份資料,所以圖上點到的格子和這裡列出來的場次一定對得起來。

    date_from / date_to 是全域的期間篩選(本地日期,含頭含尾)。
    with_puuid + relation(teammate / opponent)列出和某人同隊或對上的場次,給隊友頁下鑽用;
    不給 relation 是兩種都列。每列會多一個 with_participant_id(那個人那場的參賽者編號)。
    champion 是英雄名稱(和 Cube 的 champions.name 同一份對照),給英雄頁下鑽用。
    augment 是增幅名稱(和 Cube 的 augments.name 同一份對照),給增幅頁下鑽用。

    game_ids 是逗號分隔的對局 id:條件先交給 Cube 用語意層的定義查出是哪幾場,
    這裡只負責列出來。**新的可下鑽維度一律走這條路,不要再加參數**——
    對局長度的界線、節奏頁的「前一場」「當日第幾場」原本在這裡各有一份副本
    (後者還抄了一次視窗函數),語意層改規則時副本不會跟著動,
    會變成「圖上 12 場、點進去 9 場」而且沒有人發現。

    participants 是 game_ids 的參賽者版本(`game_id:participant_id`,逗號分隔):一樣由 Cube 決定
    是哪幾位,給「一場裡要挑特定一人」的下鑽用——陣容是整隊的屬性,所有人模式下
    一格要列的是「那一隊」,只給 game_ids 會把兩隊十個人全列出來。通常配上 puuid=*。

    puuid 決定每一列是「誰的那一列」:不給是本機帳號;逗號分隔是其中任何一人
    (英雄頁「追蹤對象」);`*` 是所有參賽者(英雄頁「所有人」)。後兩種一場可能有好幾列,
    通常再配上 champion 鎖定成「玩這隻英雄的那個人」。
    """
    conn = db.connect()
    try:
        if puuid == "*":
            subject_sql, subject_params = "1 = 1", []
        elif puuid and "," in puuid:
            wanted = [x for x in puuid.split(",") if x.strip()]
            if len(wanted) > MAX_SUBJECTS:
                return JSONResponse(status_code=400, content={"error": f"puuid 最多 {MAX_SUBJECTS} 個"})
            subject_sql, subject_params = f"mp.puuid IN ({','.join('?' for _ in wanted)})", wanted
        else:
            subject_sql, subject_params = "mp.puuid = ?", [_resolve_puuid(conn, puuid)]
        sql = """
            SELECT m.game_id, m.platform_id, m.game_creation, m.game_duration, m.queue_id,
                   m.game_mode, m.ended_surrender,
                   mp.participant_id, mp.champion_id, mp.team_id, mp.win, mp.kills, mp.deaths, mp.assists,
                   mp.dmg_to_champions, mp.gold_earned, mp.cs, mp.team_kills, mp.champ_level,
                   mp.spell1_id, mp.spell2_id,
                   mp.penta_kills, mp.quadra_kills, mp.largest_multi_kill,
                   mp.puuid, mp.riot_id,
                   COALESCE(dc.name, '英雄 ' || mp.champion_id) AS champion_name,
                   dc.icon_path AS champion_icon
            FROM match_participants mp
            JOIN matches m ON m.platform_id = mp.platform_id AND m.game_id = mp.game_id
            LEFT JOIN dim_champions dc ON dc.id = mp.champion_id
            WHERE """ + subject_sql
        params: list = [*subject_params]
        # 重開局不列、也不算進總數與勝敗（遊戲裡不算輸贏）；單場戰報 /api/match/... 仍看得到
        slice_sql = " AND m.is_remake = 0"
        slice_params: list = []
        if queue is not None:
            slice_sql += " AND m.queue_id = ?"
            slice_params.append(queue)
        if date is not None:
            slice_sql += " AND m.local_date = ?"
            slice_params.append(date)
        if weekday is not None:
            slice_sql += " AND m.local_weekday = ?"
            slice_params.append(weekday)
        if hour_from is not None:
            slice_sql += " AND m.local_hour >= ?"
            slice_params.append(hour_from)
        if hour_to is not None:
            slice_sql += " AND m.local_hour <= ?"
            slice_params.append(hour_to)
        if date_from is not None:
            slice_sql += " AND m.local_date >= ?"
            slice_params.append(date_from)
        if date_to is not None:
            slice_sql += " AND m.local_date <= ?"
            slice_params.append(date_to)
        if with_puuid is not None:
            if relation not in (None, "teammate", "opponent"):
                return JSONResponse(status_code=400, content={"error": "relation 只能是 teammate 或 opponent"})
            same_team = {"teammate": "=", "opponent": "<>"}.get(relation or "", None)
            slice_sql += f"""
                AND EXISTS (SELECT 1 FROM match_participants o
                            WHERE o.platform_id = mp.platform_id AND o.game_id = mp.game_id
                              AND o.puuid = ? AND o.puuid <> mp.puuid
                              {f'AND o.team_id {same_team} mp.team_id' if same_team else ''})"""
            slice_params.append(with_puuid)
        if champion is not None:
            # 用子查詢而不是 dc.name:下面的計數查詢沒有 join dim_champions
            slice_sql += " AND mp.champion_id IN (SELECT id FROM dim_champions WHERE name = ?)"
            slice_params.append(champion)
        if game_ids is not None:
            try:
                ids = [int(x) for x in game_ids.split(",") if x.strip()]
            except ValueError:
                return JSONResponse(status_code=400, content={"error": "game_ids 必須是逗號分隔的整數"})
            if len(ids) > MAX_GAME_IDS:
                return JSONResponse(status_code=400, content={"error": f"game_ids 最多 {MAX_GAME_IDS} 個"})
            slice_sql += f" AND m.game_id IN ({','.join('?' for _ in ids) or 'NULL'})"
            slice_params.extend(ids)
        if participants is not None:
            try:
                pairs = [tuple(int(v) for v in x.split(":")) for x in participants.split(",") if x.strip()]
                if any(len(pair) != 2 for pair in pairs):
                    raise ValueError
            except ValueError:
                return JSONResponse(status_code=400, content={"error": "participants 必須是逗號分隔的 game_id:participant_id"})
            if len(pairs) > MAX_GAME_IDS:
                return JSONResponse(status_code=400, content={"error": f"participants 最多 {MAX_GAME_IDS} 個"})
            slice_sql += f" AND (mp.game_id, mp.participant_id) IN ({','.join('(?,?)' for _ in pairs) or '(NULL,NULL)'})"
            slice_params.extend(v for pair in pairs for v in pair)
        if augment is not None:
            slice_sql += """
                AND EXISTS (SELECT 1 FROM participant_augments pa JOIN dim_augments da ON da.id = pa.augment_id
                            WHERE pa.platform_id = mp.platform_id AND pa.game_id = mp.game_id
                              AND pa.participant_id = mp.participant_id AND da.name = ?)"""
            slice_params.append(augment)
        sql += slice_sql
        params.extend(slice_params)
        sql += " ORDER BY m.game_creation DESC LIMIT ? OFFSET ?"
        params.extend([min(limit, 200), max(offset, 0)])

        matches = [{**dict(row), "riot_id": mask_name(row["riot_id"])} for row in conn.execute(sql, params).fetchall()]
        # 清單每列要顯示裝備與增幅，各自一次撈完再併回去，避免 N+1 查詢
        keys = [(m["platform_id"], m["game_id"], m["participant_id"]) for m in matches]
        if keys:
            placeholders = ",".join("(?,?,?)" for _ in keys)
            flat = [value for key in keys for value in key]

            def attach(field: str, sub_sql: str):
                """把長格式的明細（裝備、增幅）依參賽者分組掛回每一列。"""
                grouped: dict = {}
                for row in conn.execute(sub_sql.format(placeholders=placeholders), flat).fetchall():
                    grouped.setdefault(
                        (row["platform_id"], row["game_id"], row["participant_id"]), []
                    ).append(dict(row))
                for match in matches:
                    match[field] = grouped.get(
                        (match["platform_id"], match["game_id"], match["participant_id"]), []
                    )

            attach(
                "items",
                """SELECT pi.platform_id, pi.game_id, pi.participant_id, pi.slot,
                          pi.item_id, di.name, di.icon_path
                   FROM participant_items pi
                   LEFT JOIN dim_items di ON di.id = pi.item_id
                   WHERE (pi.platform_id, pi.game_id, pi.participant_id) IN ({placeholders})
                   ORDER BY pi.slot""",
            )
            attach(
                "augments",
                """SELECT pa.platform_id, pa.game_id, pa.participant_id, pa.slot,
                          pa.augment_id, da.name, da.rarity, da.icon_path
                   FROM participant_augments pa
                   LEFT JOIN dim_augments da ON da.id = pa.augment_id
                   WHERE (pa.platform_id, pa.game_id, pa.participant_id) IN ({placeholders})
                   ORDER BY pa.slot""",
            )

            # 同場另外九個人的英雄。以對局為鍵（不是參賽者），一場只撈一次；
            # 誰是我方、誰是對手交給前端用列上的 team_id 分，後端不必知道視角。
            games = list({(m["platform_id"], m["game_id"]) for m in matches})
            roster_rows = conn.execute(
                f"""SELECT mp.platform_id, mp.game_id, mp.participant_id, mp.team_id,
                           COALESCE(dc.name, '英雄 ' || mp.champion_id) AS champion_name,
                           dc.icon_path AS champion_icon
                    FROM match_participants mp
                    LEFT JOIN dim_champions dc ON dc.id = mp.champion_id
                    WHERE (mp.platform_id, mp.game_id) IN ({",".join("(?,?)" for _ in games)})
                    ORDER BY mp.team_id, mp.participant_id""",
                [value for key in games for value in key],
            ).fetchall()
            by_game: dict = {}
            for row in roster_rows:
                by_game.setdefault((row["platform_id"], row["game_id"]), []).append(dict(row))
            for match in matches:
                match["roster"] = by_game.get((match["platform_id"], match["game_id"]), [])

            # 和某人同場的下鑽：標出那個人那場是誰（參賽者編號），卡片上才能把他的英雄圈出來、
            # 「同隊和敵對一起列」時一眼看出這場是哪一種
            if with_puuid is not None:
                with_rows = conn.execute(
                    f"""SELECT platform_id, game_id, participant_id FROM match_participants
                        WHERE puuid = ? AND (platform_id, game_id) IN ({",".join("(?,?)" for _ in games)})""",
                    [with_puuid, *(value for key in games for value in key)],
                ).fetchall()
                with_of = {(r["platform_id"], r["game_id"]): r["participant_id"] for r in with_rows}
                for match in matches:
                    match["with_participant_id"] = with_of.get((match["platform_id"], match["game_id"]))

        count_sql = """
            SELECT COUNT(*) AS n, COALESCE(SUM(mp.win), 0) AS wins FROM match_participants mp
            JOIN matches m ON m.platform_id = mp.platform_id AND m.game_id = mp.game_id
            WHERE """ + subject_sql
        count_sql += slice_sql
        counts = conn.execute(count_sql, [*subject_params, *slice_params]).fetchone()

        # wins 是整個條件的勝場，不只這一頁：列表是捲動分批載入的，勝敗摘要不能只算已載入的部分
        return {"matches": matches, "total": counts["n"], "wins": counts["wins"]}
    finally:
        conn.close()


@app.get("/api/match/{platform_id}/{game_id}")
def match_detail(platform_id: str, game_id: int, puuid: Optional[str] = None):
    """單場完整戰報:10 名玩家的數據、裝備與增幅。"""
    conn = db.connect()
    try:
        header = conn.execute(
            """SELECT platform_id, game_id, queue_id, game_mode, game_version,
                      game_creation, game_duration, ended_surrender
               FROM matches WHERE platform_id = ? AND game_id = ?""",
            (platform_id, game_id),
        ).fetchone()
        if header is None:
            return JSONResponse(status_code=404, content={"error": "找不到這場對局"})

        players = [
            {**dict(row), "riot_id": mask_name(row["riot_id"])}
            for row in conn.execute(
                """SELECT mp.*, COALESCE(dc.name, '英雄 ' || mp.champion_id) AS champion_name,
                          dc.icon_path AS champion_icon,
                          (mp.puuid = ?) AS is_me
                   FROM match_participants mp
                   LEFT JOIN dim_champions dc ON dc.id = mp.champion_id
                   WHERE mp.platform_id = ? AND mp.game_id = ?
                   ORDER BY mp.team_id, mp.participant_id""",
                (_resolve_puuid(conn, puuid), platform_id, game_id),
            ).fetchall()
        ]

        def by_participant(sql):
            grouped: dict[int, list] = {}
            for row in conn.execute(sql, (platform_id, game_id)).fetchall():
                grouped.setdefault(row["participant_id"], []).append(dict(row))
            return grouped

        augments = by_participant(
            """SELECT pa.participant_id, pa.slot, pa.augment_id,
                      da.name, da.rarity, da.icon_path
               FROM participant_augments pa
               LEFT JOIN dim_augments da ON da.id = pa.augment_id
               WHERE pa.platform_id = ? AND pa.game_id = ?
               ORDER BY pa.slot"""
        )
        items = by_participant(
            """SELECT pi.participant_id, pi.slot, pi.item_id, di.name, di.icon_path
               FROM participant_items pi
               LEFT JOIN dim_items di ON di.id = pi.item_id
               WHERE pi.platform_id = ? AND pi.game_id = ?
               ORDER BY pi.slot"""
        )

        for player in players:
            pid = player["participant_id"]
            player["augments"] = augments.get(pid, [])
            player["items"] = items.get(pid, [])
            player.pop("raw_json", None)

        return {"match": dict(header), "players": players}
    finally:
        conn.close()


@app.get("/api/accounts")
def list_accounts():
    """追蹤對象，以及可以加入追蹤的候選人（曾與你同場的玩家）。"""
    conn = db.connect()
    try:
        tracked = [
            {**dict(row), "riot_id": mask_name(row["riot_id"])}
            for row in conn.execute(
                """SELECT a.puuid, a.riot_id, a.tracked,
                          -- 和我同場的場次
                          (SELECT COUNT(DISTINCT mp.game_id) FROM match_participants mp
                           WHERE mp.puuid = a.puuid AND NOT EXISTS (SELECT 1 FROM matches rm WHERE rm.platform_id = mp.platform_id AND rm.game_id = mp.game_id AND rm.is_remake = 1)
                             AND EXISTS (SELECT 1 FROM match_participants me
                                         WHERE me.platform_id = mp.platform_id
                                           AND me.game_id = mp.game_id
                                           AND me.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1))
                          ) AS shared,
                          -- 資料庫裡他總共出現幾場（追蹤之後會包含我沒參與的）
                          (SELECT COUNT(DISTINCT mp.game_id) FROM match_participants mp
                           WHERE mp.puuid = a.puuid AND NOT EXISTS (SELECT 1 FROM matches rm WHERE rm.platform_id = mp.platform_id AND rm.game_id = mp.game_id AND rm.is_remake = 1)) AS games
                   FROM accounts a WHERE a.tracked = 1 AND a.is_me = 0
                   ORDER BY games DESC"""
            ).fetchall()
        ]
        candidates = [
            {**dict(row), "riot_id": mask_name(row["riot_id"])}
            for row in conn.execute(
                """SELECT mp.riot_id, mp.puuid, COUNT(DISTINCT mp.game_id) AS games
                   FROM match_participants mp
                   WHERE mp.puuid NOT IN (SELECT puuid FROM accounts WHERE is_me = 1) AND NOT EXISTS (SELECT 1 FROM matches rm WHERE rm.platform_id = mp.platform_id AND rm.game_id = mp.game_id AND rm.is_remake = 1)
                   GROUP BY mp.puuid
                   ORDER BY games DESC LIMIT 60"""
            ).fetchall()
        ]
        me = conn.execute(
            "SELECT puuid, riot_id FROM accounts WHERE is_me = 1"
        ).fetchall()
        return {
            "me": [dict(row) for row in me],
            "tracked": tracked,
            "candidates": candidates,
        }
    finally:
        conn.close()


class TrackRequest(BaseModel):
    puuid: Optional[str] = None
    riotId: Optional[str] = None
    tracked: bool = True


@app.post("/api/accounts/track")
def track_account(body: TrackRequest):
    """加入或移除追蹤對象。重複送同樣的請求結果一致——冪等。"""
    if PUBLIC:
        return readonly_error()
    conn = db.connect()
    try:
        puuid = body.puuid
        riot_id = body.riotId
        if not puuid and riot_id:
            puuid = db.find_puuid_by_riot_id(conn, riot_id)
        if not puuid:
            return JSONResponse(
                status_code=404,
                content={"error": "找不到這個玩家。只能追蹤曾經和你同場過的人——"
                                  "客戶端沒有提供公開的名稱查詢。"},
            )
        if puuid in {row["puuid"] for row in conn.execute(
            "SELECT puuid FROM accounts WHERE is_me = 1"
        )}:
            return JSONResponse(status_code=400, content={"error": "這是你自己的帳號,本來就會採集。"})

        if not riot_id:
            row = conn.execute(
                "SELECT riot_id FROM match_participants WHERE puuid = ? LIMIT 1", (puuid,)
            ).fetchone()
            riot_id = row["riot_id"] if row else None

        previous = conn.execute("SELECT tracked, riot_id FROM accounts WHERE puuid = ?", (puuid,)).fetchone()
        db.set_tracked(conn, puuid, riot_id, body.tracked)
        if not previous or previous["tracked"] != int(body.tracked) or (riot_id and previous["riot_id"] != riot_id):
            change_events.publish()
        return {"puuid": puuid, "riotId": riot_id, "tracked": body.tracked}
    finally:
        conn.close()


CUBE_BASE = "http://127.0.0.1:4000/cubejs-api/v1"

# 公開模式下的查詢速率限制。
#
# Cube 的查詢是這裡唯一「一個請求可以吃掉很多 CPU」的地方——最重的一種
# (英雄 × 增幅這類一對多展開)第一次要跑十秒。登入的人都是熟人,但不必把
# 「大家都不會亂來」當成防線:一個寫壞的迴圈或一個好奇的人就夠了。
#
# 窗格開得比真實用量寬很多:儀表板一次發五個查詢,自由探索連點也才個位數,
# 三十秒六十次撞不到;要撞到就是在連續打。
CUBE_RATE_WINDOW = 30
CUBE_RATE_PER_SESSION = 60
CUBE_RATE_GLOBAL = 300
_cube_hits: dict = {}


def cube_rate_ok(token: Optional[str]) -> bool:
    """回 False 表示超量。以 session 為單位,另外再加一道全站上限。"""
    now = time.time()
    for key in list(_cube_hits):
        _cube_hits[key] = [t for t in _cube_hits[key] if now - t < CUBE_RATE_WINDOW]
        if not _cube_hits[key]:
            _cube_hits.pop(key, None)
    mine = _cube_hits.setdefault(token or "-", [])
    total = sum(len(v) for v in _cube_hits.values())
    if len(mine) >= CUBE_RATE_PER_SESSION or total >= CUBE_RATE_GLOBAL:
        return False
    mine.append(now)
    return True

# 共用連線池。原本每個請求 requests.get 一次，等於每次都重新建 TCP 連線。
# 實測同一個已快取的查詢，代理比直連 Cube 多出的時間 30ms -> 2ms。
# requests.Session 底下的 urllib3 連線池可以多執行緒共用。
cube_http = requests.Session()
cube_http.mount("http://", requests.adapters.HTTPAdapter(pool_connections=4, pool_maxsize=16))

# 不需要「採集到新對局後重播查詢來暖快取」——試過、量過、還原了：
# refresh key 變了之後，Cube 只有在大約 15 秒內的第一個請求會回舊結果（同時背景重算），
# 50 秒、180 秒後第一次查詢都已經是新資料（在完全沒有重播的狀態下實測）。
# 打完一場到打開頁面通常不止 15 秒，重播換不到可見的好處。


@app.api_route("/api/cube/{path:path}", methods=["GET", "POST"])
async def cube_proxy(path: str, request: Request):
    """把 Cube 的查詢 API 代理到本服務底下。

    Cube 沒有提供繫結位址的設定,它的埠一律開在所有網路介面上。所以 Cube 跑正式模式、
    每個請求都要 JWT(cube_process.auth_header()),憑證只在這裡加上,不會送到瀏覽器。
    前端改走這裡之後,瀏覽器只需要連 127.0.0.1:5057,Cube 的埠就不必讓任何人碰到
    (仍建議用防火牆擋掉對外連線)。
    順帶好處是前端與 API 同源,不必處理 CORS。
    """
    if path not in {"load", "meta", "sql"}:
        return JSONResponse(status_code=404, content={"error": "不支援的 Cube 端點"})

    if PUBLIC and path == "load" and not cube_rate_ok(request.cookies.get(SESSION_COOKIE)):
        return JSONResponse(
            status_code=429,
            content={"error": "查詢太頻繁,請等幾秒再試。"},
        )

    url = f"{CUBE_BASE}/{path}"
    if request.method == "POST":
        body = await request.json()
        send = lambda: cube_http.post(url, json=body, headers=cube_process.auth_header(), timeout=60)  # noqa: E731
    else:
        params = dict(request.query_params)
        send = lambda: cube_http.get(url, params=params, headers=cube_process.auth_header(), timeout=60)  # noqa: E731
    try:
        # requests 是同步的，直接在 async handler 裡呼叫會佔住 event loop：
        # 一個要跑兩秒的 Cube 查詢會讓其他查詢、甚至背景採集迴圈全部排隊等它。
        # 儀表板一次會發好幾個查詢，這條路徑一定要放到執行緒裡。
        try:
            resp = await asyncio.to_thread(send)
        except requests.exceptions.ConnectionError:
            # 連線池裡的閒置連線可能已經被 Cube 關掉（Node 的 keep-alive 閒置 5 秒就關），
            # 拿到它的那個請求第一次送出就是 10054「遠端主機已強制關閉」，畫面上變成「連不到 Cube」。
            # 查詢都是唯讀的，換一條新連線重送一次是安全的；Cube 真的掛了，第二次一樣會失敗。
            # （逾時不在這裡：ReadTimeout 不是 ConnectionError，慢查詢不會被重送成兩倍時間。）
            resp = await asyncio.to_thread(send)
    except requests.exceptions.RequestException as exc:
        return JSONResponse(
            status_code=503,
            content={"error": f"連不到 Cube 語意層(是不是沒啟動?): {exc}"},
        )
    if MASK_NAMES and resp.headers.get("Content-Type", "").startswith("application/json"):
        try:
            return JSONResponse(status_code=resp.status_code, content=mask_cube(resp.json()))
        except ValueError:
            pass  # 不是合法 JSON 就原樣送回,例外訊息比遮罩重要
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("Content-Type", "application/json"),
    )


@app.get("/api/icon")
def icon(path: str):
    """客戶端圖示，經磁碟快取。

    抓過的圖示不再問客戶端，所以第二次之後幾乎是零成本，客戶端關著時也還在。
    圖示內容不會變，因此標成 immutable，瀏覽器連問都不用問。
    """
    cached, status = icons.fetch(path)
    if status == "rejected":
        return JSONResponse(status_code=400, content={"error": "不允許的資源路徑"})
    if cached is None:
        # 客戶端沒開又沒快取過：回 204 讓版面留白，不要讓整頁卡住
        return Response(status_code=204)
    return FileResponse(
        cached,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


if __name__ == "__main__":
    print("=" * 62)
    print(" ARAM: Mayhem 戰績採集 + BI")
    if PUBLIC:
        print(" 公開模式:唯讀" + ("、其他玩家的名稱已換成代號" if MASK_NAMES else "、其他玩家顯示真名"))
        print("  登入:" + "＋".join(w for w in (
            "Discord" if OAUTH_ENABLED else "", "共用密碼" if PASSWORD else "") if w))
    print(f" 開瀏覽器到 http://127.0.0.1:{PORT}")
    print(" 客戶端開著的時候會自動採集,關掉也不會掉資料(下次開再補)")
    print("=" * 62)
    uvicorn.run(app, host="127.0.0.1", port=PORT)
