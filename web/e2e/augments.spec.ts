import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, gridColumn, gridRows, header, openPage, readCsv, ready, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const MIN_GAMES = 5
const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const nums = (xs: string[]) => xs.map((x) => Number(x.replace(/[^\d.-]/g, "")))
const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })

/** 自己每個增幅的場次與勝場（一個增幅一場只會被選一次）。 */
const myAugments = (champion?: string) =>
  sql(
    `SELECT a.name, COUNT(*) AS n, SUM(p.win) AS w
       FROM participant_augments pa
       JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
       JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id
       JOIN dim_augments a ON a.id = pa.augment_id
       JOIN dim_champions c ON c.id = p.champion_id
      WHERE p.puuid = ? AND m.queue_id = 2400 ${champion ? "AND c.name = ?" : ""}
      GROUP BY a.id ORDER BY n DESC, a.name`,
    champion ? [mePuuid(), champion] : [mePuuid()],
  )

test.describe("增幅裝置頁：表格與排行", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "augments")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("四張面板：選英雄、勝率排行、全部增幅，加上看誰的數據", async ({ page }) => {
    await expect(page.getByText("看某隻英雄上的表現")).toBeVisible()
    await expect(page.getByText("勝率排行", { exact: true })).toBeVisible()
    await expect(page.getByText("全部增幅", { exact: true })).toBeVisible()
    await expect(page.getByRole("radiogroup", { name: "看誰的數據" })).toBeVisible()
  })

  test("表格列數 = 選過的不同增幅數；每個增幅的場次與勝率和 SQL 一致", async ({ page }) => {
    const expected = myAugments()
    await expect(page.getByText(`${expected.length} 列`, { exact: true })).toBeVisible()
    const names = (await gridColumn(page, "augments.name")).map((t) => t.split("\n")[0])
    const games = nums(await gridColumn(page, "participants.games"))
    const winrates = await gridColumn(page, "participants.winrate")
    expect(games).toEqual([...games].sort((a, b) => b - a))
    const bySql = new Map(expected.map((r) => [String(r.name), r]))
    names.forEach((name, i) => {
      const r = bySql.get(name)
      expect(r, `SQL 裡沒有 ${name}`).toBeTruthy()
      expect(games[i], `${name} 場次`).toBe(Number(r!.n))
      expect(winrates[i], `${name} 勝率`).toContain(`${((Number(r!.w) / Number(r!.n)) * 100).toFixed(1)}%`)
    })
  })

  test("稀有度徽章：稜彩／金／銀", async ({ page }) => {
    const text = (await gridColumn(page, "augments.name")).join("\n")
    expect(text).toMatch(/Prismatic|Gold|Silver/)
  })

  test("勝率排行只畫 5 場以上的增幅，長條值 = SQL 勝率", async ({ page }) => {
    const chart = charts(page).first()
    const bars = await visibleBars(chart)
    expect(bars.length).toBeGreaterThan(0)
    const bySql = new Map(myAugments().map((r) => [String(r.name), r]))
    for (const b of bars) {
      const r = bySql.get(b.label)!
      expect(Number(r.n), `${b.label} 場次`).toBeGreaterThanOrEqual(MIN_GAMES)
      expect(b.value).toBeCloseTo((Number(r.w) / Number(r.n)) * 100, 1)
    }
    // 圖上畫的增幅數 = 5 場以上的增幅數
    const opt = await chart.evaluate((el) => (el.parentElement as any).__chart.getOption().yAxis[0].data.length)
    expect(opt).toBe(myAugments().filter((r) => Number(r.n) >= MIN_GAMES).length)
  })

  test("點一根長條 → 下方出現「選了「X」 的每一場」，場次數和 SQL 一致、麵包屑多一層；收起後消失", async ({ page }) => {
    const chart = charts(page).first()
    const bars = (await visibleBars(chart)).filter((b) => b.value > 8)
    const pick = bars[0]
    const r = myAugments().find((x) => x.name === pick.label)!
    await clickBar(page, chart, pick.label)
    const panel = page.locator('[data-slot="card"]', { has: page.getByText(`選了「${pick.label}」 的每一場`) })
    await expect(panel).toBeVisible()
    await expect(panel.getByText(`共 ${r.n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(pick.label)
    // 表格同時亮起那一列（選取）
    await expect(page.locator(".ag-row-selected")).toHaveCount(1)
    await panel.getByRole("button", { name: "收起" }).click()
    await expect(panel).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("單擊表格一列 → 同樣列出選了它的每一場；再單擊同一列取消", async ({ page }) => {
    const first = (await gridColumn(page, "augments.name"))[0].split("\n")[0]
    const row = page.locator('.ag-row[row-index="0"] [col-id="augments.name"]').first()
    await row.click()
    await expect(page.getByText(`選了「${first}」 的每一場`)).toBeVisible()
    await row.click()
    await expect(page.getByText(`選了「${first}」 的每一場`)).toHaveCount(0)
  })

  test("雙擊增幅名稱 → 加上全域下鑽「增幅：X」，整頁數字縮到那個增幅", async ({ page }) => {
    const first = (await gridColumn(page, "augments.name"))[0].split("\n")[0]
    await page.locator('.ag-row[row-index="0"] [col-id="augments.name"]').first().dblclick()
    await expect(crumbs(page)).toContainText(`增幅：${first}`)
    await ready(page)
    // 篩了增幅之後，表格剩下「同場一起選過」的增幅，第一名就是它自己，場次 = 它的場次
    await expect.poll(async () => nums(await gridColumn(page, "participants.games"))[0]).toBe(Number(myAugments()[0].n))
    await crumbs(page).getByRole("button", { name: `移除篩選 增幅：${first}` }).click()
    // 只移除全域下鑽；雙擊前的第一下單擊在這頁選取的聚焦是另一層，不受影響
    await expect(crumbs(page).getByRole("button", { name: /^移除篩選/ })).toHaveCount(0)
  })

  test("匯出 CSV：列數 = 增幅數，帶出隱藏欄（勝場、平均擊殺…）", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    expect(download.suggestedFilename()).toMatch(/^augments-\d{4}-\d{2}-\d{2}\.csv$/)
    const rows = await readCsv(await download.path())
    expect(rows.length - 1).toBe(myAugments().length)
    for (const col of ["增幅裝置", "場次", "勝場", "平均擊殺", "平均死亡", "平均助攻"]) expect(rows[0]).toContain(col)
  })

  test("hover 掃過長條圖不出錯", async ({ page }) => {
    const chart = charts(page).first()
    await chart.scrollIntoViewIfNeeded()
    const box = (await chart.boundingBox())!
    for (let i = 1; i < 10; i++) await page.mouse.move(box.x + box.width * 0.3, box.y + (box.height * i) / 10)
    await page.mouse.move(2, 2)
  })
})

test.describe("增幅裝置頁：選英雄看契合度", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "augments")
    await expect(gridRows(page).first()).toBeVisible()
  })

  const select = (page: Page) => page.locator('[data-slot="card"]', { has: page.getByText("看某隻英雄上的表現") }).getByRole("combobox")

  test("下拉選單：「全部英雄」加上玩過的每隻英雄（附場次）", async ({ page }) => {
    await select(page).click()
    const options = page.getByRole("option")
    await expect(options.first()).toHaveText("全部英雄")
    const champs = sql(
      `SELECT COUNT(DISTINCT p.champion_id) n FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
      [mePuuid()],
    )[0].n as number
    await expect(options).toHaveCount(champs + 1)
  })

  test("選一隻英雄：標題換成「X 最常選的增幅」、表格多出「契合度（加成）」，場次和 SQL 一致", async ({ page }) => {
    const top = sql(
      `SELECT c.name, COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN dim_champions c ON c.id = p.champion_id
        WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY c.id ORDER BY n DESC, c.name LIMIT 1`,
      [mePuuid()],
    )[0]
    const name = String(top.name)
    await select(page).click()
    await page.getByRole("option", { name: new RegExp(`^${name}（`) }).click()
    await expect(page.getByText(`${name} 最常選的增幅`)).toBeVisible()
    await expect(page.getByText(`${name} 的增幅契合度`)).toBeVisible()
    await ready(page)
    await expect(page.locator(".ag-header-cell-text", { hasText: "契合度（加成）" })).toBeVisible()
    const expected = myAugments(name)
    await expect(page.getByText(`${expected.length} 列`, { exact: true })).toBeVisible()
    const names = (await gridColumn(page, "augments.name")).map((t) => t.split("\n")[0])
    const games = nums(await gridColumn(page, "participants.games"))
    const bySql = new Map(expected.map((r) => [String(r.name), r]))
    names.forEach((n, i) => expect(games[i], `${n} 場次`).toBe(Number(bySql.get(n)!.n)))
  })

  test("選回「全部英雄」恢復原本的表格", async ({ page }) => {
    await select(page).click()
    await page.getByRole("option").nth(1).click()
    await ready(page)
    await select(page).click()
    await page.getByRole("option", { name: "全部英雄" }).click()
    await expect(page.getByText("勝率排行", { exact: true })).toBeVisible()
    await expect(page.getByText(`${myAugments().length} 列`, { exact: true })).toBeVisible()
  })

  test("從其他頁下鑽了英雄時，下拉選單鎖定並說明", async ({ page }) => {
    await openPage(page, "dashboard")
    const row = page.locator('[data-slot="card"]', { has: page.getByText("最常用英雄", { exact: true }) }).locator("button.slide-in").first()
    const name = (await row.locator("span.truncate").innerText()).trim()
    await row.click()
    await page.locator('[data-sidebar="menu-button"]', { hasText: "增幅裝置" }).click()
    await expect(header(page)).toHaveText("增幅裝置")
    await ready(page)
    await expect(select(page)).toBeDisabled()
    await expect(page.getByText(`已從其他頁下鑽到「${name}」`)).toBeVisible()
  })
})

test.describe("增幅裝置頁：看誰的數據", () => {
  test("追蹤對象／所有人會改變表格的場次，麵包屑標出現在是誰", async ({ page }) => {
    await openPage(page, "augments")
    await expect(gridRows(page).first()).toBeVisible()
    const mine = nums(await gridColumn(page, "participants.games"))[0]
    await whoRadio(page, "所有人").click()
    await expect(crumbs(page)).toContainText("所有人")
    await ready(page)
    await expect.poll(async () => nums(await gridColumn(page, "participants.games"))[0]).toBeGreaterThan(mine)
    await whoRadio(page, "目前帳號").click()
    await expect(crumbs(page)).toHaveCount(0)
    await expect.poll(async () => nums(await gridColumn(page, "participants.games"))[0]).toBe(mine)
  })
})
