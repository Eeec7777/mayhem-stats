import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, gridColumn, gridRows, openPage, readCsv, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const bucketOf = (s: number) => (s < 720 ? "< 12 分" : s < 840 ? "12-14 分" : s < 960 ? "14-16 分" : s < 1080 ? "16-18 分" : s < 1200 ? "18-20 分" : s < 1320 ? "20-22 分" : "22 分以上")

/** 勝局／敗局各自的平均（先各自平均再相除的指標由呼叫端組合）。 */
const byResult = () => {
  const rows = sql(
    `SELECT p.win, COUNT(*) n, AVG(p.kills) k, AVG(p.deaths) d, AVG(p.assists) a, AVG(p.dmg_taken) taken,
            AVG(p.dmg_to_champions * 60.0 / m.game_duration) dpm, AVG(p.gold_earned * 60.0 / m.game_duration) gpm,
            AVG(m.game_duration) / 60.0 AS dur, AVG(p.longest_time_living) surv,
            AVG((p.kills + p.assists) * 100.0 / NULLIF(p.team_kills, 0)) kp
       FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY p.win`,
    [mePuuid()],
  )
  const pick = (w: number) => rows.find((r) => Number(r.win) === w)!
  return { win: pick(1), loss: pick(0) }
}

test.describe("敗因分析頁：勝局 vs 敗局", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "losses")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("KPI：勝率與勝敗場、平均局長（敗局 / 勝局）和 SQL 一致", async ({ page }) => {
    const { win, loss } = byResult()
    const games = Number(win.n) + Number(loss.n)
    await expect(card(page, "勝率")).toContainText(`${((Number(win.n) / games) * 100).toFixed(1)}%`)
    await expect(card(page, "勝率")).toContainText(`${win.n} 勝 ${loss.n} 敗`)
    await expect(card(page, "平均局長")).toContainText(`${Number(loss.dur).toFixed(1)} / ${Number(win.dur).toFixed(1)} 分`)
  })

  test("「打不動還是被打爆」給出其中一個答案並附上輸時我方／敵方輸出變化", async ({ page }) => {
    await expect(card(page, "打不動還是被打爆")).toContainText(/被打爆|打不動/)
    await expect(card(page, "打不動還是被打爆")).toContainText(/輸時我方輸出 -?\d+%、敵方 [+-]?\d+%/)
  })

  test("表格 14 列：團隊 6、我自己 8（含 KDA 等）、隊內佔比 3，共 17 列", async ({ page }) => {
    await expect(page.getByText("17 列", { exact: true })).toBeVisible()
    const groups = await gridColumn(page, "group")
    expect(new Set(groups)).toEqual(new Set(["團隊", "我自己", "隊內佔比"]))
  })

  test("匯出 CSV：勝局／敗局的數字和 SQL 一致（我的擊殺、死亡、助攻、KDA、每分鐘傷害／經濟、承受傷害、參團率）", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    expect(download.suggestedFilename()).toMatch(/^win-vs-loss-\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = await readCsv(await download.path())
    const iLabel = csv[0].indexOf("指標")
    const iWin = csv[0].indexOf("勝局")
    const iLoss = csv[0].indexOf("敗局")
    const row = (label: string) => {
      const r = csv.slice(1).find((x) => x[iLabel] === label)
      if (!r) throw new Error(`CSV 沒有「${label}」：${csv.slice(1).map((x) => x[iLabel]).join("、")}`)
      return { win: Number(r[iWin]), loss: Number(r[iLoss]) }
    }
    const { win, loss } = byResult()
    const num = (r: Record<string, unknown>, k: string) => Number(r[k])
    const expectBoth = (label: string, f: (r: Record<string, unknown>) => number, digits = 6) => {
      const got = row(label)
      expect(got.win, `${label}（勝局）`).toBeCloseTo(f(win), digits)
      expect(got.loss, `${label}（敗局）`).toBeCloseTo(f(loss), digits)
    }
    expectBoth("我的擊殺", (r) => num(r, "k"))
    expectBoth("我的死亡", (r) => num(r, "d"))
    expectBoth("我的助攻", (r) => num(r, "a"))
    expectBoth("我的 KDA", (r) => (num(r, "k") + num(r, "a")) / num(r, "d"))
    expectBoth("我的每分鐘傷害", (r) => num(r, "dpm"), 3)
    expectBoth("我的每分鐘經濟", (r) => num(r, "gpm"), 3)
    expectBoth("我承受的傷害", (r) => num(r, "taken"), 3)
    expectBoth("最長存活(秒)", (r) => num(r, "surv"), 3)
    expectBoth("我的參團率", (r) => num(r, "kp"), 3)
  })

  test("敗局相差 = (敗 − 勝) ÷ |勝|，且列標題可排序", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    const csv = await readCsv(await download.path())
    const iWin = csv[0].indexOf("勝局")
    const iLoss = csv[0].indexOf("敗局")
    const iDiff = csv[0].findIndex((h) => h.startsWith("勝局 vs 敗局"))
    for (const r of csv.slice(1)) {
      const w = Number(r[iWin])
      const l = Number(r[iLoss])
      if (w) expect(Number(r[iDiff])).toBeCloseTo(((l - w) / Math.abs(w)) * 100, 4)
    }
    const diffHeader = page.locator('.ag-header-cell[col-id="diffPct"]').first()
    await diffHeader.click()
    await diffHeader.click()
    await expect(diffHeader).toHaveAttribute("aria-sort", /ascending|descending/)
  })

  test("說明文字提醒這是描述不是原因", async ({ page }) => {
    await expect(page.getByText(/這張表是描述，不是原因/)).toBeVisible()
  })
})

test.describe("敗因分析頁：對局長度與勝率", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "losses")
  })

  const chart = (page: Page) => charts(card(page, "對局長度與勝率")).first()
  const games = () =>
    sql(
      `SELECT m.game_duration AS dur, p.win FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
      [mePuuid()],
    ).map((r) => ({ b: bucketOf(Number(r.dur)), win: Number(r.win) }))

  test("七個長度分組（每 2 分鐘一段）由短到長，勝率和 SQL 一致", async ({ page }) => {
    const bars = await visibleBars(chart(page))
    // 橫向長條圖的第一個類別畫在最下面，所以 yAxis.data 是反過來的；由上到下讀才是短 → 長
    const labels = bars.map((b) => b.label).reverse()
    const order = ["< 12 分", "12-14 分", "14-16 分", "16-18 分", "18-20 分", "20-22 分", "22 分以上"]
    expect(labels).toEqual(order.filter((o) => labels.includes(o)))
    for (const b of bars) {
      const g = games().filter((x) => x.b === b.label)
      expect(b.value, b.label).toBeCloseTo((g.reduce((a, x) => a + x.win, 0) / g.length) * 100, 1)
    }
  })

  test("點一根 → 「對局長度 X 的每一場」，場次數一致、麵包屑多一層；再點取消", async ({ page }) => {
    const pick = (await visibleBars(chart(page))).filter((b) => b.value > 8)[0]
    const n = games().filter((x) => x.b === pick.label).length
    await clickBar(page, chart(page), pick.label)
    await expect(card(page, `對局長度 ${pick.label} 的每一場`).getByText(`共 ${n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(`對局長度 ${pick.label}`)
    await clickBar(page, chart(page), pick.label)
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("收起鈕關掉列表", async ({ page }) => {
    const pick = (await visibleBars(chart(page))).filter((b) => b.value > 8)[0]
    await clickBar(page, chart(page), pick.label)
    await card(page, `對局長度 ${pick.label} 的每一場`).getByRole("button", { name: "收起" }).click()
    await expect(crumbs(page)).toHaveCount(0)
  })
})

const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
const csvOf = async (page: Page) => {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
  return readCsv(await download.path())
}

/** 勝局／敗局的平均。who：自己加追蹤對象（crew）或所有人（all）。 */
const byResultOf = (who: "crew" | "all") =>
  sql(
    `SELECT p.win, COUNT(*) n, AVG(p.kills) k, AVG(p.dmg_to_champions * 60.0 / m.game_duration) dpm
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE m.queue_id = 2400 ${who === "crew" ? "AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)" : ""}
      GROUP BY p.win`,
  )

const diffPct = (rows: ReturnType<typeof byResultOf>, key: string) => {
  const w = Number(rows.find((r) => Number(r.win) === 1)![key])
  const l = Number(rows.find((r) => Number(r.win) === 0)![key])
  return ((l - w) / Math.abs(w)) * 100
}

test.describe("敗因分析頁：看誰的數據", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "losses")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("預設多一欄「所有人（敗局相差）」：數字 = 所有參賽者勝局與敗局平均的相對差", async ({ page }) => {
    const csv = await csvOf(page)
    const iLabel = csv[0].indexOf("指標")
    const iRef = csv[0].indexOf("所有人（敗局相差）")
    expect(iRef).toBeGreaterThan(-1)
    const all = byResultOf("all")
    for (const [label, key] of [["我的擊殺", "k"], ["我的每分鐘傷害", "dpm"]] as const) {
      const r = csv.slice(1).find((x) => x[iLabel] === label)!
      expect(Number(r[iRef]), label).toBeCloseTo(diffPct(all, key), 3)
    }
  })

  test("「所有人」：不列隊內佔比與敵方數字（11 列）、沒有對照欄、不畫對局長度，每場兩隊都算所以勝率 50%", async ({ page }) => {
    await whoRadio(page, "所有人").click()
    await expect(crumbs(page)).toContainText("所有人")
    await expect(page.getByText("11 列", { exact: true })).toBeVisible()
    const groups = await gridColumn(page, "group")
    expect(new Set(groups)).toEqual(new Set(["團隊", "個人"]))
    await expect(page.locator('.ag-header-cell[col-id="refDiff"]')).toHaveCount(0)
    await expect(page.getByText("對局長度與勝率", { exact: true })).toHaveCount(0)
    await expect(card(page, "勝率")).toContainText("50.0%")
    await expect(card(page, "打不動還是被打爆")).toContainText("—")
    // 數字和獨立計算一致：每場 5 勝 5 敗，所以勝敗場數相等
    const all = byResultOf("all")
    await expect(card(page, "勝率")).toContainText(`${all[0].n} 勝 ${all[0].n} 敗`)
    const csv = await csvOf(page)
    const iLabel = csv[0].indexOf("指標")
    const iDiff = csv[0].findIndex((h) => h.startsWith("勝局 vs 敗局"))
    const kills = csv.slice(1).find((x) => x[iLabel] === "擊殺")!
    expect(Number(kills[iDiff])).toBeCloseTo(diffPct(all, "k"), 3)
  })

  test("追蹤對象：指標名稱不再是「我的」，數字 = 自己加追蹤對象的勝局與敗局平均；對局長度下鑽列出每人每場", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await expect(page.getByText("17 列", { exact: true })).toBeVisible()
    const csv = await csvOf(page)
    const iLabel = csv[0].indexOf("指標")
    const iDiff = csv[0].findIndex((h) => h.startsWith("勝局 vs 敗局"))
    expect(csv.slice(1).some((x) => x[iLabel] === "我的擊殺")).toBe(false)
    const crew = byResultOf("crew")
    expect(Number(csv.slice(1).find((x) => x[iLabel] === "擊殺")![iDiff])).toBeCloseTo(diffPct(crew, "k"), 3)
    // 對局長度下鑽：場次 = 圖上那一格的場數（每位追蹤對象每場一列）
    const chart = charts(card(page, "對局長度與勝率")).first()
    const pick = (await visibleBars(chart)).filter((b) => b.value > 0)[0]
    const n = sql(
      `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE m.queue_id = 2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)
          AND (CASE WHEN m.game_duration < 720 THEN '< 12 分' WHEN m.game_duration < 840 THEN '12-14 分'
                    WHEN m.game_duration < 960 THEN '14-16 分' WHEN m.game_duration < 1080 THEN '16-18 分'
                    WHEN m.game_duration < 1200 THEN '18-20 分' WHEN m.game_duration < 1320 THEN '20-22 分' ELSE '22 分以上' END) = ?`,
      [pick.label],
    )[0].n
    await clickBar(page, chart, pick.label)
    await expect(card(page, `對局長度 ${pick.label} 的每一場`).getByText(`共 ${n} 場`)).toBeVisible()
  })
})
