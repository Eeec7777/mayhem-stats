import type { FullConfig } from "@playwright/test"

/** 測試吃的是真實服務與真實資料；服務沒開或資料庫是空的，與其讓每個測試各自逾時，不如一開始就講清楚。 */
export default async function globalSetup(config: FullConfig) {
  const base = config.projects[0].use.baseURL!
  let status: { myMayhemMatches?: number } | undefined
  try {
    status = await (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(10_000) })).json()
  } catch (e) {
    throw new Error(`連不到 ${base}。先把服務跑起來（uv run app.py，或啟動排程工作 MayhemStatsCollector）。\n${e}`)
  }
  if (!status?.myMayhemMatches) {
    throw new Error("資料庫裡沒有自己的 Mayhem 對局，端對端測試沒有東西可看。先採集一些資料。")
  }
  // Cube 要真的能回資料（/readyz 通過不代表查得動，見 verify-change）
  const q = encodeURIComponent(JSON.stringify({ measures: ["participants.games"] }))
  for (let i = 0; i < 40; i++) {
    const body = await (await fetch(`${base}/api/cube/load?query=${q}`)).json().catch(() => ({}))
    if (body.data) return
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error("Cube 一直沒有回資料，先確認語意層有起來。")
}
