import { defineConfig } from "@playwright/test"

// 端對端測試跑在「已經在跑的本機服務」上（預設 http://127.0.0.1:5057），用真實資料驗證畫面與互動。
// 不另外啟動服務：採集器、Cube 都是長駐行程，由排程工作管（見 verify-change skill）。
// 瀏覽器用本機的 Edge，不必另外下載 Chromium。想換 Chrome：E2E_CHANNEL=chrome。
// 要測別的位址（例如 Vite 開發伺服器）：E2E_BASE_URL=http://127.0.0.1:5173。
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  globalSetup: "./e2e/global-setup.ts",
  // Cube 第一次查詢可能要算幾秒；圖表與表格要等查詢回來才會出現
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // 圖表頁很吃 CPU（verify-change：同時開太多 Edge 會互搶），並行度不要開太高
  workers: Number(process.env.E2E_WORKERS ?? 2),
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5057",
    channel: process.env.E2E_CHANNEL ?? "msedge",
    viewport: { width: 1500, height: 1000 },
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
})
