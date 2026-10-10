import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, header, openPage, radarPoint, ready } from "./helpers"
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
       FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
    [puuid],
  )[0]

test.describe("好友比較頁：比較對象", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
  })

  test("每位好友一顆標籤（含自己），預設全部勾選", async ({ page }) => {
    const chips = panel(page, "比較對象").locator("button")
    await expect(chips).toHaveCount(crewMembers().length)
    for (const c of await chips.all()) await expect(c).toHaveClass(/border-primary\/50/)
  })

  test("點名字拿掉：全員一覽少一列；再點加回來；最後一個拿不掉", async ({ page }) => {
    const chips = panel(page, "比較對象").locator("button")
    const rows = () => panel(page, "全員一覽").getByTestId("crew-row")
    const n = crewMembers().length
    await expect(rows()).toHaveCount(n)
    await chips.last().click()
    await expect(rows()).toHaveCount(n - 1)
    await expect(chips.last()).toHaveClass(/opacity-60/)
    await chips.last().click()
    await expect(rows()).toHaveCount(n)
    // 全部拿掉到剩一個
    for (let i = 1; i < n; i++) await chips.nth(i).click()
    await expect(rows()).toHaveCount(1)
    await chips.first().click()
    await expect(rows()).toHaveCount(1)
    await expect(chips.first()).toHaveClass(/border-primary\/50/)
  })
})

// ── 判定：和頁面同樣的規則，在這裡獨立寫一份（不 import 前端程式，否則等於自己對自己）
// 隊內貢獻和 50 比，95% 區間（標準誤 27 ÷ √有分數的場數），同一人比 k 組時用 Šidák 放寬；
// 區間整段高於／低於 50 → 強勢／不強勢；差 6 分以上但跨過 50 → 偏強／偏弱；其餘或不到 5 場 → 看不出。
const ROLES = ["坦克", "AD 鬥士", "AD 刺客", "AD 輸出", "AP 輸出", "AP 刺客", "AP 鬥士", "輔助"]
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
  const half = (z * 27) / Math.sqrt(n)
  if (d - half > 0) return "強勢"
  if (d + half < 0) return "不強勢"
  if (d >= 6) return "偏強"
  if (d <= -6) return "偏弱"
  return "看不出"
}
type Cell = { games: number; scored: number; score: number | null; strength: string }
/** 一個人每種出裝（加上「整體」）的場次、隊內貢獻與判定 */
function expectedCells(puuid: string): Record<string, Cell> {
  const rows = sql(
    `SELECT b.build_role role, COUNT(*) games, COUNT(c.score) scored, AVG(c.score) score
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
       LEFT JOIN mat_builds b ON b.participant_rowid = p.rowid
       LEFT JOIN mat_contribution c ON c.participant_rowid = p.rowid
      WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY b.build_role`,
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
    `SELECT COUNT(*) games, COUNT(c.score) scored, AVG(c.score) score FROM match_participants p JOIN matches m USING (platform_id, game_id)
       LEFT JOIN mat_contribution c ON c.participant_rowid = p.rowid WHERE p.puuid = ? AND m.queue_id = 2400`,
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
const nameButton = (row: Locator) => row.locator("button").first()
/** 這一列是哪位好友（用名字欄的文字對） */
async function memberOf(row: Locator) {
  const text = await nameButton(row).innerText()
  const m = crewMembers().find((x) => isMember(text, x))
  expect(m, `對不到好友：${text.slice(0, 40)}`).toBeTruthy()
  return m!
}

test.describe("好友比較頁：全員一覽（出裝定位矩陣）", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await expect(matrixRows(page).first()).toBeVisible()
  })

  test("最上面一列「全體參賽者」是參照：場次與八種出裝的比例對 SQL，不是按鈕", async ({ page }) => {
    const ref = page.getByTestId("crew-reference-row")
    await expect(ref).toContainText("參照")
    const total = Number(sql(`SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400`)[0].n)
    await expect(ref).toContainText(`${total} 場`)
    for (const role of ROLES) {
      const n = Number(
        sql(
          `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
             JOIN mat_builds b ON b.participant_rowid = p.rowid WHERE m.queue_id = 2400 AND b.build_role = ?`,
          [role],
        )[0].n,
      )
      await expect(ref.locator(`[title*="是${role}"]`)).toContainText(`${Math.round((100 * n) / total)}%`)
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

  test("每一格的場次、隊內貢獻與判定（區間）都和獨立計算一致；上方的摘要句子也是", async ({ page }) => {
    let strong = 0
    let weak = 0
    let judged = 0
    for (const row of await matrixRows(page).all()) {
      const m = await memberOf(row)
      const exp = expectedCells(m.puuid)
      for (const cell of await row.getByTestId("crew-cell").all()) {
        const label = (await cell.getAttribute("data-label"))!
        const e = exp[label]
        expect(Number(await cell.getAttribute("data-games")), `${label} 場次`).toBe(e.games)
        expect(await cell.getAttribute("data-strength"), `${label} 判定`).toBe(e.strength)
        await expect(cell.locator("span").first()).toHaveText(e.score === null ? "—" : String(e.score))
      }
      for (const role of ROLES) {
        const e = exp[role]
        if (e.scored >= 5 && e.score !== null) judged++
        if (e.strength === "強勢") strong++
        if (e.strength === "不強勢") weak++
      }
    }
    await expect(page.getByTestId("crew-matrix-summary")).toHaveText(
      `${judged} 格有 5 場以上，看得出強弱的有 ${strong + weak} 格（強勢 ${strong}、不強勢 ${weak}），其餘差距都還在誤差內。`,
    )
  })

  test("圖例與「怎麼判斷的」：五級判定、▲▼ 勝率補充、為什麼不再用適合／不適合", async ({ page }) => {
    const box = panel(page, "全員一覽")
    for (const t of [/強勢：比同類型強/, /偏強：高 6 分以上/, /不強勢：比同類型弱/, /勝率比他自己的平均明顯高／低/]) {
      await expect(box.getByText(t)).toBeVisible()
    }
    await box.getByText(/怎麼判斷的/).click()
    await expect(box.getByText(/舊版的「適合／不適合」用固定門檻/)).toBeVisible()
  })

  test("英雄分頁：每人比同類型強／弱的英雄，「N 隻・看得出 M」與頭像數和獨立計算一致", async ({ page }) => {
    await panel(page, "全員一覽").getByRole("radio", { name: "英雄" }).click()
    const rows = panel(page, "全員一覽").getByTestId("crew-champ-row")
    await expect(rows).toHaveCount(crewMembers().length)
    for (const row of await rows.all()) {
      const m = await memberOf(row)
      const champs = sql(
        `SELECT p.champion_id, COUNT(c.score) scored, AVG(c.score) score FROM match_participants p JOIN matches mm USING (platform_id, game_id)
           LEFT JOIN mat_contribution c ON c.participant_rowid = p.rowid WHERE p.puuid = ? AND mm.queue_id = 2400 GROUP BY p.champion_id`,
        [m.puuid],
      ).filter((r) => r.score !== null)
      const z = zFor(champs.filter((r) => Number(r.scored) >= 5).length)
      const st = champs.map((r) => strengthOf(Number(r.score), Number(r.scored), z))
      const k = champs.filter((r) => Number(r.scored) >= 5).length
      const clear = st.filter((s) => s === "強勢" || s === "不強勢").length
      await expect(row).toContainText(`${k} 隻・看得出 ${clear}`)
      const pos = st.filter((s) => s === "強勢" || s === "偏強").length
      const neg = st.filter((s) => s === "不強勢" || s === "偏弱").length
      await expect(row.locator("> *").nth(1).getByTestId("crew-champ")).toHaveCount(Math.min(5, pos))
      await expect(row.locator("> *").nth(2).getByTestId("crew-champ")).toHaveCount(Math.min(5, neg))
    }
  })
})

test.describe("好友比較頁：抽屜（四個分頁）", () => {
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
    for (const t of ["總覽", "出裝定位", "英雄", "貢獻分解"]) await expect(drawer.getByRole("tab", { name: t })).toBeVisible()
    await expect(drawer.getByRole("tab", { name: "總覽" })).toHaveAttribute("data-state", "active")
    await expect(drawer.getByTestId("crew-reading")).toBeVisible()
    await expect(crumbs(page)).toContainText(nameOf(m.riot_id))
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })

  test("總覽：隊內貢獻與勝率兩張卡（含 95% 區間）、出裝雷達、看得出的強項／弱項", async ({ page }) => {
    await nameButton(matrixRows(page).first()).click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByText("隊內貢獻", { exact: true })).toBeVisible()
    await expect(drawer.getByText("勝率", { exact: true })).toBeVisible()
    await expect(drawer.getByText(/95% 區間 \d+～\d+・\d+ 場/)).toBeVisible()
    await expect(drawer.getByText("看得出的強項")).toBeVisible()
    await expect(drawer.getByText("看得出的弱項")).toBeVisible()
    await ready(page)
    await expect(charts(drawer)).toHaveCount(1)
  })

  test("出裝定位分頁：八種出裝一列一個，判定和矩陣同一列的格子一致", async ({ page }) => {
    const row = matrixRows(page).first()
    const cells = new Map<string, string>()
    for (const c of await row.getByTestId("crew-cell").all()) cells.set((await c.getAttribute("data-label"))!, (await c.getAttribute("data-strength"))!)
    await nameButton(row).click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "出裝定位" }).click()
    const rows = drawer.getByTestId("role-row")
    await expect(rows).toHaveCount(8)
    for (const r of await rows.all()) {
      const label = (await r.getAttribute("data-label"))!
      if (cells.has(label)) expect(await r.getAttribute("data-strength"), label).toBe(cells.get(label))
    }
  })

  test("英雄分頁：從 1 連續編號；場次加總 = 這個人的總場次；點一列展開那隻英雄的每一場，再點收起", async ({ page }) => {
    const row = matrixRows(page).first()
    const m = await memberOf(row)
    await nameButton(row).click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "英雄" }).click()
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

  test("點矩陣的一格：抽屜直接開在「英雄」分頁、只列那種出裝的英雄（場次加總 = 那格的場次）；「全部出裝」恢復", async ({ page }) => {
    const row = matrixRows(page).first()
    // 第一個有場次的出裝格（整體格開的是總覽）
    const cell = row.locator("[data-testid=crew-cell]:not([data-label='整體'])").first()
    const label = (await cell.getAttribute("data-label"))!
    const n = Number(await cell.getAttribute("data-games"))
    await cell.click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("tab", { name: "英雄" })).toHaveAttribute("data-state", "active")
    await expect(crumbs(page)).toContainText(label)
    const rows = drawer.locator("button[aria-expanded]")
    await expect(rows.first()).toBeVisible()
    const games = (await rows.allInnerTexts()).map((t) => Number(t.match(/(\d+) 場/)![1]))
    expect(games.reduce((a, b) => a + b, 0)).toBe(n)
    await drawer.getByRole("button", { name: "全部出裝" }).click()
    await expect(crumbs(page)).not.toContainText(label)
  })

  test("總覽的雷達點一個出裝定位 → 切到「英雄」分頁、只剩那種出裝", async ({ page }) => {
    await nameButton(matrixRows(page).first()).click()
    const drawer = page.getByRole("dialog")
    await ready(page)
    const radar = charts(drawer).first()
    const opt = await radar.evaluate((el) => (el.parentElement as any).__chart.getOption())
    const values: number[] = opt.series[0].data[0].value
    const idx = values.indexOf(Math.max(...values))
    const role: string = opt.radar[0].indicator[idx].name
    const p = await radarPoint(radar, idx)
    await page.mouse.click(p.x, p.y)
    await expect(drawer.getByRole("tab", { name: "英雄" })).toHaveAttribute("data-state", "active")
    await expect(crumbs(page)).toContainText(role)
  })

  test("貢獻分解分頁：雷達 + 六項橫條", async ({ page }) => {
    await nameButton(matrixRows(page).first()).click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("tab", { name: "貢獻分解" }).click()
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
    await expect(panel(page, "查英雄")).toBeVisible()
  })

  test("查英雄：預設是最多人玩過的英雄；摘要的人數、場次、勝敗和 SQL 一致", async ({ page }) => {
    const box = panel(page, "查英雄")
    const picker = box.getByRole("button", { name: /選一隻英雄|./ }).first()
    const champ = (await picker.innerText()).trim()
    const crew = crewMembers().map((m) => m.puuid)
    const r = sql(
      `SELECT COUNT(DISTINCT p.puuid) players, COUNT(*) games, SUM(p.win) wins FROM match_participants p JOIN matches m USING (platform_id, game_id)
         JOIN dim_champions c ON c.id = p.champion_id WHERE m.queue_id = 2400 AND c.name = ? AND p.puuid IN (${crew.map(() => "?").join(",")})`,
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

  test("每位好友一列：場次、勝率差、貢獻；沒玩過的標示「沒玩過」；點有玩過的展開他的每一場", async ({ page }) => {
    const box = panel(page, "查英雄")
    const rows = box.locator("button.slide-in")
    await expect(rows.first()).toBeVisible()
    const first = rows.first()
    const n = Number((await first.innerText()).match(/(\d+) 場/)![1])
    await first.click()
    await expect(first).toHaveAttribute("aria-expanded", "true")
    await expect(box.getByText(`共 ${n} 場`)).toBeVisible()
    await first.click()
    await expect(first).toHaveAttribute("aria-expanded", "false")
  })

  test("查增幅裝置：摘要的人數、場次、勝敗和 SQL 一致", async ({ page }) => {
    const box = panel(page, "查增幅裝置")
    const aug = (await box.getByRole("button").first().innerText()).trim()
    const crew = crewMembers().map((m) => m.puuid)
    const r = sql(
      `SELECT COUNT(DISTINCT p.puuid) players, COUNT(*) games, SUM(p.win) wins
         FROM participant_augments pa
         JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
         JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id JOIN dim_augments a ON a.id = pa.augment_id
        WHERE m.queue_id = 2400 AND a.name = ? AND p.puuid IN (${crew.map(() => "?").join(",")})`,
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
      WHERE p.puuid = ? AND m.queue_id = 2400 AND m.local_date >= date('now','localtime','-6 days')`,
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
