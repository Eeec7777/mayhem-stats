import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AgGridReact } from "ag-grid-react"
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  colorSchemeDark,
  colorSchemeLight,
  type CellClickedEvent,
  type CellDoubleClickedEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type ValueGetterParams,
} from "ag-grid-community"
import { Search, Download, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { iconUrl } from "@/lib/cube"
import { cn } from "@/lib/utils"
import { useThemeName } from "@/lib/theme"
import { useAfterPageEnter } from "@/lib/motion"

ModuleRegistry.registerModules([AllCommunityModule])

export type GridColumn = {
  key: string
  title: string
  kind: "dimension" | "metric"
  iconKey?: string
  rarityKey?: string
  format?: (n: number) => string
  suffix?: string
  /** 自訂這一格的好壞方向。勝率欄以外的欄位若也要上色就給這個——
   *  例如「敗局相差」看的是各指標自己的方向，不是數字大小。 */
  tone?: (value: number, row: Row) => "good" | "bad" | null
  /** 複合格子：一格放多個數字（見 components/cells.tsx）。
   *  key 仍是這欄的排序與篩選依據，所以要選「主數字」當 key。 */
  cell?: (row: Row) => ReactNode
  /** 隱藏欄：畫面上不顯示，但匯出 CSV 仍會帶出。複合格子吃掉的原始欄位放這裡。 */
  hide?: boolean
  flex?: number
  minWidth?: number
  /** 釘在左邊：欄位多到要橫向捲動時，維度欄（英雄、玩家）仍留在眼前 */
  pinned?: "left"
}

type Row = Record<string, unknown>

const ROW_H = 38
const FILTER_ROW_H = 32

const RARITY: Record<string, string> = {
  kPrismatic: "bg-prismatic/15 text-prismatic border-prismatic/30",
  kGold: "bg-gold/15 text-gold border-gold/30",
  kSilver: "bg-silver/15 text-silver border-silver/30",
}

/** 讀專案的 CSS 變數餵給 AG Grid 的 Theming API，
 *  這樣表格會跟著 shadcn 主題走，不用另外維護一份配色。 */
function useGridTheme() {
  // 主題切換後要重算：參數是當下從 CSS 變數讀出來的快照
  const { theme, isDark } = useThemeName()
  return useMemo(() => {
    const css = (name: string, fallback: string) => {
      if (typeof window === "undefined") return fallback
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
    }
    return themeQuartz.withPart(isDark ? colorSchemeDark : colorSchemeLight).withParams({
      backgroundColor: css("--card", "#1f2839"),
      foregroundColor: css("--foreground", "#eef1f8"),
      borderColor: css("--border", "rgba(255,255,255,0.11)"),
      headerBackgroundColor: css("--card", "#1f2839"),
      headerTextColor: css("--muted-foreground", "#8d96ac"),
      headerFontWeight: 600,
      headerFontSize: 11,
      oddRowBackgroundColor: "transparent",
      rowHoverColor: css("--accent", "#26303f"),
      selectedRowBackgroundColor: "color-mix(in oklab, var(--primary) 16%, transparent)",
      accentColor: css("--primary", "#ff6a3d"),
      // 篩選輸入框預設是透明無框，在深色底上等於看不見，
      // 使用者根本不會發現那格可以打字。這裡對齊 shadcn 的 input 樣式。
      inputBackgroundColor: css("--muted", "rgba(255,255,255,0.04)"),
      inputBorder: { color: css("--border", "rgba(255,255,255,0.14)"), width: 1, style: "solid" },
      inputFocusBorder: { color: css("--primary", "#ff6a3d"), width: 1, style: "solid" },
      inputBorderRadius: 6,
      inputPlaceholderTextColor: css("--muted-foreground", "#8d96ac"),
      inputHeight: 26,
      inputPaddingStart: 8,
      fontFamily: "inherit",
      fontSize: 13,
      rowHeight: ROW_H,
      headerHeight: ROW_H,
      wrapperBorderRadius: 8,
      cellHorizontalPadding: 12,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme 不在函式裡用到，但它變了 CSS 變數就變了
  }, [theme, isDark])
}

function DimensionCell({ params, column }: { params: ICellRendererParams; column: GridColumn }) {
  const row = params.data as Row
  const icon = column.iconKey ? (row[column.iconKey] as string) : null
  const rarity = column.rarityKey ? (row[column.rarityKey] as string) : null
  return (
    <span className="flex items-center gap-2">
      {icon && (
        <img src={iconUrl(icon)} alt="" className="size-6 shrink-0 rounded bg-icon-tile" />
      )}
      <span className="truncate" title={(params.value as string) ?? undefined}>
        {(params.value as string) ?? "—"}
      </span>
      {rarity && (
        <Badge variant="outline" className={cn("shrink-0 text-[10px]", RARITY[rarity])}>
          {rarity.replace("k", "")}
        </Badge>
      )}
    </span>
  )
}

export function AgTable({
  columns,
  rows,
  onDrill,
  emptyHint,
  height = 480,
  fileName = "mayhem",
  drillOn = "dblclick",
  rowHeight = ROW_H,
  highlight = null,
  onRowClick,
}: {
  /** 交叉篩選：選取並捲到這一列（例如點了圖表的某根長條）；null 清除選取 */
  highlight?: { key: string; value: string } | null
  /** 單擊一列（雙擊不算，雙擊留給下鑽） */
  onRowClick?: (row: Row) => void
  /** 複合格子有兩行內容，要把列高調高（建議 54） */
  rowHeight?: number
  columns: GridColumn[]
  rows: Row[]
  /** 維度格要單擊還是雙擊才下鑽。下鑽是頁內展開面板（不改全域條件）時用單擊比較直覺。 */
  drillOn?: "click" | "dblclick"
  /** 第三個參數是被點的那一列原始資料——用值去反查會在重複值上選錯列。 */
  onDrill?: (column: GridColumn, value: string, row: Row) => void
  emptyHint?: string
  height?: number
  fileName?: string
}) {
  const theme = useGridTheme()
  // 掛載 AG Grid 是切頁時最大的長任務（60～130ms），等進場動畫跑完才掛，見 lib/motion.ts
  const enterDone = useAfterPageEnter()
  const apiRef = useRef<GridApi | null>(null)
  const [quickFilter, setQuickFilter] = useState("")

  const colDefs = useMemo<ColDef[]>(
    () =>
      columns.map((col) => {
        const isMetric = col.kind === "metric"
        return {
          // 欄位名稱長得像 champions.name，AG Grid 預設會把點當巢狀路徑去
          // data.champions.name 取值，取不到就整欄變空。改成自己取。
          colId: col.key,
          valueGetter: (p: ValueGetterParams) => (p.data as Row)?.[col.key],
          headerName: col.title,
          sortable: true,
          resizable: true,
          // 數值欄用數字篩選器（大於／小於／區間），文字欄用文字篩選器
          filter: isMetric ? "agNumberColumnFilter" : "agTextColumnFilter",
          filterParams: { buttons: ["reset"], closeOnApply: true },
          // 全部欄位一起彈性分攤容器寬度，維度欄佔兩份。
          // 固定寬度會讓欄位一多就超出容器、逼出橫向捲軸。
          flex: col.flex ?? (isMetric ? 1 : 2),
          minWidth: col.minWidth ?? (isMetric ? 96 : 170),
          hide: col.hide,
          pinned: col.pinned,
          headerClass: isMetric && !col.cell ? "ag-right-aligned-header" : undefined,
          // 排序照原始數值，不受格式化字串影響
          comparator: isMetric
            ? (a: unknown, b: unknown) => (Number(a) || 0) - (Number(b) || 0)
            : (a: unknown, b: unknown) =>
                String(a ?? "").localeCompare(String(b ?? ""), "zh-Hant"),
          valueFormatter: isMetric
            ? (p) => {
                if (p.value === null || p.value === undefined) return "—"
                const n = Number(p.value)
                if (!Number.isFinite(n)) return "—"
                return `${col.format ? col.format(n) : n}${col.suffix ?? ""}`
              }
            : undefined,
          cellRenderer: col.cell
            ? (p: ICellRendererParams) => col.cell!(p.data as Row)
            : col.kind === "dimension"
              ? (p: ICellRendererParams) => <DimensionCell params={p} column={col} />
              : undefined,
          cellClass: (p) => {
            if (col.cell) return "rich-cell"
            if (!isMetric) return "font-medium"
            // 數字靠右才比得出位數。colDef.type 的 rightAligned 在這個版本
            // 沒有套到儲存格上，所以直接給 class。
            const base = "tabular-nums font-semibold text-right"
            const n = Number(p.value)
            if (col.tone && Number.isFinite(n)) {
              const tone = col.tone(n, p.data as Row)
              return tone ? `${base} ${tone === "good" ? "!text-win" : "!text-loss"}` : base
            }
            // participants.winrate、wr、baseWr 都算勝率欄
            if (/(winrate|wr)$/i.test(col.key) && Number.isFinite(n)) {
              return n >= 50 ? `${base} !text-win` : `${base} !text-loss`
            }
            return base
          },
        }
      }),
    [columns],
  )

  const handleDrill = (e: CellClickedEvent | CellDoubleClickedEvent) => {
    const col = columns.find((c) => c.key === e.colDef.colId)
    if (col?.kind === "dimension" && e.value != null) onDrill?.(col, String(e.value), e.data as Row)
  }

  const [gridReady, setGridReady] = useState(false)
  const onGridReady = useCallback((e: GridReadyEvent) => {
    apiRef.current = e.api
    setGridReady(true)
  }, [])

  useEffect(() => {
    const api = apiRef.current
    if (!api || !gridReady) return
    if (!highlight) {
      api.deselectAll()
      return
    }
    let target: Parameters<typeof api.ensureNodeVisible>[0] | null = null
    api.forEachNodeAfterFilterAndSort((node) => {
      if (!target && String((node.data as Row)?.[highlight.key]) === highlight.value) target = node
    })
    api.deselectAll()
    if (!target) return
    const node = target as { setSelected: (v: boolean) => void }
    node.setSelected(true)
    api.ensureNodeVisible(target, "middle")
    api.flashCells({ rowNodes: [target] })
  }, [highlight, rows, gridReady])

  const exportCsv = () =>
    apiRef.current?.exportDataAsCsv({
      fileName: `${fileName}-${new Date().toISOString().slice(0, 10)}.csv`,
      // 匯出原始數值而非格式化字串，貼進試算表才能直接運算
      processCellCallback: (p) => p.value,
      // 隱藏欄（複合格子吃掉的原始數字）也要匯出
      allColumns: true,
    })

  if (!rows.length) {
    return (
      <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
        {emptyHint ?? "這個條件下沒有資料。"}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            placeholder="快速搜尋所有欄位…"
            className="h-8 pl-8 pr-8 text-xs"
          />
          {quickFilter && (
            <button
              onClick={() => setQuickFilter("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
              aria-label="清除"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} 列</span>
        <Button size="sm" variant="outline" className="ml-auto h-8" onClick={exportCsv}>
          <Download className="size-3.5" />
          匯出 CSV
        </Button>
      </div>

      {/* 列數少時（例如下鑽到只剩一列）不要硬撐滿，否則下方是一大片空白 */}
      <div style={{ height: Math.min(height, ROW_H + rowHeight * rows.length + FILTER_ROW_H + 18) }}>
        {!enterDone ? (
          // 同高度的佔位，掛上表格時版面不跳
          <div className="h-full rounded-lg border bg-card" />
        ) : (
        <div className="reveal h-full">
        <AgGridReact
          theme={theme}
          rowData={rows}
          rowHeight={rowHeight}
          onRowClicked={(e) => {
            // 雙擊會先觸發兩次單擊（detail 1、2），只認第一下，免得選了又立刻取消
            if (onRowClick && (e.event as MouseEvent | undefined)?.detail === 1) onRowClick(e.data as Row)
          }}
          columnDefs={colDefs}
          onGridReady={onGridReady}
          quickFilterText={quickFilter}
          // 每欄標題都有篩選器圖示，點開就能設條件
          defaultColDef={{
            filter: true,
            // 標題列只留排序。原本每欄標題右側都掛一顆篩選鈕，
            // 相鄰兩欄的鈕會擠在交界處，看起來像同一欄有兩顆。
            suppressHeaderFilterButton: true,
            // 改成標題下方獨立一列篩選輸入框，一眼就知道哪個框管哪一欄
            floatingFilter: true,
            // 「每分鐘傷害」這種長標題在窄欄位會被截斷，讓它換行並自動長高
            wrapHeaderText: true,
            autoHeaderHeight: true,
          }}
          suppressCellFocus={false}
          animateRows
          rowSelection={{ mode: "multiRow", checkboxes: false, headerCheckbox: false }}
          onCellClicked={drillOn === "click" ? handleDrill : undefined}
          onCellDoubleClicked={drillOn === "dblclick" ? handleDrill : undefined}
          localeText={{
            noRowsToShow: "沒有資料",
            filterOoo: "篩選…",
            equals: "等於",
            notEqual: "不等於",
            contains: "包含",
            notContains: "不包含",
            startsWith: "開頭是",
            endsWith: "結尾是",
            blank: "空白",
            notBlank: "非空白",
            greaterThan: "大於",
            greaterThanOrEqual: "大於等於",
            lessThan: "小於",
            lessThanOrEqual: "小於等於",
            inRange: "介於",
            resetFilter: "清除",
            applyFilter: "套用",
            andCondition: "且",
            orCondition: "或",
          }}
        />
        </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        點欄位標題排序，標題下方的輸入框可逐欄篩選（數值欄支援大於／小於／區間）
        {onDrill ? `；${drillOn === "click" ? "點" : "雙擊"}維度儲存格會下鑽該項目。` : "。"}
      </p>
    </div>
  )
}
