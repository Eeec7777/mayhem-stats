import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openPage, panel } from "./helpers"
import { sql } from "./db"

// 出裝計算機：數字和這裡另外手寫的公式對（不 import 前端的 calc.ts，否則等於自己對自己）。
// 公式：打進去比例 = 100 / (100 + 有效防禦)；有效防禦 = 防禦 × (1 − %穿透) − 固定穿透（不低於 0）。

const kpi = (page: Page, label: string) =>
  page.locator('[data-testid="calc-kpis"] [data-slot="card"]', { has: page.getByText(label, { exact: true }) }).locator(".font-mono").first()

const field = (page: Page, panelTitle: string, label: string) => panel(page, panelTitle).getByLabel(label, { exact: true })

/** 普攻 + 技能的一波傷害（只有物理、沒有被動時），和預設的「普攻射手」一致。 */
function physBurst(o: { ad: number; as: number; crit: number; critDmg: number; haste: number; armor: number; armorPenPct?: number; lethality?: number }) {
  const seconds = 6, autoShare = 0.9, cd = 8, basePhys = 200, adRatio = 1
  const autos = o.as * seconds * autoShare
  const critF = 1 + (o.crit / 100) * (o.critDmg - 1)
  const casts = 1 + (seconds * (1 + o.haste / 100)) / cd
  const raw = autos * o.ad * critF + casts * (basePhys + adRatio * o.ad)
  const armor = Math.max(0, o.armor * (1 - (o.armorPenPct ?? 0) / 100) - (o.lethality ?? 0))
  return raw * (100 / (100 + armor))
}

test.describe("出裝計算機", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.removeItem("mayhem-calc")
      } catch {
        /* 存不了就是預設值 */
      }
    })
    await openPage(page, "calc")
    await expect(page.getByTestId("calc-top-pick")).toBeVisible()
  })

  test("預設面板：一波傷害、打進去的比例與有效生命，和手算一致", async ({ page }) => {
    const dmg = physBurst({ ad: 160, as: 1.1, crit: 25, critDmg: 1.75, haste: 10, armor: 85 })
    await expect(kpi(page, "一波傷害")).toHaveText(Math.round(dmg).toLocaleString())
    await expect(kpi(page, "打掉對手生命")).toHaveText(`${((dmg / 2300) * 100).toFixed(0)}%`)
    await expect(kpi(page, "實際打進去")).toHaveText(`${Math.round(10000 / 185)}% / ${Math.round(10000 / 155)}%`)
    // 對方 50% 物理、45% 魔法、5% 真實；我 1900 生命、70 物防、45 魔防
    const ehp = 1900 / (0.5 * (100 / 170) + 0.45 * (100 / 145) + 0.05)
    await expect(kpi(page, "你的有效生命")).toHaveText(Math.round(ehp).toLocaleString())
  })

  test("改面板會重算：物攻 200、物理致命 18", async ({ page }) => {
    await field(page, "我的面板", "物攻").fill("200")
    await field(page, "我的面板", "物理致命").fill("18")
    const dmg = physBurst({ ad: 200, as: 1.1, crit: 25, critDmg: 1.75, haste: 10, armor: 85, lethality: 18 })
    await expect(kpi(page, "一波傷害")).toHaveText(Math.round(dmg).toLocaleString())
  })

  test("裝備效益：無盡之刃的整件提升和手算一致", async ({ page }) => {
    const base = physBurst({ ad: 160, as: 1.1, crit: 25, critDmg: 1.75, haste: 10, armor: 85 })
    const withIe = physBurst({ ad: 235, as: 1.1, crit: 50, critDmg: 2.05, haste: 10, armor: 85 })
    const gain = (withIe / base - 1) * 100
    const row = page.locator(".ag-row", { hasText: "無盡之刃" }).first()
    await page.getByPlaceholder("快速搜尋所有欄位…").fill("無盡之刃")
    await expect(row).toContainText(`+${(gain / 3.5).toFixed(1)}%`)
    await expect(row).toContainText(`整件 +${gain.toFixed(1)}%`)
  })

  test("候選裝備：大亂鬥買過 5 次以上、商店買得到的完整裝備，和 SQL 一致", async ({ page }) => {
    const expected = sql(
      `SELECT i.id, i.name, i.price_total AS price,
              EXISTS (SELECT 1 FROM dim_item_categories c WHERE c.item_id = i.id AND c.category = 'Boots') AS boots
         FROM participant_items pi JOIN matches m USING (platform_id, game_id) JOIN dim_items i ON i.id = pi.item_id
        WHERE m.queue_id = 2400 AND i.price_total > 0 AND i.id < 200000
        GROUP BY i.id HAVING COUNT(*) >= 5`,
    )
    const catalog = await (await page.request.get("/api/calc/catalog")).json()
    expect(catalog.items.map((i: { id: number }) => i.id).sort()).toEqual(expected.map((r) => Number(r.id)).sort())
    // 「完整裝備」= 2200 金以上，或鞋子（300 金的基本鞋除外）。預設面板是純物理打法，
    // 只有帶物理／坦度屬性、或被動會影響物理傷害的裝備才有提升，其餘（純魔攻、魔力）提升是 0、不列
    const useful = new Set(
      sql(
        `SELECT DISTINCT item_id FROM dim_item_stats WHERE value > 0 AND stat IN
           ('AttackDamage','AttackSpeed','CritChance','CritDamage','Lethality','ArmorPenetration','AbilityHaste','Health','Armor','MagicResist')`,
      ).map((r) => Number(r.item_id)),
    )
    // 被動會造成傷害、但數值欄沒有物理或坦度屬性的（雷霆風暴只有魔攻與跑速，引爆傷害照樣算）
    for (const id of [6653, 4633, 3036, 6676, 3071, 3302, 3124, 3084, 3161, 4646]) useful.add(id)
    const full = expected.filter((r) => (Number(r.price) >= 2200 || (Number(r.boots) && Number(r.price) > 300)) && useful.has(Number(r.id)))
    await expect(page.getByText(/^\d+ 列$/).first()).toHaveText(`${full.length} 列`)
  })

  test("身上已有的裝備不再列為候選", async ({ page }) => {
    const toolbar = page.getByText(/^\d+ 列$/).first()
    const before = Number((await toolbar.textContent())!.split(" ")[0])
    await page.getByRole("button", { name: /加裝備/ }).click()
    await page.getByPlaceholder("搜尋名稱…").fill("無盡之刃")
    await page.getByRole("option", { name: /無盡之刃/ }).click()
    await expect(page.getByTestId("calc-owned")).toContainText("無盡之刃")
    await expect(toolbar).toHaveText(`${before - 1} 列`)
    await page.getByPlaceholder("快速搜尋所有欄位…").fill("無盡之刃")
    await expect(page.locator(".ag-row", { hasText: "無盡之刃" })).toHaveCount(0)
  })

  test("身上的被動會算進去：死亡之帽讓之後的魔攻多 30%", async ({ page }) => {
    // 爆發法師：一輪 750 + 2.2 魔攻，冷卻 7 秒、5 秒、10% 普攻；魔攻 300、魔防 55
    await page.getByRole("button", { name: "爆發法師" }).click()
    await field(page, "我的面板", "魔攻").fill("300")
    const mage = (ap: number) => {
      const casts = 1 + (5 * 1.1) / 7
      const autos = 1.1 * 5 * 0.1
      return (autos * 160 * 1.1875 * 100) / 185 + (casts * (750 + 2.2 * ap) * 100) / 155
    }
    const base = mage(300)
    const perK = (ap: number) => (((mage(ap) / base - 1) * 100) / 400) * 1000
    const steps = page.getByTestId("calc-stat-steps")
    // +20 魔攻的那一列：每千金 = 提升 ÷ 400 金 × 1000
    await expect(steps.locator("li", { hasText: "+20 魔攻" })).toContainText(`+${perK(320).toFixed(1)}%`)
    await page.getByRole("button", { name: /加裝備/ }).click()
    await page.getByPlaceholder("搜尋名稱…").fill("死亡之帽")
    await page.getByRole("option", { name: /死亡之帽/ }).click()
    // 面板 300 已含死亡之帽；再加 20 魔攻會變成 26
    await expect(steps.locator("li", { hasText: "+20 魔攻" })).toContainText(`+${perK(326).toFixed(1)}%`)
  })

  test("耀光類被動：三相之力 = 數值 + 技能後普攻 200% 基礎物攻，和手算一致", async ({ page }) => {
    // 預設：11 級近戰、普攻射手（6 秒、90% 普攻、冷卻 8、一輪 200 + 1.0 物攻）、對手 85 物防
    const g = 10 * (0.7025 + 0.0175 * 10)
    const baseAd = 60 + 3.4 * g
    const fight = (ad: number, as: number, haste: number, spellblade: boolean) => {
      const autos = as * 6 * 0.9
      const casts = 1 + (6 * (1 + haste / 100)) / 8
      const procs = spellblade ? Math.min(casts, autos, 1 + 6 / 1.5) : 0
      const raw = autos * ad * (1 + 0.25 * 0.75) + casts * (200 + ad) + procs * 2 * baseAd
      return (raw * 100) / 185
    }
    // 三相之力：36 物攻、30% 攻速（× 成長 0.65）、15 技能加速
    const gain = (fight(196, 1.1 + 0.65 * 0.3, 25, true) / fight(160, 1.1, 10, false) - 1) * 100
    await page.getByPlaceholder("快速搜尋所有欄位…").fill("三相之力")
    await expect(page.locator(".ag-row", { hasText: "三相之力" }).first()).toContainText(`整件 +${gain.toFixed(1)}%`)
  })

  test("命脈護盾算進有效生命：不朽盾弓 11 級近戰 400 + 30 × 3", async ({ page }) => {
    const taken = 0.5 * (100 / 170) + 0.45 * (100 / 145) + 0.05
    const gain = (((1900 + 490) / taken) / (1900 / taken) - 1) * 100
    await page.getByPlaceholder("快速搜尋所有欄位…").fill("不朽盾弓")
    await expect(page.locator(".ag-row", { hasText: "不朽盾弓" }).first()).toContainText(`整件 +${gain.toFixed(1)}%`)
    // 切成遠程：護盾 ×0.8
    await panel(page, "我的面板").getByRole("radio", { name: "遠程" }).click()
    const rangedGain = (((1900 + 490 * 0.8) / taken) / (1900 / taken) - 1) * 100
    await expect(page.locator(".ag-row", { hasText: "不朽盾弓" }).first()).toContainText(`整件 +${rangedGain.toFixed(1)}%`)
  })

  test("從對局帶入：面板、身上的裝備、敵人清單與估出來的對手雙防", async ({ page }) => {
    await page.route("**/api/calc/live", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          inGame: true,
          level: 13,
          stats: { ad: 250, ap: 0, attackSpeed: 1.4, critChance: 50, critDamage: 2.05, lethality: 0, armorPenPct: 0, magicPen: 0, magicPenPct: 0, haste: 0, hp: 2100, armor: 90, mr: 60 },
          players: [
            { champion: "Jinx", championName: "吉茵珂絲", icon: null, level: 13, isMe: true, ally: true, items: [3031] },
            { champion: "Garen", championName: "蓋倫", icon: null, level: 12, isMe: false, ally: false, items: [3075] },
          ],
        }),
      }),
    )
    await page.getByRole("button", { name: "從對局帶入" }).click()
    await expect(field(page, "我的面板", "物攻")).toHaveValue("250")
    await expect(page.getByTestId("calc-owned")).toContainText("無盡之刃")
    await expect(page.getByTestId("calc-live")).toContainText("蓋倫")
    // 對手 12 級：一般英雄基礎物防 32 + 4.7 × 成長，加上荊棘之甲 75 物防、150 生命
    const g = 11 * (0.7025 + 0.0175 * 11)
    await expect(field(page, "對手", "物防")).toHaveValue(String(Math.round(32 + 4.7 * g + 75)))
    await expect(field(page, "對手", "生命")).toHaveValue(String(Math.round(640 + 105 * g + 150)))
  })

  test("不在對局中：說明讀不到，面板不動", async ({ page }) => {
    await page.route("**/api/calc/live", (route) => route.fulfill({ contentType: "application/json", body: '{"inGame":false}' }))
    await page.getByRole("button", { name: "從對局帶入" }).click()
    await expect(page.getByTestId("calc-live")).toContainText("現在不在對局中")
    await expect(field(page, "我的面板", "物攻")).toHaveValue("160")
  })
})
