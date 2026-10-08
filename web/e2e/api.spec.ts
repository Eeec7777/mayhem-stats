import { test, expect } from "./fixtures"
import { mePuuid, myRecord, sql } from "./db"

// 前端依賴的後端合約。畫面測試只會在整條路徑都通的時候才綠，這裡把「後端回了什麼」單獨釘住，
// 出事時才分得出是後端改了還是畫面壞了。只送 GET，以及不會改動資料的錯誤路徑。

type Json = Record<string, any>

test.describe("狀態與玩家", () => {
  test("/api/status：服務在跑、本機模式（public=false），場次和資料庫一致", async ({ request }) => {
    const s: Json = await (await request.get("/api/status")).json()
    expect(s.running).toBe(true)
    expect(s.public).toBe(false)
    expect(s.myMayhemMatches).toBe(myRecord().games)
    expect(s.totalMatches).toBe(sql("SELECT COUNT(*) n FROM matches")[0].n)
    expect(s.mayhemMatches).toBe(sql("SELECT COUNT(*) n FROM matches WHERE queue_id = 2400")[0].n)
    expect(s.trackedCount).toBe(sql("SELECT COUNT(*) n FROM accounts WHERE tracked = 1 AND is_me = 0")[0].n)
    for (const k of ["clientConnected", "lastError", "oldestGame", "newestGame", "iconCache"]) expect(s).toHaveProperty(k)
  })

  test("/api/players：自己排第一且 crew=1；追蹤中的 crew=1；其餘 crew=0；場次由多到少（在同一組內）", async ({ request }) => {
    const { players } = (await (await request.get("/api/players")).json()) as { players: Json[] }
    expect(players[0].puuid).toBe(mePuuid())
    expect(players[0].is_me).toBe(1)
    const crew = new Set(sql("SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1").map((r) => String(r.puuid)))
    for (const p of players) expect(p.crew, p.puuid).toBe(crew.has(p.puuid) ? 1 : 0)
    // 排序：我、追蹤中、其他；其他內部依場次
    const others = players.filter((p) => !p.is_me && !p.tracked)
    expect(others.map((p) => p.games)).toEqual([...others.map((p) => p.games)].sort((a, b) => b - a))
    expect(players.length).toBe(sql("SELECT COUNT(DISTINCT puuid) n FROM match_participants")[0].n)
  })

  test("/api/me：本機模式不能綁定帳號", async ({ request }) => {
    expect(await (await request.get("/api/me")).json()).toEqual({ public: false, name: null, canLink: false, linked: [] })
  })

  test("/api/events 是 SSE（text/event-stream）", async ({ page }) => {
    await page.goto("/dashboard")
    const type = await page.evaluate(async () => {
      const ctrl = new AbortController()
      const res = await fetch("/api/events", { signal: ctrl.signal })
      const t = res.headers.get("content-type")
      ctrl.abort()
      return t
    })
    expect(type).toContain("text/event-stream")
  })
})

test.describe("/api/matches", () => {
  const get = async (request: import("@playwright/test").APIRequestContext, qs: string): Promise<Json> => (await request.get(`/api/matches?${qs}`)).json()

  test("預設：本機帳號、新到舊、一次 30 場；total 與 wins 是篩選後的全部", async ({ request }) => {
    const body = await get(request, "queue=2400")
    expect(body.matches).toHaveLength(30)
    const { games, wins } = myRecord()
    expect([body.total, body.wins]).toEqual([games, wins])
    const times = body.matches.map((m: Json) => m.game_creation)
    expect(times).toEqual([...times].sort((a, b) => b - a))
    for (const m of body.matches) expect(m.puuid).toBe(mePuuid())
  })

  test("每一列的欄位：英雄、KDA、裝備、增幅、其餘九位的 roster（不含他人的帳號名稱）", async ({ request }) => {
    const m = (await get(request, "queue=2400&limit=1")).matches[0]
    for (const k of ["champion_name", "champion_icon", "kills", "deaths", "assists", "items", "augments", "roster", "win", "game_duration", "team_kills"]) {
      expect(m, k).toHaveProperty(k)
    }
    expect(m.roster).toHaveLength(10)
    for (const r of m.roster) expect(Object.keys(r).sort()).toEqual(["champion_icon", "champion_name", "game_id", "participant_id", "platform_id", "team_id"])
    expect(m.augments.length).toBeLessThanOrEqual(4)
  })

  test("分頁：offset 接著上一頁，不重疊；limit 生效", async ({ request }) => {
    const a = await get(request, "queue=2400&limit=20&offset=0")
    const b = await get(request, "queue=2400&limit=20&offset=20")
    expect(a.matches).toHaveLength(20)
    expect(b.matches).toHaveLength(20)
    const ids = new Set(a.matches.map((m: Json) => m.game_id))
    for (const m of b.matches) expect(ids.has(m.game_id)).toBe(false)
    expect(b.matches[0].game_creation).toBeLessThan(a.matches.at(-1).game_creation)
    const all = sql(
      `SELECT m.game_id FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400 ORDER BY m.game_creation DESC LIMIT 40`,
      [mePuuid()],
    ).map((r) => Number(r.game_id))
    expect([...a.matches, ...b.matches].map((m: Json) => m.game_id)).toEqual(all)
  })

  test("date_from / date_to（含頭含尾的本地日期）：total 和 SQL 一致", async ({ request }) => {
    const d = sql(
      `SELECT m.local_date d FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY m.local_date ORDER BY m.local_date DESC LIMIT 1 OFFSET 3`,
      [mePuuid()],
    )[0].d as string
    const body = await get(request, `queue=2400&date_from=${d}&date_to=${d}&limit=200`)
    expect(body.total).toBe(myRecord("AND m.local_date = ?", [d]).games)
    for (const m of body.matches) expect(m.game_id).toBeGreaterThan(0)
  })

  test("champion 與 augment 篩選", async ({ request }) => {
    const c = sql(
      `SELECT d.name, COUNT(*) n, SUM(p.win) w FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN dim_champions d ON d.id = p.champion_id
        WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY d.id ORDER BY n DESC LIMIT 1`,
      [mePuuid()],
    )[0]
    const byChamp = await get(request, `queue=2400&champion=${encodeURIComponent(String(c.name))}&limit=200`)
    expect([byChamp.total, byChamp.wins]).toEqual([Number(c.n), Number(c.w)])
    for (const m of byChamp.matches) expect(m.champion_name).toBe(c.name)
    const a = sql(
      `SELECT a.name, COUNT(*) n FROM participant_augments pa
         JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
         JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id JOIN dim_augments a ON a.id = pa.augment_id
        WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY a.id ORDER BY n DESC LIMIT 1`,
      [mePuuid()],
    )[0]
    const byAug = await get(request, `queue=2400&augment=${encodeURIComponent(String(a.name))}&limit=200`)
    expect(byAug.total).toBe(Number(a.n))
  })

  test("game_ids：指定哪幾場就只回那幾場（由 Cube 查出來再交給這裡）", async ({ request }) => {
    const ids = (await get(request, "queue=2400&limit=5")).matches.map((m: Json) => m.game_id)
    const body = await get(request, `game_ids=${ids.join(",")}`)
    expect(body.matches.map((m: Json) => m.game_id).sort()).toEqual([...ids].sort())
  })

  test("with_puuid + relation：和某人同隊／敵對的場次數和 SQL 一致，每列帶 with_participant_id", async ({ request }) => {
    const p = sql(
      `SELECT o.puuid, SUM(o.team_id = me.team_id) mate, SUM(o.team_id <> me.team_id) foe FROM match_participants me
         JOIN matches m ON m.platform_id = me.platform_id AND m.game_id = me.game_id
         JOIN match_participants o ON o.platform_id = me.platform_id AND o.game_id = me.game_id AND o.participant_id <> me.participant_id
        WHERE me.puuid = ? AND m.queue_id = 2400 GROUP BY o.puuid HAVING mate > 0 AND foe > 0 ORDER BY mate + foe DESC LIMIT 1`,
      [mePuuid()],
    )[0]
    const mate = await get(request, `queue=2400&with_puuid=${p.puuid}&relation=teammate&limit=1`)
    const foe = await get(request, `queue=2400&with_puuid=${p.puuid}&relation=opponent&limit=1`)
    const both = await get(request, `queue=2400&with_puuid=${p.puuid}&limit=1`)
    expect([mate.total, foe.total]).toEqual([Number(p.mate), Number(p.foe)])
    expect(both.total).toBe(Number(p.mate) + Number(p.foe))
    expect(mate.matches[0].with_participant_id).toBeGreaterThan(0)
  })

  test("puuid=*：所有參賽者；一場可能不只一列", async ({ request }) => {
    const body = await get(request, "queue=2400&puuid=*&limit=1")
    expect(body.total).toBe(sql("SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400")[0].n)
  })

  test("沒有符合的條件 → total 0、matches 空陣列（不是錯誤）", async ({ request }) => {
    const body = await get(request, "queue=2400&champion=zzzz-不存在")
    expect(body).toMatchObject({ total: 0, matches: [] })
  })
})

test.describe("/api/match/{platform}/{game}", () => {
  test("單場明細：match 資訊 + 十位玩家，兩隊各五人，團隊合計和 SQL 一致，只有一位 is_me", async ({ request }) => {
    const m = (await (await request.get("/api/matches?queue=2400&limit=1")).json()).matches[0]
    const d: Json = await (await request.get(`/api/match/${m.platform_id}/${m.game_id}`)).json()
    expect(d.match).toMatchObject({ platform_id: m.platform_id, game_id: m.game_id, queue_id: 2400 })
    expect(d.players).toHaveLength(10)
    expect(d.players.filter((p: Json) => p.team_id === 100)).toHaveLength(5)
    expect(d.players.filter((p: Json) => p.team_id === 200)).toHaveLength(5)
    expect(d.players.filter((p: Json) => p.is_me)).toHaveLength(1)
    const sqlTeam = sql(`SELECT team_id, SUM(kills) k, SUM(gold_earned) g FROM match_participants WHERE platform_id = ? AND game_id = ? GROUP BY team_id`, [m.platform_id, m.game_id])
    for (const t of sqlTeam) {
      const members = d.players.filter((p: Json) => p.team_id === t.team_id)
      expect(members.reduce((a: number, p: Json) => a + p.kills, 0)).toBe(t.k)
      expect(members.reduce((a: number, p: Json) => a + p.gold_earned, 0)).toBe(t.g)
    }
  })

  test("不存在的對局 → 404 + 錯誤訊息", async ({ request }) => {
    const res = await request.get("/api/match/TW2/1")
    expect(res.status()).toBe(404)
    expect(await res.json()).toHaveProperty("error")
  })
})

test.describe("/api/accounts", () => {
  test("回傳 me / tracked / candidates；candidates 最多 60 位且不含自己", async ({ request }) => {
    const a: Json = await (await request.get("/api/accounts")).json()
    expect(a.me.map((x: Json) => x.puuid)).toEqual([mePuuid()])
    expect(a.tracked.length).toBe(sql("SELECT COUNT(*) n FROM accounts WHERE tracked = 1 AND is_me = 0")[0].n)
    expect(a.candidates.length).toBeLessThanOrEqual(60)
    expect(a.candidates.map((x: Json) => x.puuid)).not.toContain(mePuuid())
    for (const t of a.tracked) expect(t.games).toBeGreaterThanOrEqual(t.shared)
  })

  // 注意：只送會被拒絕的請求。傳一個不存在的 puuid 目前會被當成合法值寫進 accounts，所以這裡刻意不測那條路。
  test("追蹤自己的帳號 → 400；用查不到的 Riot ID → 404（兩者都不會改資料）", async ({ request }) => {
    const before = sql("SELECT COUNT(*) n, SUM(tracked) t FROM accounts")[0]
    const self = await request.post("/api/accounts/track", { data: { puuid: mePuuid(), tracked: true } })
    expect(self.status()).toBe(400)
    const unknown = await request.post("/api/accounts/track", { data: { riotId: "不存在的人#ZZZZ9", tracked: true } })
    expect(unknown.status()).toBe(404)
    expect(sql("SELECT COUNT(*) n, SUM(tracked) t FROM accounts")[0]).toEqual(before)
  })
})

test.describe("/api/cube 代理與 Cube 的存取控制", () => {
  const q = (o: object) => encodeURIComponent(JSON.stringify(o))

  test("meta：有 cubes、views，維度與指標有標題", async ({ request }) => {
    const meta: Json = await (await request.get("/api/cube/meta")).json()
    const names = meta.cubes.map((c: Json) => c.name)
    for (const n of ["participants", "matches", "champions", "augments", "contribution", "teammates"]) expect(names).toContain(n)
    const participants = meta.cubes.find((c: Json) => c.name === "participants")
    expect(participants.measures.map((m: Json) => m.name)).toEqual(expect.arrayContaining(["participants.games", "participants.winrate", "participants.kda"]))
  })

  test("load：participants.games 加帳號與模式篩選 = 自己的場次", async ({ request }) => {
    const query = { measures: ["participants.games", "participants.wins"], filters: [
      { member: "participants.puuid", operator: "equals", values: [mePuuid()] },
      { member: "matches.queue_id", operator: "equals", values: ["2400"] },
    ] }
    let body: Json = {}
    for (let i = 0; i < 20; i++) {
      body = await (await request.get(`/api/cube/load?query=${q(query)}`)).json()
      if (body.error !== "Continue wait") break
      await new Promise((r) => setTimeout(r, 500))
    }
    const { games, wins } = myRecord()
    expect(body.data).toHaveLength(1)
    expect([Number(body.data[0]["participants.games"]), Number(body.data[0]["participants.wins"])]).toEqual([games, wins])
  })

  test("load 也接受 POST", async ({ request }) => {
    const res = await request.post("/api/cube/load", { data: { query: { measures: ["participants.games"], limit: 1 } } })
    expect([200]).toContain(res.status())
  })

  test("sql：回傳 Cube 產生的 SQL（供除錯，不碰資料）", async ({ request }) => {
    const body: Json = await (await request.get(`/api/cube/sql?query=${q({ measures: ["participants.games"] })}`)).json()
    expect(body.sql.sql[0]).toMatch(/COUNT/i)
  })

  test("只開放 load / meta / sql 三個端點", async ({ request }) => {
    for (const p of ["dry-run", "pre-aggregations", "subscribe", "../meta"]) expect((await request.get(`/api/cube/${p}`)).status(), p).toBe(404)
  })

  test("Cube 跑正式模式：直接打 4000 埠沒帶憑證會被拒絕（CLAUDE.md：不准改回開發模式）", async ({ request }) => {
    const res = await request.get("http://127.0.0.1:4000/cubejs-api/v1/meta", { failOnStatusCode: false })
    expect([401, 403]).toContain(res.status())
  })

  test("Cube 的 Playground 與 SQL API 都關著", async ({ request }) => {
    // 正式模式：首頁只說「running in production mode」，開發模式才有的 Playground 端點不存在
    const root = await request.get("http://127.0.0.1:4000/", { failOnStatusCode: false })
    expect(await root.text()).toContain("running in production mode")
    expect((await request.get("http://127.0.0.1:4000/playground/context", { failOnStatusCode: false })).status()).toBe(404)
    // SQL API（Postgres 協定）預設 15432，應該沒有在聽
    const net = await import("node:net")
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect(15432, "127.0.0.1")
      s.once("connect", () => (s.destroy(), resolve(true)))
      s.once("error", () => resolve(false))
    })
    expect(open).toBe(false)
  })
})

test.describe("/api/icon", () => {
  test("客戶端圖示經磁碟快取：抓過的回 200 image/png + immutable；沒有時回 204", async ({ request }) => {
    const m = (await (await request.get("/api/matches?queue=2400&limit=1")).json()).matches[0]
    const res = await request.get(`/api/icon?path=${encodeURIComponent(m.champion_icon)}`)
    expect([200, 204]).toContain(res.status())
    if (res.status() === 200) {
      expect(res.headers()["content-type"]).toBe("image/png")
      expect(res.headers()["cache-control"]).toContain("immutable")
    }
  })

  test("不允許的路徑 → 400（擋路徑穿越）", async ({ request }) => {
    for (const p of ["../../etc/passwd", "/etc/passwd", "http://evil.example/x.png"]) {
      expect((await request.get(`/api/icon?path=${encodeURIComponent(p)}`)).status(), p).toBe(400)
    }
  })
})

test.describe("靜態檔與路由", () => {
  test("每個頁面路徑都回 SPA 的 index.html；不認得的路徑 404", async ({ request }) => {
    for (const id of ["dashboard", "matches", "champions", "augments", "lineups", "players", "crew", "time", "tilt", "losses", "explore", "recap", "tracked"]) {
      const res = await request.get(`/${id}`)
      expect(res.status(), id).toBe(200)
      expect(await res.text()).toContain('<div id="root">')
    }
    expect((await request.get("/no-such-page")).status()).toBe(404)
  })

  test("favicon.svg 載得到（已知問題）", async ({ request }) => {
    // 已知問題：app.py 只把 web/dist/assets 掛在 /assets，根目錄的 favicon.svg、icons.svg 沒人送，瀏覽器分頁沒有圖示、每次載入多一個 404。
    // 修好之後這個測試會變成「意外通過」而失敗，到時候拿掉 test.fail，並把 fixtures.ts 的 IGNORED_FAILURES 清掉。
    test.fail(true, "後端沒有送 dist 根目錄的 favicon.svg")
    expect((await request.get("/favicon.svg")).status()).toBe(200)
  })

  test("服務的是 web/dist 的打包結果：index.html 引用的 JS 與 CSS 都載得到", async ({ request }) => {
    const html = await (await request.get("/dashboard")).text()
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    expect(assets.length).toBeGreaterThan(1)
    for (const a of assets) expect((await request.get(a)).status(), a).toBe(200)
  })
})
