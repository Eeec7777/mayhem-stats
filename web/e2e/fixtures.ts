import { test as base, expect, type Page, type Request } from "@playwright/test"

/** 一次測試裡被攔下來的寫入請求（POST / PUT / DELETE）。 */
export type BlockedWrite = { method: string; path: string; body: unknown }

type Fixtures = {
  /** 這次測試裡被攔下的寫入請求。需要驗證「按下去會送出什麼」的測試用。 */
  writes: BlockedWrite[]
}

const IGNORED_FAILURES = [
  // index.html 引用了不存在的 favicon.svg；不影響功能，另外處理
  /\/favicon\.svg$/,
]

/** 所有測試共用的 page：
 *  1. 寫入一律攔下、回假的成功。測試吃的是真實資料庫，不能真的去新增追蹤對象、綁帳號、觸發採集。
 *  2. 頁面有未捕捉的例外、或 API 回 4xx/5xx，測試就失敗——不然「圖表沒畫出來」之類的壞法會被漏掉。
 *  3. 固定主題（霓虹），避免上一輪測試留在 localStorage 的主題影響到這一輪。 */
export const test = base.extend<Fixtures>({
  writes: async ({}, use) => {
    await use([])
  },
  page: async ({ page, writes }, use) => {
    const pageErrors: string[] = []
    const failed: string[] = []
    page.on("pageerror", (e) => pageErrors.push(e.message))
    page.on("response", (r) => {
      if (r.status() >= 400 && !IGNORED_FAILURES.some((re) => re.test(r.url()))) failed.push(`${r.status()} ${r.request().method()} ${r.url()}`)
    })

    await page.addInitScript(() => {
      try {
        if (!localStorage.getItem("mayhem-theme")) localStorage.setItem("mayhem-theme", "neon")
      } catch {
        /* 無痕等情況存不了就算了 */
      }
    })

    await page.route("**/api/**", (route) => {
      const req: Request = route.request()
      if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method())) {
        let body: unknown = req.postData()
        try {
          body = JSON.parse(req.postData() ?? "null")
        } catch {
          /* 不是 JSON 就留原字串 */
        }
        writes.push({ method: req.method(), path: new URL(req.url()).pathname, body })
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
      }
      return route.fallback()
    })

    await use(page)

    expect(pageErrors, "頁面丟出未捕捉的例外").toEqual([])
    expect(failed, "有 API 請求失敗").toEqual([])
  },
})

export { expect }
export type { Page }
