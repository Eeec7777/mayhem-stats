import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { filters, openPage, ready } from "./helpers"
import { mePuuid, sql } from "./db"

const FPS = 30
/** 場景長度（影格），和 web/src/recap/timeline.ts 一致：intro、volume、champions、augments、when、highlights、partner、outro。 */
const SCENES = { intro: 90, volume: 135, champions: 135, augments: 120 }

const player = (page: Page) => page.locator("main main .rounded-xl").first()
/** 播放器本體（16:9 的那塊），不含外面的卡片。 */
const video = (page: Page) => page.locator('main main div[style*="aspect-ratio"]').first()
const playBtn = (page: Page) => page.getByRole("button", { name: /^(Pause|Play) video$/ })
const clock = (page: Page) => player(page).getByText(/^\d+:\d{2} \/ \d+:\d{2}$/)
const seekbar = (page: Page) =>
  page
    .locator('div[style*="bottom: 0px"]')
    .filter({ has: page.getByRole("button", { name: /^(Pause|Play) video$/ }) })
    .locator("> div")
    .last()

const seconds = (t: string) => {
  const [m, s] = t.split(":").map(Number)
  return m * 60 + s
}

/** 暫停後跳到影片的第幾秒（點進度條）。進度條的寬度 = 整支影片。 */
async function seekTo(page: Page, sec: number) {
  if ((await playBtn(page).getAttribute("aria-label")) === "Pause video") await playBtn(page).click()
  const total = seconds((await clock(page).innerText()).split(" / ")[1])
  const box = (await seekbar(page).boundingBox())!
  await page.mouse.click(box.x + (box.width * sec) / total, box.y + box.height / 2)
  await expect.poll(async () => seconds((await clock(page).innerText()).split(" / ")[0]), { message: "跳到指定秒數" }).toBeGreaterThanOrEqual(Math.floor(sec) - 1)
}

const mine = () => {
  const r = sql(
    `SELECT COUNT(*) games, SUM(p.win) wins, SUM(m.game_duration) secs, MIN(m.local_date) first, MAX(m.local_date) last,
            julianday(MAX(m.local_date)) - julianday(MIN(m.local_date)) + 1 AS span
       FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400`,
    [mePuuid()],
  )[0]
  return { games: Number(r.games), wins: Number(r.wins), hours: Number(r.secs) / 3600, first: String(r.first), last: String(r.last), span: Number(r.span) }
}
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

test.describe("賽季回顧頁", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "recap")
    await expect(playBtn(page)).toBeVisible()
  })

  test("面板標題與說明，以及怎麼匯出 mp4 的提示（本機模式才有）", async ({ page }) => {
    await expect(page.getByText("賽季回顧", { exact: true }).nth(1)).toBeVisible()
    await expect(page.getByText(/整理成一支短片/)).toBeVisible()
    await expect(page.getByText(/npm run recap/)).toBeVisible()
  })

  test("播放器：16:9、自動播放，控制列有播放／暫停、靜音、全螢幕，時間軸是 0:32", async ({ page }) => {
    const box = (await video(page).boundingBox())!
    expect(box.width / box.height).toBeCloseTo(16 / 9, 1)
    await expect(playBtn(page)).toHaveAttribute("aria-label", "Pause video")
    await expect(page.getByRole("button", { name: /^(Un)?[Mm]ute sound$/ })).toBeVisible()
    await expect(page.getByRole("button", { name: "Enter Fullscreen" })).toBeVisible()
    await expect(clock(page)).toContainText("/ 0:32")
  })

  test("自動播放：時間會往前走；暫停後停住；再按繼續", async ({ page }) => {
    const t = async () => seconds((await clock(page).innerText()).split(" / ")[0])
    const t0 = await t()
    await expect.poll(t, { message: "時間沒有前進" }).toBeGreaterThan(t0)
    await playBtn(page).click()
    await expect(playBtn(page)).toHaveAttribute("aria-label", "Play video")
    const frozen = await t()
    await page.waitForTimeout(1500)
    expect(await t()).toBe(frozen)
    await playBtn(page).click()
    await expect(playBtn(page)).toHaveAttribute("aria-label", "Pause video")
    await expect.poll(t).toBeGreaterThan(frozen)
  })

  test("靜音鈕可切換（瀏覽器是否允許帶聲音自動播放會影響起始狀態，所以兩個方向都接受）", async ({ page }) => {
    const sound = page.getByRole("button", { name: /^(Un)?[Mm]ute sound$/ })
    const before = await sound.getAttribute("aria-label")
    await sound.click()
    await expect(sound).toHaveAttribute("aria-label", before === "Mute sound" ? "Unmute sound" : "Mute sound")
    await sound.click()
    await expect(sound).toHaveAttribute("aria-label", before!)
  })

  test("開場：帳號名稱、場次、總時數、日期區間和 SQL 一致", async ({ page }) => {
    const m = mine()
    const acct = sql("SELECT riot_id FROM accounts WHERE puuid = ?", [mePuuid()])[0].riot_id as string
    await seekTo(page, 1.5)
    await expect(player(page)).toContainText("ARAM: MAYHEM")
    await expect(player(page)).toContainText(`${md(m.first)} – ${md(m.last)}`)
    await expect(player(page)).toContainText(`${acct}`)
    await expect(player(page)).toContainText(`${m.games} 場・${m.hours.toFixed(1)} 小時`)
  })

  test("出場總覽：場次、勝敗、勝率、累計時數、平均每天幾場和 SQL 一致", async ({ page }) => {
    const m = mine()
    await seekTo(page, (SCENES.intro + SCENES.volume - 10) / FPS)
    const p = player(page)
    await expect(p).toContainText("這段期間，你打了")
    await expect(p).toContainText(`${m.wins} 勝`)
    await expect(p).toContainText(`${m.games - m.wins} 敗`)
    await expect(p).toContainText(`累計 ${m.hours.toFixed(1)} 小時，平均每天 ${(m.games / m.span).toFixed(1)} 場`)
    await expect(p).toContainText(`${((m.wins / m.games) * 100).toFixed(1)}%`)
  })

  test("英雄場景：最常出場的前三名（名稱、場次、勝率）和 SQL 一致", async ({ page }) => {
    const top = sql(
      `SELECT d.name, COUNT(*) n, SUM(p.win) w FROM match_participants p JOIN matches m USING (platform_id, game_id)
         JOIN dim_champions d ON d.id = p.champion_id WHERE p.puuid = ? AND m.queue_id = 2400
        GROUP BY d.id ORDER BY n DESC, d.name LIMIT 3`,
      [mePuuid()],
    )
    await seekTo(page, (SCENES.intro + SCENES.volume + SCENES.champions - 10) / FPS)
    const p = player(page)
    await expect(p).toContainText("你最常出場的英雄")
    for (const r of top) {
      await expect(p).toContainText(String(r.name))
      await expect(p).toContainText(`${r.n} 場・勝率 ${((Number(r.w) / Number(r.n)) * 100).toFixed(1)}%`)
    }
  })

  test("增幅場景：最常拿的增幅與勝率最高（至少 5 場）的增幅，場次與勝率和 SQL 一致", async ({ page }) => {
    const rows = sql(
      `SELECT a.name, COUNT(*) n, SUM(p.win) w FROM participant_augments pa
         JOIN match_participants p ON p.platform_id = pa.platform_id AND p.game_id = pa.game_id AND p.participant_id = pa.participant_id
         JOIN matches m ON m.platform_id = p.platform_id AND m.game_id = p.game_id JOIN dim_augments a ON a.id = pa.augment_id
        WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY a.id`,
      [mePuuid()],
    )
    const most = [...rows].sort((a, b) => Number(b.n) - Number(a.n))[0]
    const best = rows.filter((r) => Number(r.n) >= 5).sort((a, b) => Number(b.w) / Number(b.n) - Number(a.w) / Number(a.n))[0]
    await seekTo(page, (SCENES.intro + SCENES.volume + SCENES.champions + SCENES.augments - 10) / FPS)
    const p = player(page)
    await expect(p).toContainText("你的增幅偏好")
    await expect(p).toContainText(String(most.name))
    await expect(p).toContainText(`${most.n} 場・勝率 ${((Number(most.w) / Number(most.n)) * 100).toFixed(1)}%`)
    await expect(p).toContainText(String(best.name))
    await expect(p).toContainText(`${best.n} 場・勝率 ${((Number(best.w) / Number(best.n)) * 100).toFixed(1)}%`)
  })

  test("影片的顏色跟著主題：切到亮色主題，播放器背景變亮", async ({ page }) => {
    const bg = () =>
      page.evaluate(() => {
        const el = document.querySelector("main main .rounded-xl")!.querySelector('[style*="background"]') as HTMLElement
        const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!.map(Number)
        return (m[0] + m[1] + m[2]) / 3
      })
    const dark = await bg()
    await filters(page).theme.click()
    await page.getByRole("menuitem", { name: /晨光/ }).click()
    await expect.poll(bg).toBeGreaterThan(dark + 100)
  })

  test("換期間（最近 7 天）後重新載入：開場場次改成期間內的場次", async ({ page }) => {
    await filters(page).range.click()
    await page.getByRole("option", { name: "最近 7 天" }).click()
    await ready(page)
    const r = sql(
      `SELECT COUNT(*) games FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE p.puuid = ? AND m.queue_id = 2400 AND m.local_date >= date('now','localtime','-6 days')`,
      [mePuuid()],
    )[0]
    test.skip(Number(r.games) === 0, "最近 7 天沒有對局")
    await seekTo(page, 1.5)
    await expect(player(page)).toContainText(`${r.games} 場`)
  })

  test("條件下沒有對局時顯示空狀態而不是播放器", async ({ page }) => {
    // 切到一個沒有任何對局的帳號：挑資料庫裡沒有 Mayhem 場次的玩家
    const none = sql(
      `SELECT mp.puuid, mp.riot_id FROM match_participants mp GROUP BY mp.puuid
        HAVING SUM(CASE WHEN EXISTS (SELECT 1 FROM matches m WHERE m.platform_id = mp.platform_id AND m.game_id = mp.game_id AND m.queue_id = 2400) THEN 1 ELSE 0 END) = 0 LIMIT 1`,
    )
    test.skip(none.length === 0, "資料庫裡每個玩家都有 Mayhem 場次")
    await page.keyboard.press("Control+k")
    await page.getByRole("dialog", { name: "切換帳號" }).getByPlaceholder("搜尋玩家名稱…").fill(String(none[0].riot_id))
    await page.getByRole("dialog", { name: "切換帳號" }).getByRole("option").first().click()
    await expect(page.getByText("這個條件下還沒有對局，沒有東西可以回顧。")).toBeVisible()
  })
})
