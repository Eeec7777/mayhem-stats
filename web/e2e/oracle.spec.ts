import { test, expect } from "./fixtures"
import { myRecord, mePuuid, sql } from "./db"

// 對照用的資料來源本身要先確定能用：後面所有「數字跟 SQL 對得上」的測試都靠它
test("獨立 SQL 對照可用，且和 /api/status 的場次一致", async ({ page }) => {
  const status = await (await page.request.get("/api/status")).json()
  expect(mePuuid()).toMatch(/^[0-9a-f-]{36}$/)
  expect(myRecord().games).toBe(status.myMayhemMatches)
  expect(sql("SELECT 1 AS x")).toEqual([{ x: 1 }])
})
