import { test, expect } from "./fixtures"
import { PAGE_LABEL, filters, header, navTo, openPage, ready, type PageId } from "./helpers"

const IDS = Object.keys(PAGE_LABEL) as PageId[]

test.describe("外框：側邊欄與頁面切換", () => {
  test("側邊欄列出三組共 13 個頁面", async ({ page }) => {
    await openPage(page, "dashboard")
    const items = page.locator('[data-sidebar="menu-button"]')
    await expect(items).toHaveCount(13)
    await expect(page.locator('[data-sidebar="group-label"]')).toHaveText(["總覽", "分析", "工具"])
    for (const label of Object.values(PAGE_LABEL)) await expect(items.filter({ hasText: label })).toHaveCount(1)
  })

  test("點側邊欄換頁：網址、標題、選中狀態一起變", async ({ page }) => {
    await openPage(page, "dashboard")
    for (const id of ["matches", "champions", "time"] as PageId[]) {
      await navTo(page, id)
      await expect(page).toHaveURL(new RegExp(`/${id}$`))
      await expect(page.locator('[data-sidebar="menu-button"][data-active="true"]')).toHaveText(PAGE_LABEL[id])
    }
  })

  test("瀏覽器上一頁／下一頁會跟著換頁", async ({ page }) => {
    await openPage(page, "dashboard")
    await navTo(page, "champions")
    await navTo(page, "time")
    await page.goBack()
    await expect(header(page)).toHaveText(PAGE_LABEL.champions)
    await page.goBack()
    await expect(header(page)).toHaveText(PAGE_LABEL.dashboard)
    await page.goForward()
    await expect(header(page)).toHaveText(PAGE_LABEL.champions)
  })

  test("不認得的網址（popstate 到未知路徑）退回儀表板", async ({ page }) => {
    // 直接 goto 一個不存在的路徑，伺服器本身會回 404，到不了前端；退回邏輯只在 popstate 時用得到
    await openPage(page, "champions")
    await page.evaluate(() => {
      history.pushState(null, "", "/no-such-page")
      window.dispatchEvent(new PopStateEvent("popstate"))
    })
    await expect(header(page)).toHaveText(PAGE_LABEL.dashboard)
  })

  test("每個頁面直接用網址開都能載入，頁首有標題與說明", async ({ page }) => {
    for (const id of IDS) {
      await openPage(page, id)
      await expect(page.locator("header p").first()).not.toBeEmpty()
    }
  })

  test("側邊欄可以收合成圖示列再展開", async ({ page }) => {
    await openPage(page, "dashboard")
    const sidebar = page.locator('[data-slot="sidebar"]').first()
    await expect(sidebar).toHaveAttribute("data-state", "expanded")
    await page.getByRole("button", { name: "Toggle Sidebar" }).click()
    await expect(sidebar).toHaveAttribute("data-state", "collapsed")
    await page.getByRole("button", { name: "Toggle Sidebar" }).click()
    await expect(sidebar).toHaveAttribute("data-state", "expanded")
  })

  test("側邊欄底下的採集狀態：顯示場次，「立即採集」送出 POST /api/ingest", async ({ page, writes }) => {
    await openPage(page, "dashboard")
    const pill = page.locator('[data-slot="sidebar"]').getByText(/我的 Mayhem/)
    await expect(pill).toContainText(/\d+\s*場/)
    await expect(page.locator('[data-slot="sidebar"]').getByText(/資料庫共 \d+ 場/)).toBeVisible()
    await page.getByRole("button", { name: "立即採集" }).click()
    await expect.poll(() => writes.map((w) => `${w.method} ${w.path}`)).toContain("POST /api/ingest")
  })

  test("手機寬度：側邊欄變成抽屜，選完頁面自動關起來", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await page.goto("/dashboard")
    await expect(header(page)).toHaveText(PAGE_LABEL.dashboard)
    await page.getByRole("button", { name: "Toggle Sidebar" }).click()
    const nav = page.getByRole("dialog")
    await expect(nav).toBeVisible()
    await nav.locator('[data-sidebar="menu-button"]', { hasText: PAGE_LABEL.champions }).click()
    await expect(header(page)).toHaveText(PAGE_LABEL.champions)
    await expect(nav).toBeHidden()
    await ready(page)
    // 版面不該出現橫向捲動
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  })

  test("全域篩選列有帳號、模式、期間、主題四個控制項", async ({ page }) => {
    await openPage(page, "dashboard")
    const f = filters(page)
    await expect(f.account).toBeVisible()
    await expect(f.queue).toBeVisible()
    await expect(f.range).toBeVisible()
    await expect(f.theme).toBeVisible()
  })
})
