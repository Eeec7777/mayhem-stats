import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openPage } from "./helpers"
import { mePuuid, sql } from "./db"

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

// ── 單場每分鐘紀錄 ──────────────────────────────────────────────────────────
// 畫面上的十二個指標，各自獨立寫一次 SQL（分子 × 60 ÷ 秒數的最大值）來對。
// 範圍要和畫面的預設一致：**本機帳號也在場的對局**（追蹤對象自己單獨打的不算）、
// 人是本機帳號 ＋ 追蹤中的帳號、只看 Mayhem、全部期間、不含重開局。

const RECORDS = [
  { label: "每分鐘擊殺", numerator: "p.kills", decimals: 2 },
  { label: "每分鐘死亡", numerator: "p.deaths", decimals: 2 },
  { label: "每分鐘助攻", numerator: "p.assists", decimals: 2 },
  { label: "每分鐘對英雄傷害", numerator: "p.dmg_to_champions", decimals: 0 },
  { label: "每分鐘承受傷害", numerator: "p.dmg_taken", decimals: 0 },
  { label: "每分鐘減免傷害", numerator: "p.dmg_mitigated", decimals: 0 },
  { label: "每分鐘治療", numerator: "p.total_heal", decimals: 0 },
  { label: "每分鐘控場", numerator: "p.time_ccing_others", decimals: 1 },
  { label: "每分鐘經濟", numerator: "p.gold_earned", decimals: 0 },
  { label: "每分鐘補兵", numerator: "p.cs", decimals: 1 },
  { label: "每分鐘建築傷害", numerator: "p.dmg_to_objectives", decimals: 0 },
  { label: "每分鐘小兵傷害（估）", numerator: "(p.total_damage - p.dmg_to_champions - COALESCE(p.dmg_to_objectives, 0))", decimals: 0 },
]

/** 這一群人每一場的每分鐘值，由高到低。
 *  shared（預設）＝ 只算本機帳號（中心）也在場的那些對局，和畫面一致；false 則不限制，用來確認限制真的有生效。 */
const crewPerMin = (numerator: string, shared = true) =>
  sql(
    `SELECT ${numerator} * 60.0 / NULLIF(p.game_duration, 0) AS v, p.puuid AS puuid
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE m.queue_id = 2400 AND m.is_remake = 0 AND p.game_duration > 0
        AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)
        AND ${numerator} IS NOT NULL
        ${shared ? `AND EXISTS (SELECT 1 FROM match_participants c
                     WHERE c.platform_id = p.platform_id AND c.game_id = p.game_id AND c.puuid = ?)` : ""}
      ORDER BY v DESC`,
    shared ? [mePuuid()] : [],
  ).map((r) => ({ v: Number(r.v), puuid: String(r.puuid) }))

/** 畫面上的寫法：整數加千分位，其餘固定小數位。 */
const shown = (v: number, decimals: number) => (decimals === 0 ? Math.round(v).toLocaleString() : v.toFixed(decimals))
/** 畫面上的字（可能帶千分位與「秒」）換回數字；「—」回 NaN，不要變成 0。 */
const parse = (text: string) => {
  const digits = text.replace(/[^\d.]/g, "")
  return digits ? Number(digits) : NaN
}

const recordCard = (page: Page, label: string) =>
  page.locator('[data-testid="record-card"]', { has: page.getByText(label, { exact: true }) })

test.describe("追蹤對象頁：單場每分鐘紀錄", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "tracked")
    await expect(page.locator('[data-testid="record-card"]')).toHaveCount(RECORDS.length)
  })

  test("十二張卡的數字 = 追蹤對象這群人每分鐘值的單場最高（和 SQL 一致）", async ({ page }) => {
    for (const r of RECORDS) {
      const best = crewPerMin(r.numerator)[0]
      // 數字會從 0 跑上去（CountUp），用 poll 等它停在最終值
      await expect
        .poll(async () => parse(await recordCard(page, r.label).locator(".font-mono").innerText()), { message: r.label })
        .toBe(Number(shown(best.v, r.decimals).replace(/,/g, "")))
    }
  })

  test("追蹤對象自己單獨打的場次不算：卡片是「同場」的最高值，不是不限制的最高值", async ({ page }) => {
    // 找一個「限制同場」和「不限制」答案不同的指標。追蹤對象在你沒參與的場次裡剛好沒有任何一項破紀錄時，
    // 這個測試就沒有東西可比，略過（不是失敗）。
    const differs = RECORDS.find((r) => {
      const shared = crewPerMin(r.numerator)[0]?.v
      const any = crewPerMin(r.numerator, false)[0]?.v
      return shared !== undefined && any !== undefined && Math.abs(shared - any) > 1e-9
    })
    test.skip(!differs, "這份資料裡，追蹤對象沒參與你的場次之外的紀錄，無從分辨")
    const r = differs!
    const shared = crewPerMin(r.numerator)[0].v
    const any = crewPerMin(r.numerator, false)[0].v
    await expect.poll(async () => parse(await recordCard(page, r.label).locator(".font-mono").innerText())).toBe(
      Number(shown(shared, r.decimals).replace(/,/g, "")),
    )
    expect(parse(await recordCard(page, r.label).locator(".font-mono").innerText())).not.toBe(
      Number(shown(any, r.decimals).replace(/,/g, "")),
    )
  })

  test("點一張卡：列出同一個指標最高的 10 場，由高到低，第一場就是卡片上的數字", async ({ page }) => {
    const r = RECORDS[3] // 每分鐘對英雄傷害
    const expected = crewPerMin(r.numerator).slice(0, 10)
    await recordCard(page, r.label).click()
    const panel = page.locator('[data-slot="card"]', { has: page.getByText(`${r.label}：最高的 10 場`) })
    await expect(panel.locator('[data-testid="record-game"]')).toHaveCount(expected.length)
    const values = await panel.locator('[data-testid="record-value"]').allInnerTexts()
    expect(values.map(parse)).toEqual(expected.map((e) => Number(shown(e.v, r.decimals).replace(/,/g, ""))))
    // 卡片上的最高值就是清單的第一列
    expect(parse(await recordCard(page, r.label).locator(".font-mono").innerText())).toBe(values.map(parse)[0])
    // 麵包屑登記了這一層，點一下可以退回
    await expect(page.locator("header").getByText(r.label)).toBeVisible()
  })

  test("列出這幾場的戰報：逐場卡片的場數和清單一樣", async ({ page }) => {
    const r = RECORDS[0]
    const count = Math.min(10, crewPerMin(r.numerator).length)
    await recordCard(page, r.label).click()
    const panel = page.locator('[data-slot="card"]', { has: page.getByText(`${r.label}：最高的 10 場`) })
    await panel.getByRole("button", { name: "列出這幾場的戰報" }).click()
    await expect(panel.getByText(new RegExp(`共 ${count} 場`))).toBeVisible()
  })

  test("每個人的單場最高：一列的數字 = 每個人各自的 SQL 最高值", async ({ page }) => {
    const r = RECORDS[3] // 每分鐘對英雄傷害
    const perPlayer = new Map<string, number>()
    for (const row of crewPerMin(r.numerator)) {
      if (!perPlayer.has(row.puuid)) perPlayer.set(row.puuid, row.v) // 已由高到低排序，第一次遇到就是最高
    }
    const expected = [...perPlayer.values()].map((v) => Number(shown(v, r.decimals).replace(/,/g, ""))).sort((a, b) => b - a)
    const cells = await page
      .locator(`[data-testid="per-player-row"][data-metric="participants.best_dpm"] td`)
      .allInnerTexts()
    // 欄的順序是「自己排前面、其餘依名稱」，和 SQL 的排序無關，所以比的是整列的數字集合
    expect(cells.map(parse).filter(Number.isFinite).sort((a, b) => b - a)).toEqual(expected)
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
