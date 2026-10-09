import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, filters, header, openPage, ready } from "./helpers"
import { mePuuid, myRecord, sql } from "./db"

const cards = (page: Page) => page.locator("main main button.slide-in")
const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

/** 我自己的 Mayhem 場次，新到舊。 */
const myMatches = (limit: number, offset = 0) =>
  sql(
    `SELECT m.platform_id, m.game_id, m.game_duration, p.participant_id, p.win, p.kills, p.deaths, p.assists, p.cs, p.team_id, d.name AS champion
       FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN dim_champions d ON d.id = p.champion_id
      WHERE p.puuid = ? AND m.queue_id = 2400 ORDER BY m.game_creation DESC LIMIT ? OFFSET ?`,
    [mePuuid(), limit, offset],
  )

test.describe("對局紀錄：列表", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "matches")
    await expect(cards(page).first()).toBeVisible()
  })

  test("摘要列：總場數、勝敗、勝率和 SQL 一致", async ({ page }) => {
    const { games, wins } = myRecord()
    await expect(page.getByText(`共 ${games} 場・${wins} 勝 ${games - wins} 敗・勝率 ${((wins / games) * 100).toFixed(1)}%`)).toBeVisible()
  })

  test("第一批載入 20 場，由新到舊，英雄、勝敗、KDA、補兵、時長都和 SQL 一致", async ({ page }) => {
    // 第一批是 20 場；視窗夠高時，底部哨兵已經在預載範圍內，會馬上接著載下一批，所以不是剛好 20
    await expect.poll(() => cards(page).count()).toBeGreaterThanOrEqual(20)
    for (const [i, g] of myMatches(20).entries()) {
      const c = cards(page).nth(i)
      await expect(c.locator("img").first(), `第 ${i + 1} 場英雄`).toHaveAttribute("title", String(g.champion))
      await expect(c).toContainText(g.win ? "勝利" : "戰敗")
      await expect(c).toContainText(fmtDuration(Number(g.game_duration)))
      await expect(c).toContainText(`${g.kills} / ${g.deaths} / ${g.assists}`)
      await expect(c).toContainText(`${g.cs} 補兵`)
      const kda = g.deaths === 0 ? "Perfect" : ((Number(g.kills) + Number(g.assists)) / Number(g.deaths)).toFixed(2)
      await expect(c).toContainText(`KDA ${kda}`)
    }
  })

  test("每張卡片：我方 4 位隊友 + 對手 5 位的英雄圖示、最多 4 個增幅、出裝格", async ({ page }) => {
    const c = cards(page).first()
    await expect(c.locator('[title="我方"] img')).toHaveCount(4)
    await expect(c.locator('[title="對手"] img')).toHaveCount(5)
    // 卡片上的 img：英雄 1 + 增幅（至少 4 格，空格不是 img）+ 裝備（最多 7）+ 隊友 9
    expect(await c.locator("img").count()).toBeGreaterThanOrEqual(1 + 9)
  })

  test("勝利卡片用勝色底、戰敗用敗色底", async ({ page }) => {
    for (const [i, g] of myMatches(10).entries()) {
      await expect(cards(page).nth(i)).toHaveClass(g.win ? /bg-win/ : /bg-loss/)
    }
  })

  test("卡片上有出裝定位晶片與表現分", async ({ page }) => {
    const c = cards(page).first()
    await expect(c.getByText(/^表現 \d+$/)).toBeVisible()
    await expect(c.locator("[class*='border']").filter({ hasText: /坦克|輸出|鬥士|刺客|輔助/ }).first()).toBeVisible()
  })

  test("MVP／ACE 標籤：同一場最多一個，且 MVP 只出現在勝場、ACE 只出現在敗場", async ({ page }) => {
    const n = await cards(page).count()
    for (let i = 0; i < n; i++) {
      const c = cards(page).nth(i)
      const mvp = await c.getByText("MVP", { exact: true }).count()
      const ace = await c.getByText("ACE", { exact: true }).count()
      expect(mvp + ace).toBeLessThanOrEqual(1)
      if (mvp) await expect(c).toContainText("勝利")
      if (ace) await expect(c).toContainText("戰敗")
    }
  })

  test("「載入更多」按鈕再載入 50 場，標示已載入數", async ({ page }) => {
    // 視窗矮一點，哨兵才不會落在預載範圍（捲動前 600px）內而自動載入
    await page.setViewportSize({ width: 1500, height: 360 })
    await openPage(page, "matches")
    const { games } = myRecord()
    const more = page.getByRole("button", { name: /載入更多/ })
    await expect(more).toContainText(`已載入 20 / ${games} 場`)
    // 不用 click()：Playwright 會先把按鈕捲進視窗，那一捲就讓哨兵進了預載範圍，自動載入搶在點擊之前
    await more.dispatchEvent("click")
    await expect(cards(page)).toHaveCount(Math.min(70, games))
  })

  test("一路載到底：全部場次都列出來、沒有重複，結尾有「已經是全部 N 場」", async ({ page }) => {
    const { games } = myRecord()
    test.setTimeout(120_000)
    for (let i = 0; i < 12; i++) {
      if ((await cards(page).count()) >= games) break
      await page.mouse.wheel(0, 100_000)
      await page.getByRole("button", { name: /載入更多/ }).click({ timeout: 2000 }).catch(() => undefined)
      await page.waitForTimeout(700)
    }
    await expect(cards(page)).toHaveCount(games)
    await expect(page.getByText(`已經是全部 ${games} 場`)).toBeVisible()
    // 沒有重複：標題 + 時間（日期欄）組合不應重複
    const stamps = await cards(page).evaluateAll((els) => els.map((e) => e.textContent!.match(/\d{4}\/\d{2}\/\d{2}[^\d]*\d{1,2}:\d{2}/)?.[0] ?? e.textContent!.slice(-40)))
    expect(new Set(stamps).size).toBe(stamps.length)
  })

  test("頁面說明下有出裝定位圖例", async ({ page }) => {
    await expect(page.getByText("近期對戰")).toBeVisible()
  })
})

test.describe("對局紀錄：單場戰報", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "matches")
    await expect(cards(page).first()).toBeVisible()
  })

  test("點卡片進入戰報：有「回列表」、勝敗、模式／時長／日期，麵包屑多一層", async ({ page }) => {
    const g = myMatches(1)[0]
    await cards(page).first().click()
    await expect(page.getByRole("button", { name: "回列表" })).toBeVisible()
    await expect(page.getByText(g.win ? "勝利" : "失敗", { exact: true }).first()).toBeVisible()
    await expect(page.getByText(new RegExp(`${fmtDuration(Number(g.game_duration))} ·`))).toBeVisible()
    await expect(crumbs(page)).toContainText(String(g.champion))
  })

  test("計分板：兩隊各 5 人，隊伍擊殺／死亡／助攻合計和 SQL 一致，自己那一列有強調", async ({ page }) => {
    const g = myMatches(1)[0]
    await cards(page).first().click()
    const teamBoxes = page.locator('[role="tabpanel"]').first().locator("> div.space-y-4 > div")
    await expect(teamBoxes).toHaveCount(2)
    for (const teamBox of await teamBoxes.all()) await expect(teamBox.locator(".divide-y > div")).toHaveCount(5)
    await expect(page.getByText(/隊伍 1 · (勝利|失敗)/)).toBeVisible()
    await expect(page.getByText(/隊伍 2 · (勝利|失敗)/)).toBeVisible()
    for (const team of [100, 200]) {
      const t = sql(
        `SELECT SUM(kills) k, SUM(deaths) d, SUM(assists) a, SUM(gold_earned) gold FROM match_participants WHERE platform_id = ? AND game_id = ? AND team_id = ?`,
        [String(g.platform_id), Number(g.game_id), team],
      )[0]
      const box = teamBoxes.nth(team === 100 ? 0 : 1)
      await expect(box.locator("> div").first()).toContainText(`${t.k} / ${t.d} / ${t.a}`)
      await expect(box.locator("> div").first()).toContainText(Number(t.gold).toLocaleString("en-US"))
    }
    await expect(page.locator('[role="tabpanel"]').first().locator(".bg-primary\\/10")).toHaveCount(1)
  })

  test("計分板每個人的 KDA 與金錢和 SQL 逐列一致", async ({ page }) => {
    const g = myMatches(1)[0]
    await cards(page).first().click()
    const rows = page.locator('[role="tabpanel"]').first().locator(".divide-y > div")
    await expect(rows).toHaveCount(10)
    const players = sql(
      `SELECT team_id, participant_id, kills, deaths, assists, gold_earned FROM match_participants WHERE platform_id = ? AND game_id = ? ORDER BY team_id, participant_id`,
      [String(g.platform_id), Number(g.game_id)],
    )
    const texts = await rows.allInnerTexts()
    for (const p of players) {
      const hit = texts.filter((t) => t.includes(`${p.kills} / ${p.deaths} / ${p.assists}`) && t.includes(Number(p.gold_earned).toLocaleString("en-US")))
      expect(hit.length, `participant ${p.participant_id}`).toBeGreaterThanOrEqual(1)
    }
  })

  test("每一列都有表現分；整場剛好一個 MVP 和一個 ACE（6 分鐘以上的對局）", async ({ page }) => {
    const g = myMatches(1)[0]
    test.skip(Number(g.game_duration) < 360, "6 分鐘內的重開局不計分")
    await cards(page).first().click()
    const board = page.locator('[role="tabpanel"]').first()
    await expect(board.locator("button[aria-expanded]")).toHaveCount(10)
    await expect(board.getByText("MVP", { exact: true })).toHaveCount(1)
    await expect(board.getByText("ACE", { exact: true })).toHaveCount(1)
  })

  test("點某人的表現分展開六項明細：雷達圖 + 橫條，再點收合", async ({ page }) => {
    await cards(page).first().click()
    const board = page.locator('[role="tabpanel"]').first()
    const meter = board.locator("button[aria-expanded]").first()
    await meter.click()
    await expect(meter).toHaveAttribute("aria-expanded", "true")
    const reveal = board.locator(".reveal")
    await expect(reveal).toHaveCount(1)
    await expect(reveal.getByText(/當局表現：每分鐘的實際數值/)).toBeVisible()
    await expect(charts(reveal)).toHaveCount(1)
    expect(await reveal.locator("[title*='百分位']").count()).toBeGreaterThanOrEqual(5)
    await meter.click()
    await expect(reveal).toHaveCount(0)
  })

  test("可以同時展開好幾個人互相比", async ({ page }) => {
    await cards(page).first().click()
    const meters = page.locator('[role="tabpanel"]').first().locator("button[aria-expanded]")
    await meters.nth(0).click()
    await meters.nth(1).click()
    await expect(page.locator('[role="tabpanel"]').first().locator(".reveal")).toHaveCount(2)
  })

  test("「數據」分頁：十人橫向比較表，分區標題齊全，全場最高值以主色標出", async ({ page }) => {
    await cards(page).first().click()
    await page.getByRole("tab", { name: "數據" }).click()
    const table = page.locator("table").first()
    await expect(table).toBeVisible()
    for (const title of ["對戰", "造成傷害", "承受與生存", "資源"]) await expect(table.getByText(title, { exact: true })).toBeVisible()
    await expect(table.getByText(/^當局表現（/)).toBeVisible()
    await expect(table.getByText(/^隊內貢獻（/)).toBeVisible()
    await expect(table.locator("thead th")).toHaveCount(11) // 項目 + 10 位
    await expect(table.locator("td.text-primary").first()).toBeVisible()
  })

  test("數據表的對英雄總傷害、擊殺和 SQL 一致", async ({ page }) => {
    const g = myMatches(1)[0]
    await cards(page).first().click()
    await page.getByRole("tab", { name: "數據" }).click()
    const table = page.locator("table").first()
    const rowValues = async (label: string) =>
      (await table.locator("tr", { has: page.getByText(label, { exact: true }) }).first().locator("td").allInnerTexts()).slice(1).map((t) => Number(t.replace(/,/g, "")))
    const sqlRows = sql(
      `SELECT kills, dmg_to_champions, cs FROM match_participants WHERE platform_id = ? AND game_id = ? ORDER BY team_id, participant_id`,
      [String(g.platform_id), Number(g.game_id)],
    )
    expect(await rowValues("擊殺")).toEqual(sqlRows.map((r) => Number(r.kills)))
    expect(await rowValues("對英雄總傷害")).toEqual(sqlRows.map((r) => Number(r.dmg_to_champions)))
    expect(await rowValues("補兵")).toEqual(sqlRows.map((r) => Number(r.cs)))
  })

  test("「回列表」回到列表，不會重新載入（卡片還在、麵包屑那層消失）", async ({ page }) => {
    await cards(page).nth(3).click()
    await page.getByRole("button", { name: "回列表" }).click()
    await expect(cards(page).first()).toBeVisible()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("點頁名（麵包屑最上層）也能回列表", async ({ page }) => {
    await cards(page).nth(2).click()
    await expect(crumbs(page)).toBeVisible()
    await header(page).getByRole("button", { name: "對局紀錄" }).click()
    await expect(cards(page).first()).toBeVisible()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("列表捲很深點進戰報，回列表後捲動位置還原", async ({ page }) => {
    // 往下捲，觸發無限捲動載入到至少 60 場
    for (let i = 0; i < 10 && (await cards(page).count()) < 60; i++) {
      await page.mouse.wheel(0, 3000)
      await page.waitForTimeout(500)
    }
    expect(await cards(page).count()).toBeGreaterThanOrEqual(60)
    const target = cards(page).nth(45)
    await target.scrollIntoViewIfNeeded()
    const before = await page.evaluate(() => window.scrollY)
    expect(before).toBeGreaterThan(1000)
    await target.click()
    await expect(page.getByRole("button", { name: "回列表" })).toBeVisible()
    await page.getByRole("button", { name: "回列表" }).click()
    await expect(cards(page).nth(45)).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: "捲動位置沒有還原" }).toBeGreaterThan(before - 200)
  })

  test("切換帳號後列表重來，不殘留前一個人的戰報", async ({ page }) => {
    await cards(page).first().click()
    await expect(page.getByRole("button", { name: "回列表" })).toBeVisible()
    await page.keyboard.press("Control+k")
    await page.getByRole("dialog", { name: "切換帳號" }).getByRole("option").nth(1).click()
    await ready(page)
    await expect(page.getByRole("button", { name: "回列表" })).toHaveCount(0)
    await expect(cards(page).first()).toBeVisible()
  })
})

test.describe("對局紀錄：跨頁篩選", () => {
  test("在儀表板點英雄下鑽後，對局紀錄只列那隻英雄的場次（走 Cube 的 game_ids）", async ({ page }) => {
    await openPage(page, "dashboard")
    const row = page.locator('[data-slot="card"]', { has: page.getByText("最常用英雄", { exact: true }) }).locator("button.slide-in").first()
    const name = (await row.locator("span.truncate").innerText()).trim()
    await row.click()
    await page.locator('[data-sidebar="menu-button"]', { hasText: "對局紀錄" }).click()
    await ready(page)
    await expect(cards(page).first()).toBeVisible()
    const n = sql(
      `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN dim_champions d ON d.id = p.champion_id
        WHERE p.puuid = ? AND m.queue_id = 2400 AND d.name = ?`,
      [mePuuid(), name],
    )[0].n as number
    await expect(page.getByText(new RegExp(`共 ${n} 場`))).toBeVisible()
    for (const c of await cards(page).all()) await expect(c.locator("img").first()).toHaveAttribute("title", name)
  })

  test("切到「全部模式」後，列表比 Mayhem 多（包含其他模式）", async ({ page }) => {
    await openPage(page, "matches")
    await filters(page).queue.click()
    await page.getByRole("option", { name: "全部模式" }).click()
    await ready(page)
    const all = sql("SELECT COUNT(*) n FROM match_participants WHERE puuid = ?", [mePuuid()])[0].n as number
    await expect(page.getByText(new RegExp(`共 ${all} 場`))).toBeVisible()
  })
})

test.describe("對局紀錄：看誰的數據", () => {
  const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
  /** 自己加追蹤對象的 Mayhem 場次，一場一列（同場好幾位也只算一場）。crew 不會出現在兩隊，所以一場的勝負就是 crew 的勝負。 */
  const crewMatches = () =>
    sql(
      `SELECT m.platform_id, m.game_id, MAX(p.win) AS win, COUNT(*) AS crew_n, MIN(p.participant_id) AS first_pid
         FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE m.queue_id = 2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)
        GROUP BY m.platform_id, m.game_id ORDER BY m.game_creation DESC`,
    )

  test.beforeEach(async ({ page }) => {
    await openPage(page, "matches")
    await expect(cards(page).first()).toBeVisible()
  })

  test("「所有人」停用並寫出原因；預設仍是目前帳號", async ({ page }) => {
    await expect(whoRadio(page, "所有人")).toHaveAttribute("aria-disabled", "true")
    await expect(page.getByText(/「所有人」不能選：每一場至少有一位你或追蹤對象/)).toBeVisible()
    await expect(whoRadio(page, "目前帳號")).toHaveAttribute("aria-checked", "true")
  })

  test("追蹤對象：一場只列一張卡片，總場數與勝敗 = 自己加追蹤對象的不重複場次", async ({ page }) => {
    const matches = crewMatches()
    const wins = matches.filter((m) => Number(m.win)).length
    await whoRadio(page, "追蹤對象").click()
    await expect(crumbs(page)).toContainText("追蹤對象")
    await expect(
      page.getByText(`共 ${matches.length} 場・${wins} 勝 ${matches.length - wins} 敗・勝率 ${((wins / matches.length) * 100).toFixed(1)}%`),
    ).toBeVisible()
    // 逐人列會是 1397 列、遠多於場數：卡片數不能超過場數
    await expect.poll(() => cards(page).count()).toBeGreaterThanOrEqual(20)
    expect(await cards(page).count()).toBeLessThanOrEqual(matches.length)
  })

  test("追蹤對象：最新幾場的順序與 SQL 一致，同場有多位時標頭列出「同場追蹤」", async ({ page }) => {
    const matches = crewMatches()
    await whoRadio(page, "追蹤對象").click()
    await expect.poll(() => cards(page).count()).toBeGreaterThanOrEqual(20)
    for (const [i, m] of matches.slice(0, 20).entries()) {
      const c = cards(page).nth(i)
      await expect(c, `第 ${i + 1} 場勝敗`).toContainText(Number(m.win) ? "勝利" : "戰敗")
      if (Number(m.crew_n) > 1) await expect(c, `第 ${i + 1} 場`).toContainText("同場追蹤")
      else await expect(c, `第 ${i + 1} 場`).not.toContainText("同場追蹤")
    }
  })

  test("切回目前帳號：回到自己的場數、麵包屑清掉", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await expect(crumbs(page)).toContainText("追蹤對象")
    await whoRadio(page, "目前帳號").click()
    const { games, wins } = myRecord()
    await expect(page.getByText(`共 ${games} 場・${wins} 勝 ${games - wins} 敗`)).toBeVisible()
    await expect(crumbs(page)).toHaveCount(0)
  })
})
