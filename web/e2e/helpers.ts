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

/** 目前頁面上 AG Grid 的資料列。 */
export const gridRows = (scope: Page | Locator) => scope.locator(".ag-center-cols-container .ag-row")

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
