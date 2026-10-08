import { expect, type Locator, type Page } from "@playwright/test"

export type PageId =
  | "dashboard" | "matches" | "champions" | "augments" | "lineups" | "players" | "crew"
  | "time" | "tilt" | "losses" | "explore" | "tracked" | "recap"

/** 側邊欄的頁名，和 AppShell 的 NAV 一致。 */
export const PAGE_LABEL: Record<PageId, string> = {
  dashboard: "儀表板", matches: "對局紀錄", champions: "英雄", augments: "增幅裝置", lineups: "陣容",
  players: "隊友 / 對手", crew: "好友比較", time: "時段", tilt: "節奏與連敗", losses: "敗因分析",
  explore: "自由探索", recap: "賽季回顧", tracked: "追蹤對象",
}

/** 頁面內容區。外層的 SidebarInset 也是 <main>，所以要指到內層那個。 */
export const content = (page: Page) => page.locator("main main")

/** 頁首（麵包屑那塊）的標題。 */
export const header = (page: Page) => page.locator("header h1")

/** 等這一頁「真的畫完」：沒有骨架、每張圖都有 canvas、表格有列。
 *  只看網址或標題會在資料還沒回來時就放行，後面的斷言變成碰運氣。 */
export async function ready(page: Page) {
  await expect(content(page)).toBeVisible()
  await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.querySelectorAll("div[_echarts_instance_]")].every((el) => (el as HTMLElement).offsetWidth > 0 && el.querySelector("canvas")),
        ),
      { message: "圖表沒有畫出 canvas" },
    )
    .toBe(true)
  // 進場動畫（rise / reveal 最長約 500ms）跑完再動手，不然點擊會打到還在位移的元素
  await page.waitForTimeout(600)
}

/** 直接用網址進某一頁（SPA 讀 location.pathname）。 */
export async function openPage(page: Page, id: PageId) {
  await page.goto(`/${id}`)
  await expect(header(page)).toHaveText(PAGE_LABEL[id])
  await ready(page)
}

/** 從側邊欄點進某一頁。 */
export async function navTo(page: Page, id: PageId) {
  await page.locator('[data-sidebar="menu-button"]', { hasText: PAGE_LABEL[id] }).click()
  await expect(header(page)).toHaveText(PAGE_LABEL[id])
  await ready(page)
}

/** 一張面板（Panel）：用標題找。 */
export const panel = (page: Page, title: string | RegExp): Locator =>
  page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: typeof title === "string" }) }).first()

/** 目前頁面上 AG Grid 已畫出來的資料列（AG Grid 36 只畫看得到的列，釘住的欄用 sticky，不再分左右容器）。 */
export const gridRows = (scope: Page | Locator) => scope.locator(".ag-row")

/** 打開頂部的 Select（Radix）並選一項。 */
export async function pick(page: Page, trigger: Locator, option: string | RegExp) {
  await trigger.click()
  await page.getByRole("option", { name: option }).click()
}

/** 全域篩選列的三個控制項。 */
export const filters = (page: Page) => ({
  account: page.locator("header").getByRole("button", { name: /#/ }).first(),
  queue: page.locator("header").getByRole("combobox").nth(0),
  range: page.locator("header").getByRole("combobox").nth(1),
  theme: page.getByRole("button", { name: "切換主題" }),
})

/** 對 Cube 查詢計數：在 fn 期間送出了幾個 /api/cube/load。 */
export async function cubeQueries(page: Page, fn: () => Promise<void>) {
  const urls: string[] = []
  const on = (r: { url(): string }) => r.url().includes("/api/cube/load") && urls.push(decodeURIComponent(r.url()))
  page.on("request", on)
  try {
    await fn()
  } finally {
    page.off("request", on)
  }
  return urls
}

/** 直接問 Cube（走本機 /api/cube/load），給測試拿「獨立的對照數字」用。處理 Continue wait。 */
export async function cubeLoad(page: Page, query: object): Promise<Record<string, string | number | null>[]> {
  for (let i = 0; i < 40; i++) {
    const res = await page.request.get(`/api/cube/load?query=${encodeURIComponent(JSON.stringify(query))}`)
    const body = await res.json()
    if (body.data) return body.data
    if (body.error && body.error !== "Continue wait") throw new Error(String(body.error))
    await page.waitForTimeout(1000)
  }
  throw new Error("Cube 查詢逾時")
}

// ───────────────────────────────────────────── 圖表（ECharts）
// 圖表是 canvas，DOM 裡看不到資料。ResponsiveChart 把 ECharts 實例掛在外層 div 的 __chart 上，
// 測試靠它讀出實際的 option（驗證畫的是對的資料）與資料點的像素位置（點得到對的那一根）。

/** 頁面上所有圖表。 */
export const charts = (scope: Page | Locator) => scope.locator("div[_echarts_instance_]")

type ChartHost = HTMLElement & { __chart?: { getOption(): unknown; convertToPixel(f: object, v: unknown): number | number[]; getWidth(): number; getHeight(): number } }

/** 圖表目前的 option（函式欄位如 formatter 會被丟掉，只留資料與設定）。 */
export async function chartOption<T = any>(chart: Locator): Promise<T> {
  return chart.evaluate((el) => {
    const host = el.parentElement as ChartHost
    if (!host.__chart) throw new Error("這張圖沒有掛 __chart")
    return JSON.parse(JSON.stringify(host.__chart.getOption()))
  })
}

/** 把座標軸上的值換成頁面座標（給 mouse.move / mouse.click 用）。 */
export async function chartPoint(chart: Locator, finder: object, value: unknown): Promise<{ x: number; y: number }> {
  const box = await chart.boundingBox()
  if (!box) throw new Error("圖表不在畫面上")
  const px = await chart.evaluate(
    (el, [f, v]) => (el.parentElement as ChartHost).__chart!.convertToPixel(f as object, v),
    [finder, value] as const,
  )
  const [x, y] = Array.isArray(px) ? px : [px, 0]
  return { x: box.x + x, y: box.y + y }
}

/** 在圖表上掃一排 hover，回傳出現過的 tooltip 文字。圖表 hover 出錯（例如 zrender 解析顏色失敗）會變成 pageerror，由 fixture 接住。 */
export async function sweepHover(page: Page, chart: Locator, steps = 8) {
  await chart.scrollIntoViewIfNeeded()
  const box = (await chart.boundingBox())!
  const seen = new Set<string>()
  for (let i = 1; i <= steps; i++) {
    for (const fy of [0.35, 0.7]) {
      await page.mouse.move(box.x + (box.width * i) / (steps + 1), box.y + box.height * fy)
      await page.waitForTimeout(40)
      const tip = await page.locator("div[style*='z-index: 9999999']").allInnerTexts().catch(() => [])
      tip.filter(Boolean).forEach((t) => seen.add(t.trim()))
    }
  }
  await page.mouse.move(2, 2)
  return [...seen]
}

/** 雷達圖某一軸上的頁面座標。frac 是離圓心多遠（1＝外框）。軸 0 在正上方、逆時針（ECharts 預設，見 RadarChart 的 pixelClick）。 */
export async function radarPoint(chart: Locator, index: number, frac = 0.7): Promise<{ x: number; y: number }> {
  const box = (await chart.boundingBox())!
  const geo = await chart.evaluate((el) => {
    const o = (el.parentElement as ChartHost).__chart!.getOption() as { radar: { center: [number, number]; radius: number; indicator: unknown[] }[] }
    return { center: o.radar[0].center, radius: o.radar[0].radius, n: o.radar[0].indicator.length }
  })
  const a = (index * 2 * Math.PI) / geo.n
  return { x: box.x + geo.center[0] - Math.sin(a) * geo.radius * frac, y: box.y + geo.center[1] - Math.cos(a) * geo.radius * frac }
}

/** 表格（AG Grid）的欄位標題。 */
export const gridHeaders = (scope: Page | Locator) => scope.locator(".ag-header-cell-text")

/** 表格某一欄（依 col-id，例如 "participants.games"）所有已渲染儲存格的文字，依列序由上到下。
 *  AG Grid 只畫看得到的欄與列（虛擬化），釘在左邊的欄在另一個容器，這裡一併找。 */
export async function gridColumn(scope: Page | Locator, colId: string): Promise<string[]> {
  const root = "waitForLoadState" in scope ? scope.locator("body") : scope
  return root.evaluate((el, id) => {
    const out: [number, string][] = []
    el.querySelectorAll(".ag-row").forEach((row) => {
      const cell = row.querySelector(`[col-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (cell) out.push([Number(row.getAttribute("row-index")), cell.innerText.trim()])
    })
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1])
  }, colId)
}

/** 讀 CSV 並解析成二維陣列（支援引號與跳脫的雙引號）。 */
export async function readCsv(path: string): Promise<string[][]> {
  const { readFileSync } = await import("node:fs")
  const text = readFileSync(path, "utf-8").replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") (row.push(cell), (cell = ""))
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  if (cell !== "" || row.length) (row.push(cell), rows.push(row))
  return rows
}

// ───────────────────────────────────────────── 橫向長條圖（BarChart）

export type BarInfo = { label: string; value: number }

/** 目前畫面上看得到的長條（超過一頁的長條圖用 dataZoom 只顯示一段），依圖上由上到下排列。 */
export async function visibleBars(chart: Locator): Promise<BarInfo[]> {
  return chart.evaluate((el) => {
    const c = (el.parentElement as ChartHost).__chart as unknown as {
      getOption(): { yAxis: { data: string[] }[]; series: { data: ({ value: number } | number)[] }[]; dataZoom?: { startValue?: number; endValue?: number }[] }
    }
    const o = c.getOption()
    const labels = o.yAxis[0].data
    const zoom = o.dataZoom?.[0]
    const from = zoom?.startValue ?? 0
    const to = zoom?.endValue ?? labels.length - 1
    return labels
      .map((label, i) => ({ label, i, value: Number(typeof o.series[0].data[i] === "object" ? (o.series[0].data[i] as { value: number }).value : o.series[0].data[i]) }))
      .filter((b) => b.i >= from && b.i <= to)
      .map(({ label, value }) => ({ label, value }))
  })
}

/** 點某一根長條（要有寬度才點得到，所以 value 必須大於 0）。長條圖比較高時外層會捲動，先捲到那一根再點。 */
export async function clickBar(page: Page, chart: Locator, label: string) {
  const pos = await chart.evaluate(async (el, label) => {
    const host = el.parentElement as ChartHost & HTMLElement
    const c = host.__chart as unknown as {
      getOption(): { yAxis: { data: string[] }[]; series: { data: ({ value: number } | number)[] }[] }
      convertToPixel(f: object, v: unknown): number
    }
    const o = c.getOption()
    const i = o.yAxis[0].data.indexOf(label)
    if (i < 0) throw new Error(`圖上沒有 ${label}`)
    const d = o.series[0].data[i]
    const value = Number(typeof d === "object" ? d.value : d)
    const y = c.convertToPixel({ yAxisIndex: 0 }, label)
    const x = c.convertToPixel({ xAxisIndex: 0 }, value / 2)
    const scroller = host.closest(".overflow-y-auto") as HTMLElement | null
    if (scroller) scroller.scrollTop = Math.max(0, y - scroller.clientHeight / 2)
    await new Promise((r) => requestAnimationFrame(() => r(null)))
    return { x, y }
  }, label)
  // 目標點若在視窗外（圖在頁面下半部、第一根長條在圖的最底下），把頁面捲到讓它落在視窗中間
  let box = (await chart.boundingBox())!
  const vh = page.viewportSize()!.height
  if (box.y + pos.y < 60 || box.y + pos.y > vh - 60) {
    await page.evaluate((dy) => window.scrollBy(0, dy), box.y + pos.y - vh / 2)
    await page.waitForTimeout(100)
    box = (await chart.boundingBox())!
  }
  await page.mouse.click(box.x + pos.x, box.y + pos.y)
}
