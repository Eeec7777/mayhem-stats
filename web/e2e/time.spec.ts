import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, chartOption, chartPoint, clickBar, openPage, ready, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"]
const BLOCKS = [
  { label: "深夜 0-5", from: 0, to: 5 },
  { label: "早上 6-11", from: 6, to: 11 },
  { label: "下午 12-17", from: 12, to: 17 },
  { label: "晚上 18-23", from: 18, to: 23 },
]
const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const banner = (page: Page) => page.locator("div.sticky.top-\\[72px\\]")

/** 自己每場的本地星期、小時、日期與勝負（採集時就算好存在 matches 上）。 */
const myGames = () =>
  sql(
    `SELECT m.local_date AS d, m.local_weekday AS wd, m.local_hour AS h, p.win
       FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
    [mePuuid()],
  ).map((r) => ({ d: String(r.d), wd: Number(r.wd), h: Number(r.h), win: Number(r.win) }))

test.describe("時段頁：KPI 與每天趨勢", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "time")
  })

  test("三個 KPI：總場次、打過的日子（含起始日）、最常打的時段", async ({ page }) => {
    const games = myGames()
    const days = [...new Set(games.map((g) => g.d))].sort()
    await expect(card(page, "總場次").locator(".font-mono").first()).toHaveText(String(games.length))
    await expect(card(page, "打過的日子").locator(".font-mono").first()).toHaveText(String(days.length))
    await expect(card(page, "打過的日子")).toContainText(`${days[0]} 起`)
    // 最常打：該星期該小時的場次，是所有（星期, 小時）格裡最多的
    const byHour = new Map<string, number>()
    for (const g of games) byHour.set(`${g.wd}:${g.h}`, (byHour.get(`${g.wd}:${g.h}`) ?? 0) + 1)
    const max = Math.max(...byHour.values())
    const text = await card(page, "最常打的時段").innerText()
    const [, wd, hh] = text.match(/(週.) (\d{2}):00/)!
    expect(byHour.get(`${WEEKDAYS.indexOf(wd)}:${Number(hh)}`)).toBe(max)
    await expect(card(page, "最常打的時段")).toContainText(`${max} 場`)
  })

  test("每日圖：每天的勝場、敗場和 SQL 逐日一致", async ({ page }) => {
    const opt = await chartOption(charts(card(page, "每天的場次與勝率")).first())
    const wins: number[] = opt.series.find((s: any) => s.name === "當天勝場").data.map((d: any) => d.value)
    const losses: number[] = opt.series.find((s: any) => s.name === "當天敗場").data.map((d: any) => d.value)
    const labels: string[] = opt.xAxis[0].data
    const byDay = new Map<string, [number, number]>()
    for (const g of myGames()) {
      const k = g.d.slice(5)
      const c = byDay.get(k) ?? [0, 0]
      byDay.set(k, [c[0] + g.win, c[1] + 1 - g.win])
    }
    labels.forEach((day, i) => expect([day, wins[i], losses[i]]).toEqual([day, ...(byDay.get(day) ?? [0, 0])]))
  })
})

test.describe("時段頁：星期 × 時段熱力圖", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "time")
  })
  const heat = (page: Page) => charts(card(page, "星期 × 時段")).first()

  test("預設四時段：28 格，每格場次與勝率和 SQL 一致", async ({ page }) => {
    const opt = await chartOption(heat(page))
    const data: { value: [number, number, number, number | null] }[] = opt.series[0].data
    expect(data).toHaveLength(28)
    expect(opt.xAxis[0].data).toEqual(BLOCKS.map((b) => b.label))
    const games = myGames()
    for (const { value } of data) {
      const [x, wd, n, wr] = value
      const inBlock = games.filter((g) => g.wd === wd && g.h >= BLOCKS[x].from && g.h <= BLOCKS[x].to)
      expect(n, `${WEEKDAYS[wd]} ${BLOCKS[x].label}`).toBe(inBlock.length)
      if (inBlock.length) expect(wr).toBeCloseTo((inBlock.reduce((a, g) => a + g.win, 0) / inBlock.length) * 100, 1)
    }
  })

  test("切到「逐小時」：168 格，場次加總 = 總場次；切回「四時段」", async ({ page }) => {
    await card(page, "星期 × 時段").getByRole("radio", { name: "逐小時" }).click()
    await expect(card(page, "星期 × 時段").getByText(/攤在 168 格裡/)).toBeVisible()
    await expect.poll(async () => (await chartOption(heat(page))).series[0].data.length).toBe(168)
    const data: { value: number[] }[] = (await chartOption(heat(page))).series[0].data
    expect(data.reduce((a, d) => a + d.value[2], 0)).toBe(myGames().length)
    await card(page, "星期 × 時段").getByRole("radio", { name: "四時段" }).click()
    await expect.poll(async () => (await chartOption(heat(page))).series[0].data.length).toBe(28)
  })

  test("點一格 → 聚焦橫幅、麵包屑、那一塊的每一場（場次數和 SQL 一致）；再點同一格取消", async ({ page }) => {
    const games = myGames()
    // 挑場次最多的格子（至少 3 場）
    const opt = await chartOption(heat(page))
    const best = (opt.series[0].data as { value: number[] }[]).map((d) => d.value).sort((a, b) => b[2] - a[2])[0]
    const [x, wd, n] = best
    expect(n).toBeGreaterThanOrEqual(3)
    const label = `${WEEKDAYS[wd]} ${BLOCKS[x].label}`
    const pt = await chartPoint(heat(page), { xAxisIndex: 0, yAxisIndex: 0 }, [x, wd])
    await page.mouse.click(pt.x, pt.y)
    await expect(banner(page).getByText(label, { exact: true })).toBeVisible()
    const inBlock = games.filter((g) => g.wd === wd && g.h >= BLOCKS[x].from && g.h <= BLOCKS[x].to)
    const wins = inBlock.reduce((a, g) => a + g.win, 0)
    await expect(banner(page)).toContainText(`${inBlock.length} 場 · ${wins} 勝 ${inBlock.length - wins} 敗 · ${((wins / inBlock.length) * 100).toFixed(1)}%`)
    await expect(crumbs(page)).toContainText(label)
    const list = card(page, `${label} 的每一場`)
    await expect(list.getByText(`共 ${inBlock.length} 場`)).toBeVisible()
    await page.mouse.click(pt.x, pt.y)
    await expect(banner(page).getByText(label)).toHaveCount(0)
    await expect(list).toHaveCount(0)
  })

  test("逐小時模式點一格：聚焦標籤是 HH:00", async ({ page }) => {
    await card(page, "星期 × 時段").getByRole("radio", { name: "逐小時" }).click()
    await expect.poll(async () => (await chartOption(heat(page))).series[0].data.length).toBe(168)
    const opt = await chartOption(heat(page))
    const best = (opt.series[0].data as { value: number[] }[]).map((d) => d.value).sort((a, b) => b[2] - a[2])[0]
    const [x, wd] = best
    const pt = await chartPoint(heat(page), { xAxisIndex: 0, yAxisIndex: 0 }, [x, wd])
    await page.mouse.click(pt.x, pt.y)
    await expect(banner(page)).toContainText(`${WEEKDAYS[wd]} ${String(x).padStart(2, "0")}:00`)
  })

  test("hover 掃過熱力圖不出錯", async ({ page }) => {
    const box = (await heat(page).boundingBox())!
    for (let i = 1; i < 12; i++) await page.mouse.move(box.x + (box.width * i) / 12, box.y + box.height * 0.5)
    await page.mouse.move(2, 2)
  })
})

test.describe("時段頁：星期別勝率與連動聚焦", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "time")
  })
  const weekdayChart = (page: Page) => charts(card(page, "星期別勝率")).first()

  test("星期別長條的勝率和 SQL 一致", async ({ page }) => {
    const bars = await visibleBars(weekdayChart(page))
    const games = myGames()
    for (const b of bars) {
      const wd = WEEKDAYS.indexOf(b.label)
      const g = games.filter((x) => x.wd === wd)
      expect(b.value, b.label).toBeCloseTo((g.reduce((a, x) => a + x.win, 0) / g.length) * 100, 1)
    }
    expect(bars.length).toBe(new Set(games.map((g) => g.wd)).size)
  })

  test("點一個星期 → 聚焦「全天」，三張圖連動，下方列出那天（星期）的所有場次", async ({ page }) => {
    const bars = (await visibleBars(weekdayChart(page))).filter((b) => b.value > 8)
    const pick = bars[0]
    const wd = WEEKDAYS.indexOf(pick.label)
    await clickBar(page, weekdayChart(page), pick.label)
    await expect(banner(page)).toContainText(`${pick.label} 全天`)
    await expect(banner(page)).toContainText(`${WEEKDAYS[wd]}以外的資料淡化`)
    const n = myGames().filter((g) => g.wd === wd).length
    await expect(card(page, `${pick.label} 全天 的每一場`).getByText(`共 ${n} 場`)).toBeVisible()
    // 熱力圖：其他星期被淡化（opacity 較低）
    const opt = await chartOption(charts(card(page, "星期 × 時段")).first())
    const opacities = (opt.series[0].data as { value: number[]; itemStyle: { opacity?: number } }[]).map((d) => [d.value[1], d.itemStyle.opacity ?? 1])
    expect(opacities.filter(([w]) => w === wd).every(([, o]) => o === 1)).toBe(true)
    expect(opacities.filter(([w]) => w !== wd).every(([, o]) => (o as number) < 1)).toBe(true)
  })

  test("橫幅的「清除」與「收起」都能取消聚焦；「看每一場」捲到列表", async ({ page }) => {
    const pick = (await visibleBars(weekdayChart(page))).filter((b) => b.value > 8)[0]
    await clickBar(page, weekdayChart(page), pick.label)
    await expect(banner(page).getByText("聚焦", { exact: true })).toBeVisible()
    await banner(page).getByRole("button", { name: "看每一場" }).click()
    await expect(page.locator("#focus-matches")).toBeVisible()
    await banner(page).getByRole("button", { name: "清除" }).click()
    await expect(banner(page).getByText("聚焦", { exact: true })).toHaveCount(0)
    await expect(banner(page).getByText(/點下面任一張圖的某天/)).toBeVisible()
    await clickBar(page, weekdayChart(page), pick.label)
    await card(page, `${pick.label} 全天 的每一場`).getByRole("button", { name: "收起" }).click()
    await expect(banner(page).getByText("聚焦", { exact: true })).toHaveCount(0)
  })

  test("點每日圖的某一天 → 聚焦那天，橫幅的場次勝敗與 SQL 一致，三張圖都亮起那天所屬的星期", async ({ page }) => {
    const daily = charts(card(page, "每天的場次與勝率")).first()
    const opt = await chartOption(daily)
    const labels: string[] = opt.xAxis[0].data
    const wins: number[] = opt.series.find((s: any) => s.name === "當天勝場").data.map((d: any) => d.value)
    const losses: number[] = opt.series.find((s: any) => s.name === "當天敗場").data.map((d: any) => d.value)
    const idx = labels.map((_, i) => i).reverse().find((i) => wins[i] + losses[i] >= 3 && wins[i] + losses[i] <= 20)!
    const total = wins[idx] + losses[idx]
    const pt = await chartPoint(daily, { xAxisIndex: 0 }, idx)
    const box = (await daily.boundingBox())!
    await page.mouse.click(pt.x, box.y + box.height * 0.5)
    const date = (await banner(page).locator("b").innerText()).trim()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date.slice(5)).toBe(labels[idx])
    await expect(banner(page)).toContainText(`${total} 場 · ${wins[idx]} 勝 ${losses[idx]} 敗`)
    await expect(card(page, `${date} 的每一場`).locator("button.slide-in")).toHaveCount(total)
    const wd = new Date(`${date}T12:00:00`).getDay()
    await expect(banner(page)).toContainText(`${WEEKDAYS[wd]}以外的資料淡化`)
  })

  test("聚焦後換成「全部模式」仍有效，切走再回來聚焦已重設", async ({ page }) => {
    const pick = (await visibleBars(weekdayChart(page))).filter((b) => b.value > 8)[0]
    await clickBar(page, weekdayChart(page), pick.label)
    await expect(crumbs(page)).toContainText(pick.label)
    await page.locator('[data-sidebar="menu-button"]', { hasText: "儀表板" }).click()
    await ready(page)
    await page.locator('[data-sidebar="menu-button"]', { hasText: "時段" }).click()
    await ready(page)
    await expect(crumbs(page)).toHaveCount(0)
  })
})

test.describe("時段頁：看誰的數據", () => {
  const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
  const CREW = "p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)"
  /** 自己加追蹤對象，每位玩家每場一列：本地星期、小時。 */
  const crewRows = () =>
    sql(
      `SELECT p.puuid, m.local_weekday AS wd, m.local_hour AS h
         FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400 AND ${CREW}`,
    ).map((r) => ({ puuid: String(r.puuid), wd: Number(r.wd), h: Number(r.h) }))

  test.beforeEach(async ({ page }) => {
    await openPage(page, "time")
  })

  test("「所有人」停用並寫出原因；預設沒有逐人面板", async ({ page }) => {
    await expect(whoRadio(page, "所有人")).toHaveAttribute("aria-disabled", "true")
    await expect(page.getByText(/「所有人」不能選：每場兩隊十位都算/)).toBeVisible()
    await expect(page.getByText("每個人在什麼時候打")).toHaveCount(0)
  })

  test("追蹤對象：總場次 = 每人每場各算一次；逐人面板一人一列，七天與四時段的場次和 SQL 一致", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await expect(crumbs(page)).toContainText("追蹤對象")
    await ready(page)
    const rows = crewRows()
    await expect(card(page, "總場次")).toContainText(String(rows.length))
    await expect(card(page, "總場次")).toContainText("每位玩家的每一場各算一次")
    const people = [...new Set(rows.map((r) => r.puuid))]
    const lines = page.getByTestId("person-times-row")
    await expect(lines).toHaveCount(people.length)
    // 一列一個人：場次由大到小，每列七天的格子加總 = 他的場次，四時段加總也一樣
    const perPerson = people.map((p) => rows.filter((r) => r.puuid === p)).sort((a, b) => b.length - a.length)
    for (const [i, mine] of perPerson.entries()) {
      const line = lines.nth(i)
      await expect(line).toContainText(`${mine.length} 場`)
      const cells = await line.locator("[title$=' 場']").evaluateAll((els) => els.map((e) => Number(e.getAttribute("title")!.replace(" 場", ""))))
      expect(cells).toHaveLength(11)
      expect(cells.slice(0, 7), `第 ${i + 1} 列的星期`).toEqual(WEEKDAYS.map((_, wd) => mine.filter((r) => r.wd === wd).length))
      expect(cells.slice(7), `第 ${i + 1} 列的時段`).toEqual(BLOCKS.map((b) => mine.filter((r) => r.h >= b.from && r.h <= b.to).length))
    }
  })

  test("追蹤對象下點一個星期：列出的場次數 = 那天所有人的場次（每人每場一列），並標出是誰玩的", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    const chart = charts(card(page, "星期別勝率")).first()
    const pick = (await visibleBars(chart)).filter((b) => b.value > 0)[0]
    const wd = WEEKDAYS.indexOf(pick.label)
    await clickBar(page, chart, pick.label)
    const n = crewRows().filter((r) => r.wd === wd).length
    await expect(card(page, `${pick.label} 全天 的每一場`).getByText(`共 ${n} 場`)).toBeVisible()
  })

  test("切回目前帳號：逐人面板消失、麵包屑清掉", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    await whoRadio(page, "目前帳號").click()
    await ready(page)
    await expect(page.getByText("每個人在什麼時候打")).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
    await expect(card(page, "總場次")).toContainText(String(myGames().length))
  })
})
