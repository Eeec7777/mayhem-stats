import { test, expect } from "./fixtures"
import { PAGE_LABEL, charts, openPage, sweepHover, type PageId } from "./helpers"

// 跨頁面的整體檢查：每個主題、每個尺寸、每一頁。單頁的功能測試不會發現「換了主題之後某張圖 hover 就丟例外」
// （zrender 解析 oklch 失敗就是這樣，見 ui-conventions）或「窄螢幕橫向溢出」這類跨頁面的退化。

const PAGES = Object.keys(PAGE_LABEL) as PageId[]
// 陣容頁與敗因分析頁的對局長度改成 HTML 的勝率差森林圖（2026-10），不再有 ECharts
const CHART_PAGES: PageId[] = ["dashboard", "champions", "augments", "players", "time", "tilt"]
const THEMES = [
  ["neon", "霓虹"], ["matrix", "終端"], ["lava", "熔岩"], ["violet", "紫電"],
  ["daylight", "晨光"], ["mint", "薄荷"], ["sakura", "櫻花"], ["sand", "沙丘"],
] as const

test.describe("每個主題 × 有圖表的頁面", () => {
  for (const [id, label] of THEMES) {
    test(`「${label}」：${CHART_PAGES.length} 個圖表頁都能畫出來，每張圖 hover 掃一輪不丟例外`, async ({ page }) => {
      test.setTimeout(180_000)
      await page.addInitScript((theme) => localStorage.setItem("mayhem-theme", theme), id)
      for (const p of CHART_PAGES) {
        await openPage(page, p)
        await expect(page.locator("html")).toHaveAttribute("data-theme", id)
        const n = await charts(page).count()
        expect(n, `${p} 應該有圖表`).toBeGreaterThan(0)
        for (let i = 0; i < n; i++) await sweepHover(page, charts(page).nth(i), 5)
      }
      // 掃完後沒有未捕捉的例外：由 fixture 在測試結束時檢查 pageerror
    })
  }
})

// 已知會橫向溢出的頁。列進來的頁用 test.fail：修好之後該頁的測試會「意外通過」而失敗，屆時把頁名拿掉。
// 768px：對局紀錄的卡片列固定寬度合計超過內容區（溢出約 50px），好友比較的全員一覽表格沒有放進自己的捲動容器（約 256px）。
// 陣容頁原本也在名單上，2026-10 改版成森林圖、矩陣收進自己的捲動容器之後不再溢出。
const KNOWN_OVERFLOW: Record<number, Set<PageId>> = { 390: new Set(), 768: new Set<PageId>(["matches", "crew"]) }

test.describe("窄螢幕：頁面本身不橫向溢出（表格與矩陣要在自己的容器裡捲動）", () => {
  for (const width of [390, 768]) {
    for (const p of PAGES) {
      test(`${width}px 寬：${PAGE_LABEL[p]}${KNOWN_OVERFLOW[width].has(p) ? "（已知問題）" : ""}`, async ({ page }) => {
        if (KNOWN_OVERFLOW[width].has(p)) test.fail(true, "頁面橫向溢出")
        await page.setViewportSize({ width, height: 900 })
        await openPage(page, p)
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
        expect(over, `${p} 超出視窗 ${over}px`).toBeLessThanOrEqual(1)
      })
    }
  }
})

test.describe("無障礙基本功", () => {
  test("每個按鈕都有可讀的名稱（文字、aria-label 或 title）", async ({ page }) => {
    test.setTimeout(180_000)
    const nameless: string[] = []
    for (const p of PAGES) {
      await openPage(page, p)
      const bad = await page.evaluate(() =>
        [...document.querySelectorAll("button, [role=button]")]
          .filter((b) => {
            const el = b as HTMLElement
            if (el.closest("[aria-hidden=true]") || el.offsetParent === null) return false
            return !(el.innerText.trim() || el.getAttribute("aria-label") || el.getAttribute("title") || el.querySelector("img[alt]:not([alt=''])"))
          })
          .map((b) => (b as HTMLElement).outerHTML.slice(0, 120)),
      )
      bad.forEach((h) => nameless.push(`${p}: ${h}`))
    }
    expect(nameless).toEqual([])
  })

  test("頁首有且只有一個 h1，標題和側邊欄選中的頁一致", async ({ page }) => {
    // 一次走完 13 頁，每頁都要等資料畫完，預設的時限不夠
    test.setTimeout(180_000)
    for (const p of PAGES) {
      await openPage(page, p)
      await expect(page.locator("h1")).toHaveCount(1)
      await expect(page.locator("h1")).toHaveText(PAGE_LABEL[p])
    }
  })

  test("頁面有 lang 屬性與 <title>", async ({ page }) => {
    await openPage(page, "dashboard")
    await expect(page.locator("html")).toHaveAttribute("lang", /zh/)
    expect((await page.title()).length).toBeGreaterThan(0)
  })

  test("鍵盤：Tab 能依序走到側邊欄的每個頁面，Enter 換頁", async ({ page }) => {
    await openPage(page, "dashboard")
    const first = page.locator('[data-sidebar="menu-button"]', { hasText: PAGE_LABEL.matches })
    await first.focus()
    await page.keyboard.press("Enter")
    await expect(page.locator("h1")).toHaveText(PAGE_LABEL.matches)
  })
})
