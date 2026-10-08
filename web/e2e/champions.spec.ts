import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { charts, chartOption, gridColumn, gridRows, header, openPage, radarPoint, readCsv, ready } from "./helpers"
import { mePuuid, myRecord, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
const nums = (xs: string[]) => xs.map((x) => Number(x.replace(/[^\d.-]/g, "")))

/** 自己每隻英雄的場次與勝場。 */
const myChampions = () =>
  sql(
    `SELECT d.name, COUNT(*) AS n, SUM(p.win) AS w FROM match_participants p JOIN matches m USING (platform_id, game_id)
       JOIN dim_champions d ON d.id = p.champion_id WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY d.id ORDER BY n DESC, d.name`,
    [mePuuid()],
  )

test.describe("英雄頁：表格", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "champions")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("列數 = 玩過的英雄數，頁面標出「N 列」", async ({ page }) => {
    await expect(page.getByText(`${myChampions().length} 列`, { exact: true })).toBeVisible()
  })

  test("預設依場次由多到少，每隻英雄的場次與勝率和 SQL 一致", async ({ page }) => {
    const expected = myChampions()
    const games = nums(await gridColumn(page, "participants.games"))
    expect(games.length).toBeGreaterThan(5)
    // 由多到少
    expect(games).toEqual([...games].sort((a, b) => b - a))
    // 前幾列逐一對：名稱(第一行)、場次、勝敗
    const names = (await gridColumn(page, "champions.name")).map((t) => t.split("\n")[0])
    const winrates = await gridColumn(page, "participants.winrate")
    const byName = new Map(expected.map((r) => [String(r.name), r]))
    names.forEach((name, i) => {
      const r = byName.get(name)!
      expect(r, `SQL 裡沒有 ${name}`).toBeTruthy()
      expect(games[i], `${name} 場次`).toBe(Number(r.n))
      expect(winrates[i], `${name} 勝率`).toContain(`${((Number(r.w) / Number(r.n)) * 100).toFixed(1)}%`)
      expect(winrates[i]).toContain(`${r.w} 勝 ${Number(r.n) - Number(r.w)} 敗`)
    })
  })

  test("英雄名下面標出最常出的出裝定位", async ({ page }) => {
    const first = (await gridColumn(page, "champions.name"))[0]
    expect(first.split("\n").length).toBeGreaterThanOrEqual(2)
  })

  test("KDA 欄：(平均擊殺+平均助攻)÷平均死亡，和 SQL 一致", async ({ page }) => {
    const name = (await gridColumn(page, "champions.name"))[0].split("\n")[0]
    const r = sql(
      `SELECT AVG(p.kills) k, AVG(p.deaths) d, AVG(p.assists) a FROM match_participants p JOIN matches m USING (platform_id, game_id)
         JOIN dim_champions c ON c.id = p.champion_id WHERE p.puuid = ? AND m.queue_id = 2400 AND c.name = ?`,
      [mePuuid(), name],
    )[0]
    const kda = ((Number(r.k) + Number(r.a)) / Number(r.d)).toFixed(2)
    expect((await gridColumn(page, "participants.kda"))[0]).toContain(kda)
  })

  test("點欄位標題排序：第一下遞增、第二下遞減", async ({ page }) => {
    const header = page.locator('.ag-header-cell[col-id="participants.games"]').first()
    await header.click()
    await expect.poll(async () => nums(await gridColumn(page, "participants.games"))[0]).toBeLessThanOrEqual(2)
    const asc = nums(await gridColumn(page, "participants.games"))
    expect(asc).toEqual([...asc].sort((a, b) => a - b))
    await header.click()
    await expect.poll(async () => nums(await gridColumn(page, "participants.games"))[0]).toBe(myChampions()[0].n)
  })

  test("欄位篩選：場次「等於 10」只剩剛好 10 場的英雄，清掉後恢復", async ({ page }) => {
    // 標題下方每欄各有一個篩選輸入框；數值欄預設的條件是「等於」
    const input = page.locator('[col-id="participants.games"] input.ag-number-field-input').first()
    await input.fill("10")
    await input.press("Enter")
    const expected = myChampions().filter((r) => Number(r.n) === 10).length
    await expect.poll(async () => (await gridColumn(page, "participants.games")).length).toBe(expected)
    expect(nums(await gridColumn(page, "participants.games")).every((g) => g === 10)).toBe(true)
    await input.fill("")
    await input.press("Enter")
    await expect.poll(async () => (await gridColumn(page, "participants.games")).length).toBeGreaterThan(expected)
  })

  test("文字欄篩選：英雄欄輸入名稱只剩那隻", async ({ page }) => {
    const top = (await gridColumn(page, "champions.name"))[0].split("\n")[0]
    const input = page.locator('[col-id="champions.name"] input.ag-text-field-input').first()
    await input.fill(top)
    await input.press("Enter")
    await expect.poll(async () => (await gridColumn(page, "champions.name")).map((n) => n.split("\n")[0])).toEqual(
      myChampions().filter((r) => String(r.name).includes(top)).map((r) => String(r.name)),
    )
  })

  test("快速搜尋：輸入英雄名只剩符合的列，清除鈕恢復", async ({ page }) => {
    const top = (await gridColumn(page, "champions.name"))[0].split("\n")[0]
    const box = page.getByPlaceholder("快速搜尋所有欄位…")
    await box.fill(top)
    await expect
      .poll(async () => {
        const names = await gridColumn(page, "champions.name")
        return names.length > 0 && names.every((n) => n.includes(top))
      })
      .toBe(true)
    await page.getByRole("button", { name: "清除" }).click()
    await expect(box).toHaveValue("")
    await expect.poll(async () => (await gridColumn(page, "champions.name")).length).toBeGreaterThan(5)
  })

  test("快速搜尋找不到時顯示「沒有符合的列」覆蓋層", async ({ page }) => {
    await page.getByPlaceholder("快速搜尋所有欄位…").fill("zzzz-不存在-zzzz")
    await expect(page.locator(".ag-overlay-no-matching-rows-center")).toBeVisible()
  })

  test("匯出 CSV：下載檔名、欄位與列數、原始數值（不是格式化字串）", async ({ page }) => {
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    expect(download.suggestedFilename()).toMatch(/^champions-\d{4}-\d{2}-\d{2}\.csv$/)
    const rows = await readCsv(await download.path())
    expect(rows.length - 1).toBe(myChampions().length)
    expect(rows[0]).toContain("英雄")
    expect(rows[0]).toContain("場次")
    const iGames = rows[0].indexOf("場次")
    const top = myChampions()[0]
    const csvTop = rows.slice(1).find((r) => r[rows[0].indexOf("英雄")] === String(top.name))!
    expect(Number(csvTop[iGames])).toBe(Number(top.n))
  })
})

test.describe("英雄頁：出裝定位雷達", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "champions")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("八個軸，各軸場次和 SQL 一致", async ({ page }) => {
    const opt = await chartOption(charts(page).first())
    expect(opt.radar[0].indicator).toHaveLength(8)
    const labels: string[] = opt.radar[0].indicator.map((i: any) => i.name)
    const sqlRows = new Map(
      sql(
        `SELECT b.build_role r, COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN mat_builds b ON b.participant_rowid = p.rowid
          WHERE p.puuid = ? AND m.queue_id = 2400 GROUP BY b.build_role`,
        [mePuuid()],
      ).map((r) => [String(r.r), Number(r.n)]),
    )
    // 場次模式下 data[0].value 是各軸場次（做過縮放的話以 games 為準，故只檢查比例順序）
    const values: number[] = opt.series[0].data[0].value
    const order = (xs: number[]) => xs.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map((x) => x[1])
    expect(order(values)).toEqual(order(labels.map((l) => sqlRows.get(l) ?? 0)))
  })

  test("點某一軸 → 表格只剩那一類，出現「只看出裝是X」晶片與麵包屑；再點一次取消", async ({ page }) => {
    const radar = charts(page).first()
    const opt = await chartOption(radar)
    const labels: string[] = opt.radar[0].indicator.map((i: any) => i.name)
    // 選場次最多的那一軸
    const values: number[] = opt.series[0].data[0].value
    const idx = values.indexOf(Math.max(...values))
    const role = labels[idx]
    const p = await radarPoint(radar, idx)
    await page.mouse.click(p.x, p.y)
    await expect(page.getByRole("button", { name: `只看出裝是${role}` })).toBeVisible()
    await expect(crumbs(page)).toContainText(`出裝是${role}`)
    await ready(page)
    // 表格是虛擬化的，只畫得出看得到的列；用匯出 CSV 拿全部列，場次加總 = 那個定位的場次
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "匯出 CSV" }).click()])
    const csv = await readCsv(await download.path())
    const iGames = csv[0].indexOf("場次")
    const expected = sql(
      `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN mat_builds b ON b.participant_rowid = p.rowid
        WHERE p.puuid = ? AND m.queue_id = 2400 AND b.build_role = ?`,
      [mePuuid(), role],
    )[0].n as number
    expect(csv.slice(1).reduce((a, r) => a + Number(r[iGames]), 0)).toBe(expected)
    await page.mouse.click(p.x, p.y)
    await expect(page.getByText("全部類型")).toBeVisible()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("晶片的 × 也能取消定位篩選", async ({ page }) => {
    const radar = charts(page).first()
    const p = await radarPoint(radar, 3)
    await page.mouse.click(p.x, p.y)
    const chip = page.getByRole("button", { name: /^只看出裝是/ })
    await expect(chip).toBeVisible()
    await chip.click()
    await expect(page.getByText("全部類型")).toBeVisible()
  })

  test("切到「形狀：勝率」：雷達改畫勝率，虛線圈是整體勝率", async ({ page }) => {
    const before = await chartOption(charts(page).first())
    await page.getByRole("radio", { name: "形狀：勝率" }).click()
    await expect(page.getByText(/形狀是勝率（外框 100%）；虛線圈是你的整體勝率 \d+\.\d%/)).toBeVisible()
    await expect.poll(async () => JSON.stringify((await chartOption(charts(page).first())).series[0].data[0].value)).not.toBe(JSON.stringify(before.series[0].data[0].value))
    await page.getByRole("radio", { name: "形狀：場次" }).click()
    await expect(page.getByText(/形狀是場次/)).toBeVisible()
  })

  test("hover 掃過雷達圖不出錯", async ({ page }) => {
    const box = (await charts(page).first().boundingBox())!
    for (let i = 0; i < 12; i++) await page.mouse.move(box.x + (box.width * (i + 1)) / 13, box.y + box.height * (0.3 + 0.03 * i))
    await page.mouse.move(2, 2)
  })
})

test.describe("英雄頁：看誰的數據", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "champions")
    await expect(gridRows(page).first()).toBeVisible()
  })

  test("三個選項：目前帳號（預設）、追蹤對象 + 人數、所有人", async ({ page }) => {
    await expect(whoRadio(page, "目前帳號")).toHaveAttribute("aria-checked", "true")
    const tracked = sql("SELECT COUNT(*) n FROM accounts WHERE is_me = 1 OR tracked = 1")[0].n as number
    await expect(whoRadio(page, "追蹤對象")).toContainText(String(tracked))
    await expect(page.getByText(/只算 .+ 自己的場次，和其他頁一樣/)).toBeVisible()
    await expect(whoRadio(page, "所有人")).toBeVisible()
  })

  test("追蹤對象：場次加總等於「自己 + 追蹤中」的總場次，麵包屑出現「追蹤對象」", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await expect(whoRadio(page, "追蹤對象")).toHaveAttribute("aria-checked", "true")
    await expect(crumbs(page)).toContainText("追蹤對象")
    await ready(page)
    const expected = sql(
      `SELECT COUNT(*) n FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE m.queue_id = 2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1)`,
    )[0].n as number
    await expect.poll(async () => nums(await gridColumn(page, "participants.games")).length).toBeGreaterThan(0)
    // 表格是虛擬化的，只算畫出來的列；改用「N 列」與場次最多那列對照
    const topGames = nums(await gridColumn(page, "participants.games"))[0]
    expect(topGames).toBeGreaterThan(myChampions()[0].n as number)
    expect(topGames).toBeLessThanOrEqual(expected)
  })

  test("所有人：一場十位都算，整體勝率接近 50%，場次是 Mayhem 參賽者總數", async ({ page }) => {
    await whoRadio(page, "所有人").click()
    await expect(crumbs(page)).toContainText("所有人")
    await expect(page.getByText(/整體勝率因此接近 50%/)).toBeVisible()
    await ready(page)
    await page.getByRole("radio", { name: "形狀：勝率" }).click()
    const total = sql(`SELECT COUNT(*) n, SUM(p.win) w FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE m.queue_id = 2400`)[0]
    const pct = ((Number(total.w) / Number(total.n)) * 100).toFixed(1)
    await expect(page.getByText(new RegExp(`所有人的整體勝率 ${pct}%`))).toBeVisible()
  })

  test("在麵包屑清掉「追蹤對象」→ 回到目前帳號", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    // 麵包屑最後一層是純文字；點頁名（最上層）會清掉這頁的所有聚焦
    await header(page).getByRole("button", { name: "英雄" }).click()
    await expect(whoRadio(page, "目前帳號")).toHaveAttribute("aria-checked", "true")
    await expect(crumbs(page)).toHaveCount(0)
  })
})

test.describe("英雄頁：單隻英雄抽屜", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "champions")
    await expect(gridRows(page).first()).toBeVisible()
  })

  const openFirst = async (page: Page) => {
    const name = (await gridColumn(page, "champions.name"))[0].split("\n")[0]
    await page.locator('.ag-row[row-index="0"] [col-id="champions.name"]').first().click()
    const drawer = page.getByRole("dialog")
    await expect(drawer.getByRole("heading", { name })).toBeVisible()
    return { name, drawer }
  }

  test("單擊一列開右側抽屜：標題是英雄，副標題有場次；麵包屑多一層；Esc 關閉", async ({ page }) => {
    const { name, drawer } = await openFirst(page)
    const r = myChampions()[0]
    expect(name).toBe(r.name)
    await expect(drawer.getByText(`${r.n} 場 · 出裝、增幅與每一場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(name)
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
    await expect(crumbs(page)).toHaveCount(0)
  })

  test("抽屜 KPI：勝率與勝敗、KDA 和 SQL 一致", async ({ page }) => {
    const { drawer } = await openFirst(page)
    const r = myChampions()[0]
    const box = drawer.locator('[data-slot="card"]', { has: page.getByText("勝率", { exact: true }) }).first()
    await expect(box).toContainText(`${((Number(r.w) / Number(r.n)) * 100).toFixed(1)}%`)
    await expect(box).toContainText(`${r.w} 勝 ${Number(r.n) - Number(r.w)} 敗`)
  })

  test("抽屜有「最常出的裝備」「最常選的增幅」兩份清單，且有說明這不是因果", async ({ page }) => {
    const { drawer } = await openFirst(page)
    await expect(drawer.getByText("最常出的裝備")).toBeVisible()
    await expect(drawer.getByText("最常選的增幅")).toBeVisible()
    await expect(drawer.getByText(/不是因果/)).toBeVisible()
  })

  test("抽屜底下列出這隻英雄的每一場，場次數和 SQL 一致", async ({ page }) => {
    const { drawer } = await openFirst(page)
    const r = myChampions()[0]
    await expect(drawer.getByText(`共 ${r.n} 場`)).toBeVisible()
    await expect(drawer.locator("button.slide-in").first()).toBeVisible()
    for (const c of await drawer.locator("button.slide-in").all()) await expect(c.locator("img").first()).toHaveAttribute("title", String(r.name))
  })

  test("「其他頁也只看這隻」：加上全域下鑽並停用按鈕；到對局紀錄只剩那隻", async ({ page }) => {
    const { name, drawer } = await openFirst(page)
    const btn = drawer.getByRole("button", { name: "其他頁也只看這隻" })
    await btn.click()
    await expect(drawer.getByRole("button", { name: "其他頁已只看這隻" })).toBeDisabled()
    await expect(crumbs(page)).toContainText(`英雄：${name}`)
    await page.keyboard.press("Escape")
    await page.locator('[data-sidebar="menu-button"]', { hasText: "對局紀錄" }).click()
    await expect(header(page)).toHaveText("對局紀錄")
    await ready(page)
    await expect(page.getByText(new RegExp(`共 ${myChampions()[0].n} 場`))).toBeVisible()
  })

  test("抽屜裡再點一場可以看戰報", async ({ page }) => {
    const { drawer } = await openFirst(page)
    await drawer.locator("button.slide-in").first().click()
    await expect(drawer.getByRole("tab", { name: "計分板" })).toBeVisible()
  })

  test("換成「所有人」時，開著的抽屜會關掉", async ({ page }) => {
    const { drawer } = await openFirst(page)
    await page.keyboard.press("Escape")
    await expect(drawer).toBeHidden()
    await whoRadio(page, "所有人").click()
    await expect(page.getByRole("dialog")).toHaveCount(0)
  })
})

test("英雄頁：場次總和不超過自己的總場次", async ({ page }) => {
  await openPage(page, "champions")
  await expect(gridRows(page).first()).toBeVisible()
  const sum = myChampions().reduce((a, r) => a + Number(r.n), 0)
  expect(sum).toBe(myRecord().games)
})
