---
name: ui-conventions
description: 這個專案前端的主題與動畫規範。只要動到 web/src 的畫面——新增或修改頁面、元件、圖表、顏色、動畫、主題——就必須先讀。內含：顏色只能用主題變數、圖表取色與 ECharts 的陷阱、新增主題的配色驗證、切頁不卡頓的動畫規則，以及對應的驗證腳本。
---

# 前端主題與動畫規範

這些規則每一條都來自實際踩過的坑，括號裡是當時量到或看到的結果。
改完要跑最後一節的驗證，不是看起來對就算數。

## 一、主題

### 結構

- 主題定義在 `web/src/index.css`，以 `<html data-theme="...">` 切換；清單與分組在 `web/src/lib/theme.tsx`。
- 兩大類各四種：**暗色**（霓虹 neon、終端 matrix、熔岩 lava、紫電 violet）、**亮色**（晨光 daylight、薄荷 mint、櫻花 sakura、沙丘 sand）。預設霓虹。
- 選擇存在 `localStorage`（`mayhem-theme`），切換時用 View Transition 交叉淡化。

### 顏色規則

1. **不准寫死顏色。** 一律用主題 token：Tailwind 的 `bg-card`、`text-muted-foreground`、`text-win`、`bg-icon-tile`……
   或 CSS 變數。寫死的 `#fff`、`rgba(255,255,255,.04)` 在亮色主題會直接看不見。
2. **語意 token 各司其職，不要混用：**
   | token | 用途 |
   |---|---|
   | `--primary` | 介面強調（選中、按鈕、平均線、焦點） |
   | `--win` / `--loss` | 發散配色的兩極：勝率高於／低於你的平均 |
   | `--data` | 單一系列資料（勝率走勢、場次長條、散布點）。刻意和勝敗不同色，才不會被讀成好壞 |
   | `--icon-tile` | 圖示底塊。增幅圖示是白色線條的透明圖，亮色主題也必須墊深色（沒墊的話白線直接消失） |
   | `--glow` / `--grid-line` | 頁面底的光暈與格線 |
3. **勝敗不用紅綠。** 紅綠色盲分不出來。現有每組兩極都是冷色對暖色。
4. **發散配色的中點是無彩的灰。** 用 `neutralGray()`，不要直接混主題的灰字色——霓虹的灰字偏藍，混出來的中性格和勝方藍色撞色。

### 出裝定位標籤

- 畫面上出現出裝定位（坦克、AD 鬥士、AD 刺客…）一律用 `components/RoleChip.tsx` 的 `<RoleChip>`，旁邊需要讀法時放 `<RoleLegend>`。
- 八種定位**不各給一個顏色**：8 色任兩色都分得開做不到（`validate_palette.js --pairs all` 色盲 ΔE 最低 1.6）。
  改成兩個編碼——顏色＝傷害類型（`--role-ad`／`--role-ap`／`--role-util` 三色，all-pairs 在八個主題都 PASS），
  框線＝站位（實心前排、虛線刺客、空心後排）。文字用前景色，不用定位色。
- 定位要從語意層查：`hooks/useBuildRoles.ts` 拿參賽者鍵（`participants.participant_key`）向 Cube 查，一批不超過 50 個鍵。
  不要在後端或前端另寫一份分類規則。

### 圖表（ECharts）取色

- 只能透過 `charts.tsx` 的 `useTheme()` 取色，它依主題名稱重算，切換主題時圖表才會跟著換。
- `cssVar()` 會先把顏色轉成 `rgba()`。**不要把 CSS 變數原值直接交給 ECharts**：原值可能是 `oklch()`，
  滑鼠移上去時 zrender 做 hover 內插解析失敗，拋出 `reading 'colorStops'`，接著的 click 事件不觸發
  （時段頁「點某天」在真實瀏覽器裡一直沒反應就是這個）。
- 半透明、漸層用 `alpha()`、`fade()`；座標軸用 `axisLabel()`、`splitLine()`；tooltip 用 `baseTooltip()`。
- 折線要自訂點的填色時，必須指定 `symbol: "circle"`。預設的 `emptyCircle` 會無視 `itemStyle.color` 一律填白。
- **不准兩組都顯示刻度的雙 y 軸。** 讀者會去比「長條頂端和折線誰高」，而那個比較沒有意義。
  兩個量級不同的指標，預設拆成上下兩個 grid 共用 x 軸；使用者要求合成一張時，照 `DailyChart` 的做法：
  主指標的軸往下多延伸一段留白（那段刻度文字不顯示），次指標用隱藏的軸（`show: false`）壓在那段留白裡，
  數值直接標在圖形上，不給第二組刻度。
- AG Grid 的配色在 `AgTable.tsx` 的 `useGridTheme()`，同樣依主題重算，亮色主題用 `colorSchemeLight`。

### 新增或修改一個主題

1. 在 `index.css` 複製一個同類（暗色或亮色）的區塊，改 `data-theme` 與所有變數——**每個變數都要給**，
   漏一個就會吃到預設主題的值。亮色主題要給深色的 `--icon-tile`。
2. 在 `theme.tsx` 的 `THEMES` 加一筆（`dark`、`swatch` 依序是底色、介面強調、勝、敗）。
3. **勝／敗／資料色必須跑 dataviz 驗證器**，不准憑感覺挑（載入 `dataviz` skill，腳本在它的 `scripts/`）：
   ```bash
   node scripts/validate_palette.js "<勝>,<敗>,<資料>" --mode dark --surface "<--card 的值>" --pairs all
   ```
   亮色主題用 `--mode light`。要全部 PASS；只允許「資料色 vs 勝或敗」的 WARN（它們不會出現在同一張圖），
   勝敗兩極之間必須 PASS。暗色的亮度帶是 L 0.48–0.67，太亮的霓虹色會被擋，調暗再試。
4. 跑下面的主題截圖腳本，暗色、亮色各至少看一個，確認圖示、資料點、熱力圖中性格都看得見。

## 二、動畫

動畫分兩種：**版面動畫**（卡片、清單、頁面怎麼出現）和**資料動畫**（數字怎麼跑、圖表怎麼長）。
只有淡入淡出太單調，資料要讓人看得出「從哪裡長上來」。

### 規則

1. **版面動畫只用 CSS，只動 `opacity` / `transform`。** 這兩個屬性在合成器執行緒跑，主執行緒被 AG Grid 或
   ECharts 卡住時動畫不會停。不要用 `motion` / JS 逐幀做進場效果
   （原本用 motion，實測英雄頁切換最長停一格 201ms，動畫跟著停）。
2. 用現成的 utility（定義在 `index.css`），錯開量用 `style={{ "--stagger": "…ms" }}` 給：
   | class | 用途 | 時長 |
   |---|---|---|
   | `page-enter` | 換頁（App 已套用，頁面不用自己加） | 200ms |
   | `rise` | 卡片由下浮現；`Kpi` / `Panel` 已內建，傳 `index` 會依序錯開（上限 240ms） | 280ms |
   | `slide-in` | 清單列由左滑入（對局卡片、最常用清單），每列錯開 30～40ms（上限 400ms） | 320ms |
   | `reveal` | 沒有自己資料動畫的內容（表格、逐場列表外框）從骨架換上時淡入 | 220ms |
   | `bar-grow` | 表格格子裡的迷你資料條從左邊長出（`scaleX`） | 600ms |
   | `drawer-in` / `drawer-overlay` | 右側詳細抽屜滑入 32px + 淡入／遮罩淡入（英雄頁點一列）。抽屜裡的重元件等滑完（300ms）再掛 | 280ms / 200ms |
   不要自己另寫時長。需要新的動畫就加 utility 並更新這張表。
3. **資料動畫可以用 JS，但有兩個條件**：等換頁進場動畫結束才開始（`useAfterPageEnter()`），
   而且**不准每一幀都 setState**（七個 KPI × 60 幀 = 420 次重新渲染）。現成的做法：
   | 對象 | 怎麼做 | 時長 |
   |---|---|---|
   | 數字（KPI、清單裡的場次與勝率） | `<CountUp text="45.3%" />`：從 0 或上一次的值跑到目標，逐幀直接改 textContent。字串裡多個數字會一起跑；時間、日期、區間（`21:00`、`0-5`）自動不跑 | 900ms，easeOutExpo |
   | 長條 | 從軸線長出、依序錯開（`animationDelay: (i) => stagger(i)`）；長條上的數字加 `label.valueAnimation: true` 跟著跑 | 900ms，每根錯開 45ms（上限 500ms） |
   | 折線 | 由左往右畫（ECharts 預設），比長條慢一點 | 1200ms |
   | 參考線（平均、50%） | `markLine.animationDelay` 設在主資料長到約 60～70% 時才出現 | 400ms |
   | 熱力圖格子 | 由左往右一欄一欄掃進來 | 500ms |
   | 散布點 | 從中心彈出（`backOut`）、依序錯開 | 700ms |
   時長常數在 `lib/motion.ts`（`COUNT_UP_MS`、`CHART_GROW_MS`、`STAGGER_MS`、`STAGGER_CAP_MS`），
   預設值由 `ResponsiveChart` 統一套上，個別圖表只加錯開和特例。資料更新（換篩選、換主題）走 450ms 的過渡，
   不重長一次，所以錯開一律加 `animationDelayUpdate: 0`。
4. **絕對不要無條件呼叫 ECharts 的 `chart.resize()`。** 它會把進行中的動畫直接跳到終點——
   原本 `onChartReady` 和 ResizeObserver 都無條件 resize，結果每張圖的生長動畫都被吃掉，長條一出現就是滿的。
   只在 `chart.getWidth()` 和容器寬度真的不同時才 resize（`ResponsiveChart` 已處理）。
5. **不做離場動畫。** 新頁要等舊頁離場才掛載，查詢會晚送出（實測回訪一頁 280ms 裡 214ms 在等動畫）。
6. **重元件等進場動畫結束才掛。** AG Grid、ECharts 已經用 `useAfterPageEnter()`（`lib/motion.ts`）處理。
   新增其他重元件（大型清單、編輯器……）照做，等待期間畫**同高度**的佔位，版面才不會跳。
7. **骨架與內容等高。** 骨架高度要接近真正內容，否則換上內容時整頁往下推（CLS）。
8. **尊重「減少動態」。** CSS 那邊由 `index.css` 的 `prefers-reduced-motion` 縮成 1ms；JS 的資料動畫要自己檢查
   `prefersReducedMotion()`（`CountUp` 直接顯示最終值、`ResponsiveChart` 關掉 ECharts 動畫）。新動畫不要繞過它。

## 三、表格的複合格子

一格一個數字的寬表格，改成「一格 = 主數字 + 補充 + 迷你圖」。元件在 `components/cells.tsx`：

| 元件 | 用途 | 用在 |
|---|---|---|
| `RecordCell` | 勝率 + 勝敗比例條；`baseline` 在條上畫比較基準的刻度線（勝段比例 = 勝率，所以刻度有意義） | 英雄、增幅、隊友、對手、隊友下鑽 |
| `StatCell` | 主數字 + 一行補充 | KDA |
| `BarCell` | 數字 + 資料條 + 平均刻度 + 補充 | 輸出（每分鐘傷害） |
| `LiftCell` | 子彈圖：條 = 這個條件下的勝率，刻度 = 基準勝率，數字 = 加成 | 增幅頁選英雄後的契合度 |
| `ContrastCell` | 勝局 / 敗局兩條同刻度細條 + 相對差（好壞方向由呼叫端給） | 敗因分析 |

取數與刻度用同檔的 `numOf` / `num0` / `solidMax` / `weightedAvg`，各頁算法才一致。
範例：英雄頁 `buildColumns`、增幅頁 `buildColumns`（含選英雄時的條件欄位）。

1. **欄位的 `key` 放主數字**，AgTable 用它排序與篩選；`cell: (row) => <RecordCell … />` 決定畫什麼。
2. **被合併的原始欄位留成 `hide: true`**：畫面不顯示，匯出 CSV 仍帶出（AgTable 匯出時 `allColumns: true`）。
3. 有複合格子的表格設 `rowHeight={54}`。所有格子已由 `index.css` 垂直置中，單行格子不會黏在上緣。
4. **補充文字不准被截斷**：窄視窗（1150px）也要放得下。量法：`.rich-cell .truncate` 的 `scrollWidth > clientWidth`
   數量要是 0。放不下就縮短字（整數百分比、去掉空白），或把補充移到另一行——不要只靠 `…` 和 hover title。
5. 資料條的最大值只取樣本夠（`MIN_GAMES`）的列，免得一場的極端值把整欄壓扁；平均線用依場次加權的平均。
6. **欄位定義與列資料都要 `useMemo`**。欄位依資料算刻度，所以要跟著資料重建；但若列資料每次渲染都是新陣列，
   欄位也跟著每次重建，AG Grid 會把使用者點的排序重設。
7. **表格變高時，載入骨架也要跟著改高**（例：敗因分析表改 54px 列高後，骨架沒改，首次進頁 CLS 從 0 變 0.027）。
8. **截圖檢查表格時不要用 Edge 的 `--hide-scrollbars`**：它把捲軸藏起來，但 AG Grid 仍依捲軸寬度裁掉最右欄約 16px，
   會看到「最後一欄被切掉」的假問題（實際瀏覽器正常）。另外被裁的是 grid 的捲動區而不是格子本身，
   只比「文字 vs 自己的格子」量不出來，要實際看截圖。
9. **驗證：畫面上的格子文字逐字和手寫 SQL 對**。Python 比對時注意四捨五入：JS `toFixed` 對剛好一半的值往上捨，
   Python 的格式化是往偶數捨（6.25 → JS「6.3」、Python「6.2」），要用 `Decimal` + `ROUND_HALF_UP`。
10. **比較基準不能被看成正中間**：勝率條同時畫 `CenterNotch`（條下方灰色 50% 小刻度）和 `BaselineTick`
    （強調色、帶 `title` 說明是誰的勝率）。`RecordCell` 必須傳 `baselineLabel` 講清楚比的是什麼
    （例：「你的整體勝率」、「這隻英雄的整體勝率」），不要用白色／前景色畫基準線——使用者會以為那是 50%。
11. **資料一律全部列出，不截斷、不淡化**（使用者明確要求）：
    - 表格查詢的 `limit` 用 `pages/shared.ts` 的 `NO_LIMIT`，不要寫 50、200、500；AG Grid 本身就是虛擬捲動。
    - 不要依場次把列淡化或藏起來（舊的 `sampleKey` 已移除）；樣本多寡讓使用者看場次欄自己判斷。
      `MIN_GAMES` 只用在「排行圖畫哪些長條」。
    - 長條圖不要 `.slice(0, N)`：`BarChart` 超過 14 根會整張圖長高，外面包一層原生捲動容器
      （高度固定在 14 根）。不要改回 ECharts 的 dataZoom——滑鼠移到圖上時滾輪會被圖接走、
      頁面捲到那裡就卡住，而且每一格滾動都重算座標軸，81 根時明顯頓。
      點長條只改 `selected`，捲動位置留著；換排序或篩選（長條的順序變了）才回到最上面。
      超過 `BAR_FIT_MAX`（200 根）才退回 dataZoom，那時 canvas 會高到吃記憶體。
    - 逐場列表一律用 `MatchList`：捲到底自動載入下一批（首批 20、之後每批 50），勝敗摘要用 API 回的整體 `wins`，
      不要只算已載入的部分。對局紀錄頁也是用它。
    - 驗證：表格工具列的「N 列」、列表捲到底的「已經是全部 N 場」都要和手寫 SQL 的筆數一致。

## 四、交叉篩選（Cross-filter）

點一張圖，同一頁其他圖表跟著聚焦。只做在「圖表之間共用同一個維度」的地方，不要為了做而做。

| 頁面 | 點 | 連動 |
|---|---|---|
| 時段 | 每日圖某天 / 熱力圖某格 / 星期長條某天 | 三張圖都亮起同一個星期、其餘淡化；聚焦列顯示那一塊的場次與勝率；下方列出每一場 |
| 隊友下鑽 | 定位長條 | 逐隻英雄只剩那個定位（定位是依「我的英雄」算的，選了定位時鎖在我的英雄） |
| 增幅裝置 | 勝率排行長條 ↔ 表格的列 | 雙向：點長條表格選到那列並捲過去；點列長條亮起 |

規則：
1. **狀態放在頁面**，由圖表的 `onPick` 設定，傳回圖表的 `selected` / `focusRow` / `focusWeekday`，表格的 `highlight`。
2. **淡化一律用 `DIM_OPACITY`**（`charts.tsx`，0.28），選中的用 `--primary` 描邊，不要自己另挑顏色。
3. **再點一次同一個 = 取消**；同時一定要有看得到的「清除」按鈕或標籤。
4. **聚焦狀態要有文字說明**（時段頁的聚焦列、隊友下鑽的「只看坦克」標籤），不能只靠顏色表示「現在被篩選了」。
5. 聚焦列裡的數字從圖表已載入的資料加總，不另外查詢；但一樣要和手寫 SQL 對過。
6. 表格單擊（`onRowClick`）給交叉篩選用，雙擊保留給下鑽；AgTable 已經濾掉雙擊造成的兩次單擊。

驗證方法：`ResponsiveChart` 把 ECharts 實例掛在容器上（`el.parentElement.__chart`），驗證腳本可以
`convertToPixel` 換算座標實際點某根長條，再讀 `getOption().series[i].data[j].itemStyle.opacity` 確認別張圖有淡化。
**不要用畫面上渲染出的表格列數判斷篩選結果**——AG Grid 只渲染看得到的列，要讀工具列的「N 列」。

## 五、下鑽到明細（Drill-through）與麵包屑

**詳細抽屜**：點了「一個東西」要看它的細節（一隻英雄、一天、一場對局），用 `components/DetailDrawer.tsx`
從右邊滑出，原頁面留在原位；抽屜裡的重內容（逐場卡片、戰報）用 `useDrawerSettled()` 等滑完再掛。
英雄頁、儀表板已改用；其他頁的 `DrillPanel` 還是頁內展開，之後要統一時照這個改。
**不要**再用「在頁面頂端插一塊 Panel + `scrollTo`」——剛點的東西會瞬間不見。

**下鑽**：點圖表的一組 → 列出組成它的每一場 → 點一場看戰報。一律用 `components/MatchList.tsx`：
- `<DrillPanel title params onClose />`：「XX 的每一場」面板，出現時自動捲到看得到的位置。
- `params` 直接送 `/api/matches`，先展開 `matchParams()`（帳號、模式、期間），再加這一組的條件。
- 後端的分組條件（`duration`、`prev_result`、`session_stage`…）**標籤必須和 Cube 模型裡的字串一字不差**，
  在 `app.py` 查白名單換成 SQL 條件，不認得回 400，**不准把標籤拼進 SQL**。
- 要驗證：每一組「列表的 total／勝場 = Cube 圖表的數字 = 手寫 SQL」。

**麵包屑**：標題列顯示「頁名 › 全域下鑽 › 頁面內各層」，取代散在各處的篩選標籤。
- 頁面內的聚焦狀態用 `useCrumb(order, label | null, clear)` 登記（`lib/breadcrumb.tsx`）。
  order：頁面第一層 10、第二層 20、單場戰報 90。label 為 null 表示沒有聚焦。
- 新增任何「點了會進到更細一層」的互動，都要登記一層，使用者才知道自己在哪、能一鍵退回。
- 點某一層清掉比它深的所有層；點頁名清掉這頁所有聚焦；離開頁面自動清空，不用手動處理。
- 頁面內原本的「收起」「清除」按鈕保留，麵包屑是額外的統一入口，不是取代。

**自由探索的下鑽路徑與交叉矩陣**（`components/DrillPath.tsx`、`PivotMatrix.tsx`，共用規則在 `lib/drill.ts`）：
- 預設路徑寫在 `cube/model/cubes/*.yml` 的 `hierarchies`，前端從 `/meta` 讀，不要在前端另寫一份。
- 維度分兩家：participants 與 teammates 之間沒有 join 路徑，一條路徑／一張矩陣只能用同一家（`dimensionsOf`）。
  teammates 家族不能走 `apply()`，改用 `useDrillScope`，套不上的全域條件要在畫面上列出來。
- 走到底的逐場列表：先用同一組條件向 Cube 查 `matches.game_id`，再送 `/api/matches?game_ids=`，
  不必為每個維度在後端各寫一套 SQL 對應。
- 新增的維度若是 CASE 或子查詢算出的數字，要宣告成 string 並轉成文字（見 `participants.party_size`），
  否則點下去 `equals` 永遠查不到東西。

## 六、驗證

服務要先在 `127.0.0.1:5057` 跑著（重啟方式見 `verify-change` skill）。前端改動要先 `cd web && npm run build`。

### 切頁流暢度（動到版面、動畫、重元件時）

```bash
node .claude/skills/ui-conventions/scripts/perf_nav.mjs before.json 9450
# 改完、build 之後
node .claude/skills/ui-conventions/scripts/perf_nav.mjs after.json 9451
```

看每一頁的三個數字：
- **動畫期最長**：點下去 250ms 內最長的一格停頓。回訪頁應在 ~40ms 以內，超過 60ms 就是看得出來的卡頓。
- **CLS**：版面跳動，應接近 0（目前儀表板 0.007、增幅頁 0.031，其餘 ≤ 0.005）。
- **long tot / max**：長任務。表格頁有 50～140ms 是 AG Grid 本身的成本，重點是它不能落在動畫期間。

量測陷阱：
- 某些列出現「幀數 0」或上萬毫秒的長任務，是機器被別的東西佔住或分頁被節流，**那一輪作廢重跑**，不要拿來比。
  常見是跑到一半才開始節流（前幾頁正常、後面全部幀數 0），只比正常的那幾列。
- **整輪都異常時，不要直接下結論說改動變慢了**：`git stash push -- web` 在同一時間點量一次舊版。
  舊版正常、新版異常才是退步；再用 CDP `Performance.getMetrics` 量頁面閒置 5 秒的 `ScriptDuration`
  排除渲染迴圈（應該是 0）。實際發生過：新版連兩輪全異常，同時間量舊版正常，但接著再量新版也正常——是環境間歇性節流。
- 改前改後要在同一台機器、同一份資料上量。要量舊版可以 `git stash push -- web`（`web/dist` 有進版控，
  stash 後服務就是舊版），量完 `git stash pop`。
- 前一次的 Edge 還沒完全關時，同一個除錯埠會連不上——換一個埠號。

### 資料動畫（動到數字或圖表動畫時）

- **數字最終值必須和不跑動畫時一模一樣**：CDP 送 `Emulation.setEmulatedMedia`
  `{ features: [{ name: "prefers-reduced-motion", value: "reduce" }] }` 讀一次卡片文字，
  和正常模式等 3 秒後的文字逐字比對（格式化千分位、小數位最容易出錯）。
- **圖表真的有在長**：在頁面內用 `setTimeout` 每 40ms 對 canvas 取一條 `getImageData`（整條一次讀，
  不要逐像素讀——那樣一次取樣就要好幾秒），數彩色像素，數量要隨時間遞增到穩定。
  一出現就是最終值，代表動畫被吃掉了（先查有沒有人呼叫 `resize()`）。

### 主題（動到顏色、圖表、主題時）

```bash
node .claude/skills/ui-conventions/scripts/theme_check.mjs neon
node .claude/skills/ui-conventions/scripts/theme_check.mjs daylight
```

輸出每頁截圖 `th_<主題>_<序號>.png`，並對每張圖做滑鼠 hover 掃描，回報例外數——**必須是 0**
（hover 例外代表有顏色沒轉成 rgba）。打開截圖實際看，亮色主題特別檢查圖示與資料點。

### 收尾

- `cd web && npx tsc -b && npx oxlint src`，只看自己動到的檔案有沒有新警告。
- `git status` 確認 `web/dist` 有重新 build 進去。
