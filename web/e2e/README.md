# 端對端測試（Playwright）

打在**已經在跑的本機服務**（預設 `http://127.0.0.1:5057`）上，用真實資料驗證每個頁面的功能。
瀏覽器用本機的 Edge，不必另外下載 Chromium。

```bash
cd web
npm run test:e2e                         # 全部（約 14 分鐘，2 個 worker）
npx playwright test dashboard            # 只跑某一個檔案
npx playwright test -g "點某一軸"          # 只跑名稱符合的測試
npm run test:e2e:report                  # 開 HTML 報告（失敗時有截圖與 trace）
npm run typecheck:e2e                    # 測試本身的型別檢查（Playwright 執行時不檢查型別）
```

環境變數：`E2E_BASE_URL`（換位址）、`E2E_CHANNEL`（`chrome` 改用 Chrome）、`E2E_WORKERS`（並行數，預設 2；
圖表頁很吃 CPU，開太多會互搶、服務變慢）、`E2E_PYTHON`（對照用的 Python）。

## 跑之前

- 服務要開著，Cube 要查得動（`e2e/global-setup.ts` 會檢查，不通就直接說明原因，不會讓每個測試各自逾時）。
- 前端改了要先 `npm run build`——服務讀的是 `web/dist`，不是原始碼。
- 資料庫裡要有自己的 Mayhem 對局。**測試讀的是真實資料**：對照的數字都是現算的，不寫死場次或勝率，
  所以資料變多不會壞；但是**測試進行中剛好採集到新對局**，少數數字（總場次）會差一場，重跑一次即可。

## 怎麼驗證數字

照 `verify-change` skill 的規則：Cube 算出來的東西不能只看它自己。`e2e/oracle.py` 以**唯讀**方式直接讀 `mayhem.db`，
測試用 `db.ts` 的 `sql()` 自己寫 SQL 算同一件事再比（陣容矩陣、好友比較的陣容情境、節奏頁的「一輪」等
有視窗函數或分類規則的指標，是在測試裡用 TypeScript 獨立重寫一遍規則來比）。

圖表是 canvas，DOM 裡看不到資料。`ResponsiveChart` 把 ECharts 實例掛在外層 div 的 `__chart`，
`helpers.ts` 靠它讀出實際畫的資料（`chartOption`）、換算像素位置去點（`chartPoint`、`clickBar`、`radarPoint`）。

## 不會動到真實資料

`fixtures.ts` 把所有 POST/PUT/PATCH/DELETE 攔下來回假的成功（採集、追蹤、綁定帳號都不會真的發生），
並記錄在 `writes` 裡，要驗證「按下去會送出什麼」的測試直接檢查它。
`api.spec.ts` 裡直接打後端的寫入請求只有「一定會被拒絕」的錯誤路徑。

每個測試結束時還會檢查：頁面沒有未捕捉的例外、沒有 4xx/5xx 的請求。

## 已知問題

標成 `test.fail(...)` 的測試是「目前確實壞著」的行為：測試照正確的行為寫，現在預期失敗，所以套件是綠的；
**問題修好之後它會「意外通過」而失敗**，提醒你把 `test.fail` 拿掉。

| 測試 | 問題 |
|---|---|
| `explore.spec.ts` 自訂篩選：玩家對局數 大於 10 | 指標當條件時 Cube 產生 `HAVING COUNT(...) > ?`，值以字串 `'10'` 綁定，SQLite 裡整數 > 文字恆為假，`gt` 一律 0 列（`lt` 一律全中） |
| `api.spec.ts` favicon.svg 載得到 | `app.py` 只把 `web/dist/assets` 掛在 `/assets`，`dist` 根目錄的 `favicon.svg`、`icons.svg` 回 404 |
| `smoke.spec.ts` 768px 寬：對局紀錄、陣容、好友比較 | 頁面橫向溢出 50～256px |

## 檔案

| 檔案 | 內容 |
|---|---|
| `shell` | 側邊欄、換頁、上一頁／下一頁、收合、手機版抽屜 |
| `global-filters` | 帳號切換（Ctrl+K）、模式、期間、八個主題 |
| `dashboard` `matches` `champions` `augments` `lineups` `players` `crew` `time` `tilt` `losses` `explore` `recap` `tracked` | 對應頁面的每個功能 |
| `api` | 後端 API 合約，以及 Cube 正式模式的存取控制 |
| `smoke` | 八個主題 × 圖表頁的 hover 掃描、窄螢幕溢出、無障礙基本功 |
| `fixtures.ts` `helpers.ts` `db.ts` `oracle.py` | 共用：攔截寫入與錯誤檢查、等待就緒／圖表／表格的工具、對照用 SQL |
