import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { cubeQueries, filters, header, openPage, ready } from "./helpers"
import { mePuuid, myRecord, sql } from "./db"

/** 儀表板「整體戰績」那張卡裡的場次大字（"291 場"）。 */
const overallGames = async (page: Page) =>
  Number((await page.locator('[data-slot="card"]', { hasText: "整體戰績" }).first().getByText(/^\d+ 場$/).first().innerText()).replace(/\D/g, ""))

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

test.describe("全域篩選：帳號", () => {
  test("預設是站長自己的帳號，沒有「他人」徽章也沒有提示列", async ({ page }) => {
    await openPage(page, "dashboard")
    const me = sql("SELECT riot_id FROM accounts WHERE puuid = ?", [mePuuid()])[0].riot_id as string
    await expect(filters(page).account).toContainText(me)
    await expect(filters(page).account.getByText("他人")).toHaveCount(0)
    await expect(page.getByText("不是你自己的")).toHaveCount(0)
  })

  test("Ctrl+K 開啟帳號面板，分成「我的帳號」「追蹤中」「同場過的玩家」三組，Esc 關閉", async ({ page }) => {
    await openPage(page, "dashboard")
    await page.keyboard.press("Control+k")
    const dialog = page.getByRole("dialog", { name: "切換帳號" })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("我的帳號", { exact: true })).toBeVisible()
    await expect(dialog.getByText("追蹤中", { exact: true })).toBeVisible()
    await expect(dialog.getByText("同場過的玩家", { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
  })

  test("面板只畫前 50 位同場過的玩家，並說明其餘要靠搜尋", async ({ page }) => {
    await openPage(page, "dashboard")
    await filters(page).account.click()
    const dialog = page.getByRole("dialog", { name: "切換帳號" })
    await expect(dialog.getByText(/只列出場次最多的 50 位，其餘 \d+ 位請輸入名稱搜尋/)).toBeVisible()
    // 我 + 追蹤中 + 50 位，不是整個資料庫
    expect(await dialog.getByRole("option").count()).toBeLessThan(80)
  })

  test("搜尋：輸入名稱縮小清單，找不到時顯示說明；搜尋字在重開時清掉", async ({ page }) => {
    await openPage(page, "dashboard")
    const tracked = sql("SELECT riot_id FROM accounts WHERE tracked = 1 AND is_me = 0 AND riot_id IS NOT NULL LIMIT 1")[0].riot_id as string
    await filters(page).account.click()
    const dialog = page.getByRole("dialog", { name: "切換帳號" })
    const input = dialog.getByPlaceholder("搜尋玩家名稱…")
    await input.fill(tracked)
    await expect(dialog.getByRole("option")).not.toHaveCount(0)
    for (const opt of await dialog.getByRole("option").all()) await expect(opt).toContainText(tracked.slice(0, 3), { ignoreCase: true })
    await input.fill("zzzz-不存在的玩家-zzzz")
    await expect(dialog.getByText("找不到這個玩家")).toBeVisible()
    await page.keyboard.press("Escape")
    await filters(page).account.click()
    await expect(dialog.getByPlaceholder("搜尋玩家名稱…")).toHaveValue("")
  })

  test("切到追蹤中的人：帳號鈕出現「他人」、頁面出現提示列、場次換成那個人的", async ({ page }) => {
    await openPage(page, "dashboard")
    const mineGames = await overallGames(page)
    const other = sql(
      `SELECT a.puuid, a.riot_id, COUNT(*) AS games FROM accounts a
         JOIN match_participants p ON p.puuid = a.puuid JOIN matches m USING (platform_id, game_id)
        WHERE a.tracked = 1 AND a.is_me = 0 AND m.queue_id = 2400 AND a.riot_id IS NOT NULL
        GROUP BY a.puuid ORDER BY games DESC LIMIT 1`,
    )[0]
    await filters(page).account.click()
    await page.getByRole("dialog", { name: "切換帳號" }).getByRole("option", { name: new RegExp(escapeRe(String(other.riot_id))) }).first().click()
    await expect(filters(page).account.getByText("他人")).toBeVisible()
    await expect(page.getByText(/目前看的是.*的數據，不是你自己的/)).toBeVisible()
    await ready(page)
    await expect.poll(() => overallGames(page)).toBe(Number(other.games))
    expect(Number(other.games)).not.toBe(mineGames)
  })

  test("切換帳號會清掉前一個人的跨頁下鑽條件", async ({ page }) => {
    await openPage(page, "dashboard")
    await page.locator('[data-slot="card"]', { hasText: "最常用英雄" }).getByRole("button", { name: /場/ }).first().click()
    await expect(page.locator('nav[aria-label="目前位置"]')).toContainText("英雄：")
    await page.keyboard.press("Control+k")
    await page.getByRole("dialog", { name: "切換帳號" }).getByRole("option").nth(1).click()
    await expect(page.locator('nav[aria-label="目前位置"]')).toHaveCount(0)
  })
})

test.describe("全域篩選：模式與期間", () => {
  test("預設只看 Mayhem；切到「全部模式」後場次不少於 Mayhem", async ({ page }) => {
    await openPage(page, "dashboard")
    await expect(filters(page).queue).toContainText("只看 Mayhem")
    const mayhem = await overallGames(page)
    expect(mayhem).toBe(myRecord().games)
    await filters(page).queue.click()
    await page.getByRole("option", { name: "全部模式" }).click()
    await ready(page)
    const all = sql(`SELECT COUNT(*) AS n FROM match_participants WHERE puuid = ?`, [mePuuid()])[0].n as number
    await expect.poll(() => overallGames(page)).toBe(all)
    expect(all).toBeGreaterThanOrEqual(mayhem)
  })

  test("期間選項：全部、7／14／30／90 天", async ({ page }) => {
    await openPage(page, "dashboard")
    await filters(page).range.click()
    await expect(page.getByRole("option")).toHaveText(["全部期間", "最近 7 天", "最近 14 天", "最近 30 天", "最近 90 天"])
  })

  test("選「最近 7 天」：場次和獨立 SQL（含今天往回 7 天）一致，且送出的查詢帶日期區間", async ({ page }) => {
    await openPage(page, "dashboard")
    const queries = await cubeQueries(page, async () => {
      await filters(page).range.click()
      await page.getByRole("option", { name: "最近 7 天" }).click()
      await ready(page)
    })
    expect(queries.some((q) => q.includes('"dateRange"'))).toBe(true)
    // 「含今天」的 7 個本地日期：今天往回 6 天
    const expected = myRecord(`AND m.local_date >= date('now','localtime','-6 days') AND m.local_date <= date('now','localtime')`)
    await expect.poll(() => overallGames(page)).toBe(expected.games)
  })

  test("期間篩選跨頁保留：到對局紀錄頁時，列表的請求帶同一組日期，總場數和獨立 SQL 一致", async ({ page }) => {
    await openPage(page, "dashboard")
    await filters(page).range.click()
    await page.getByRole("option", { name: "最近 7 天" }).click()
    await ready(page)
    const listed = page.waitForResponse((r) => r.url().includes("/api/matches?") && r.url().includes("date_from="))
    await page.locator('[data-sidebar="menu-button"]', { hasText: "對局紀錄" }).click()
    await expect(header(page)).toHaveText("對局紀錄")
    const res = await listed
    const url = new URL(res.url())
    expect(url.searchParams.get("date_from")).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(url.searchParams.get("date_to")).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(url.searchParams.get("queue")).toBe("2400")
    const body = await res.json()
    expect(body.total).toBe(myRecord(`AND m.local_date >= date('now','localtime','-6 days')`).games)
    await ready(page)
    await expect(filters(page).range).toContainText("最近 7 天")
  })
})

test.describe("主題", () => {
  test("八個主題分成暗色四、亮色四，目前的有勾", async ({ page }) => {
    await openPage(page, "dashboard")
    await filters(page).theme.click()
    const menu = page.getByRole("menu")
    await expect(menu.getByText("暗色")).toBeVisible()
    await expect(menu.getByText("亮色")).toBeVisible()
    await expect(menu.getByRole("menuitem")).toHaveCount(8)
    await expect(menu.getByRole("menuitem", { name: /霓虹/ }).locator("svg.lucide-check")).toBeVisible()
  })

  for (const [id, label] of [["neon", "霓虹"], ["matrix", "終端"], ["lava", "熔岩"], ["violet", "紫電"], ["daylight", "晨光"], ["mint", "薄荷"], ["sakura", "櫻花"], ["sand", "沙丘"]] as const) {
    test(`切換到「${label}」：<html data-theme>、localStorage、按鈕文字一起換，圖表重畫不出錯`, async ({ page }) => {
      await openPage(page, "dashboard")
      await filters(page).theme.click()
      await page.getByRole("menuitem", { name: new RegExp(label) }).click()
      await expect(page.locator("html")).toHaveAttribute("data-theme", id)
      await expect(filters(page).theme).toContainText(label)
      expect(await page.evaluate(() => localStorage.getItem("mayhem-theme"))).toBe(id)
      await ready(page)
    })
  }

  test("主題記在 localStorage，重新整理後還在", async ({ page }) => {
    await openPage(page, "dashboard")
    await filters(page).theme.click()
    await page.getByRole("menuitem", { name: /薄荷/ }).click()
    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "mint")
    await ready(page)
  })

  test("亮色與暗色主題的底色真的不同（背景亮度）", async ({ page }) => {
    await openPage(page, "dashboard")
    const lum = () =>
      page.evaluate(() => {
        const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.map(Number)
        return (m[0] + m[1] + m[2]) / 3
      })
    const dark = await lum()
    await filters(page).theme.click()
    await page.getByRole("menuitem", { name: /晨光/ }).click()
    await expect.poll(lum).toBeGreaterThan(dark + 100)
  })
})
