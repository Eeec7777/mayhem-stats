import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, openPage, visibleBars } from "./helpers"
import { mePuuid, sql } from "./db"

const MIN_GAMES = 5
const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const stage = (n: number) => (n <= 2 ? "第 1-2 場" : n <= 5 ? "第 3-5 場" : n <= 9 ? "第 6-9 場" : "第 10 場以後")

/** 獨立重算「前一場結果」與「一輪」（前一場結束後休息超過 60 分鐘就開新的一輪），規則見 participant_context.yml。 */
function sequence() {
  const rows = sql(
    `SELECT m.game_creation AS t, m.game_duration AS dur, p.win, m.game_id
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE p.puuid = ? AND m.queue_id = 2400 ORDER BY m.game_creation, m.platform_id, m.game_id`,
    [mePuuid()],
  )
  let idx = 0
  return rows.map((r, i) => {
    const prev = i ? rows[i - 1] : null
    const newSession = !prev || Number(r.t) > Number(prev.t) + Number(prev.dur) * 1000 + 3_600_000
    idx = newSession ? 1 : idx + 1
    return { win: Number(r.win), prev: prev ? (Number(prev.win) ? "前一場贏" : "前一場輸") : "沒有前一場", idx, gameId: Number(r.game_id) }
  })
}

const tally = <T,>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, { n: number; w: number }>()
  for (const r of rows) {
    const k = key(r)
    const c = m.get(k) ?? { n: 0, w: 0 }
    m.set(k, { n: c.n + 1, w: c.w + (r as unknown as { win: number }).win })
  }
  return m
}

test.describe("節奏與連敗頁", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "tilt")
  })

  test("三個 KPI：前一場輸之後、贏之後的勝率與場次，落差 = 輸後 − 贏後", async ({ page }) => {
    const t = tally(sequence(), (r) => r.prev)
    const loss = t.get("前一場輸")!
    const win = t.get("前一場贏")!
    const lw = (loss.w / loss.n) * 100
    const ww = (win.w / win.n) * 100
    await expect(card(page, "前一場輸之後")).toContainText(`${lw.toFixed(1)}%`)
    await expect(card(page, "前一場輸之後")).toContainText(`${loss.n} 場`)
    await expect(card(page, "前一場贏之後")).toContainText(`${ww.toFixed(1)}%`)
    await expect(card(page, "前一場贏之後")).toContainText(`${win.n} 場`)
    const d = lw - ww
    await expect(card(page, "落差")).toContainText(`${d > 0 ? "+" : ""}${d.toFixed(1)} pp`)
    await expect(card(page, "落差")).toContainText(/95% 區間 -?\d+～-?\d+ pp|樣本太少/)
  })

  test("落差的 95% 區間和獨立計算一致；區間不含 0 才上色", async ({ page }) => {
    const t = tally(sequence(), (r) => r.prev)
    const a = t.get("前一場輸")!
    const b = t.get("前一場贏")!
    const pa = a.w / a.n
    const pb = b.w / b.n
    const se = Math.sqrt((pa * (1 - pa)) / a.n + (pb * (1 - pb)) / b.n) * 100
    const d = (pa - pb) * 100
    const lo = d - 1.96 * se
    const hi = d + 1.96 * se
    const clear = hi < 0 || lo > 0
    await expect(card(page, "落差")).toContainText(`95% 區間 ${lo.toFixed(0)}～${hi.toFixed(0)} pp・${clear ? "區間不含 0" : "還在樣本誤差內"}`)
    const value = card(page, "落差").locator(".font-mono").first()
    if (clear) await expect(value).toHaveClass(d < 0 ? /text-loss/ : /text-win/)
    else await expect(value).not.toHaveClass(/text-(win|loss)/)
  })

  test("「前一場的結果」長條：贏／輸兩根，勝率和場次和獨立計算一致（沒有前一場不畫）", async ({ page }) => {
    const t = tally(sequence(), (r) => r.prev)
    const bars = await visibleBars(charts(card(page, "前一場的結果，和這一場的勝率")).first())
    expect(bars.map((b) => b.label).sort()).toEqual(["前一場贏", "前一場輸"])
    for (const b of bars) {
      const c = t.get(b.label)!
      expect(b.value, b.label).toBeCloseTo((c.w / c.n) * 100, 1)
    }
  })

  test("點「前一場輸」的長條 → 列出那些場次，場次數 = 獨立計算；再點取消", async ({ page }) => {
    const chart = charts(card(page, "前一場的結果，和這一場的勝率")).first()
    const n = tally(sequence(), (r) => r.prev).get("前一場輸")!.n
    await clickBar(page, chart, "前一場輸")
    const list = card(page, "前一場輸 的每一場")
    await expect(list.getByText(`共 ${n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText("前一場輸")
    await clickBar(page, chart, "前一場輸")
    await expect(list).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("「同一輪連續打到第幾場」分段：四段的勝率和場次和獨立計算一致", async ({ page }) => {
    const t = tally(sequence(), (r) => stage(r.idx))
    const bars = await visibleBars(charts(card(page, "同一輪連續打到第幾場")).first())
    expect(bars.map((b) => b.label)).toEqual(expect.arrayContaining([...t.keys()]))
    for (const b of bars) {
      const c = t.get(b.label)!
      expect(b.value, b.label).toBeCloseTo((c.w / c.n) * 100, 1)
    }
  })

  test("點某一段 → 列出當輪那段的每一場，場次數一致", async ({ page }) => {
    const t = tally(sequence(), (r) => stage(r.idx))
    const chart = charts(card(page, "同一輪連續打到第幾場")).first()
    const pick = (await visibleBars(chart)).filter((b) => b.value > 8)[0]
    await clickBar(page, chart, pick.label)
    await expect(card(page, `當輪${pick.label} 的每一場`).getByText(`共 ${t.get(pick.label)!.n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(`當輪${pick.label}`)
  })

  test("切到「逐場」：只列累積 5 場以上的場次序號，每一根和獨立計算一致", async ({ page }) => {
    await card(page, "同一輪連續打到第幾場").getByRole("radio", { name: "逐場" }).click()
    await expect(card(page, "同一輪連續打到第幾場").getByText(/逐場拆開，只列出累積 5 場以上的場次序號/)).toBeVisible()
    const t = tally(sequence(), (r) => `第 ${r.idx} 場`)
    const expected = [...t].filter(([, v]) => v.n >= MIN_GAMES)
    await expect.poll(async () => (await visibleBars(charts(card(page, "同一輪連續打到第幾場")).first())).length).toBe(expected.length)
    for (const b of await visibleBars(charts(card(page, "同一輪連續打到第幾場")).first())) {
      const c = t.get(b.label)!
      expect(b.value, b.label).toBeCloseTo((c.w / c.n) * 100, 1)
    }
    await card(page, "同一輪連續打到第幾場").getByRole("radio", { name: "分段" }).click()
    await expect(card(page, "同一輪連續打到第幾場").getByText(/一輪 = 前一場結束後不到 60 分鐘就接著打/)).toBeVisible()
  })

  test("逐場模式點一根 → 標題「當輪第 N 場」，列出的場次數 = 獨立計算", async ({ page }) => {
    await card(page, "同一輪連續打到第幾場").getByRole("radio", { name: "逐場" }).click()
    const chart = charts(card(page, "同一輪連續打到第幾場")).first()
    await expect.poll(async () => (await visibleBars(chart)).length).toBeGreaterThan(0)
    const pick = (await visibleBars(chart)).filter((b) => b.value > 8)[0]
    const n = tally(sequence(), (r) => `第 ${r.idx} 場`).get(pick.label)!.n
    await clickBar(page, chart, pick.label)
    await expect(card(page, `當輪${pick.label} 的每一場`).getByText(`共 ${n} 場`)).toBeVisible()
  })

  test("兩張圖的聚焦互相取代（同時只有一個列表），收起後麵包屑消失", async ({ page }) => {
    const prev = charts(card(page, "前一場的結果，和這一場的勝率")).first()
    await clickBar(page, prev, "前一場輸")
    await expect(card(page, "前一場輸 的每一場")).toBeVisible()
    const stageChart = charts(card(page, "同一輪連續打到第幾場")).first()
    const pick = (await visibleBars(stageChart)).filter((b) => b.value > 8)[0]
    await clickBar(page, stageChart, pick.label)
    await expect(card(page, `當輪${pick.label} 的每一場`)).toBeVisible()
    await expect(card(page, "前一場輸 的每一場")).toHaveCount(0)
    await card(page, `當輪${pick.label} 的每一場`).getByRole("button", { name: "收起" }).click()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("說明文字：關聯不是因果", async ({ page }) => {
    await expect(page.getByText(/這是關聯不是因果/)).toBeVisible()
    await expect(page.getByText(/60 分鐘是分析上的切法/)).toBeVisible()
  })
})
