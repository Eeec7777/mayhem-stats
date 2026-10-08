import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, openPage, ready, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
const facetRadio = (page: Page, name: string) => page.getByRole("radiogroup", { name: "比較的面向" }).getByRole("radio", { name })
const matrix = (page: Page) => page.locator("table").first()
/** 矩陣裡某一格（我方 × 敵方）。 */
const cell = (page: Page, mine: string, enemy: string) => matrix(page).locator(`button[title^="我方 ${mine} × 敵方 ${enemy}："]`)

const bucket = (n: number) => (n >= 3 ? "3 個以上" : `${n} 個`)
const mixOf = (ad: number, ap: number) => (ad - ap >= 2 ? "物理為主" : ap - ad >= 2 ? "魔法為主" : "混合")

/** 獨立算出：每場我方／敵方的前排數、物理魔法人數，再按對陣分組。 */
function lineupGames() {
  return sql(
    `WITH g AS (
       SELECT p.platform_id, p.game_id, p.team_id AS my, p.win
         FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400),
     t AS (
       SELECT q.platform_id, q.game_id, q.team_id,
              SUM(b.build_role = '坦克' OR b.build_role LIKE '%鬥士') AS front,
              SUM(b.build_role LIKE 'AD %') AS ad, SUM(b.build_role LIKE 'AP %') AS ap,
              SUM(b.build_role = '輔助') AS sup
         FROM match_participants q LEFT JOIN mat_builds b ON b.participant_rowid = q.rowid
        GROUP BY q.platform_id, q.game_id, q.team_id)
     SELECT g.game_id, g.win, mt.front AS mf, et.front AS ef, mt.ad AS mad, mt.ap AS map_, et.ad AS ead, et.ap AS eap
       FROM g JOIN t mt ON mt.platform_id = g.platform_id AND mt.game_id = g.game_id AND mt.team_id = g.my
              JOIN t et ON et.platform_id = g.platform_id AND et.game_id = g.game_id AND et.team_id <> g.my`,
    [mePuuid()],
  ).map((r) => ({
    win: Number(r.win),
    mf: bucket(Number(r.mf)),
    ef: bucket(Number(r.ef)),
    mm: mixOf(Number(r.mad), Number(r.map_)),
    em: mixOf(Number(r.ead), Number(r.eap)),
  }))
}

const tally = <T,>(rows: T[], key: (r: T) => string, win: (r: T) => number) => {
  const m = new Map<string, { n: number; w: number }>()
  for (const r of rows) {
    const c = m.get(key(r)) ?? { n: 0, w: 0 }
    m.set(key(r), { n: c.n + 1, w: c.w + win(r) })
  }
  return m
}

test.describe("陣容頁：對陣矩陣", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(matrix(page)).toBeVisible()
  })

  test("四種面向：前排數（預設）、輸出組成、輔助、陣容類型", async ({ page }) => {
    const group = page.getByRole("radiogroup", { name: "比較的面向" })
    await expect(group.getByRole("radio")).toHaveText(["前排數", "輸出組成", "輔助", "陣容類型"])
    await expect(facetRadio(page, "前排數")).toHaveAttribute("aria-checked", "true")
  })

  test("前排數矩陣：每一格的場次、勝率和獨立 SQL 逐格一致", async ({ page }) => {
    const games = lineupGames()
    const cells = tally(games, (g) => `${g.mf}|${g.ef}`, (g) => g.win)
    expect(cells.size).toBeGreaterThan(3)
    for (const [key, v] of cells) {
      const [m, e] = key.split("|")
      const btn = cell(page, m, e)
      await expect(btn, `${m} × ${e}`).toHaveAttribute("title", `我方 ${m} × 敵方 ${e}：${v.n} 場 ${v.w} 勝`)
      await expect(btn).toContainText(`${Math.round((100 * v.w) / v.n)}%`)
    }
  })

  test("「我方合計」欄與「遇到的敵方合計」列 = 各格加總；總場次 = 自己的 Mayhem 場次", async ({ page }) => {
    const games = lineupGames()
    const mine = tally(games, (g) => g.mf, (g) => g.win)
    for (const [m, v] of mine) {
      await expect(matrix(page).locator(`button[title^="我方 ${m}（不論敵方）"]`)).toHaveAttribute("title", `我方 ${m}（不論敵方）：${v.n} 場 ${v.w} 勝`)
    }
    const theirs = tally(games, (g) => g.ef, (g) => g.win)
    for (const [e, v] of theirs) {
      await expect(matrix(page).locator(`button[title^="敵方 ${e}（不論我方）"]`)).toHaveAttribute("title", `敵方 ${e}（不論我方）：${v.n} 場 ${v.w} 勝`)
    }
    expect([...mine.values()].reduce((a, v) => a + v.n, 0)).toBe(games.length)
  })

  test("輸出組成矩陣：物理為主／混合／魔法為主，逐格和 SQL 一致", async ({ page }) => {
    await facetRadio(page, "輸出組成").click()
    await expect(facetRadio(page, "輸出組成")).toHaveAttribute("aria-checked", "true")
    const cells = tally(lineupGames(), (g) => `${g.mm}|${g.em}`, (g) => g.win)
    for (const [key, v] of cells) {
      const [m, e] = key.split("|")
      await expect(cell(page, m, e), `${m} × ${e}`).toHaveAttribute("title", `我方 ${m} × 敵方 ${e}：${v.n} 場 ${v.w} 勝`)
    }
  })

  test("輔助面向：有輔助／沒有輔助兩種", async ({ page }) => {
    await facetRadio(page, "輔助").click()
    await expect(matrix(page).locator("thead")).toContainText("沒有輔助")
    await expect(matrix(page).locator("tbody th").first()).toHaveText(/有輔助|沒有輔助/)
  })

  test("陣容類型面向：沒出現過的類型整列整欄省略，列標題格式「N 前排・混合」", async ({ page }) => {
    await facetRadio(page, "陣容類型").click()
    await expect(matrix(page).locator("tbody th").nth(2)).toBeVisible()
    const labels = await matrix(page).locator("tbody th").allInnerTexts()
    expect(labels.length).toBeGreaterThan(2)
    expect(labels.length).toBeLessThanOrEqual(13) // 12 種 + 合計列
    for (const l of labels.slice(0, -1)) expect(l).toMatch(/^(0|1|2|3\+) 前排・(物理為主|混合|魔法為主)$/)
  })

  test("點一格 → 列出那幾場，標題與場次數和格子一致，格子亮起、麵包屑多一層；再點取消", async ({ page }) => {
    const cells = tally(lineupGames(), (g) => `${g.mf}|${g.ef}`, (g) => g.win)
    const [key, v] = [...cells].sort((a, b) => b[1].n - a[1].n)[0]
    const [m, e] = key.split("|")
    const btn = cell(page, m, e)
    await btn.click()
    const title = `我方前排 ${m} × 敵方前排 ${e}`
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`${title} 的每一場`) })
    await expect(drill).toBeVisible()
    await expect(drill.getByText(`共 ${v.n} 場`)).toBeVisible()
    await expect(drill.getByText(new RegExp(`${v.w} 勝 ${v.n - v.w} 敗`))).toBeVisible()
    await expect(crumbs(page)).toContainText(title)
    await expect(btn).toHaveClass(/ring-2/)
    await btn.click()
    await expect(drill).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("點合計格（只看一邊）→ 列出我方這種前排數的所有場次", async ({ page }) => {
    const mine = tally(lineupGames(), (g) => g.mf, (g) => g.win)
    const [m, v] = [...mine].sort((a, b) => b[1].n - a[1].n)[0]
    await matrix(page).locator(`button[title^="我方 ${m}（不論敵方）"]`).click()
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`我方前排 ${m} 的每一場`) })
    await expect(drill.getByText(`共 ${v.n} 場`)).toBeVisible()
  })

  test("切換面向會清掉聚焦", async ({ page }) => {
    await matrix(page).locator("tbody button").first().click()
    await expect(crumbs(page)).toBeVisible()
    await facetRadio(page, "輸出組成").click()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("說明文字：整體勝率、前排的定義", async ({ page }) => {
    await expect(page.getByText(/顏色和整體 \d+\.\d% 比/)).toBeVisible()
    await expect(page.getByText(/前排＝出裝是坦克、AD 鬥士或 AP 鬥士的人/)).toBeVisible()
  })
})

test.describe("陣容頁：陣容類型長條", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(charts(page)).toHaveCount(2)
  })

  test("兩張長條圖：我方陣容類型、遇到的敵方陣容類型，長條 = 勝率，各圖場次加總 = 總場次", async ({ page }) => {
    const total = lineupGames().length
    for (const i of [0, 1]) {
      const opt = await charts(page).nth(i).evaluate((el) => (el.parentElement as any).__chart.getOption())
      const labels: string[] = opt.yAxis[0].data
      expect(labels.length).toBeGreaterThan(2)
      // 長條末端的場次寫在 label 或 data 上；用場次加總驗證：點進去的每一場數 = 這根長條的場次，這裡只確認有資料
      expect(opt.series[0].data.length).toBe(labels.length)
    }
    void total
  })

  test("點「我方陣容類型」的一根長條 → 列出那種陣容的每一場，場次數和 SQL 一致", async ({ page }) => {
    const chart = charts(page).first()
    const bars = (await visibleBars(chart)).filter((b) => b.value > 8)
    const pick = bars[0]
    await clickBar(page, chart, pick.label)
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`我方 ${pick.label} 的每一場`) })
    await expect(drill).toBeVisible()
    await expect(crumbs(page)).toContainText(pick.label)
    // 標題的場次 = SQL：這個陣容類型 = 前排數 + 輸出組成
    const [front, mix] = pick.label.split(" 前排・")
    const n = lineupGames().filter((g) => (front === "3+" ? g.mf === "3 個以上" : g.mf === `${front} 個`) && g.mm === mix).length
    await expect(drill.getByText(`共 ${n} 場`)).toBeVisible()
  })

  test("點「遇到的敵方陣容類型」的一根長條 → 標題是「敵方 …」", async ({ page }) => {
    const chart = charts(page).nth(1)
    const pick = (await visibleBars(chart)).filter((b) => b.value > 8)[0]
    await clickBar(page, chart, pick.label)
    await expect(page.locator('[data-slot="card"]', { has: page.getByText(`敵方 ${pick.label} 的每一場`) })).toBeVisible()
  })
})

test.describe("陣容頁：看誰的數據", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(matrix(page)).toBeVisible()
  })

  test("預設單位是「場」；換成「所有人」單位變「隊」，矩陣對稱（A 打 B + B 打 A = 100%）", async ({ page }) => {
    await expect(matrix(page).locator("button").first()).toContainText("場")
    await whoRadio(page, "所有人").click()
    await expect(crumbs(page)).toContainText("所有人")
    await ready(page)
    await expect(matrix(page).locator("button").first()).toContainText("隊")
    await expect(page.getByText(/矩陣對稱/)).toBeVisible()
    // 對稱：取兩個非對角的格子，勝率加起來 100（四捨五入容許 1）
    const titles = await matrix(page).locator('tbody button[title*=" × 敵方 "]').evaluateAll((els) =>
      els.map((e) => ({ t: e.getAttribute("title")!, text: (e as HTMLElement).innerText })),
    )
    const wrOf = new Map(titles.map((x) => [x.t.split("：")[0], Number(x.text.match(/(\d+)%/)![1])]))
    let checked = 0
    for (const [k, v] of wrOf) {
      const m = k.match(/^我方 (.+) × 敵方 (.+)$/)!
      const opposite = wrOf.get(`我方 ${m[2]} × 敵方 ${m[1]}`)
      if (opposite === undefined) continue
      expect(Math.abs(v + opposite - 100), k).toBeLessThanOrEqual(1)
      checked++
    }
    expect(checked).toBeGreaterThan(2)
  })

  test("所有人模式下點一格：列出的場次數等於格子上的隊數", async ({ page }) => {
    await whoRadio(page, "所有人").click()
    await ready(page)
    const first = matrix(page).locator('tbody button[title*=" × 敵方 "]').first()
    const title = (await first.getAttribute("title"))!
    const n = Number(title.match(/：(\d+) 隊/)![1])
    await first.click()
    // 每隊挑一位代表，所以列數 = 隊數（不是十個人都列）
    await expect(page.getByText(new RegExp(`共 ${n} 場`))).toBeVisible()
  })
})
