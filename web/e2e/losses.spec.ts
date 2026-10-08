import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, gridColumn, gridRows, openPage, readCsv, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const bucketOf = (s: number) => (s < 900 ? "< 15 分" : s < 1200 ? "15-20 分" : s < 1500 ? "20-25 分" : "25 分以上")

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

  test("四個長度分組由短到長，勝率和 SQL 一致", async ({ page }) => {
    const bars = await visibleBars(chart(page))
    // 橫向長條圖的第一個類別畫在最下面，所以 yAxis.data 是反過來的；由上到下讀才是短 → 長
    const labels = bars.map((b) => b.label).reverse()
    const order = ["< 15 分", "15-20 分", "20-25 分", "25 分以上"]
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
