import type { Page } from "@playwright/test"
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
    const rows = () => panel(page, "全員一覽").locator("button.slide-in")
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

test.describe("好友比較頁：全員一覽", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await expect(panel(page, "全員一覽").locator("button.slide-in").first()).toBeVisible()
  })

  test("最上面一列「全體參賽者」是參照：場次、勝率 50%、KDA 對獨立 SQL，雷達八種出裝的場次對 SQL", async ({ page }) => {
    const ref = page.getByTestId("crew-reference-row")
    await expect(ref).toContainText("參照")
    const r = sql(
      `SELECT COUNT(*) n, AVG(p.kills) k, AVG(p.assists) a, AVG(p.deaths) d, AVG(p.win) w
         FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400`,
    )[0]
    const kda = ((Number(r.k) + Number(r.a)) / Number(r.d)).toFixed(2)
    await expect(ref).toContainText(`${r.n} 場・${(Number(r.w) * 100).toFixed(1)}%・KDA ${kda}`)
    // 雷達的 tooltip 列出八種出裝各自的場次（沒判定出裝的不在雷達上，個人的雷達也一樣）；每一種都對 SQL
    const tip = (await ref.locator("svg title").textContent())!
    const lines = [...tip.matchAll(/^(\S+(?: \S+)?) \d+%（(\d+) 場/gm)].map((m) => ({ label: m[1], games: Number(m[2]) }))
    expect(lines).toHaveLength(8)
    for (const l of lines) {
      const n = sql(
        `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
           JOIN mat_builds b ON b.participant_rowid = p.rowid WHERE m.queue_id = 2400 AND b.build_role = ?`,
        [l.label],
      )[0].n
      expect(l.games, l.label).toBe(Number(n))
    }
    // 參照列不是按鈕，不算進「每人一列」
    await expect(ref.locator("button")).toHaveCount(0)
  })

  test("每人一列，依場次多到少排；場次、勝率、KDA 和 SQL 一致", async ({ page }) => {
    const rows = panel(page, "全員一覽").locator("button.slide-in")
    const members = crewMembers()
    await expect(rows).toHaveCount(members.length)
    const games: number[] = []
    for (const [i, row] of (await rows.all()).entries()) {
      const text = await row.innerText()
      const m = members.find((x) => isMember(text, x))
      expect(m, `第 ${i + 1} 列對不到好友：${text.slice(0, 40)}`).toBeTruthy()
      const r = record(m!.puuid)
      const g = Number(r.games)
      games.push(g)
      expect(text).toContain(`${g} 場`)
      expect(text).toContain(`${((Number(r.wins) / g) * 100).toFixed(1)}%`)
      expect(text).toContain(`KDA ${((Number(r.k) + Number(r.a)) / Number(r.d)).toFixed(2)}`)
      expect(text).toMatch(/隊內貢獻 (\d+|—)/)
    }
    expect(games).toEqual([...games].sort((a, b) => b - a))
  })

  test("表頭：玩家、出裝定位、出裝好壞、英雄好壞", async ({ page }) => {
    const box = panel(page, "全員一覽")
    for (const t of ["玩家", "出裝定位", "出裝：好的一面", "出裝：要注意的", "英雄：好的一面", "英雄：要注意的"]) {
      await expect(box.getByText(t, { exact: true })).toBeVisible()
    }
  })

  test("每列有迷你雷達（SVG）與出裝、英雄的判斷標籤", async ({ page }) => {
    await expect(panel(page, "全員一覽").locator("button.slide-in svg").first()).toBeVisible()
    const text = await panel(page, "全員一覽").locator("button.slide-in").first().innerText()
    expect(text).toMatch(/適合|不適合|靠隊友|非戰之罪|勝率好|勝率差|AD|AP|坦克|輔助|鬥士|刺客|輸出/)
  })

  test("點一列開右側抽屜：標題是玩家，副標題是整體勝率、場次、KDA，麵包屑多一層，Esc 關閉", async ({ page }) => {
    const first = panel(page, "全員一覽").locator("button.slide-in").first()
    const text = await first.innerText()
    const m = crewMembers().find((x) => isMember(text, x))!
    const r = record(m.puuid)
    await first.click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading")).toContainText(nameOf(m.riot_id))
    await expect(drawer.getByText(`整體 ${((Number(r.wins) / Number(r.games)) * 100).toFixed(1)}%・${r.games} 場・KDA`)).toBeVisible()
    await expect(crumbs(page)).toContainText(nameOf(m.riot_id))
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
  })

  test("抽屜內容：四份好壞清單、出裝定位雷達、貢獻分解（雷達 + 橫條）、玩過的每隻英雄", async ({ page }) => {
    await panel(page, "全員一覽").locator("button.slide-in").first().click()
    const drawer = page.getByRole("dialog")
    for (const t of ["出裝定位：好的一面", "出裝定位：要注意的", "英雄：好的一面", "英雄：要注意的"]) {
      await expect(drawer.getByText(t, { exact: true })).toBeVisible()
    }
    await expect(drawer.getByText(/貢獻分解・所有出裝/)).toBeVisible()
    await expect(drawer.getByText("玩過的每隻英雄")).toBeVisible()
    await expect(charts(drawer)).toHaveCount(2)
    await ready(page)
    // 六項貢獻的橫條
    expect(await drawer.locator("[title*='百分位']").count()).toBeGreaterThanOrEqual(5)
  })

  test("抽屜的「形狀：勝率」切換說明文字", async ({ page }) => {
    await panel(page, "全員一覽").locator("button.slide-in").first().click()
    const drawer = page.getByRole("dialog")
    await drawer.getByRole("radio", { name: "形狀：勝率" }).click()
    await expect(drawer.getByText(/虛線圈是他自己的整體勝率/)).toBeVisible()
  })

  test("抽屜裡玩過的英雄：場次加總 = 這個人的總場次；點一列展開那隻英雄的每一場，再點收起", async ({ page }) => {
    const first = panel(page, "全員一覽").locator("button.slide-in").first()
    const text = await first.innerText()
    const m = crewMembers().find((x) => isMember(text, x))!
    await first.click()
    const drawer = page.getByRole("dialog")
    await ready(page)
    const rows = drawer.locator("button[aria-expanded]")
    await expect(rows.first()).toBeVisible()
    const games = (await rows.allInnerTexts()).map((t) => Number(t.match(/(\d+) 場/)![1]))
    expect(games.reduce((a, b) => a + b, 0)).toBe(Number(record(m.puuid).games))
    const row = rows.first()
    await row.click()
    await expect(row).toHaveAttribute("aria-expanded", "true")
    await expect(drawer.getByText(`共 ${games[0]} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText("的每一場")
    await row.click()
    await expect(row).toHaveAttribute("aria-expanded", "false")
  })

  test("點抽屜雷達的一個出裝定位 → 貢獻分解與英雄清單只剩那種出裝，「看全部出裝」恢復", async ({ page }) => {
    const first = panel(page, "全員一覽").locator("button.slide-in").first()
    await first.click()
    const drawer = page.getByRole("dialog")
    await ready(page)
    const radar = charts(drawer).first()
    const opt = await radar.evaluate((el) => (el.parentElement as any).__chart.getOption())
    const values: number[] = opt.series[0].data[0].value
    const idx = values.indexOf(Math.max(...values))
    const role: string = opt.radar[0].indicator[idx].name
    const p = await radarPoint(radar, idx)
    await page.mouse.click(p.x, p.y)
    await expect(drawer.getByText(`貢獻分解・出裝是${role}時`)).toBeVisible()
    await expect(drawer.getByText(`出裝是${role}時玩過的英雄`)).toBeVisible()
    await drawer.getByRole("button", { name: "看全部出裝" }).click()
    await expect(drawer.getByText("玩過的每隻英雄")).toBeVisible()
  })

  test("「切換成看他的完整數據」：帳號換成他，回到儀表板並出現「他人」提示", async ({ page }) => {
    // 第一列可能是自己；挑一個不是自己的
    const rows = panel(page, "全員一覽").locator("button.slide-in")
    const others = crewMembers().filter((m) => !m.is_me)
    let target = rows.first()
    for (const row of await rows.all()) {
      const t = await row.innerText()
      if (others.some((o) => isMember(t, o))) {
        target = row
        break
      }
    }
    const text = await target.innerText()
    const m = others.find((o) => isMember(text, o))!
    await target.click()
    await page.getByRole("dialog").getByRole("button", { name: /切換成看他的完整數據/ }).click()
    await expect(header(page)).toHaveText("儀表板")
    await expect(page.getByText(/目前看的是.*的數據，不是你自己的/)).toBeVisible()
    await ready(page)
    await expect(page.locator('[data-slot="card"]', { hasText: "整體戰績" }).first().getByText(`${record(m.puuid).games} 場`, { exact: true })).toBeVisible()
  })
})

test.describe("好友比較頁：陣容情境", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "crew")
    await expect(panel(page, "陣容情境").locator("table")).toBeVisible()
  })

  const ctx = (page: Page) => panel(page, "陣容情境")
  const bucket = (n: number, cap: number) => (n >= cap ? (cap === 2 ? "2 個以上" : `${cap} 個以上`) : `${n} 個`)
  const front = "(b.build_role = '坦克' OR b.build_role LIKE '%鬥士')"

  test("預設看自己、「隊友前排數」；基準文字是他自己的整體勝率", async ({ page }) => {
    const me = crewMembers().find((m) => m.is_me)!
    const r = record(me.puuid)
    await expect(ctx(page).getByRole("combobox", { name: "要看的玩家" })).toHaveValue(me.puuid)
    await expect(ctx(page).getByRole("radio", { name: "隊友前排數" })).toHaveAttribute("aria-checked", "true")
    await expect(ctx(page).getByText(`基準：他自己的整體勝率 ${((Number(r.wins) / Number(r.games)) * 100).toFixed(1)}%`)).toBeVisible()
  })

  test("四種分組可選：隊友前排數、敵方前排數、敵方傷害類型、隊友傷害類型", async ({ page }) => {
    await expect(ctx(page).getByRole("radio")).toHaveText(["隊友前排數", "敵方前排數", "敵方傷害類型", "隊友傷害類型"])
  })

  test("隊友前排數矩陣：每個「出裝 × 前排數」格子的場次與勝敗和 SQL 一致", async ({ page }) => {
    const me = crewMembers().find((m) => m.is_me)!
    const rows = sql(
      `WITH g AS (
         SELECT p.platform_id, p.game_id, p.team_id, p.participant_id, p.win, b.build_role AS role
           FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN mat_builds b ON b.participant_rowid = p.rowid
          WHERE p.puuid = ? AND m.queue_id = 2400)
       SELECT g.role, g.win,
              (SELECT COUNT(*) FROM match_participants q JOIN mat_builds b ON b.participant_rowid = q.rowid
                WHERE q.platform_id = g.platform_id AND q.game_id = g.game_id AND q.team_id = g.team_id AND q.participant_id <> g.participant_id AND ${front}) AS ally_front
         FROM g`,
      [me.puuid],
    )
    const cells = new Map<string, { n: number; w: number }>()
    for (const r of rows) {
      // 「未成形」（裝備太少判不出定位）不是矩陣的一列，只算在「所有出裝」裡
      if (r.role === "未成形") continue
      const k = `${r.role}|${bucket(Number(r.ally_front), 2)}`
      const c = cells.get(k) ?? { n: 0, w: 0 }
      cells.set(k, { n: c.n + 1, w: c.w + Number(r.win) })
    }
    expect(cells.size).toBeGreaterThan(4)
    for (const [k, v] of cells) {
      const [role, b] = k.split("|")
      const cell = ctx(page).locator(`div[title^="${role}・隊友前排數 ${b}"]`)
      await expect(cell, k).toContainText(`${v.w}-${v.n - v.w}`)
      await expect(cell).toHaveAttribute("title", new RegExp(`${v.n} 場・${v.w} 勝 ${v.n - v.w} 敗`))
    }
  })

  test("「所有出裝」×「所有陣容」格 = 這個人的總場次與勝率", async ({ page }) => {
    const me = crewMembers().find((m) => m.is_me)!
    const r = record(me.puuid)
    const all = ctx(page).locator('div[title^="所有出裝・所有陣容"]')
    await expect(all).toHaveAttribute("title", new RegExp(`${r.games} 場・${r.wins} 勝 ${Number(r.games) - Number(r.wins)} 敗・勝率 ${((Number(r.wins) / Number(r.games)) * 100).toFixed(1)}%`))
  })

  test("敵方前排數：格子加總 = 總場次", async ({ page }) => {
    await ctx(page).getByRole("radio", { name: "敵方前排數" }).click()
    await expect(ctx(page).locator("thead")).toContainText("敵方有幾個前排")
    const me = crewMembers().find((m) => m.is_me)!
    const total = Number(record(me.puuid).games)
    // 最下面的「所有出裝」列：各陣容桶加總 = 總場次
    const titles = await ctx(page).locator('div[title^="所有出裝・敵方前排數 "]').evaluateAll((els) => els.map((e) => e.getAttribute("title")!))
    const sum = titles.reduce((a, t) => a + Number(t.match(/(\d+) 場/)?.[1] ?? 0), 0)
    expect(sum).toBe(total)
  })

  test("每種陣容下有「適合／避開」建議卡", async ({ page }) => {
    await expect(ctx(page).getByText(/^隊友前排數：(0 個|1 個|2 個以上)$/)).toHaveCount(3)
    await ctx(page).getByRole("radio", { name: "敵方傷害類型" }).click()
    await expect(ctx(page).getByText(/^敵方傷害類型：/)).toHaveCount(3)
  })

  test("換成別的好友：基準勝率與總格跟著變成那個人的", async ({ page }) => {
    const other = crewMembers().find((m) => !m.is_me)!
    await ctx(page).getByRole("combobox", { name: "要看的玩家" }).selectOption(other.puuid)
    const r = record(other.puuid)
    await expect(ctx(page).getByText(`基準：他自己的整體勝率 ${((Number(r.wins) / Number(r.games)) * 100).toFixed(1)}%`)).toBeVisible()
    await expect(ctx(page).locator('div[title^="所有出裝・所有陣容"]')).toHaveAttribute("title", new RegExp(`${r.games} 場・${r.wins} 勝`))
  })
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
  await expect(panel(page, "全員一覽").locator("button.slide-in").first()).toBeVisible()
  await page.locator("header").getByRole("combobox").nth(1).click()
  await page.getByRole("option", { name: "最近 7 天" }).click()
  await ready(page)
  const me = crewMembers().find((m) => m.is_me)!
  const r = sql(
    `SELECT COUNT(*) games FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE p.puuid = ? AND m.queue_id = 2400 AND m.local_date >= date('now','localtime','-6 days')`,
    [me.puuid],
  )[0]
  const myRow = panel(page, "全員一覽").locator("button.slide-in", { hasText: nameOf(me.riot_id) }).first()
  if (Number(r.games) > 0) await expect(myRow).toContainText(`${r.games} 場`)
})
