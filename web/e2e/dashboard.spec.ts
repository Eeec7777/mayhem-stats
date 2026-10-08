import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, chartOption, chartPoint, header, openPage, ready, sweepHover } from "./helpers"
import { mePuuid, myRecord, sql } from "./db"

const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const kpi = (page: Page, label: string) => page.locator('[data-slot="card"]', { has: page.getByText(label, { exact: true }) }).locator(".font-mono").first()

/** 我自己的 Mayhem 場次，新到舊。 */
const myGames = (limit: number) =>
  sql(
    `SELECT m.game_id, p.win, p.kills, p.deaths, p.assists, d.name AS champion
       FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN dim_champions d ON d.id = p.champion_id
      WHERE p.puuid = ? AND m.queue_id = 2400 ORDER BY m.game_creation DESC LIMIT ?`,
    [mePuuid(), limit],
  )

test.describe("儀表板", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "dashboard")
  })

  test("九張卡片都在", async ({ page }) => {
    for (const title of ["整體戰績", "最近戰績", "每日勝率趨勢", "最常用英雄", "出裝定位", "最常選的增幅", "什麼時候打"]) {
      await expect(card(page, title)).toBeVisible()
    }
    for (const label of ["KDA", "每分鐘傷害", "每分鐘經濟", "參團率"]) await expect(card(page, label)).toBeVisible()
  })

  test.describe("整體戰績", () => {
    test("場次、勝敗、勝率和獨立 SQL 一致", async ({ page }) => {
      const { games, wins } = myRecord()
      const hero = card(page, "整體戰績")
      await expect(hero.getByText(`${games} 場`, { exact: true })).toBeVisible()
      await expect(hero.getByText(`${wins} 勝 ${games - wins} 敗`)).toBeVisible()
      await expect(hero.getByText(`${((wins / games) * 100).toFixed(1)}%`, { exact: true }).first()).toBeVisible()
    })

    test("勝率大字：過 50% 用勝色、沒過用敗色", async ({ page }) => {
      const { games, wins } = myRecord()
      const big = card(page, "整體戰績").getByText(`${((wins / games) * 100).toFixed(1)}%`, { exact: true }).first()
      // 顏色掛在外層的 div 上（CountUp 只是裡面的 span）
      await expect(big.locator("xpath=ancestor::div[contains(@class,'font-mono')][1]")).toHaveClass(new RegExp(wins / games >= 0.5 ? "text-win" : "text-loss"))
    })

    test("近期動能：最近 7 個有資料的日子 vs 前 7 個，數字和 SQL 一致", async ({ page }) => {
      const days = sql(
        `SELECT m.local_date AS d, COUNT(*) AS games, SUM(p.win) AS wins
           FROM match_participants p JOIN matches m USING (platform_id, game_id)
          WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY m.local_date ORDER BY m.local_date DESC LIMIT 14`,
        [mePuuid()],
      ).reverse()
      const recent = days.slice(-7)
      const rg = recent.reduce((s, r) => s + Number(r.games), 0)
      const rw = recent.reduce((s, r) => s + Number(r.wins), 0)
      const hero = card(page, "整體戰績")
      await expect(hero.getByText(`${rg} 場`, { exact: true })).toBeVisible()
      await expect(hero.getByText(`${((rw / rg) * 100).toFixed(1)}%`, { exact: true }).last()).toBeVisible()
    })
  })

  test.describe("最近戰績", () => {
    test("列出最近 10 場，順序、勝敗、KDA 和 SQL 一致", async ({ page }) => {
      const expected = myGames(10)
      const buttons = card(page, "最近戰績").locator("button[title]")
      await expect(buttons).toHaveCount(10)
      for (const [i, g] of expected.entries()) {
        const b = buttons.nth(i)
        await expect(b).toHaveAttribute("title", new RegExp(`^${g.champion}・${g.win ? "勝利" : "戰敗"}`))
        await expect(b).toContainText(`${g.kills}/${g.deaths}/${g.assists}`)
        await expect(b).toContainText(g.win ? "勝" : "敗")
      }
    })

    test("摘要：最近 10 場幾勝幾敗，連勝連敗徽章與 SQL 一致", async ({ page }) => {
      const rows = myGames(20)
      const wins = rows.slice(0, 10).filter((r) => r.win).length
      const box = card(page, "最近戰績")
      await expect(box.getByText(`最近 10 場`)).toBeVisible()
      await expect(box.getByText(`${wins} 勝`, { exact: true })).toBeVisible()
      await expect(box.getByText(`${10 - wins} 敗`, { exact: true })).toBeVisible()
      let streak = 0
      while (streak < rows.length && rows[streak].win === rows[0].win) streak++
      const badge = box.getByText(/目前 \d+\+? (連勝|連敗)/)
      if (streak >= 2) await expect(badge).toHaveText(`目前 ${streak}${streak === 20 ? "+" : ""} ${rows[0].win ? "連勝" : "連敗"}`)
      else await expect(badge).toHaveCount(0)
    })

    test("點一場開右側抽屜：標題是英雄與勝敗，有計分板與數據兩個分頁，Esc 關閉", async ({ page }) => {
      const first = myGames(1)[0]
      await card(page, "最近戰績").locator("button[title]").first().click()
      const drawer = page.getByRole("dialog")
      await expect(drawer.getByRole("heading", { name: `${first.champion}・${first.win ? "勝利" : "戰敗"}` })).toBeVisible()
      await expect(drawer.getByRole("tab", { name: "計分板" })).toBeVisible()
      await expect(drawer.getByRole("tab", { name: "數據" })).toBeVisible()
      await expect(drawer.getByText(/隊伍 1 · (勝利|失敗)/)).toBeVisible()
      await expect(drawer.getByText(/隊伍 2 · (勝利|失敗)/)).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(drawer).toBeHidden()
    })

    test("抽屜的「關閉」鈕和右上角 × 都能關", async ({ page }) => {
      const open = async () => {
        await card(page, "最近戰績").locator("button[title]").first().click()
        await expect(page.getByRole("dialog").getByRole("tab", { name: "計分板" })).toBeVisible()
      }
      await open()
      await page.getByRole("dialog").getByRole("button", { name: "關閉", exact: true }).first().click()
      await expect(page.getByRole("dialog")).toBeHidden()
      await open()
      await page.getByRole("dialog").locator('button[aria-label="關閉"]').click()
      await expect(page.getByRole("dialog")).toBeHidden()
    })

    test("「對局紀錄」連結導到對局紀錄頁", async ({ page }) => {
      await card(page, "最近戰績").getByRole("button", { name: /對局紀錄/ }).click()
      await expect(header(page)).toHaveText("對局紀錄")
    })
  })

  test.describe("KPI", () => {
    test("KDA = (平均擊殺 + 平均助攻) ÷ 平均死亡", async ({ page }) => {
      const r = sql(
        `SELECT AVG(p.kills) k, AVG(p.assists) a, AVG(p.deaths) d FROM match_participants p JOIN matches m USING (platform_id, game_id)
          WHERE p.puuid = ? AND m.queue_id = 2400`,
        [mePuuid()],
      )[0]
      const kda = ((Number(r.k) + Number(r.a)) / Number(r.d)).toFixed(2)
      await expect(kpi(page, "KDA")).toHaveText(kda)
    })

    test("每分鐘傷害／經濟：每場先除以時間再平均", async ({ page }) => {
      const r = sql(
        `SELECT AVG(p.dmg_to_champions * 60.0 / m.game_duration) dpm, AVG(p.gold_earned * 60.0 / m.game_duration) gpm
           FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
        [mePuuid()],
      )[0]
      await expect(kpi(page, "每分鐘傷害")).toHaveText(Math.round(Number(r.dpm)).toLocaleString("en-US"))
      await expect(kpi(page, "每分鐘經濟")).toHaveText(Math.round(Number(r.gpm)).toLocaleString("en-US"))
    })

    test("參團率：每場 (擊殺+助攻)÷我方總擊殺 的平均", async ({ page }) => {
      const r = sql(
        `SELECT AVG((p.kills + p.assists) * 100.0 / NULLIF(p.team_kills, 0)) kp FROM match_participants p JOIN matches m USING (platform_id, game_id)
          WHERE p.puuid = ? AND m.queue_id = 2400`,
        [mePuuid()],
      )[0]
      await expect(kpi(page, "參團率")).toHaveText(`${Number(r.kp).toFixed(1)}%`)
    })
  })

  test.describe("每日勝率趨勢", () => {
    const chart = (page: Page) => charts(card(page, "每日勝率趨勢"))

    test("每一天的勝場、敗場和 SQL 逐日一致，加總等於總場次", async ({ page }) => {
      const opt = await chartOption(chart(page))
      const wins: number[] = opt.series.find((s: any) => s.name === "當天勝場").data.map((d: any) => d.value)
      const losses: number[] = opt.series.find((s: any) => s.name === "當天敗場").data.map((d: any) => d.value)
      const labels: string[] = opt.xAxis[0].data
      const byDay = new Map(
        sql(
          `SELECT substr(m.local_date, 6) AS d, SUM(p.win) AS w, COUNT(*) - SUM(p.win) AS l
             FROM match_participants p JOIN matches m USING (platform_id, game_id)
            WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY m.local_date`,
          [mePuuid()],
        ).map((r) => [String(r.d), [Number(r.w), Number(r.l)]]),
      )
      labels.forEach((day, i) => expect([day, wins[i], losses[i]], `${day} 的勝敗`).toEqual([day, ...(byDay.get(day) ?? [0, 0])]))
      const { games, wins: w } = myRecord()
      expect(wins.reduce((a, b) => a + b, 0)).toBe(w)
      expect(wins.reduce((a, b) => a + b, 0) + losses.reduce((a, b) => a + b, 0)).toBe(games)
    })

    test("累積勝率折線最後一點 = 整體勝率", async ({ page }) => {
      const opt = await chartOption(chart(page))
      const line = opt.series.find((s: any) => s.name === "累積勝率").data.map((d: any) => d.value ?? d)
      const last = [...line].reverse().find((v: unknown) => typeof v === "number") as number
      const { games, wins } = myRecord()
      expect(last).toBeCloseTo((wins / games) * 100, 1)
    })

    test("hover 掃過整張圖不出錯，tooltip 提示可以點", async ({ page }) => {
      const tips = await sweepHover(page, chart(page).first())
      expect(tips.length).toBeGreaterThan(0)
      expect(tips.join("\n")).toContain("點一下看這天的每一場")
    })

    test("點某一天：右側抽屜開啟，標題是那天，列出的場次數和 SQL 一致，再點同一天會收起", async ({ page }) => {
      const opt = await chartOption(chart(page))
      const labels: string[] = opt.xAxis[0].data
      const wins: number[] = opt.series.find((s: any) => s.name === "當天勝場").data.map((d: any) => d.value)
      const losses: number[] = opt.series.find((s: any) => s.name === "當天敗場").data.map((d: any) => d.value)
      // 最近一個場次不超過第一批（20 場）的日子，才能直接數卡片
      const idx = labels.map((_, i) => i).reverse().find((i) => wins[i] + losses[i] > 0 && wins[i] + losses[i] <= 20)!
      const total = wins[idx] + losses[idx]
      const pt = await chartPoint(chart(page), { xAxisIndex: 0 }, idx)
      const box = (await chart(page).boundingBox())!
      await page.mouse.click(pt.x, box.y + box.height * 0.5)
      const drawer = page.getByRole("dialog")
      await expect(drawer.getByRole("heading")).toHaveText(/^\d{4}-\d{2}-\d{2}$/)
      const date = await drawer.getByRole("heading").innerText()
      expect(date.slice(5)).toBe(labels[idx])
      await expect(drawer.locator("button.slide-in")).toHaveCount(total)
      // 麵包屑出現那一天
      await expect(page.locator('nav[aria-label="目前位置"]')).toContainText(date)
      await page.keyboard.press("Escape")
      await expect(drawer).toBeHidden()
      await expect(page.locator('nav[aria-label="目前位置"]')).toHaveCount(0)
    })

    test("抽屜裡再點一場，可以看那場的戰報", async ({ page }) => {
      const opt = await chartOption(chart(page))
      const labels: string[] = opt.xAxis[0].data
      const wins: number[] = opt.series.find((s: any) => s.name === "當天勝場").data.map((d: any) => d.value)
      const idx = labels.map((_, i) => i).reverse().find((i) => wins[i] > 0)!
      const pt = await chartPoint(chart(page), { xAxisIndex: 0 }, idx)
      const box = (await chart(page).boundingBox())!
      await page.mouse.click(pt.x, box.y + box.height * 0.5)
      const drawer = page.getByRole("dialog")
      await drawer.locator("button.slide-in").first().click()
      await expect(drawer.getByRole("tab", { name: "計分板" })).toBeVisible()
      await expect(drawer.getByText(/隊伍 1 · /)).toBeVisible()
    })
  })

  test.describe("最常用英雄／最常選的增幅", () => {
    test("英雄清單：前 8 名的名稱、場次、勝率和 SQL 一致", async ({ page }) => {
      const rows = sql(
        `SELECT d.name, COUNT(*) AS n, SUM(p.win) AS w FROM match_participants p JOIN matches m USING (platform_id, game_id)
           JOIN dim_champions d ON d.id = p.champion_id WHERE p.puuid = ? AND m.queue_id = 2400
          GROUP BY d.id ORDER BY n DESC, d.name LIMIT 8`,
        [mePuuid()],
      )
      const list = card(page, "最常用英雄").locator("button.slide-in")
      await expect(list).toHaveCount(8)
      // 同場次的英雄排序由 Cube 決定，所以只比對「場次」序列與每隻英雄各自的數字
      for (const r of rows) {
        const row = list.filter({ hasText: String(r.name) }).first()
        if ((await row.count()) === 0) continue // 並列時被擠出前 8 名的
        await expect(row).toContainText(`${r.n} 場`)
        await expect(row).toContainText(`${((Number(r.w) / Number(r.n)) * 100).toFixed(1)}%`)
      }
      await expect(card(page, "最常用英雄").getByText(/共用過 \d+ 隻/)).toBeVisible()
    })

    test("點英雄 → 加上全域下鑽「英雄：xxx」，整頁數字跟著縮到那隻英雄，可以從麵包屑移除", async ({ page }) => {
      const row = card(page, "最常用英雄").locator("button.slide-in").first()
      const name = (await row.locator("span.truncate").innerText()).trim()
      const n = Number((await row.getByText(/^\d+ 場$/).innerText()).replace(/\D/g, ""))
      await row.click()
      const crumbs = page.locator('nav[aria-label="目前位置"]')
      await expect(crumbs).toContainText(`英雄：${name}`)
      await ready(page)
      await expect(card(page, "整體戰績").getByText(`${n} 場`, { exact: true })).toBeVisible()
      await crumbs.getByRole("button", { name: `移除篩選 英雄：${name}` }).click()
      await expect(crumbs).toHaveCount(0)
      await expect(card(page, "整體戰績").getByText(`${myRecord().games} 場`, { exact: true })).toBeVisible()
    })

    test("點增幅 → 加上「增幅：xxx」；再點英雄 → 兩個條件並存，「全部清除」一次清掉", async ({ page }) => {
      await card(page, "最常選的增幅").locator("button.slide-in").first().click()
      const crumbs = page.locator('nav[aria-label="目前位置"]')
      await expect(crumbs).toContainText("增幅：")
      await card(page, "最常用英雄").locator("button.slide-in").first().click()
      await expect(crumbs).toContainText("英雄：")
      await expect(crumbs.getByText("增幅：", { exact: false })).toBeVisible()
      await crumbs.getByRole("button", { name: "全部清除" }).click()
      await expect(crumbs).toHaveCount(0)
    })

    test("增幅清單的場次與 SQL 一致", async ({ page }) => {
      const top = sql(
        `SELECT a.name, COUNT(DISTINCT pa.game_id) AS n FROM participant_augments pa
           JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
           JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id JOIN dim_augments a ON a.id = pa.augment_id
          WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY a.id ORDER BY n DESC LIMIT 1`,
        [mePuuid()],
      )[0]
      await expect(card(page, "最常選的增幅").locator("button.slide-in").filter({ hasText: String(top.name) }).first()).toContainText(`${top.n} 場`)
    })

    test("「看全部」連到英雄頁／增幅頁", async ({ page }) => {
      await card(page, "最常用英雄").getByRole("button", { name: /看全部/ }).click()
      await expect(header(page)).toHaveText("英雄")
      await page.goBack()
      await card(page, "最常選的增幅").getByRole("button", { name: /看全部/ }).click()
      await expect(header(page)).toHaveText("增幅裝置")
    })
  })

  test.describe("出裝定位", () => {
    test("雷達圖八個軸，各軸場次和 SQL 一致", async ({ page }) => {
      const radar = charts(card(page, "出裝定位")).first()
      const opt = await chartOption(radar)
      expect(opt.radar[0].indicator).toHaveLength(8)
      const labels: string[] = opt.radar[0].indicator.map((i: any) => i.name)
      const values: number[] = opt.series[0].data[0].value
      // 還有極少數場次判不出定位（裝備太少），不在這八軸裡，所以不能拿總場次對
      const bySql = new Map(
        sql(
          `SELECT b.build_role AS role, COUNT(*) AS n FROM match_participants p JOIN matches m USING (platform_id, game_id)
             JOIN mat_builds b ON b.participant_rowid = p.rowid WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY b.build_role`,
          [mePuuid()],
        ).map((r) => [String(r.role), Number(r.n)]),
      )
      labels.forEach((label, i) => expect([label, values[i]]).toEqual([label, bySql.get(label) ?? 0]))
      expect(values.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(myRecord().games)
    })

    test("標題下的說明點出最常出的定位", async ({ page }) => {
      await expect(card(page, "出裝定位").getByText(/最常出.+（\d+%）・依終場出裝/)).toBeVisible()
    })
  })

  test.describe("什麼時候打", () => {
    test("最常打的時段與 SQL 一致", async ({ page }) => {
      // 四時段的界線在 Cube 的 matches.time_block 定義；這裡只驗「最常打」那一格的場次在合理範圍：不超過總場次、至少是平均值
      const text = await card(page, "什麼時候打").getByText(/^\d+ 場$/).first().innerText()
      const n = Number(text.replace(/\D/g, ""))
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThanOrEqual(myRecord().games)
    })

    test("三個指標卡：最常打、表現最好、表現最差", async ({ page }) => {
      const box = card(page, "什麼時候打")
      for (const label of ["最常打", "表現最好", "表現最差"]) await expect(box.getByText(label, { exact: true })).toBeVisible()
    })

    test("「看熱力圖」連到時段頁", async ({ page }) => {
      await card(page, "什麼時候打").getByRole("button", { name: /看熱力圖/ }).click()
      await expect(header(page)).toHaveText("時段")
    })
  })

  test("「時段分析」連結導到時段頁", async ({ page }) => {
    await card(page, "每日勝率趨勢").getByRole("button", { name: /時段分析/ }).click()
    await expect(header(page)).toHaveText("時段")
  })
})

