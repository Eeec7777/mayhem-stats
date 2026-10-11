import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openPage, ready } from "./helpers"
import { mePuuid, sql } from "./db"

const crumbs = (page: Page) => page.locator('nav[aria-label="目前位置"]')
const whoRadio = (page: Page, name: string) => page.getByRole("radio", { name: new RegExp(name) })
const facetRadio = (page: Page, name: string) => page.getByRole("radiogroup", { name: "比較的面向" }).getByRole("radio", { name })
const matrix = (page: Page) => page.locator("table").first()
/** 矩陣裡某一格（我方 × 敵方）。 */
const cell = (page: Page, mine: string, enemy: string) => matrix(page).locator(`button[title^="我方 ${mine} × 敵方 ${enemy}："]`)

const bucket = (n: number) => (n >= 3 ? "3 個以上" : `${n} 個`)
const mixOf = (ad: number, ap: number) => (ad - ap >= 2 ? "物理為主" : ap - ad >= 2 ? "魔法為主" : "混合")

/** 獨立算出：每場我方／敵方的前排數、物理魔法人數，再按對陣分組。 */
function lineupGames() {
  return sql(
    `WITH g AS (
       SELECT p.platform_id, p.game_id, p.team_id AS my, p.win
         FROM match_participants p JOIN matches m USING (platform_id, game_id) WHERE p.puuid = ? AND m.queue_id = 2400),
     t AS (
       SELECT q.platform_id, q.game_id, q.team_id,
              SUM(b.build_role = '坦克' OR b.build_role LIKE '%鬥士') AS front,
              SUM(b.build_role LIKE 'AD %') AS ad, SUM(b.build_role LIKE 'AP %') AS ap,
              SUM(b.build_role = '輔助') AS sup
         FROM match_participants q LEFT JOIN mat_builds b ON b.participant_rowid = q.rowid
        GROUP BY q.platform_id, q.game_id, q.team_id)
     SELECT g.game_id, g.win, mt.front AS mf, et.front AS ef, mt.ad AS mad, mt.ap AS map_, et.ad AS ead, et.ap AS eap
       FROM g JOIN t mt ON mt.platform_id = g.platform_id AND mt.game_id = g.game_id AND mt.team_id = g.my
              JOIN t et ON et.platform_id = g.platform_id AND et.game_id = g.game_id AND et.team_id <> g.my`,
    [mePuuid()],
  ).map((r) => ({
    win: Number(r.win),
    mf: bucket(Number(r.mf)),
    ef: bucket(Number(r.ef)),
    mm: mixOf(Number(r.mad), Number(r.map_)),
    em: mixOf(Number(r.ead), Number(r.eap)),
  }))
}

const tally = <T,>(rows: T[], key: (r: T) => string, win: (r: T) => number) => {
  const m = new Map<string, { n: number; w: number }>()
  for (const r of rows) {
    const c = m.get(key(r)) ?? { n: 0, w: 0 }
    m.set(key(r), { n: c.n + 1, w: c.w + win(r) })
  }
  return m
}

/** 森林圖的一列（GapForest）：data-games / data-wins 是那一組的場次與勝場 */
const gapRow = (scope: Locator, label: string) => scope.getByTestId("gap-row").filter({ has: scope.page().getByText(label, { exact: true }) })
const sidePanel = (page: Page) => page.locator('[data-slot="card"]', { has: page.getByText("拆開看：各項陣容條件", { exact: true }) })
const buildPanel = (page: Page) => page.locator('[data-slot="card"]', { has: page.getByText("這種陣容下出什麼裝", { exact: true }) })
/** 一邊（我方／敵方）的那一欄 */
const sideColumn = (page: Page, title: RegExp) => sidePanel(page).locator("div.space-y-2", { has: page.getByText(title) }).first()
const expandMatrix = async (page: Page) => {
  await page.getByRole("button", { name: "展開矩陣" }).click()
  await expect(matrix(page)).toBeVisible()
}

async function expectRow(row: Locator, v: { n: number; w: number } | undefined, label: string) {
  await expect(row, label).toHaveAttribute("data-games", String(v?.n ?? 0))
  await expect(row, label).toHaveAttribute("data-wins", String(v?.w ?? 0))
}

test.describe("陣容頁：什麼陣容比較會贏", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(sidePanel(page).getByTestId("gap-row").first()).toBeVisible()
  })

  test("我方與敵方各三組（前排數、輸出組成、輔助），每一列的場次與勝場和獨立 SQL 一致", async ({ page }) => {
    const games = lineupGames()
    const mine = sideColumn(page, /^我方（含你自己）$/)
    const theirs = sideColumn(page, /^敵方$/)
    for (const [b, v] of tally(games, (g) => g.mf, (g) => g.win)) await expectRow(gapRow(mine, `前排 ${b}`), v, `我方前排 ${b}`)
    for (const [b, v] of tally(games, (g) => g.ef, (g) => g.win)) await expectRow(gapRow(theirs, `前排 ${b}`), v, `敵方前排 ${b}`)
    for (const [b, v] of tally(games, (g) => g.mm, (g) => g.win)) await expectRow(gapRow(mine, b), v, `我方${b}`)
    for (const [b, v] of tally(games, (g) => g.em, (g) => g.win)) await expectRow(gapRow(theirs, b), v, `敵方${b}`)
    // 每一組加總 = 總場次
    const front = await mine.getByTestId("gap-row").evaluateAll((els) => els.slice(0, 4).reduce((a, e) => a + Number(e.getAttribute("data-games")), 0))
    expect(front).toBe(games.length)
  })

  test("說明文字：整體勝率與前排的定義；最上面一句寫出看得出差別的組（或寫明目前沒有）", async ({ page }) => {
    const games = lineupGames()
    const base = (100 * games.reduce((a, g) => a + g.win, 0)) / games.length
    await expect(sidePanel(page).getByText(new RegExp(`比整體 ${base.toFixed(1)}% 高或低`))).toBeVisible()
    await expect(page.getByText(/前排＝出裝是坦克、AD 鬥士或 AP 鬥士的人/)).toBeVisible()
    await expect(sidePanel(page).getByText(/^看得出差別的：|^目前沒有任何一種陣容看得出差別/)).toBeVisible()
  })

  test("點一列 → 列出那種陣容的每一場，場次數一致、麵包屑多一層、列亮起；再點取消", async ({ page }) => {
    const [b, v] = [...tally(lineupGames(), (g) => g.mf, (g) => g.win)].sort((x, y) => y[1].n - x[1].n)[0]
    const row = gapRow(sideColumn(page, /^我方（含你自己）$/), `前排 ${b}`)
    await row.click()
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`我方前排 ${b} 的每一場`) })
    await expect(drill.getByText(`共 ${v.n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(`我方前排 ${b}`)
    await expect(row).toHaveClass(/ring-primary/)
    await row.click()
    await expect(drill).toHaveCount(0)
    await expect(crumbs(page)).toHaveCount(0)
  })
})

test.describe("陣容頁：這種陣容下出什麼裝", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(buildPanel(page).getByTestId("gap-row").first()).toBeVisible()
  })

  /** 自己每場的出裝定位與隊友前排數（不含自己）、敵方前排數 */
  const myBuilds = () =>
    sql(
      `WITH g AS (
         SELECT p.platform_id, p.game_id, p.team_id, p.participant_id, p.win, b.build_role AS role
           FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN mat_builds b ON b.participant_rowid = p.rowid
          WHERE p.puuid = ? AND m.queue_id = 2400)
       SELECT g.role, g.win,
              (SELECT COUNT(*) FROM match_participants q JOIN mat_builds b ON b.participant_rowid = q.rowid
                WHERE q.platform_id = g.platform_id AND q.game_id = g.game_id AND q.team_id = g.team_id AND q.participant_id <> g.participant_id
                  AND (b.build_role = '坦克' OR b.build_role LIKE '%鬥士')) AS ally_front,
              (SELECT COUNT(*) FROM match_participants q JOIN mat_builds b ON b.participant_rowid = q.rowid
                WHERE q.platform_id = g.platform_id AND q.game_id = g.game_id AND q.team_id <> g.team_id
                  AND (b.build_role = '坦克' OR b.build_role LIKE '%鬥士')) AS enemy_front
         FROM g`,
      [mePuuid()],
    ).map((r) => ({ role: String(r.role), win: Number(r.win), af: Number(r.ally_front), ef: Number(r.enemy_front) }))

  test("預設「隊友前排數」：三欄（0 個、1 個、2 個以上），每一格的場次與勝場和 SQL 一致", async ({ page }) => {
    await expect(buildPanel(page).getByRole("radio", { name: "隊友前排數" })).toHaveAttribute("aria-checked", "true")
    const cols = buildPanel(page).getByTestId("build-context")
    await expect(cols).toHaveCount(3)
    const b2 = (n: number) => (n >= 2 ? "2 個以上" : `${n} 個`)
    const cells = tally(myBuilds().filter((r) => r.role !== "未成形"), (r) => `${b2(r.af)}|${r.role}`, (r) => r.win)
    for (const [i, b] of ["0 個", "1 個", "2 個以上"].entries()) {
      const col = cols.nth(i)
      await expect(col).toContainText(`隊友前排 ${b}`)
      for (const role of ["坦克", "AD 鬥士", "AD 近戰", "AD 刺客", "射手", "AP 輸出", "AP 刺客", "AP 鬥士", "輔助"]) {
        await expectRow(gapRow(col, role), cells.get(`${b}|${role}`), `隊友前排 ${b}・${role}`)
      }
    }
  })

  test("切到「敵方前排數」：四欄，每欄加總 = 那種敵方前排數的場次", async ({ page }) => {
    await buildPanel(page).getByRole("radio", { name: "敵方前排數" }).click()
    const cols = buildPanel(page).getByTestId("build-context")
    await expect(cols).toHaveCount(4)
    const rows = myBuilds().filter((r) => r.role !== "未成形")
    for (const [i, b] of ["0 個", "1 個", "2 個", "3 個以上"].entries()) {
      const n = rows.filter((r) => bucket(r.ef) === b).length
      await expect(cols.nth(i)).toContainText(`${n} 場`)
    }
  })

  test("三種分組：隊友前排數、敵方前排數、敵方輸出組成（不再有用實際傷害算的「傷害類型」）", async ({ page }) => {
    await expect(buildPanel(page).getByRole("radio")).toHaveText(["隊友前排數", "敵方前排數", "敵方輸出組成"])
  })

  test("點一格 → 列出那種情況下那樣出裝的每一場", async ({ page }) => {
    const b2 = (n: number) => (n >= 2 ? "2 個以上" : `${n} 個`)
    const cells = tally(myBuilds(), (r) => `${b2(r.af)}|${r.role}`, (r) => r.win)
    const [key, v] = [...cells].filter(([k]) => !k.endsWith("未成形")).sort((x, y) => y[1].n - x[1].n)[0]
    const [b, role] = key.split("|")
    const col = buildPanel(page).getByTestId("build-context").filter({ hasText: `隊友前排 ${b}` })
    await gapRow(col, role).click()
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`隊友前排 ${b}・${role} 的每一場`) })
    await expect(drill.getByText(`共 ${v.n} 場`)).toBeVisible()
  })
})

test.describe("陣容頁：細看對陣矩陣", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expandMatrix(page)
  })

  test("預設收起，展開後三種面向：前排數（預設）、輸出組成、輔助", async ({ page }) => {
    const group = page.getByRole("radiogroup", { name: "比較的面向" })
    await expect(group.getByRole("radio")).toHaveText(["前排數", "輸出組成", "輔助"])
    await expect(facetRadio(page, "前排數")).toHaveAttribute("aria-checked", "true")
    await page.getByRole("button", { name: "收起" }).click()
    await expect(page.locator("table")).toHaveCount(0)
  })

  test("前排數矩陣：每一格的場次、勝率和獨立 SQL 逐格一致", async ({ page }) => {
    const cells = tally(lineupGames(), (g) => `${g.mf}|${g.ef}`, (g) => g.win)
    expect(cells.size).toBeGreaterThan(3)
    for (const [key, v] of cells) {
      const [m, e] = key.split("|")
      const btn = cell(page, m, e)
      await expect(btn, `${m} × ${e}`).toHaveAttribute("title", `我方 ${m} × 敵方 ${e}：${v.n} 場 ${v.w} 勝`)
      await expect(btn).toContainText(`${Math.round((100 * v.w) / v.n)}%`)
    }
  })

  test("「我方合計」欄與「遇到的敵方合計」列 = 各格加總；總場次 = 自己的 Mayhem 場次", async ({ page }) => {
    const games = lineupGames()
    const mine = tally(games, (g) => g.mf, (g) => g.win)
    for (const [m, v] of mine) {
      await expect(matrix(page).locator(`button[title^="我方 ${m}（不論敵方）"]`)).toHaveAttribute("title", `我方 ${m}（不論敵方）：${v.n} 場 ${v.w} 勝`)
    }
    const theirs = tally(games, (g) => g.ef, (g) => g.win)
    for (const [e, v] of theirs) {
      await expect(matrix(page).locator(`button[title^="敵方 ${e}（不論我方）"]`)).toHaveAttribute("title", `敵方 ${e}（不論我方）：${v.n} 場 ${v.w} 勝`)
    }
    expect([...mine.values()].reduce((a, v) => a + v.n, 0)).toBe(games.length)
  })

  test("輸出組成矩陣：物理為主／混合／魔法為主，逐格和 SQL 一致", async ({ page }) => {
    await facetRadio(page, "輸出組成").click()
    const cells = tally(lineupGames(), (g) => `${g.mm}|${g.em}`, (g) => g.win)
    for (const [key, v] of cells) {
      const [m, e] = key.split("|")
      await expect(cell(page, m, e), `${m} × ${e}`).toHaveAttribute("title", `我方 ${m} × 敵方 ${e}：${v.n} 場 ${v.w} 勝`)
    }
  })

  test("點一格 → 列出那幾場，標題與場次數和格子一致；切換面向清掉聚焦", async ({ page }) => {
    const [key, v] = [...tally(lineupGames(), (g) => `${g.mf}|${g.ef}`, (g) => g.win)].sort((a, b) => b[1].n - a[1].n)[0]
    const [m, e] = key.split("|")
    await cell(page, m, e).click()
    const title = `我方前排 ${m} × 敵方前排 ${e}`
    const drill = page.locator('[data-slot="card"]', { has: page.getByText(`${title} 的每一場`) })
    await expect(drill.getByText(`共 ${v.n} 場`)).toBeVisible()
    await expect(crumbs(page)).toContainText(title)
    await facetRadio(page, "輸出組成").click()
    await expect(crumbs(page)).toHaveCount(0)
  })
})

test.describe("陣容頁：看誰的數據", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
  })

  test("所有人：只畫「一隊的陣容」一邊（敵方是鏡像），單位變「隊」；矩陣對稱", async ({ page }) => {
    await whoRadio(page, "所有人").click()
    await expect(crumbs(page)).toContainText("所有人")
    await ready(page)
    await expect(sidePanel(page).getByText("一隊的陣容", { exact: true })).toBeVisible()
    await expect(sidePanel(page).getByText("敵方", { exact: true })).toHaveCount(0)
    await expect(page.getByText(/敵方就是我方的鏡像/)).toBeVisible()
    await expandMatrix(page)
    await expect(matrix(page).locator("button").first()).toContainText("隊")
    const titles = await matrix(page).locator('tbody button[title*=" × 敵方 "]').evaluateAll((els) =>
      els.map((e) => ({ t: e.getAttribute("title")!, text: (e as HTMLElement).innerText })),
    )
    const wrOf = new Map(titles.map((x) => [x.t.split("：")[0], Number(x.text.match(/(\d+)%/)![1])]))
    let checked = 0
    for (const [k, v] of wrOf) {
      const m = k.match(/^我方 (.+) × 敵方 (.+)$/)!
      const opposite = wrOf.get(`我方 ${m[2]} × 敵方 ${m[1]}`)
      if (opposite === undefined) continue
      expect(Math.abs(v + opposite - 100), k).toBeLessThanOrEqual(1)
      checked++
    }
    expect(checked).toBeGreaterThan(2)
  })

  test("追蹤對象：同一隊只算一次（前排數各組加總 = 有追蹤對象的不重複隊伍數）", async ({ page }) => {
    await whoRadio(page, "追蹤對象").click()
    await ready(page)
    const teams = sql(
      `SELECT COUNT(*) n FROM (SELECT DISTINCT p.platform_id, p.game_id, p.team_id FROM match_participants p JOIN matches m USING (platform_id, game_id)
        WHERE m.queue_id = 2400 AND p.puuid IN (SELECT puuid FROM accounts WHERE is_me = 1 OR tracked = 1))`,
    )[0].n
    const mine = sideColumn(page, /^我方（含那位玩家自己）$/)
    const sum = await mine.getByTestId("gap-row").evaluateAll((els) => els.slice(0, 4).reduce((a, e) => a + Number(e.getAttribute("data-games")), 0))
    expect(sum).toBe(Number(teams))
  })
})

/** 全資料庫每一隊（兩隊都算）的陣容原型，獨立用 SQL 算：前排＝坦克／鬥士，輸出核心＝AD／AP 輸出與刺客 */
function allTeams() {
  const rows = sql(
    `SELECT p.platform_id, p.game_id, p.team_id, MAX(p.win) AS win,
            SUM(b.build_role = '坦克' OR b.build_role LIKE '%鬥士') AS front,
            SUM(b.build_role IN ('射手', 'AD 近戰', 'AD 刺客', 'AP 輸出', 'AP 刺客')) AS carry
       FROM match_participants p JOIN matches m USING (platform_id, game_id) JOIN mat_builds b ON b.participant_rowid = p.rowid
      WHERE m.queue_id = 2400 GROUP BY p.platform_id, p.game_id, p.team_id`,
  )
  return rows.map((r) => ({
    game: `${r.platform_id}:${r.game_id}`,
    win: Number(r.win),
    arch: Number(r.front) >= 3 ? "前排重" : Number(r.carry) >= 4 ? "輸出多" : "均衡",
  }))
}

/** Šidák 校正後 k = 3 的雙尾 z（α = 1 − 0.95^(1/3) ≈ 0.01695） */
const Z3 = 2.3940

function wilsonZ(x: number, n: number, z: number): [number, number] {
  const p = x / n
  const d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [(c - h) * 100, (c + h) * 100]
}

test.describe("陣容頁：陣容強弱（原型）", () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, "lineups")
    await expect(page.getByTestId("archetype-row").first()).toBeVisible()
  })
  const rows = (page: Page) => page.getByTestId("archetype-row")

  test("三種原型：前排重、均衡、輸出多；每列的隊數與勝場和獨立 SQL 一致（兩隊都算）", async ({ page }) => {
    const teams = allTeams()
    await expect(rows(page)).toHaveCount(3)
    for (const [i, arch] of ["前排重", "均衡", "輸出多"].entries()) {
      const mine = teams.filter((t) => t.arch === arch)
      await expect(rows(page).nth(i), arch).toContainText(arch)
      await expect(rows(page).nth(i), arch).toHaveAttribute("data-games", String(mine.length))
      await expect(rows(page).nth(i), arch).toHaveAttribute("data-wins", String(mine.reduce((a, t) => a + t.win, 0)))
    }
    // 兩隊都算：所有隊伍合起來勝率必然是 50%
    expect(teams.reduce((a, t) => a + t.win, 0) / teams.length).toBeCloseTo(0.5, 2)
  })

  test("資料判定：強勢／不強勢要區間（Šidák 校正）整段在 50% 同一邊；差 3pp 以上寫偏強／偏弱，其餘看不出", async ({ page }) => {
    const teams = allTeams()
    const base = (100 * teams.reduce((a, t) => a + t.win, 0)) / teams.length
    for (const [i, arch] of ["前排重", "均衡", "輸出多"].entries()) {
      const mine = teams.filter((t) => t.arch === arch)
      const x = mine.reduce((a, t) => a + t.win, 0)
      const [lo, hi] = wilsonZ(x, mine.length, Z3)
      const diff = (100 * x) / mine.length - base
      const expected = lo > base ? "強勢" : hi < base ? "不強勢" : diff >= 3 ? "偏強" : diff <= -3 ? "偏弱" : "看不出"
      await expect(rows(page).nth(i), arch).toHaveAttribute("data-verdict", expected)
    }
  })

  test("對決實測：一場裡只有一邊是這種原型時，這一邊贏幾場，和獨立計算一致", async ({ page }) => {
    const teams = allTeams()
    const byGame = new Map<string, typeof teams>()
    for (const t of teams) byGame.set(t.game, [...(byGame.get(t.game) ?? []), t])
    for (const arch of ["前排重", "均衡", "輸出多"]) {
      let n = 0
      let x = 0
      for (const g of byGame.values()) {
        const hit = g.filter((t) => t.arch === arch)
        if (hit.length === 1 && g.length === 2) {
          n++
          x += hit[0].win
        }
      }
      await expect(page.getByTestId("archetype-paired")).toContainText(`${arch} ${x}/${n}（${Math.round((100 * x) / n)}%`)
    }
  })

  test("每列有「常理預期」，不是只列資料", async ({ page }) => {
    await expect(rows(page).nth(0)).toContainText("預期偏弱")
    await expect(rows(page).nth(1)).toContainText("預期偏強")
    await expect(rows(page).nth(2)).toContainText("沒有預期")
  })

  test("切到「所有人」只剩一欄（所有隊伍），沒有「你們」那欄", async ({ page }) => {
    await page.getByRole("radio", { name: /所有人/ }).click()
    await expect(page.getByText("你們（目前範圍）")).toHaveCount(0)
    await expect(rows(page)).toHaveCount(3)
  })
})
