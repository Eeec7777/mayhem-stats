import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, header, openPage, ready } from "./helpers"
import { sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const panel = (page: Page, title: string) => page.locator('[data-slot="card"]', { has: page.getByText(title, { exact: true }) }).first()

type Member = { puuid: string; riot_id: string; is_me: number }
/** 好友比較的對象：站長自己 + 追蹤中的帳號（和 /api/players 的 crew 一致）。 */
const crewMembers = (): Member[] =>
  sql(`SELECT puuid, riot_id, is_me FROM accounts WHERE is_me = 1 OR tracked = 1 ORDER BY is_me DESC, added_at`) as unknown as Member[]

/** 名稱與 #tag 分開顯示，所以用名稱（# 前面）對。 */
const nameOf = (riotId: string) => riotId.split("#")[0]
/** 一列／一顆標籤的文字是不是這位好友的（開頭是「名稱 換行 #tag」；只比名稱會被別人的 tag 撞到）。 */
const isMember = (text: string, m: { riot_id: string }) => {
  const [name, tag] = m.riot_id.split("#")
  return text.startsWith(tag ? `${name}
#${tag}` : name)
}

const record = (puuid: string) =>
  sql(
    `SELECT COUNT(*) games, SUM(p.win) wins, AVG(p.kills) k, AVG(p.deaths) d, AVG(p.assists) a
       FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400 AND m.is_remake = 0`,
    [puuid],
  )[0]

test.describe("好友比較頁：比較對象", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("每位好友一顆標籤（含自己），預設全部勾選", async ({ page }) => {
    const chips = panel(page, "比較對象").getByTestId("crew-chip")
    await expect(chips).toHaveCount(crewMembers().length)
    for (const c of await chips.all()) await expect(c).toHaveClass(/border-primary\/50/)
  })

  test("點名字拿掉：全員一覽少一列；再點加回來；最後一個拿不掉", async ({ page }) => {
    const chips = panel(page, "比較對象").getByTestId("crew-chip")
    const toggle = (i: number) => chips.nth(i).locator("button").first()
    const rows = () => panel(page, "全員一覽").getByTestId("crew-row")
    const n = crewMembers().length
    await expect(rows()).toHaveCount(n)
    await toggle(n - 1).click()
    await expect(rows()).toHaveCount(n - 1)
    await expect(chips.nth(n - 1)).toHaveClass(/opacity-60/)
    await toggle(n - 1).click()
    await expect(rows()).toHaveCount(n)
    // 全部拿掉到剩一個
    for (let i = 1; i < n; i++) await toggle(i).click()
    await expect(rows()).toHaveCount(1)
    await toggle(0).click()
    await expect(rows()).toHaveCount(1)
    await expect(chips.nth(0)).toHaveClass(/border-primary\/50/)
  })
})

test.describe("好友比較頁：頂層分頁與範圍列", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("四個分頁一次只看一段；捲下去時分頁列貼在頁首正下方；調整比較對象回到最上面", async ({ page }) => {
    await expect(page.getByRole("tab", { name: "全員一覽", exact: true })).toHaveAttribute("data-state", "active")
    await expect(panel(page, "全員一覽")).toBeVisible()
    await expect(panel(page, "數據總表")).toHaveCount(0)
    await page.getByRole("tab", { name: "數據總表", exact: true }).click()
    await expect(panel(page, "數據總表")).toBeVisible()
    await expect(panel(page, "全員一覽")).toHaveCount(0)
    await page.getByRole("tab", { name: "查英雄", exact: true }).click()
    await expect(panel(page, "查英雄")).toBeVisible()
    await page.getByRole("tab", { name: "查增幅裝置", exact: true }).click()
    await expect(panel(page, "查增幅裝置")).toBeVisible()

    await page.evaluate(() => window.scrollTo(0, 600))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    const gap = await page.evaluate(() => {
      const bar = document.querySelector('[data-testid="crew-sticky"]')!.getBoundingClientRect().top
      const head = document.getElementById("app-header")!.getBoundingClientRect().bottom
      return Math.abs(bar - head)
    })
    expect(gap).toBeLessThan(2)

    await page.getByRole("button", { name: "調整比較對象", exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })
})

// ── 判定：和頁面同樣的規則，在這裡獨立寫一份（不 import 前端程式，否則等於自己對自己）
// 隊內貢獻和 50 比，95% 區間（標準誤 27 ÷ √有分數的場數），同一人比 k 組時用 Šidák 放寬；
// 區間整段高於／低於 50 → 強勢／不強勢；差 6 分以上但跨過 50 → 偏強／偏弱；其餘或不到 5 場 → 看不出。
const ROLES = ["坦克", "鬥士", "刺客", "射手", "法師", "輔助"]
const normCdf = (x: number) => {
  // Abramowitz–Stegun 7.1.26，誤差 < 1.5e-7
  const t = 1 / (1 + (0.3275911 * Math.abs(x)) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
const zFor = (k: number) => {
  if (k <= 1) return 1.96
  const target = 1 - (1 - Math.pow(0.95, 1 / k)) / 2
  let lo = 0
  let hi = 10
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (normCdf(mid) < target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
const strengthOf = (mean: number | null, n: number, z: number) => {
  if (mean === null || n < 5) return "看不出"
  const d = mean - 50
  const half = (z * 18.5) / Math.sqrt(n)  // WORK_SD（lib/gap.ts）
  if (d - half > 0) return "強勢"
  if (d + half < 0) return "不強勢"
  if (d >= 4) return "偏強"
  if (d <= -4) return "偏弱"
  return "看不出"
}
type Cell = { games: number; scored: number; score: number | null; strength: string }
/** 一個人每種出裝（加上「整體」）的場次、隊內貢獻與判定 */
function expectedCells(puuid: string): Record<string, Cell> {
  const rows = sql(
    `SELECT b.build_role role, COUNT(*) games, COUNT(c.work_score_v2) scored, AVG(c.work_score_v2) score
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
       LEFT JOIN mat_builds b ON b.participant_rowid = p.rowid
       LEFT JOIN mat_contribution_v2 c ON c.participant_rowid = p.rowid
      WHERE p.puuid = ? AND m.queue_id = 2400 AND m.is_remake = 0 GROUP BY b.build_role`,
    [puuid],
  )
  const k = rows.filter((r) => ROLES.includes(String(r.role)) && Number(r.scored) >= 5).length
  const z = zFor(k)
  const out: Record<string, Cell> = {}
  for (const role of ROLES) {
    const r = rows.find((x) => x.role === role)
    const score = r?.score === null || r?.score === undefined ? null : Number(r.score)
    out[role] = {
      games: Number(r?.games ?? 0),
      scored: Number(r?.scored ?? 0),
      score: score === null ? null : Math.round(score),
      strength: r ? strengthOf(score, Number(r.scored), z) : "看不出",
    }
  }
  const t = sql(
    `SELECT COUNT(*) games, COUNT(c.work_score_v2) scored, AVG(c.work_score_v2) score FROM match_participants p JOIN matches m USING (platform_id, game_id)
       LEFT JOIN mat_contribution_v2 c ON c.participant_rowid = p.rowid WHERE p.puuid = ? AND m.queue_id = 2400 AND m.is_remake = 0`,
    [puuid],
  )[0]
  out["整體"] = {
    games: Number(t.games),
    scored: Number(t.scored),
    score: Math.round(Number(t.score)),
    strength: strengthOf(Number(t.score), Number(t.scored), 1.96),
  }
  return out
}

const matrixRows = (page: Page) => panel(page, "全員一覽").getByTestId("crew-row")
const nameButton = (row: Locator) => row
/** 這一列是哪位好友（用名字欄的文字對） */
async function memberOf(row: Locator) {
  const text = await nameButton(row).innerText()
  const m = crewMembers().find((x) => isMember(text, x))
  expect(m, `對不到好友：${text.slice(0, 40)}`).toBeTruthy()
  return m!
}

test.describe("好友比較頁：全員一覽", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await expect(matrixRows(page).first()).toBeVisible()
  })

  test("最上面一列「全體參賽者」是參照：場次對 SQL，雷達八種出裝的場次對 SQL，不是按鈕", async ({ page }) => {
    const ref = page.getByTestId("crew-reference-row")
    await expect(ref).toContainText("參照")
    const total = Number(sql(`SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400 AND m.is_remake = 0`)[0].n)
    await expect(ref).toContainText(`${total} 場`)
    const tip = (await ref.locator("svg title").textContent())!
    const lines = [...tip.matchAll(/^(\S+(?: \S+)?) \d+%（(\d+) 場/gm)].map((m) => ({ label: m[1], games: Number(m[2]) }))
    expect(lines).toHaveLength(8)
    for (const l of lines) {
      const n = sql(
        `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
           JOIN mat_builds b ON b.participant_rowid = p.rowid WHERE m.queue_id = 2400 AND m.is_remake = 0 AND b.build_role = ?`,
        [l.label],
      )[0].n
      expect(l.games, l.label).toBe(Number(n))
    }
    await expect(ref.locator("button")).toHaveCount(0)
  })

  test("每人一列，依場次多到少排；場次、勝率、KDA 和 SQL 一致", async ({ page }) => {
    const rows = matrixRows(page)
    await expect(rows).toHaveCount(crewMembers().length)
    const games: number[] = []
    for (const row of await rows.all()) {
      const m = await memberOf(row)
      const r = record(m.puuid)
      const g = Number(r.games)
      games.push(g)
      const text = await nameButton(row).innerText()
      expect(text).toContain(`${g} 場・${((Number(r.wins) / g) * 100).toFixed(1)}%`)
      expect(text).toContain(`KDA ${((Number(r.k) + Number(r.a)) / Number(r.d)).toFixed(2)}`)
    }
    expect(games).toEqual([...games].sort((a, b) => b - a))
  })

  test("出裝標籤（強勢／偏強／偏弱／不強勢）與整體判定都和獨立計算一致；上方的摘要句子也是", async ({ page }) => {
    let strong = 0
    let weak = 0
    let judged = 0
    for (const row of await matrixRows(page).all()) {
      const m = await memberOf(row)
      const exp = expectedCells(m.puuid)
      const shown = await row.getByTestId("crew-role-chip").evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.label}:${(e as HTMLElement).dataset.strength}`))
      const want = ROLES.filter((r) => exp[r].strength !== "看不出").map((r) => `${r}:${exp[r].strength}`)
      expect([...shown].sort(), nameOf(m.riot_id)).toEqual([...want].sort())
      await expect(row.getByTestId("crew-overall")).toHaveAttribute("data-strength", exp["整體"].strength)
      await expect(row.getByTestId("crew-overall")).toContainText(`隊內貢獻 ${exp["整體"].score}`)
      for (const role of ROLES) {
        const e = exp[role]
        if (e.scored >= 5 && e.score !== null) judged++
        if (e.strength === "強勢") strong++
        if (e.strength === "不強勢") weak++
      }
    }
    await expect(page.getByTestId("crew-matrix-summary")).toHaveText(
      `各出裝裡 ${judged} 格有 5 場以上，看得出強弱的有 ${strong + weak} 格（強勢 ${strong}、不強勢 ${weak}），其餘差距都還在誤差內。`,
    )
  })

  test("出裝標籤前面是 1、2、3… 連續的名次，看得出的排在還在誤差內的前面", async ({ page }) => {
    for (const row of await matrixRows(page).all()) {
      const chips = await row.getByTestId("crew-role-chip").evaluateAll((els) =>
        els.map((e) => ({ rank: (e.firstElementChild as HTMLElement).innerText, strength: (e as HTMLElement).dataset.strength! })),
      )
      const pos = chips.filter((c) => c.strength === "強勢" || c.strength === "偏強")
      const neg = chips.filter((c) => c.strength === "不強勢" || c.strength === "偏弱")
      for (const list of [pos, neg]) {
        expect(list.map((c) => c.rank)).toEqual(list.map((_, i) => String(i + 1)))
        const firstLean = list.findIndex((c) => c.strength === "偏強" || c.strength === "偏弱")
        if (firstLean >= 0) expect(list.slice(firstLean).every((c) => c.strength === "偏強" || c.strength === "偏弱")).toBe(true)
      }
    }
  })

  test("圖例與「怎麼判斷的」：五級判定、▲▼ 勝率補充、為什麼不再用適合／不適合", async ({ page }) => {
    const box = panel(page, "全員一覽")
    for (const t of [/比平均強（看得出）/, /高 4 分以上，還在誤差內/, /比平均弱（看得出）/, /勝率比他自己的平均明顯高／低/]) {
      await expect(box.getByText(t)).toBeVisible()
    }
    await box.getByText(/怎麼判斷的/).click()
    await expect(box.getByText(/舊版的「適合／不適合」用固定門檻/)).toBeVisible()
  })

  test("英雄頭像：每人比平均強／弱的英雄各最多 5 隻，數量和獨立計算一致", async ({ page }) => {
    for (const row of await matrixRows(page).all()) {
      const m = await memberOf(row)
      const champs = sql(
        `SELECT p.champion_id, COUNT(c.work_score_v2) scored, AVG(c.work_score_v2) score FROM match_participants p JOIN matches mm USING (platform_id, game_id)
           LEFT JOIN mat_contribution_v2 c ON c.participant_rowid = p.rowid WHERE p.puuid = ? AND mm.queue_id = 2400 AND mm.is_remake = 0 GROUP BY p.champion_id`,
        [m.puuid],
      ).filter((r) => r.score !== null)
      const z = zFor(champs.filter((r) => Number(r.scored) >= 5).length)
      const st = champs.map((r) => strengthOf(Number(r.score), Number(r.scored), z))
      const pos = st.filter((x) => x === "強勢" || x === "偏強").length
      const neg = st.filter((x) => x === "不強勢" || x === "偏弱").length
      const sides = row.locator("> span").nth(3).locator("> span")
      await expect(sides.nth(0).getByTestId("crew-champ")).toHaveCount(Math.min(5, pos))
      await expect(sides.nth(1).getByTestId("crew-champ")).toHaveCount(Math.min(5, neg))
    }
  })
})

test.describe("好友比較頁：抽屜（兩個分頁）", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await expect(matrixRows(page).first()).toBeVisible()
  })

  test("點名字開右側抽屜：標題是玩家，副標題是整體勝率、場次、KDA，預設在「總覽」，麵包屑多一層，Esc 關閉", async ({ page }) => {
    const row = matrixRows(page).first()
    const m = await memberOf(row)
    const r = record(m.puuid)
    await nameButton(row).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading")).toContainText(nameOf(m.riot_id))
    await expect(drawer.getByText(`整體 ${((Number(r.wins) / Number(r.games)) * 100).toFixed(1)}%・${r.games} 場・KDA`)).toBeVisible()
    await expect(drawer.getByRole("tab")).toHaveText(["總覽", "出裝與英雄"])
    await expect(drawer.getByRole("tab", { name: "總覽" })).toHaveAttribute("data-state", "active")
    await expect(drawer.getByTestId("crew-reading")).toBeVisible()
    await expect(crumbs(page)).toContainText(nameOf(m.riot_id))
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })

  test("總覽：隊內貢獻與勝率兩張卡（含 95% 區間）、出裝雷達、看得出的強項／弱項、貢獻分解", async ({ page }) => {
    await nameButton(matrixRows(page).first()).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByText("隊內貢獻", { exact: true })).toBeVisible()
    await expect(drawer.getByText("勝率", { exact: true })).toBeVisible()
    await expect(drawer.getByText(/95% 區間 \d+～\d+・\d+ 場/)).toBeVisible()
    await expect(drawer.getByText("看得出的強項")).toBeVisible()
    await expect(drawer.getByText("看得出的弱項")).toBeVisible()
    await ready(page)
    // 出裝雷達是 SVG（和一覽表同一套判定），ECharts 只剩貢獻分解那一張
    await expect(charts(drawer)).toHaveCount(1)
    await expect(drawer.getByTestId("role-hex")).toBeVisible()
  })

  test("出裝與英雄分頁：八種出裝一列一個，判定和一覽表同一列的標籤一致", async ({ page }) => {
    const row = matrixRows(page).first()
    const chips = new Map<string, string>()
    for (const c of await row.getByTestId("crew-role-chip").all()) chips.set((await c.getAttribute("data-label"))!, (await c.getAttribute("data-strength"))!)
    await row.click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "出裝與英雄" }).click()
    const rows = drawer.getByTestId("role-row")
    await expect(rows).toHaveCount(8)
    for (const r of await rows.all()) {
      const label = (await r.getAttribute("data-label"))!
      if (chips.has(label)) expect(await r.getAttribute("data-strength"), label).toBe(chips.get(label))
    }
  })

  test("出裝與英雄分頁的英雄清單：從 1 連續編號；場次加總 = 這個人的總場次；點一列展開那隻英雄的每一場，再點收起", async ({ page }) => {
    const row = matrixRows(page).first()
    const m = await memberOf(row)
    await nameButton(row).click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "出裝與英雄" }).click()
    const ranks = await drawer.getByTestId("pick-rank").allInnerTexts()
    expect(ranks).toEqual(ranks.map((_, i) => String(i + 1)))
    const rows = drawer.locator("button[aria-expanded]")
    const games = (await rows.allInnerTexts()).map((t) => Number(t.match(/(\d+) 場/)![1]))
    expect(games.reduce((a, b) => a + b, 0)).toBe(Number(record(m.puuid).games))
    const first = rows.first()
    await first.click()
    await expect(first).toHaveAttribute("aria-expanded", "true")
    await expect(drawer.getByText(`共 ${games[0]} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText("的每一場")
    await first.click()
    await expect(first).toHaveAttribute("aria-expanded", "false")
  })

  test("出裝與英雄分頁：上方兩條橫向長條列出比平均強／弱的全部英雄，頭像數 = 一覽表那一列的數量（不只前 5 隻）", async ({ page }) => {
    const row = matrixRows(page).first()
    const m = await memberOf(row)
    const champs = sql(
      `SELECT p.champion_id, COUNT(c.work_score_v2) scored, AVG(c.work_score_v2) score FROM match_participants p JOIN matches mm USING (platform_id, game_id)
         LEFT JOIN mat_contribution_v2 c ON c.participant_rowid = p.rowid WHERE p.puuid = ? AND mm.queue_id = 2400 AND mm.is_remake = 0 GROUP BY p.champion_id`,
      [m.puuid],
    ).filter((r) => r.score !== null)
    const z = zFor(champs.filter((r) => Number(r.scored) >= 5).length)
    const st = champs.map((r) => strengthOf(Number(r.score), Number(r.scored), z))
    await row.click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "出裝與英雄" }).click()
    await expect(drawer.getByTestId("strip-strong").getByTestId("crew-champ")).toHaveCount(st.filter((x) => x === "強勢" || x === "偏強").length)
    await expect(drawer.getByTestId("strip-weak").getByTestId("crew-champ")).toHaveCount(st.filter((x) => x === "不強勢" || x === "偏弱").length)
  })

  test("總覽的雷達點一個出裝定位 → 切到「出裝與英雄」分頁、只剩那種出裝；雷達的判定和一覽表同一列一致", async ({ page }) => {
    const row = matrixRows(page).first()
    const chips = new Map<string, string>()
    for (const c of await row.getByTestId("crew-role-chip").all()) chips.set((await c.getAttribute("data-label"))!, (await c.getAttribute("data-strength"))!)
    await row.click()
    const drawer = page.getByRole("dialog")
    const hex = drawer.getByTestId("role-hex")
    for (const g of await hex.locator("g[data-label]").all()) {
      const label = (await g.getAttribute("data-label"))!
      if (chips.has(label)) expect(await g.getAttribute("data-strength"), label).toBe(chips.get(label))
    }
    const role = (await hex.locator("g[data-label][tabindex='0']").first().getAttribute("data-label"))!
    await hex.locator(`g[data-label="${role}"]`).click()
    await expect(drawer.getByRole("tab", { name: "出裝與英雄" })).toHaveAttribute("data-state", "active")
    await expect(crumbs(page)).toContainText(role)
  })

  test("一覽表裡的英雄頭像可以點：打開抽屜的「出裝與英雄」並展開那隻英雄的每一場", async ({ page }) => {
    const champ = matrixRows(page).first().locator("[role=button][data-testid=crew-champ]").first()
    const label = (await champ.getAttribute("aria-label"))!.replace(/^看|的每一場$/g, "")
    await expect(champ).toHaveCSS("cursor", "pointer")
    await champ.click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("tab", { name: "出裝與英雄" })).toHaveAttribute("data-state", "active")
    await expect(drawer.locator(`button[aria-expanded="true"][data-row-key="${label}"]`)).toBeVisible()
  })

  test("總覽最下面是貢獻分解：雷達 + 六項橫條", async ({ page }) => {
    await nameButton(matrixRows(page).first()).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByText(/貢獻分解・所有出裝/)).toBeVisible()
    await ready(page)
    expect(await drawer.locator("[title*='百分位']").count()).toBeGreaterThanOrEqual(5)
  })

  test("「切換成看他的完整數據」：帳號換成他，回到儀表板並出現「他人」提示", async ({ page }) => {
    // 第一列可能是自己；挑一個不是自己的
    let target: Locator | null = null
    let who: Member | null = null
    for (const row of await matrixRows(page).all()) {
      const m = await memberOf(row)
      if (!m.is_me) {
        target = nameButton(row)
        who = m
        break
      }
    }
    await target!.click()
    await page.getByRole("dialog").getByRole("button", { name: /切換成看他的完整數據/ }).click()
    await expect(header(page)).toHaveText("儀表板")
    await expect(page.getByText(/目前看的是.*的數據，不是你自己的/)).toBeVisible()
    await ready(page)
    await expect(page.locator('[data-slot="card"]', { hasText: "整體戰績" }).first().getByText(`${record(who!.puuid).games} 場`, { exact: true })).toBeVisible()
  })
})

test("好友比較頁不再有「陣容情境」：陣容分析集中在陣容頁", async ({ page }) => {
  await openPage(page, "crew")
  await expect(panel(page, "全員一覽").getByTestId("crew-row").first()).toBeVisible()
  await expect(page.getByText("陣容情境", { exact: true })).toHaveCount(0)
})

test.describe("好友比較頁：查英雄／查增幅裝置", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await page.getByRole("tab", { name: "查英雄", exact: true }).click()
    await expect(panel(page, "查英雄")).toBeVisible()
  })

  test("查英雄：預設是最多人玩過的英雄；摘要的人數、場次、勝敗和 SQL 一致", async ({ page }) => {
    const box = panel(page, "查英雄")
    const picker = box.getByRole("button", { name: /選一隻英雄|./ }).first()
    const champ = (await picker.innerText()).trim()
    const crew = crewMembers().map((m) => m.puuid)
    const r = sql(
      `SELECT COUNT(DISTINCT p.puuid) players, COUNT(*) games, SUM(p.win) wins FROM match_participants p JOIN matches m USING (platform_id, game_id)
         JOIN dim_champions c ON c.id = p.champion_id WHERE m.queue_id = 2400 AND m.is_remake = 0 AND c.name = ? AND p.puuid IN (${crew.map(() => "?").join(",")})`,
      [champ, ...crew],
    )[0]
    await expect(box.getByText(`${r.players} 人玩過・合計 ${r.games} 場・${r.wins} 勝 ${Number(r.games) - Number(r.wins)} 敗`)).toBeVisible()
  })

  test("選擇器可以搜尋並選別的英雄，摘要跟著變", async ({ page }) => {
    const box = panel(page, "查英雄")
    await box.getByRole("button").first().click()
    const list = page.locator("[cmdk-item]")
    const second = list.nth(1)
    const name = (await second.locator("span.truncate").innerText()).trim()
    await page.getByPlaceholder("搜尋英雄名稱…").fill(name)
    await expect(list).toHaveCount(1)
    await list.first().click()
    await expect(box.getByRole("button").first()).toContainText(name)
    await expect(box.getByText(/\d+ 人玩過・合計 \d+ 場/)).toBeVisible()
  })

  test("搜尋不到時顯示「這群人都沒玩過這隻」", async ({ page }) => {
    await panel(page, "查英雄").getByRole("button").first().click()
    await page.getByPlaceholder("搜尋英雄名稱…").fill("zzzz-不存在-zzzz")
    await expect(page.getByText("這群人都沒玩過這隻。")).toBeVisible()
  })

  test("每位好友一列：場次、勝率差、貢獻；沒玩過的標示「沒玩過」；點有玩過的開抽屜看他的每一場", async ({ page }) => {
    const box = panel(page, "查英雄")
    const rows = box.getByTestId("lookup-row")
    await expect(rows.first()).toBeVisible()
    const first = rows.first()
    const n = Number((await first.innerText()).match(/(\d+) 場/)![1])
    await first.click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading")).toContainText("的每一場")
    await expect(drawer.getByText(`共 ${n} 場`)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })

  test("查增幅裝置：摘要的人數、場次、勝敗和 SQL 一致", async ({ page }) => {
    await page.getByRole("tab", { name: "查增幅裝置", exact: true }).click()
    const box = panel(page, "查增幅裝置")
    const aug = (await box.getByRole("button").first().innerText()).trim()
    const crew = crewMembers().map((m) => m.puuid)
    const r = sql(
      `SELECT COUNT(DISTINCT p.puuid) players, COUNT(*) games, SUM(p.win) wins
         FROM participant_augments pa
         JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
         JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id JOIN dim_augments a ON a.id = pa.augment_id
        WHERE m.queue_id = 2400 AND m.is_remake = 0 AND a.name = ? AND p.puuid IN (${crew.map(() => "?").join(",")})`,
      [aug, ...crew],
    )[0]
    await expect(box.getByText(`${r.players} 人拿過・合計 ${r.games} 場・${r.wins} 勝 ${Number(r.games) - Number(r.wins)} 敗`)).toBeVisible()
  })
})

test("好友比較頁：模式與期間篩選照常套用", async ({ page }) => {
  await openPage(page, "crew")
  await expect(panel(page, "全員一覽").getByTestId("crew-row").first()).toBeVisible()
  await page.locator("header").getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: "最近 7 天" }).click()
  await ready(page)
  const me = crewMembers().find((m) => m.is_me)!
  const r = sql(
    `SELECT COUNT(*) games FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE p.puuid = ? AND m.queue_id = 2400 AND m.is_remake = 0 AND m.local_date >= date('now','localtime','-6 days')`,
    [me.puuid],
  )[0]
  const myRow = panel(page, "全員一覽").getByTestId("crew-row").filter({ hasText: nameOf(me.riot_id) }).first()
  if (Number(r.games) > 0) await expect(myRow).toContainText(`${r.games} 場`)
})

test("好友比較頁：不再出現固定門檻的「適合／不適合」標籤", async ({ page }) => {
  await openPage(page, "crew")
  await expect(panel(page, "全員一覽").getByTestId("crew-row").first()).toBeVisible()
  await expect(panel(page, "全員一覽").getByTestId("crew-row").getByText(/適合/)).toHaveCount(0)
})

/** 數據總表 → 單場前 10 場：回傳那個面板 */
const peakTop = async (page: Page) => {
  await page.getByRole("tab", { name: "數據總表", exact: true }).click()
  const p = panel(page, "數據總表")
  await p.getByRole("button", { name: "單場前 10 場", exact: true }).click()
  return p
}

/** 比較對象裡一個人的標籤（名字在前）右邊的 ★：設為中心的那一顆 */
const centerBtn = (page: Page, riotId: string) =>
  panel(page, "比較對象").getByTestId("crew-chip").filter({ hasText: nameOf(riotId) }).first().getByTestId("crew-center")

/** 比較對象（站長＋追蹤中的帳號）的每一場，某個每分鐘數值由高到低前 10 場；有給中心就只算他也在場的對局。獨立手寫，不經過語意層。 */
const minuteTop = (numerator: string, centers: string[] = []) =>
  sql(
    `SELECT ${numerator} * 60.0 / NULLIF(p.game_duration, 0) AS v
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE m.queue_id = 2400 AND m.is_remake = 0 AND p.game_duration > 0
        AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)
        ${centers.map(() => "AND EXISTS (SELECT 1 FROM match_participants c WHERE c.platform_id = p.platform_id AND c.game_id = p.game_id AND c.puuid = ?)").join("\n        ")}
        AND ${numerator} IS NOT NULL
      ORDER BY v DESC LIMIT 10`,
    centers,
  ).map((r) => Number(r.v))

test.describe("好友比較頁：單場每分鐘紀錄", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("預設不設中心：每分鐘擊殺的前 10 場由高到低，數值和獨立 SQL 一致（比較對象的每一場一起比）", async ({ page }) => {
    const p = await peakTop(page)
    const want = minuteTop("p.kills").map((v) => v.toFixed(2))
    await expect(p.getByTestId("minute-record-game")).toHaveCount(want.length)
    expect(await p.getByTestId("minute-record-value").allInnerTexts()).toEqual(want)
  })

  test("換成每分鐘補兵（下拉選單）：數值換成補兵的 SQL，同樣是前 10 場", async ({ page }) => {
    const p = await peakTop(page)
    await p.getByRole("combobox").click()
    await page.getByRole("option", { name: "單場最高每分鐘補兵", exact: true }).click()
    const want = minuteTop("p.cs").map((v) => v.toFixed(1))
    await expect(p.getByTestId("minute-record-game")).toHaveCount(want.length)
    expect(await p.getByTestId("minute-record-value").allInnerTexts()).toEqual(want)
  })

  test("列出這幾場的戰報：開抽屜列出前 10 場，Esc 關閉", async ({ page }) => {
    const p = await peakTop(page)
    await p.getByRole("button", { name: "列出這幾場的戰報", exact: true }).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading")).toContainText("前 10 場的戰報")
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })
})

test.describe("好友比較頁：單場每分鐘紀錄的中心（選填）", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("中心在「比較對象」決定：列表只算他也在場的對局；再按一次取消，回到不設中心", async ({ page }) => {
    const p = await peakTop(page)
    const picker = panel(page, "比較對象")
    const me = crewMembers().find((m) => m.is_me === 1)!
    const values = () => p.getByTestId("minute-record-value").allInnerTexts()

    await centerBtn(page, me.riot_id).click()
    const withCenter = minuteTop("p.kills", [me.puuid]).map((v) => v.toFixed(2))
    await expect(p.getByTestId("minute-record-game")).toHaveCount(withCenter.length)
    expect(await values()).toEqual(withCenter)

    await picker.getByRole("button", { name: "不設中心", exact: true }).click()
    const noCenter = minuteTop("p.kills").map((v) => v.toFixed(2))
    await expect.poll(values).toEqual(noCenter)
  })
})

test.describe("好友比較頁：單場前 10 場點一列看那一場", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("點第一列：開抽屜列出那一場（只顯示這一場），Esc 關閉", async ({ page }) => {
    const p = await peakTop(page)
    await p.getByTestId("minute-record-game").first().locator("button").click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading")).toContainText("第 1 名")
    await expect(drawer).toContainText("只顯示這一場")
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })
})

test.describe("好友比較頁：中心可多選（只看這幾位都在場的場次）", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("選兩位：單場每分鐘紀錄只算他們兩位都在場的場次，數值和獨立 SQL 一致", async ({ page }) => {
    const p = await peakTop(page)
    const me = crewMembers().find((m) => m.is_me === 1)!
    const other = crewMembers().find((m) => m.is_me !== 1)!
    await centerBtn(page, me.riot_id).click()
    await centerBtn(page, other.riot_id).click()
    const want = minuteTop("p.kills", [me.puuid, other.puuid]).map((v) => v.toFixed(2))
    await expect(p.getByTestId("minute-record-game")).toHaveCount(want.length)
    expect(await p.getByTestId("minute-record-value").allInnerTexts()).toEqual(want)
  })
})
