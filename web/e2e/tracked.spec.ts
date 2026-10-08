import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openPage } from "./helpers"
import { sql } from "./db"

const card = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()
const kpi = (page: Page, label: string) => card(page, label).locator(".font-mono").first()

/** 追蹤中的帳號：和我同場的場次（shared）、資料庫裡他出現的總場次（games）。邏輯和 /api/accounts 一樣，但是是獨立寫的。 */
const trackedAccounts = () =>
  sql(
    `SELECT a.puuid, a.riot_id,
            (SELECT COUNT(DISTINCT mp.game_id) FROM match_participants mp WHERE mp.puuid = a.puuid
                AND EXISTS (SELECT 1 FROM match_participants me WHERE me.platform_id = mp.platform_id AND me.game_id = mp.game_id
                               AND me.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1))) AS shared,
            (SELECT COUNT(DISTINCT mp.game_id) FROM match_participants mp WHERE mp.puuid = a.puuid) AS games
       FROM accounts a WHERE a.tracked = 1 AND a.is_me = 0 ORDER BY games DESC`,
  )

test.describe("追蹤對象頁", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "tracked")
    await expect(card(page, "追蹤中").locator("[data-slot=badge]").first()).toBeVisible()
  })

  test("三個 KPI：我的 Mayhem 場次、資料庫全部對局、追蹤中的對象，和 SQL 一致", async ({ page }) => {
    const mine = sql(
      `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1) AND m.queue_id = 2400`,
    )[0].n
    const total = sql("SELECT COUNT(*) n FROM matches")[0].n
    await expect(kpi(page, "我的 Mayhem 場次")).toHaveText(String(mine))
    await expect(kpi(page, "資料庫全部對局")).toHaveText(String(total))
    await expect(kpi(page, "追蹤中的對象")).toHaveText(String(trackedAccounts().length))
  })

  test("追蹤中：每個人一顆標籤，標出同場數與「＋N 場你沒參與」，和 SQL 一致", async ({ page }) => {
    const expected = trackedAccounts()
    const badges = card(page, "追蹤中").locator("[data-slot=badge]")
    await expect(badges).toHaveCount(expected.length)
    // 由多到少
    const texts = await badges.allInnerTexts()
    for (const [i, a] of expected.entries()) {
      expect(texts[i], `第 ${i + 1} 位`).toContain(String(a.riot_id))
      expect(texts[i]).toContain(`同場 ${a.shared}`)
      const extra = Number(a.games) - Number(a.shared)
      if (extra > 0) expect(texts[i]).toContain(`＋${extra} 場你沒參與`)
      else expect(texts[i]).not.toContain("你沒參與")
    }
  })

  test("取消追蹤：送出 POST /api/accounts/track { puuid, tracked: false }（請求被攔下，不會真的改名單）", async ({ page, writes }) => {
    const first = trackedAccounts()[0]
    await card(page, "追蹤中").locator("[data-slot=badge]").first().getByRole("button", { name: "取消追蹤" }).click()
    await expect.poll(() => writes.length).toBe(1)
    expect(writes[0]).toEqual({ method: "POST", path: "/api/accounts/track", body: { puuid: first.puuid, tracked: false } })
    // 名單是重新向後端問的；因為寫入被攔下，真實名單沒變
    await expect(card(page, "追蹤中").locator("[data-slot=badge]")).toHaveCount(trackedAccounts().length)
  })

  test("「可加入的對象」：最多 60 位曾同場的人（排除自己與已追蹤的），每人標出場次", async ({ page }) => {
    const tracked = new Set(trackedAccounts().map((a) => String(a.puuid)))
    const cand = sql(
      `SELECT mp.puuid, mp.riot_id, COUNT(DISTINCT mp.game_id) AS games FROM match_participants mp
        WHERE mp.puuid NOT IN (SELECT puuid FROM accounts WHERE is_me = 1) GROUP BY mp.puuid ORDER BY games DESC LIMIT 60`,
    ).filter((c) => !tracked.has(String(c.puuid)))
    const buttons = card(page, "可加入的對象").locator("button")
    await expect(buttons).toHaveCount(cand.length)
    const texts = await buttons.allInnerTexts()
    // 場次由多到少，且前幾位的場次和 SQL 一致（同場次的人順序不固定，所以比的是場次序列）
    expect(texts.map((t) => Number(t.match(/(\d+) 場/)![1]))).toEqual(cand.map((c) => Number(c.games)))
  })

  test("搜尋名稱：只剩符合的人；找不到時顯示「沒有符合的對象」", async ({ page }) => {
    const first = (await card(page, "可加入的對象").locator("button").first().innerText()).split("\n")[0].trim()
    const needle = first.slice(0, 2)
    await card(page, "可加入的對象").getByPlaceholder("搜尋名稱…").fill(needle)
    const texts = await card(page, "可加入的對象").locator("button").allInnerTexts()
    expect(texts.length).toBeGreaterThan(0)
    for (const t of texts) expect(t.toLowerCase()).toContain(needle.toLowerCase())
    await card(page, "可加入的對象").getByPlaceholder("搜尋名稱…").fill("zzzz-不存在-zzzz")
    await expect(page.getByText("沒有符合的對象。")).toBeVisible()
  })

  test("點一位候選人 → 送出 POST /api/accounts/track { puuid, tracked: true }", async ({ page, writes }) => {
    const btn = card(page, "可加入的對象").locator("button").first()
    const name = (await btn.innerText()).split("\n")[0].trim()
    await btn.click()
    await expect.poll(() => writes.length).toBe(1)
    const expected = sql("SELECT puuid FROM match_participants WHERE riot_id = ? LIMIT 1", [name])
    expect(writes[0]).toMatchObject({ method: "POST", path: "/api/accounts/track", body: { tracked: true } })
    expect((writes[0].body as { puuid: string }).puuid).toBe(String(expected[0].puuid))
  })

  test("「立即採集」：送出 POST /api/ingest", async ({ page, writes }) => {
    await card(page, "追蹤中").getByRole("button", { name: "立即採集" }).click()
    await expect.poll(() => writes.map((w) => `${w.method} ${w.path}`)).toContain("POST /api/ingest")
  })

  test("說明文字：只給最新 20 場、重複採集不會產生重複資料", async ({ page }) => {
    await expect(page.getByText(/別人的紀錄只給最新 20 場/)).toBeVisible()
    await expect(page.getByText(/重複採集不會產生重複資料/)).toBeVisible()
  })
})

test.describe("追蹤對象頁：唯讀模式（模擬對外開放的鏡像）", () => {
  test.beforeEach(async ({ page }) => {
    // 把 /api/status 改成 public: true，就是鏡像上看到的樣子
    await page.route("**/api/status", async (route) => {
      const res = await route.fetch()
      const body = await res.json()
      await route.fulfill({ response: res, json: { ...body, public: true } })
    })
    await openPage(page, "tracked")
    await expect(card(page, "追蹤中").locator("[data-slot=badge]").first()).toBeVisible()
  })

  test("顯示唯讀提示，沒有「立即採集」，取消追蹤與候選人按鈕都停用", async ({ page, writes }) => {
    await expect(page.getByText("對外開放的唯讀模式")).toBeVisible()
    await expect(page.getByRole("button", { name: "立即採集" })).toHaveCount(0)
    for (const b of await card(page, "追蹤中").getByRole("button", { name: "取消追蹤" }).all()) await expect(b).toBeDisabled()
    for (const b of await card(page, "可加入的對象").locator("button").all()) await expect(b).toBeDisabled()
    expect(writes).toEqual([])
  })

  test("側邊欄的採集狀態也標示唯讀，沒有「立即採集」鈕", async ({ page }) => {
    await expect(page.locator('[data-slot="sidebar"]').getByText("唯讀模式（對外開放中）")).toBeVisible()
  })
})
