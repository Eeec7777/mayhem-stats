// Cube 設定。只放「關掉開發模式之後要自己補回來」的東西，連線設定仍在 .env。
//
// 為什麼關開發模式：開發模式不驗證身分，4000 埠又開在所有網卡上，
// 同一個區網或 ZeroTier 網路的人不用登入就能查整個資料庫，Playground 還能改寫模型檔。
// 關掉之後每個請求都要帶用 CUBEJS_API_SECRET 簽的 JWT（由 cube_process.auth_header() 產生），
// Playground 與 SQL API（15432 埠）也一起關閉。
//
// 開發模式會監看 model/ 自動重新編譯，正式模式不會。這裡用 schemaVersion 補回來：
// Cube 每個請求都會問一次版本，版本變了就重新編譯——改 yml 之後不必重啟。
const fs = require("fs")
const path = require("path")
const sqlite3 = require("sqlite3")
const SqliteDriver = require("@cubejs-backend/sqlite-driver")

const MODEL_DIR = path.join(__dirname, "model")
// 每個請求都掃一次目錄太浪費；兩秒內沿用上一次的結果，改完模型最多慢兩秒生效
const CHECK_EVERY_MS = 2000

let checkedAt = 0
let version = ""

function latestChange(dir) {
  let latest = 0
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const [sub, n] = latestChange(full)
      latest = Math.max(latest, sub)
      count += n
    } else {
      latest = Math.max(latest, fs.statSync(full).mtimeMs)
      count += 1
    }
  }
  return [latest, count]
}

// 內建的 SQLite driver 整個 Cube 只開一條連線，佇列並行度卻是 2：兩個查詢擠同一條連線、
// 互相拖到兩個都跑完才一起回來，一頁同時送出的查詢因此「一起卡住」。
// SQLite 是 WAL 模式，多條唯讀連線可以真的同時讀，查詢跑在 libuv 的執行緒池上（預設 4 條）。
const POOL_SIZE = Number(process.env.MAYHEM_SQLITE_POOL || 4)

class PooledSqliteDriver extends SqliteDriver {
  constructor(config = {}) {
    super(config)
    this.pool = Array.from({ length: POOL_SIZE }, () =>
      new sqlite3.Database(this.config.database, sqlite3.OPEN_READONLY))
    this.busy = this.pool.map(() => 0)
  }

  // 交給手上查詢最少的那條連線
  query(query, values) {
    let i = 0
    for (let k = 1; k < this.pool.length; k++) if (this.busy[k] < this.busy[i]) i = k
    this.busy[i]++
    return new Promise((resolve, reject) =>
      this.pool[i].all(query, values || [], (err, rows) => {
        this.busy[i]--
        if (err) reject(err)
        else resolve(rows)
      }))
  }

  async release() {
    await Promise.all(this.pool.map((db) => new Promise((done) => db.close(() => done()))))
    await super.release()
  }
}

// 數字型篩選的參數要轉成數字再比。
// Cube 把所有篩選值都綁成字串；欄位有 INTEGER 親和性時 SQLite 會自動轉，但「指標」（COUNT(...)、SUM(...)）
// 和運算式沒有親和性，整數 > 文字在 SQLite 裡恆為假：自由探索的「玩家對局數 大於 10」一律 0 列、
// 「小於」一律全中。
// Cube 預設用 Rust 的 Tesseract 規劃器產生 SQL，套的是 sqlTemplates() 的 filters 範本；gt/gte/lt/lte 只用在數字比較
// （日期區間有自己的 time_range_filter），所以這四個範本的參數一律包成 CAST(? AS REAL)。
// 舊的 JS 規劃器（CUBEJS_TESSERACT_SQL_PLANNER=false）走 newFilter().castParameter()，一併照顧。
// 設定名稱是 dialectFactory（寫成 dialectClass 會被 Cube 拒絕、整個起不來）。
const { SqliteQuery } = require("@cubejs-backend/schema-compiler/dist/src/adapter/SqliteQuery")
let NumericAwareFilter = null
class MayhemSqliteQuery extends SqliteQuery {
  sqlTemplates() {
    const templates = super.sqlTemplates()
    for (const [op, sign] of [["gt", ">"], ["gte", ">="], ["lt", "<"], ["lte", "<="]]) {
      templates.filters[op] = `{{ column }} ${sign} CAST({{ param }} AS REAL)`
    }
    return templates
  }

  newFilter(filter) {
    const base = super.newFilter(filter)
    if (!NumericAwareFilter) {
      // SqliteFilter 沒有匯出，從實例拿到它的類別再繼承，like 的不分大小寫等行為照舊
      NumericAwareFilter = class extends base.constructor {
        castParameter() {
          let type = null
          try {
            type = this.definition()?.type
          } catch {
            /* 拿不到定義的（segment 之類）照舊 */
          }
          return this.measure || type === "number" ? "CAST(? AS REAL)" : super.castParameter()
        }
      }
    }
    return new NumericAwareFilter(this, filter)
  }
}

module.exports = {
  driverFactory: () => new PooledSqliteDriver(),
  dialectFactory: ({ dbType }) => (dbType === "sqlite" ? MayhemSqliteQuery : undefined),
  orchestratorOptions: {
    queryCacheOptions: { queueOptions: { concurrency: POOL_SIZE } },
  },
  schemaVersion: () => {
    const now = Date.now()
    if (now - checkedAt > CHECK_EVERY_MS) {
      checkedAt = now
      // 檔案數也算進去：刪掉一個檔不會讓任何剩下的檔案 mtime 變大
      const [latest, count] = latestChange(MODEL_DIR)
      version = `${latest}:${count}`
    }
    return version
  },
}

// 主執行緒卡頓偵測：每 100ms 檢查一次，延遲超過 250ms 就寫一行進 cube.log。
// Cube 的查詢編譯、結果處理全都在這一條執行緒上，它一卡，所有請求一起卡，
// 瀏覽器那邊看起來就是「一頁的請求全部同時轉 2～3 秒」。2026-09 就是靠這個抓到
// 服務被排程工作跑成「低於正常」優先權、被瀏覽器搶走 CPU（見 app.py 的 _normal_priority）。
// 查法：grep "EVENT LOOP BLOCKED" cube/cube.log
{
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - last - 100
    if (lag > 250) console.log(JSON.stringify({ message: "EVENT LOOP BLOCKED", lag, at: new Date(now).toISOString() }))
    last = now
  }, 100).unref()
}
