import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, clickBar, openPage, ready, visibleBars } from "./helpers"
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

/** 自己加上追蹤對象，各自照「前一場」分組的場數與勝場（獨立的視窗函數，不讀 mat_participant_context）。 */
function crewByPerson() {
  const rows = sql(
    `WITH s AS (
       SELECT p.puuid, p.win,
              LAG(p.win) OVER (PARTITION BY p.puuid ORDER BY m.game_creation, m.platform_id, m.game_id) AS prev
         FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE m.queue_id = 2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1))
     SELECT puuid, prev, COUNT(*) AS n, SUM(win) AS w FROM s GROUP BY puuid, prev`,
  )
  const names = new Map(sql("SELECT puuid, riot_id FROM accounts").map((r) => [String(r.puuid), String(r.riot_id ?? "").split("#")[0]]))
  const people = new Map<string, { name: string; loss: { n: number; w: number }; win: { n: number; w: number } }>()
  for (const r of rows) {
    const p = people.get(String(r.puuid)) ?? { name: names.get(String(r.puuid)) ?? "", loss: { n: 0, w: 0 }, win: { n: 0, w: 0 } }
    if (r.prev === 0) p.loss = { n: Number(r.n), w: Number(r.w) }
    if (r.prev === 1) p.win = { n: Number(r.n), w: Number(r.w) }
    people.set(String(r.puuid), p)
  }
  return [...people.values()]
}

const pct = (c: { n: number; w: number }) => `${((100 * c.w) / c.n).toFixed(0)}%`
const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })

test.describe("節奏與連敗頁：看誰的數據", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "tilt")
  })

  test("「所有人」停用並寫出原因，點了不會換；預設不出現逐人面板", async ({ page }) => {
    const all = whoRadio(page, "所有人")
    await expect(all).toHaveAttribute("aria-disabled", "true")
    await expect(page.getByText(/「所有人」不能選：.*沒有完整歷史/)).toBeVisible()
    await all.click({ force: true })
    await expect(whoRadio(page, "目前帳號")).toHaveAttribute("aria-checked", "true")
    await expect(crumbs(page)).toHaveCount(0)
    await expect(page.getByText("每個人的落差")).toHaveCount(0)
  })

  test("追蹤對象：KPI 的場次與勝率 = 每個人的場次加總", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await expect(crumbs(page)).toContainText("追蹤對象")
    await ready(page)
    const people = crewByPerson()
    const sum = (k: "loss" | "win") => people.reduce((a, p) => ({ n: a.n + p[k].n, w: a.w + p[k].w }), { n: 0, w: 0 })
    const loss = sum("loss")
    const win = sum("win")
    await expect(card(page, "前一場輸之後")).toContainText(`${((loss.w / loss.n) * 100).toFixed(1)}%`)
    await expect(card(page, "前一場輸之後")).toContainText(`${loss.n} 場`)
    await expect(card(page, "前一場贏之後")).toContainText(`${((win.w / win.n) * 100).toFixed(1)}%`)
    await expect(card(page, "前一場贏之後")).toContainText(`${win.n} 場`)
    await expect(card(page, "落差")).toContainText("同場重複算，區間偏窄")
  })

  test("逐人面板：每人一列（名稱、落差、輸後／贏後的勝率與場次）加一列合併，和獨立計算一致", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    const people = crewByPerson()
    const rows = card(page, "每個人的落差").getByRole("img")
    // 每位玩家一列，再加最下面的合併
    await expect(rows).toHaveCount(people.length + 1)
    const texts = await rows.evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ")))
    for (const p of people) {
      const detail = `輸後 ${pct(p.loss)}（${p.loss.n}）・贏後 ${pct(p.win)}（${p.win.n}）`
      const hit = texts.find((t) => t.includes(detail) && t.includes(p.name))
      expect(hit, `${p.name} ${detail}`).toBeTruthy()
      if (p.loss.n >= MIN_GAMES && p.win.n >= MIN_GAMES) {
        const d = (p.loss.w / p.loss.n - p.win.w / p.win.n) * 100
        expect(hit, p.name).toContain(`${d > 0 ? "+" : ""}${d.toFixed(1)} pp`)
      } else {
        expect(hit, p.name).toContain("樣本太少")
      }
    }
    // 合併那列 = 大家加總
    const loss = people.reduce((a, p) => a + p.loss.n, 0)
    const win = people.reduce((a, p) => a + p.win.n, 0)
    expect(texts.at(-1)).toContain(`合併（${people.length} 位）`)
    expect(texts.at(-1)).toContain(`（${loss}）`)
    expect(texts.at(-1)).toContain(`（${win}）`)
  })

  test("追蹤對象下點「前一場輸」的長條：列出的場次數 = 每位玩家輸後那一場的總數（每人每場一列）", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    const n = crewByPerson().reduce((a, p) => a + p.loss.n, 0)
    await clickBar(page, charts(card(page, "前一場的結果，和這一場的勝率")).first(), "前一場輸")
    await expect(card(page, "前一場輸 的每一場").getByText(`共 ${n} 場`)).toBeVisible()
  })

  test("切回目前帳號：逐人面板消失、麵包屑清掉、KPI 回到自己的數字", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    await whoRadio(page, "目前帳號").click()
    await ready(page)
    await expect(page.getByText("每個人的落差")).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
    const loss = tally(sequence(), (r) => r.prev).get("前一場輸")!
    await expect(card(page, "前一場輸之後")).toContainText(`${loss.n} 場`)
  })
})
