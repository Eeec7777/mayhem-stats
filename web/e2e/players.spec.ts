import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, gridColumn, gridRows, openPage, readCsv, ready, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const nums = (xs: string[]) => xs.map((x) => Number(x.replace(/[^\d.-]/g, "")))
const radio = (scope: Page | ReturnType<Page["locator"]>, name: string | RegExp) => scope.getByRole("radio", { name })
const tablePanel = (page: Page) => page.locator('[data-slot="card"]', { has: page.getByText("同場過的人", { exact: true }) })

/** 我每個同場過的人：同隊／敵對的場次與我方勝場（只算 Mayhem）。 */
const people = () =>
  sql(
    `SELECT o.puuid, o.riot_id AS name, COUNT(*) AS games, SUM(me.win) AS wins,
            SUM(o.team_id = me.team_id) AS mate, SUM(o.team_id <> me.team_id) AS foe,
            SUM(CASE WHEN o.team_id = me.team_id THEN me.win ELSE 0 END) AS mate_wins,
            SUM(CASE WHEN o.team_id <> me.team_id THEN me.win ELSE 0 END) AS foe_wins
       FROM match_participants me
       JOIN matches m ON m.platform_id = me.platform_id AND m.game_id = me.game_id
       JOIN match_participants o ON o.platform_id = me.platform_id AND o.game_id = me.game_id AND o.participant_id <> me.participant_id
      WHERE me.puuid = ? AND m.queue_id = 2400
      GROUP BY o.puuid ORDER BY games DESC, o.riot_id`,
    [mePuuid()],
  )

test.describe("隊友 / 對手頁：同隊朋友數", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "players")
  })

  test("長條圖：N 人 = 我方隊伍裡除了自己之外有幾個追蹤中的帳號，每根長條的勝率和 SQL 一致", async ({ page }) => {
    const bySql = sql(
      `WITH crew AS (SELECT puuid FROM accounts WHERE tracked = 1),
            g AS (SELECT p.platform_id, p.game_id, p.team_id, p.win FROM match_participants p JOIN matches m USING (platform_id, game_id)
                   WHERE p.puuid = ? AND m.queue_id = 2400)
       SELECT n, COUNT(*) AS games, SUM(win) AS wins FROM (
         SELECT g.platform_id, g.game_id, g.win,
                (SELECT COUNT(*) FROM match_participants q WHERE q.platform_id = g.platform_id AND q.game_id = g.game_id AND q.team_id = g.team_id
                    AND q.puuid <> ? AND q.puuid IN (SELECT puuid FROM crew)) AS n
           FROM g) GROUP BY n ORDER BY n`,
      [mePuuid(), mePuuid()],
    )
    const bars = await visibleBars(charts(page).first())
    expect(bars.map((b) => b.label).sort()).toEqual(bySql.map((r) => `${r.n} 人`).sort())
    for (const b of bars) {
      const r = bySql.find((x) => `${x.n} 人` === b.label)!
      expect(b.value, b.label).toBeCloseTo((Number(r.wins) / Number(r.games)) * 100, 1)
    }
  })
})

test.describe("隊友 / 對手頁：同場過的人", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "players")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("四個分頁的人數和 SQL 一致：全部、同隊過、敵對過、兩邊都遇過", async ({ page }) => {
    const all = people()
    const group = tablePanel(page)
    await expect(radio(group, /^全部/)).toHaveText(`全部（${all.length}）`)
    await expect(radio(group, /^同隊過/)).toHaveText(`同隊過（${all.filter((p) => Number(p.mate) > 0).length}）`)
    await expect(radio(group, /^敵對過/)).toHaveText(`敵對過（${all.filter((p) => Number(p.foe) > 0).length}）`)
    await expect(radio(group, /^兩邊都遇過/)).toHaveText(`兩邊都遇過（${all.filter((p) => Number(p.mate) > 0 && Number(p.foe) > 0).length}）`)
  })

  test("預設「全部」，表格有「N 列」，欄位：玩家、同場、同隊、同隊時我的戰績、敵對、敵對時我的戰績、最近同場", async ({ page }) => {
    await expect(radio(tablePanel(page), /^全部/)).toHaveAttribute("aria-checked", "true")
    await expect(page.getByText(`${people().length} 列`, { exact: true })).toBeVisible()
    for (const col of ["玩家", "同場", "同隊", "同隊時我的戰績", "敵對", "敵對時我的戰績", "最近同場"]) {
      await expect(page.locator(".ag-header-cell-text", { hasText: new RegExp(`^${col}$`) })).toBeVisible()
    }
  })

  test("每一列的同場／同隊／敵對場次和 SQL 一致", async ({ page }) => {
    const bySql = new Map(people().map((p) => [String(p.name), p]))
    const names = await gridColumn(page, "player")
    const games = nums(await gridColumn(page, "games"))
    const mate = nums(await gridColumn(page, "mate_games"))
    const foe = nums(await gridColumn(page, "foe_games"))
    expect(names.length).toBeGreaterThan(5)
    names.forEach((name, i) => {
      const p = bySql.get(name)
      expect(p, `SQL 裡沒有 ${name}`).toBeTruthy()
      // 同名的人（改過名）可能不只一個，只在名字唯一時比數字
      const dupes = people().filter((x) => x.name === name).length
      if (dupes > 1) return
      expect([games[i], mate[i], foe[i]], `第 ${i + 1} 列`).toEqual([Number(p!.games), Number(p!.mate), Number(p!.foe)])
    })
  })

  test("同隊時我的戰績：勝敗場數與 SQL 一致，沒同隊過的寫「沒有同隊過」", async ({ page }) => {
    const bySql = new Map(people().map((p) => [String(p.name), p]))
    const names = await gridColumn(page, "player")
    const mateCells = await gridColumn(page, "mate_winrate")
    names.forEach((name, i) => {
      const p = bySql.get(name)!
      if (people().filter((x) => x.name === name).length > 1) return
      if (Number(p.mate) === 0) expect(mateCells[i]).toContain("沒有同隊過")
      else expect(mateCells[i]).toContain(`${p.mate_wins} 勝 ${Number(p.mate) - Number(p.mate_wins)} 敗`)
    })
  })

  test("分頁「同隊過」只剩同隊過的人；「兩邊都遇過」只剩既同隊又敵對的人", async ({ page }) => {
    await radio(tablePanel(page), /^同隊過/).click()
    await expect(page.getByText(`${people().filter((p) => Number(p.mate) > 0).length} 列`, { exact: true })).toBeVisible()
    for (const v of nums(await gridColumn(page, "mate_games"))) expect(v).toBeGreaterThan(0)
    await radio(tablePanel(page), /^兩邊都遇過/).click()
    await expect(page.getByText(`${people().filter((p) => Number(p.mate) > 0 && Number(p.foe) > 0).length} 列`, { exact: true })).toBeVisible()
    for (const v of nums(await gridColumn(page, "foe_games"))) expect(v).toBeGreaterThan(0)
  })

  test("匯出 CSV：檔名依分頁（players-all），帶出隱藏的勝場欄", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    expect(download.suggestedFilename()).toMatch(/^players-all-\d{4}-\d{2}-\d{2}\.csv$/)
    const rows = await readCsv(await download.path())
    expect(rows.length - 1).toBe(people().length)
    for (const col of ["同場我方勝場", "同隊勝場", "敵對時我方勝場"]) expect(rows[0]).toContain(col)
  })

  test("快速搜尋：輸入名字只剩符合的列", async ({ page }) => {
    const name = (await gridColumn(page, "player"))[0]
    await page.getByPlaceholder("快速搜尋所有欄位…").fill(name)
    await expect.poll(async () => (await gridColumn(page, "player")).every((n) => n.includes(name))).toBe(true)
  })
})

test.describe("隊友 / 對手頁：單一玩家抽屜", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "players")
    await expect(gridRows(page).first()).toBeVisible()
  })

  /** 點第一列，回傳那個人和 SQL 裡對應的資料。 */
  const openFirst = async (page: Page) => {
    const name = (await gridColumn(page, "player"))[0]
    const p = people().find((x) => x.name === name)!
    await page.locator('.ag-row[row-index="0"] [col-id="player"]').first().click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading", { name })).toBeVisible()
    return { name, p, drawer }
  }

  test("單擊一列開抽屜：標題是玩家、副標題有同場／同隊／敵對場次和最近日期，麵包屑多一層，Esc 關閉", async ({ page }) => {
    const { name, p, drawer } = await openFirst(page)
    await expect(drawer.getByText(new RegExp(`同場 ${p.games} 場 · 同隊 ${p.mate} · 敵對 ${p.foe}`))).toBeVisible()
    await expect(crumbs(page)).toContainText(name)
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("三張 KPI：同場次數、同隊時我的勝率、敵對時我的勝率，數字和 SQL 一致", async ({ page }) => {
    const { p, drawer } = await openFirst(page)
    const card = (label: string) => drawer.locator('[data-slot="card"]', { has: page.getByText(label, { exact: true }) }).first()
    await expect(card("同場次數")).toContainText(String(p.games))
    await expect(card("同場次數")).toContainText(`同隊 ${p.mate} 場 · 敵對 ${p.foe} 場`)
    if (Number(p.mate)) await expect(card("同隊時我的勝率")).toContainText(`${((Number(p.mate_wins) / Number(p.mate)) * 100).toFixed(1)}%`)
    if (Number(p.foe)) await expect(card("敵對時我的勝率")).toContainText(`${((Number(p.foe_wins) / Number(p.foe)) * 100).toFixed(1)}%`)
  })

  test("「每一場」預設兩邊一起列：共 N 場 = 同場次數，卡片上圈出他那場用的英雄", async ({ page }) => {
    const { p, drawer } = await openFirst(page)
    await expect(drawer.getByText(`共 ${p.games} 場`)).toBeVisible()
    await expect(drawer.locator("button.slide-in").first().locator("img.ring-primary")).toBeVisible()
  })

  test("切到「同隊」「敵對」：列出的場次數 = 該關係的場次；沒有那種關係的選項是停用的", async ({ page }) => {
    const { p, drawer } = await openFirst(page)
    if (Number(p.mate)) {
      await radio(drawer, /^同隊（/).click()
      await expect(drawer.getByText(`共 ${p.mate} 場`)).toBeVisible()
      await expect(crumbs(page)).toContainText("同隊")
    } else {
      await expect(radio(drawer, /^同隊（/)).toBeDisabled()
    }
    if (Number(p.foe)) {
      await radio(drawer, /^敵對（/).click()
      await expect(drawer.getByText(`共 ${p.foe} 場`)).toBeVisible()
    } else {
      await expect(radio(drawer, /^敵對（/)).toBeDisabled()
    }
  })

  test("「英雄與定位拆解」：出裝定位長條 + 逐隻英雄表格；點定位只剩那一類並固定看我的英雄", async ({ page }) => {
    const { p, drawer } = await openFirst(page)
    await radio(drawer, "英雄與定位拆解").click()
    await expect(drawer.getByText("我玩哪類英雄比較會贏")).toBeVisible()
    await expect(drawer.getByText("逐隻英雄", { exact: true })).toBeVisible()
    const chart = charts(drawer).first()
    await expect(chart).toBeVisible()
    const bars = await visibleBars(chart)
    expect(bars.length).toBeGreaterThan(0)
    // 逐隻英雄（我的英雄）的場次加總 = 和他同場的總場次
    const [download] = await Promise.all([page.waitForEvent("download"), drawer.getByRole("button", { name: "匯出 CSV" }).click()])
    const csv = await readCsv(await download.path())
    const iGames = csv[0].indexOf("場次")
    expect(csv.slice(1).reduce((a, r) => a + Number(r[iGames]), 0)).toBe(Number(p.games))
    // 點定位：出現「只看X」晶片，「他的英雄」選項停用
    const clickable = bars.filter((b) => b.value > 8)[0] ?? bars[0]
    await clickBar(page, chart, clickable.label)
    await expect(drawer.getByRole("button", { name: `只看${clickable.label}` })).toBeVisible()
    await expect(radio(drawer, / 的英雄$/)).toBeDisabled()
    await drawer.getByRole("button", { name: `只看${clickable.label}` }).click()
    await expect(drawer.getByRole("button", { name: `只看${clickable.label}` })).toHaveCount(0)
  })

  test("「追蹤這個人」／「追蹤中」：按下去送出 POST /api/accounts/track，內容是這個人的 puuid", async ({ page, writes }) => {
    const { p, drawer } = await openFirst(page)
    const btn = drawer.getByRole("button", { name: /追蹤這個人|追蹤中/ })
    await expect(btn).toBeVisible()
    const wasTracked = (await btn.innerText()).includes("追蹤中")
    await btn.click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/accounts/track", body: { puuid: String(p.puuid), tracked: !wasTracked } })
    // 被攔截，所以真實追蹤名單沒變；畫面上的狀態已切換
    await expect(drawer.getByRole("button", { name: wasTracked ? "追蹤這個人" : "追蹤中" })).toBeVisible()
  })

  test("抽屜裡點一場可以看戰報", async ({ page }) => {
    const { drawer } = await openFirst(page)
    await drawer.locator("button.slide-in").first().click()
    await expect(drawer.getByRole("tab", { name: "計分板" })).toBeVisible()
  })

  test("切換帳號後，開著的抽屜與麵包屑一起清掉", async ({ page }) => {
    await openFirst(page)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+k")
    await page.getByRole("dialog", { name: "切換帳號" }).getByRole("option").nth(1).click()
    await ready(page)
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })
})

test("隊友 / 對手頁：從儀表板下鑽英雄後，同場玩家表提示沒套用的條件、只套英雄", async ({ page }) => {
  await openPage(page, "dashboard")
  await page.locator('[data-slot="card"]', { has: page.getByText("最常選的增幅", { exact: true }) }).locator("button.slide-in").first().click()
  await page.locator('[data-sidebar="menu-button"]', { hasText: "隊友 / 對手" }).click()
  await ready(page)
  await expect(page.getByText(/下面的同場玩家表沒有套用「增幅：.+」/)).toBeVisible()
})
