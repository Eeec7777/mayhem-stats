import { useEffect, useMemo, useRef, useState } from "react"
import ReactECharts from "echarts-for-react"
import { CONTRIB_GAP } from "@/hooks/useContribution"
import { useThemeName } from "@/lib/theme"
import { CHART_GROW_MS, STAGGER_CAP_MS, STAGGER_MS, prefersReducedMotion, useAfterPageEnter } from "@/lib/motion"

/** 交叉篩選時，沒被選中的資料淡到這個不透明度——各張圖一致，看得出「這些是背景」但仍讀得到。 */
export const DIM_OPACITY = 0.28

/** 依序錯開：第 i 個元素晚多少出現，超過上限就不再往後排。 */
const stagger = (i: number, step = STAGGER_MS) => Math.min(i * step, STAGGER_CAP_MS)

/** 包一層尺寸觀察。
 *
 * ECharts 是在掛載當下量容器寬度，而在 grid／flex 版面裡那一刻寬度常常還是 0，
 * 之後它也不會自己重算——結果就是高度正常、寬度 0 的空白圖。
 * ResizeObserver 在初次佈局與之後每次容器變動時都會觸發，補上這個缺口。
 */
type EChartsInstance = {
  resize: () => void
  getWidth: () => number
  getHeight: () => number
  /** zrender 的事件層：ECharts 自己的 click 只在資料元素上觸發，整張圖任一點要從這裡接。 */
  getZr: () => { on: (event: string, handler: (e: { offsetX: number; offsetY: number }) => void) => void }
  /** 像素換回資料座標。finder 指定單一座標軸時，value 給一個數字、回傳一個數字。 */
  convertFromPixel: (finder: Record<string, number>, value: number) => number
}

function ResponsiveChart({
  option,
  height,
  onEvent,
  onPixelClick,
}: {
  option: unknown
  height: number
  /** 圖表事件，主要用來做下鑽（點一個點就把它加成篩選）。 */
  onEvent?: Record<string, (params: never) => void>
  /** 圖上任何一點被點到（不限資料元素）。x／y 是相對圖表左上角的像素，
   *  由呼叫端自己 convertFromPixel 換算成是哪一組資料——像每日圖那樣
   *  「整條欄位都可以點」，不必正好點中那根長條。 */
  onPixelClick?: (chart: EChartsInstance, x: number, y: number) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const instance = useRef<EChartsInstance | null>(null)
  const [width, setWidth] = useState(0)
  const enterDone = useAfterPageEnter()

  // zr 的事件只在建立圖表時掛一次，靠 ref 讀到最新的回呼（否則會抓到第一次渲染的 days）
  const pixelClick = useRef(onPixelClick)
  useEffect(() => {
    pixelClick.current = onPixelClick
  })

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const sync = () => {
      const w = box.clientWidth
      setWidth(w)
      // 只在寬度真的變了才 resize：ECharts 的 resize() 會把進行中的動畫直接跳到終點，
      // ResizeObserver 一掛上就會觸發一次，無條件 resize 等於把每張圖的生長動畫都吃掉
      // （實測長條一出現就是滿的）。
      const chart = instance.current
      if (w > 0 && chart && Math.abs(chart.getWidth() - w) > 1) chart.resize()
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // 寬度還是 0 就先不要建立圖表。ECharts 在掛載當下量寬度,量到 0 就不會產生
  // canvas,而且之後只能靠 resize 救回來——分頁在背景時瀏覽器會把 ResizeObserver
  // 一起節流,那個 resize 可能好幾秒後才來,圖就一直是空白的。
  // 也等換頁進場動畫跑完才建立（見 lib/motion.ts），佔位的高度和圖一樣，版面不跳。
  if (width === 0 || !enterDone) {
    return <div ref={boxRef} className="w-full" style={{ height }} />
  }

  return (
    // 不加淡入：座標軸先出現、資料再從軸線長出來，比整張圖一起淡入更看得出方向
    <div ref={boxRef} className="w-full">
      <ReactECharts
        // onChartReady 是取得實例的官方途徑；改用元件 ref 拿 getEchartsInstance
        // 在這個版本拿不到東西，resize 會被 optional chaining 靜靜吞掉。
        onChartReady={(chart: EChartsInstance) => {
          instance.current = chart
          // 整張圖的點擊。ECharts 的 click 只在長條、折線的點這些圖元上觸發，
          // 想要「點那一欄的任何位置」就得接 zrender 這層。
          chart.getZr().on("click", (e) => pixelClick.current?.(chart, e.offsetX, e.offsetY))
          // 掛在容器上給驗證腳本讀（換算座標去點某根長條、讀 option 確認有沒有淡化），畫面本身不用
          if (boxRef.current) (boxRef.current as HTMLDivElement & { __chart?: EChartsInstance }).__chart = chart
          // 建立時量到的寬度不對才補一次 resize（理由同上，無條件呼叫會吃掉生長動畫）
          const w = boxRef.current?.clientWidth ?? 0
          if (w > 0 && Math.abs(chart.getWidth() - w) > 1) chart.resize()
        }}
        // 進場的生長動畫（長條從軸線長出、折線由左往右畫）；各圖表可以再加依序錯開的 animationDelay。
        // 資料更新（換篩選、換主題）用較短的過渡，從舊值滑到新值而不是重長一次
        option={{
          animationDuration: CHART_GROW_MS,
          animationEasing: "cubicOut",
          animationDurationUpdate: 450,
          animationEasingUpdate: "cubicInOut",
          ...(option as object),
          ...(prefersReducedMotion() ? { animation: false } : {}),
        } as never}
        onEvents={onEvent as never}
        style={{ height, width: "100%" }}
        notMerge
      />
    </div>
  )
}

/** 把任何 CSS 顏色字串解析成 [r,g,b]。
 *
 *  專案的主題色是 oklch()。canvas 的 fillStyle 看得懂它,所以單純填色沒問題,
 *  但 ECharts 的 visualMap 漸層是交給 zrender 自己做內插的,而 zrender 解析不了
 *  oklch——漸層會整個塌掉。實測結果是熱力圖完全沒有顏色,只剩背景的棋盤格。
 *  這裡借畫布讓瀏覽器幫我們解析,之後所有內插都自己算,只餵 ECharts 純 rgb()。 */
const rgbCache = new Map<string, [number, number, number]>()

function toRgb(color: string): [number, number, number] {
  const hit = rgbCache.get(color)
  if (hit) return hit
  let out: [number, number, number] = [128, 128, 128]
  try {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    ctx.fillStyle = color
    ctx.fillRect(0, 0, 1, 1)
    const d = ctx.getImageData(0, 0, 1, 1).data
    out = [d[0], d[1], d[2]]
  } catch {
    /* 解析不了就用中性灰，總比整張圖沒顏色好 */
  }
  rgbCache.set(color, out)
  return out
}

const mix = (a: string, b: string, t: number) => {
  const [r1, g1, b1] = toRgb(a)
  const [r2, g2, b2] = toRgb(b)
  const k = Math.max(0, Math.min(1, t))
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)})`
}

/** 文字要黑要白，看背景亮度決定。 */
const readableOn = (color: string) => {
  const [r, g, b] = toRgb(color)
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0f1520" : "#eef1f8"
}

/** 從 CSS 變數讀主題色，讓圖表跟著 shadcn 的主題走，不要另外寫死一組色。
 *
 *  一律轉成 rgba() 再交給 ECharts。原始值是 oklch()，靜態填色看起來正常，但滑鼠一移到
 *  長條或點上，zrender 要替 hover 狀態做顏色內插、解析不了 oklch，直接拋出
 *  「Cannot read properties of undefined (reading 'colorStops')」——例外發生在事件
 *  處理途中，接在後面的 click 也跟著不觸發：每日圖點某天一直沒有反應就是這個原因。 */
function cssVar(name: string, fallback: string) {
  if (typeof window === "undefined") return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
  try {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!
    ctx.fillStyle = value
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
    return `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`
  } catch {
    return fallback
  }
}

/** 發散配色的中點：去掉色相、只留亮度的灰。
 *  不能直接用主題的灰字色——霓虹主題的灰字偏藍，混出來的「中性」格會和勝方的藍色撞在一起。 */
const neutralGray = (theme: { card: string; muted: string }, t: number) => {
  const [r, g, b] = toRgb(theme.muted)
  const l = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  return mix(theme.card, `rgb(${l},${l},${l})`, t)
}

/** 同一個顏色換透明度。ECharts 的漸層、光暈都要 rgba，不能直接疊 CSS 的 / 語法。 */
const alpha = (color: string, a: number) => {
  const [r, g, b] = toRgb(color)
  return `rgba(${r},${g},${b},${a})`
}

const MONO = '"Cascadia Code", "JetBrains Mono", Consolas, ui-monospace, monospace'

function useTheme() {
  // 依主題名稱重算：切換主題時 <html data-theme> 已先寫好，這裡讀到的就是新主題的變數
  const { theme: name, isDark } = useThemeName()
  return useMemo(
    () => ({
      name,
      isDark,
      text: cssVar("--foreground", "#eef1f8"),
      muted: cssVar("--muted-foreground", "#8d96ac"),
      border: cssVar("--border", "rgba(255,255,255,0.11)"),
      card: cssVar("--card", "#1f2839"),
      primary: cssVar("--primary", "#22d3ee"),
      win: cssVar("--win", "#129bc9"),
      loss: cssVar("--loss", "#e3437c"),
      /** 單一系列（勝率走勢、場次、散布點）的資料色。和勝／敗兩極不同色，不會被誤讀成好壞。 */
      data: cssVar("--data", "#8272f2"),
    }),
    [name, isDark],
  )
}

type Theme = ReturnType<typeof useTheme>

function baseTooltip(theme: Theme) {
  return {
    // 掛到 body 而不是圖表容器：容器外層的卡片是 overflow-hidden，
    // 圖表貼著卡片邊緣時（例如英雄頁左欄的六邊形），提示框往外長的那一半會被裁掉
    appendTo: "body",
    backgroundColor: alpha(theme.card, 0.92),
    borderColor: alpha(theme.primary, 0.35),
    borderWidth: 1,
    textStyle: { color: theme.text, fontSize: 12 },
    padding: [8, 12],
    extraCssText: `backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 0 0 1px ${alpha(theme.primary, 0.08)}, 0 10px 30px rgba(0,0,0,${theme.isDark ? 0.45 : 0.12});`,
  }
}

/** 座標軸共用樣式：數字用等寬字、格線用虛線且很淡——資料是主角，框線退到背景。 */
const axisLabel = (theme: Theme, extra: Record<string, unknown> = {}) => ({
  color: theme.muted,
  fontSize: 10,
  fontFamily: MONO,
  ...extra,
})
const splitLine = (theme: Theme) => ({ lineStyle: { color: alpha(theme.muted, 0.14), type: [3, 4] } })

/** 由左（或下）到右（或上）淡入的漸層：長條根部半透明、末端實色，帶一點「發光」的科技感。 */
const fade = (color: string, horizontal: boolean, from = 0.35) => ({
  type: "linear",
  x: 0,
  y: horizontal ? 0 : 1,
  x2: horizontal ? 1 : 0,
  y2: 0,
  colorStops: [
    { offset: 0, color: alpha(color, from) },
    { offset: 1, color: alpha(color, 1) },
  ],
})

const WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"]

/** 熱力圖用的 24 小時刻度。 */
export const HOURS_24 = Array.from({ length: 24 }, (_, i) => String(i))

// ─────────────────────────────────────────── 勝率趨勢

export type TrendPoint = { date: string; games: number; winrate: number | null }

export function TrendChart({ points }: { points: TrendPoint[] }) {
  const theme = useTheme()

  const option = useMemo(() => {
    const maxGames = Math.max(1, ...points.map((p) => p.games))
    return {
      grid: { left: 44, right: 20, top: 20, bottom: 32 },
      tooltip: {
        trigger: "axis",
        ...baseTooltip(theme),
        formatter: (params: { data: [string, number]; dataIndex: number }[]) => {
          const p = points[params[0].dataIndex]
          return `${p.date}<br/>${p.games} 場 · 勝率 ${p.winrate?.toFixed(1) ?? "—"}%`
        },
      },
      // time 軸會依實際日期定位，沒打球的日子自然留白，不會把有間隔的兩天畫成相鄰
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: alpha(theme.muted, 0.3) } },
        axisLabel: axisLabel(theme),
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: axisLabel(theme, { formatter: "{value}%" }),
        splitLine: splitLine(theme),
      },
      series: [
        {
          type: "line",
          smooth: 0.25,
          data: points.map((p) => [p.date, p.winrate]),
          lineStyle: { color: theme.data, width: 2, shadowBlur: 12, shadowColor: alpha(theme.data, 0.6) },
          // 暗色：空心點（卡片色填心）發光；亮色：白心在白底上像線斷掉，改成實心點加白框
          // 折線預設的點是 emptyCircle，會無視 itemStyle.color 一律填白；要自己控制填色得指定成 circle
          symbol: "circle",
          itemStyle: theme.isDark ? { color: theme.card, borderColor: theme.data, borderWidth: 2 } : { color: theme.data, borderColor: theme.card, borderWidth: 2 },
          // 點的大小代表當天場次，避免只打一場的 0%／100% 看起來跟 20 場一樣重
          symbolSize: (_: unknown, params: { dataIndex: number }) =>
            8 + 10 * Math.sqrt(points[params.dataIndex].games / maxGames),
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: alpha(theme.data, 0.32) },
                { offset: 1, color: alpha(theme.data, 0) },
              ],
            },
          },
          emphasis: { itemStyle: { color: theme.data, borderColor: theme.text } },
          // 折線由左往右畫出來，比長條慢一點，讀得出「時間往前走」
          animationDuration: CHART_GROW_MS + 300,
          animationEasing: "cubicInOut",
          markLine: {
            silent: true,
            symbol: "none",
            // 參考線等線畫到一半才淡入，不要一開始就擋在前面
            animationDelay: CHART_GROW_MS * 0.6,
            animationDuration: 400,
            data: [{ yAxis: 50 }],
            lineStyle: { color: alpha(theme.muted, 0.5), type: "dashed", width: 1 },
            label: { formatter: "50%", color: theme.muted, fontSize: 10, fontFamily: MONO, position: "insideStartTop" },
          },
        },
      ],
    }
  }, [points, theme])

  return <ResponsiveChart option={option} height={240} />
}

// ─────────────────────────────────────────── 星期 × 時段熱力圖

export type HeatCell = { weekday: number; x: number; games: number; winrate: number | null }

/** 樣本數多少才算「這格的勝率可以看」。低於這個數會被拉回整體平均。 */
export const SHRINK_K = 6
/** 顏色飽和到頂的偏離幅度。用 ±20 個百分點,不是 0~100,否則真實差距全被壓成一團。 */
const SPREAD = 20

/** 把一格的勝率往整體平均收縮。
 *
 *  一場 100% 和二十場 60%,原始數字看起來前者比較強,但前者只是還沒輸過而已。
 *  收縮之後 (wins + k*base) / (n + k),一場的格子幾乎貼著平均、顏色很淡,
 *  場次夠多才會真的往兩端跑。這樣顏色本身就帶著「可不可信」的資訊。 */
export function shrunk(games: number, winrate: number | null, base: number) {
  if (!games || winrate === null) return base
  const wins = (winrate / 100) * games
  return ((wins + SHRINK_K * (base / 100)) / (games + SHRINK_K)) * 100
}

export function Heatmap({
  cells,
  xLabels,
  selected,
  focusRow = null,
  onPick,
}: {
  cells: HeatCell[]
  /** x 軸的刻度。24 小時就給 24 個，粗分組就給 4 個。 */
  xLabels: string[]
  /** 目前下鑽中的格子,會打上外框。 */
  selected?: { weekday: number; x: number } | null
  /** 交叉篩選：只亮這個星期那一列，其他列淡掉 */
  focusRow?: number | null
  onPick?: (cell: { weekday: number; x: number }) => void
}) {
  const theme = useTheme()

  const { option, base } = useMemo(() => {
    const totalGames = cells.reduce((sum, c) => sum + c.games, 0)
    const totalWins = cells.reduce((sum, c) => sum + (c.games * (c.winrate ?? 0)) / 100, 0)
    const base = totalGames ? (totalWins / totalGames) * 100 : 50

    // 空格也要畫出來,否則會分不清「沒打過」和「打過但勝率中庸」。
    const byKey = new Map(cells.map((c) => [`${c.weekday}:${c.x}`, c]))
    // 空格要看得出來是「格子」，否則 168 格的版面會散掉，也分不清沒打過和打過但普通
    const empty = neutralGray(theme, 0.14)
    const neutral = neutralGray(theme, 0.5)

    const data = []
    for (let wd = 0; wd < 7; wd++) {
      for (let x = 0; x < xLabels.length; x++) {
        const cell = byKey.get(`${wd}:${x}`)
        const games = cell?.games ?? 0
        const adjusted = shrunk(games, cell?.winrate ?? null, base)
        const deviation = (adjusted - base) / SPREAD // -1 ~ 1
        const color = !games
          ? empty
          : mix(neutral, deviation >= 0 ? theme.win : theme.loss, Math.min(1, Math.abs(deviation)))
        const isSelected = selected && selected.weekday === wd && selected.x === x
        const dimmed = focusRow !== null && focusRow !== wd
        data.push({
          value: [x, wd, games, cell?.winrate ?? null, adjusted],
          itemStyle: {
            color,
            opacity: dimmed ? DIM_OPACITY : 1,
            // 2px 的卡片色縫隙把格子分開；選中的格子用介面強調色描邊並發光
            borderColor: isSelected ? theme.primary : theme.card,
            borderWidth: 2,
            shadowBlur: isSelected ? 12 : 0,
            shadowColor: alpha(theme.primary, 0.7),
          },
          label: { color: games ? readableOn(color) : "transparent", opacity: dimmed ? DIM_OPACITY : 1 },
        })
      }
    }

    return {
      base,
      option: {
        grid: { left: 46, right: 16, top: 10, bottom: 26 },
        tooltip: {
          ...baseTooltip(theme),
          formatter: (p: { value: [number, number, number, number | null, number] }) => {
            const [x, wd, games, raw, adj] = p.value
            const when = `${WEEKDAYS[wd]} ${xLabels[x]}`
            if (!games) return `${when}<br/>沒有對局`
            const wins = Math.round(((raw ?? 0) / 100) * games)
            const note =
              games < SHRINK_K
                ? `<br/><span style="opacity:.7">只有 ${games} 場，顏色已往整體 ${base.toFixed(0)}% 收斂</span>`
                : ""
            return (
              `${when}<br/>${games} 場 · ${wins} 勝 ${games - wins} 敗` +
              `<br/>勝率 ${(raw ?? 0).toFixed(1)}%（校正後 ${adj.toFixed(1)}%）${note}`
            )
          },
        },
        xAxis: {
          type: "category",
          data: xLabels,
          splitArea: { show: false },
          axisLabel: axisLabel(theme, { fontSize: xLabels.length > 12 ? 10 : 11, interval: 0 }),
          axisLine: { show: false },
          axisTick: { show: false },
        },
        yAxis: {
          type: "category",
          data: WEEKDAYS,
          splitArea: { show: false },
          axisLabel: { color: theme.muted, fontSize: 11 },
          axisLine: { show: false },
          axisTick: { show: false },
        },
        series: [
          {
            type: "heatmap",
            data,
            label: { show: true, formatter: (p: { value: number[] }) => (p.value[2] ? String(p.value[2]) : ""), fontSize: 10, fontFamily: MONO },
            itemStyle: { borderRadius: 5 },
            emphasis: { itemStyle: { borderColor: theme.primary, borderWidth: 2, shadowBlur: 10, shadowColor: alpha(theme.primary, 0.6) } },
            // 格子由左往右一欄一欄掃進來（資料是週日→週六、每列由左到右排的）
            animationDuration: 500,
            animationDelay: (idx: number) => {
              const x = idx % xLabels.length
              const wd = Math.floor(idx / xLabels.length)
              return Math.min(x * (xLabels.length > 12 ? 18 : 70) + wd * 15, STAGGER_CAP_MS + 200)
            },
          },
        ],
      },
    }
  }, [cells, xLabels, selected, focusRow, theme])

  return (
    <div className="space-y-2">
      <ResponsiveChart
        option={option}
        height={260}
        onEvent={
          onPick
            ? { click: (p: { value?: number[] }) => p.value && onPick({ weekday: p.value[1], x: p.value[0] }) }
            : undefined
        }
      />
      <HeatLegend base={base} theme={theme} />
    </div>
  )
}

/** 自己畫圖例。ECharts 的 visualMap 會用 zrender 內插主題色,而它解析不了 oklch。 */
function HeatLegend({ base, theme }: { base: number; theme: Theme }) {
  const neutral = neutralGray(theme, 0.5)
  const steps = [-1, -0.6, -0.3, 0, 0.3, 0.6, 1]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      <span>勝率低</span>
      <span className="flex overflow-hidden rounded">
        {steps.map((d) => (
          <span
            key={d}
            className="h-3 w-6"
            style={{ background: mix(neutral, d >= 0 ? theme.win : theme.loss, Math.abs(d)) }}
          />
        ))}
      </span>
      <span>勝率高</span>
      <span className="opacity-70">
        中間 = 你的整體 {base.toFixed(1)}%，兩端 = ±{SPREAD} 個百分點；格子裡的數字是場次
      </span>
    </div>
  )
}


export type BarDatum = { label: string; value: number; games: number }

/** 橫條圖一次看得到幾根，以及每根佔多高。超過就捲動，不截掉後面的資料。 */
const BAR_VISIBLE = 14
const BAR_ROW = 34

/** 幾根以內用「整張圖長高 + 外面包原生捲動」。
 *
 *  原本一律用 ECharts 內建的 dataZoom：滑鼠移到圖上，滾輪就被圖接走（頁面捲到這裡會卡住），
 *  而且每一格滾動都要重算一次座標軸，81 根時明顯頓。改成瀏覽器自己的捲軸之後，
 *  滾輪行為和頁面其他地方一致、捲動不重繪，點長條後的位置也自然保留。
 *  代價是 canvas 會有好幾千像素高（81 根約 2700px），所以還是留一個上限，
 *  再多就退回 dataZoom——記憶體比順不順手重要。 */
const BAR_FIT_MAX = 200

export function BarChart({
  data,
  suffix = "",
  colorBy = "value",
  baseline,
  selected = null,
  showGames = false,
  onPick,
}: {
  /** 交叉篩選：選中的那根描邊，其他淡掉 */
  selected?: string | null
  data: BarDatum[]
  suffix?: string
  colorBy?: "value" | "flat"
  /** 長條末端連場次一起標出來。沒有場次門檻的排行一定要開——
   *  不然 100% 的那根看起來和 20 場 60% 的一樣有份量。 */
  showGames?: boolean
  /** 紅綠的分界。預設用這批資料自己的加權平均——也就是「你的水準」。
   *  傳數字可以改成固定門檻(例如 50)。 */
  baseline?: number
  onPick?: (label: string) => void
}) {
  const theme = useTheme()
  const scroll = data.length > BAR_VISIBLE
  // 一般情況：整張圖長高，外面用原生捲軸。根數多到 canvas 太大才退回 dataZoom。
  const fitAll = scroll && data.length <= BAR_FIT_MAX
  const zoomed = scroll && !fitAll
  // dataZoom 捲到哪裡要記住：點長條會改 selected、option 重建（notMerge），不記的話每點一下就跳回最上面。
  // 資料換了才回到最上面。（原生捲軸那條路不需要，容器的 scrollTop 本來就不會動。）
  const zoom = useRef<{ data: BarDatum[]; start: number; end: number } | null>(null)
  if (zoom.current?.data !== data) zoom.current = { data, start: 100 * (1 - BAR_VISIBLE / Math.max(data.length, 1)), end: 100 }

  // 換了排序或篩選就回到最上面；點長條（只改 selected，順序沒變）不動。
  // 不能只看 data 是不是同一個陣列——頁面每次渲染都會給一份新的。
  const box = useRef<HTMLDivElement>(null)
  const order = data.map((d) => d.label).join(" ")
  const lastOrder = useRef(order)
  useEffect(() => {
    if (lastOrder.current === order) return
    lastOrder.current = order
    if (box.current) box.current.scrollTop = 0
  }, [order])

  const option = useMemo(() => {
    const ordered = [...data].reverse() // ECharts 的 y 軸由下往上
    // 用 50% 當紅綠分界，對整體勝率 42.6% 的人來說幾乎整排都是紅的，
    // 看不出「哪個比較適合我」。改成跟自己的平均比。
    const totalGames = data.reduce((a, d) => a + d.games, 0)
    const base =
      baseline ??
      (totalGames
        ? data.reduce((a, d) => a + d.value * d.games, 0) / totalGames
        : data.reduce((a, d) => a + d.value, 0) / Math.max(1, data.length))
    const neutral = neutralGray(theme, 0.5)
    // 顏色和熱力圖同一套規則：場次少的先往平均收縮，不會因為兩場全勝就通紅通綠
    const tint = (d: BarDatum) => {
      const adj = shrunk(d.games, d.value, base)
      const dev = (adj - base) / SPREAD
      return mix(neutral, dev >= 0 ? theme.win : theme.loss, Math.min(1, Math.abs(dev)))
    }
    return {
      // 有平均線時上緣要留位置給它的標籤，否則會被切掉
      // 末端的標籤要留得下，帶場次時再多讓一點
      grid: { left: 8, right: (zoomed ? 76 : 56) + (showGames ? 52 : 0), top: colorBy === "flat" ? 8 : 20, bottom: 8, containLabel: true },
      dataZoom: zoomed
        ? [
            // 最上面（ordered 的尾端）是第一根，預設停在那裡
            { type: "inside", yAxisIndex: 0, start: zoom.current!.start, end: zoom.current!.end, zoomOnMouseWheel: false, moveOnMouseWheel: true, moveOnMouseMove: false },
            {
              type: "slider",
              yAxisIndex: 0,
              start: zoom.current!.start,
              end: zoom.current!.end,
              right: 6,
              width: 10,
              zoomLock: true,
              showDetail: false,
              showDataShadow: false,
              brushSelect: false,
              borderColor: "transparent",
              backgroundColor: alpha(theme.muted, theme.isDark ? 0.08 : 0.1),
              fillerColor: alpha(theme.primary, 0.35),
              handleSize: 0,
              moveHandleSize: 0,
            },
          ]
        : undefined,
      tooltip: {
        ...baseTooltip(theme),
        formatter: (p: { name: string; value: number; dataIndex: number }) => {
          const d = ordered[p.dataIndex]
          const diff = p.value - base
          const tail =
            colorBy === "flat"
              ? ""
              : `<br/><span style="opacity:.7">比平均 ${base.toFixed(1)}${suffix} ${diff >= 0 ? "高" : "低"} ${Math.abs(diff).toFixed(1)}${suffix}</span>`
          return `${p.name}<br/>${p.value.toFixed(1)}${suffix} · ${d.games} 場${tail}`
        },
      },
      xAxis: {
        type: "value",
        axisLabel: axisLabel(theme),
        splitLine: splitLine(theme),
      },
      yAxis: {
        type: "category",
        data: ordered.map((d) => d.label),
        axisLabel: { color: theme.text, fontSize: 12 },
        axisLine: { lineStyle: { color: alpha(theme.muted, 0.3) } },
        axisTick: { show: false },
      },
      series: [
        {
          type: "bar",
          data: ordered.map((d) => {
            const color = colorBy === "flat" ? theme.data : tint(d)
            const isSelected = selected === d.label
            const dimmed = selected !== null && !isSelected
            return {
              value: d.value,
              itemStyle: {
                // 根部半透明、末端實色：長條像一道光往外打，而不是一塊平塗的色塊
                color: fade(color, true),
                borderRadius: [0, 4, 4, 0],
                opacity: dimmed ? DIM_OPACITY : 1,
                borderColor: isSelected ? theme.primary : "transparent",
                borderWidth: isSelected ? 1.5 : 0,
                shadowBlur: isSelected ? 14 : 0,
                shadowColor: alpha(theme.primary, 0.6),
              },
              label: { opacity: dimmed ? DIM_OPACITY : 1 },
              emphasis: { itemStyle: { color, shadowBlur: 14, shadowColor: alpha(color, 0.7) } },
            }
          }),
          barMaxWidth: 18,
          // 長條從軸線往右長出來，由上往下依序錯開（ordered 是反過來的，最後一個在最上面）
          animationDelay: (idx: number) => stagger(ordered.length - 1 - idx),
          animationDelayUpdate: 0,
          // 長條背後的「軌道」，一眼看出離滿格還差多少
          showBackground: true,
          backgroundStyle: { color: alpha(theme.muted, theme.isDark ? 0.06 : 0.08), borderRadius: [0, 4, 4, 0] },
          markLine:
            colorBy === "flat"
              ? undefined
              : {
                  silent: true,
                  symbol: "none",
                  // 平均線等長條長得差不多了才出現
                  animationDelay: CHART_GROW_MS * 0.7,
                  animationDuration: 400,
                  data: [{ xAxis: base }],
                  lineStyle: { color: alpha(theme.primary, 0.7), type: "dashed", width: 1 },
                  label: {
                    formatter: `平均 ${base.toFixed(1)}${suffix}`,
                    color: theme.primary,
                    fontSize: 10,
                    fontFamily: MONO,
                    // 預設會沿著線轉成直的，壓在長條上很難讀
                    rotate: 0,
                    position: "end",
                    distance: 2,
                  },
                },
          label: {
            show: true,
            position: "right",
            color: theme.text,
            fontSize: 11,
            fontFamily: MONO,
            // 數字跟著長條一起從 0 跑上來
            valueAnimation: true,
            formatter: (p: { value: number; dataIndex: number }) =>
              showGames
                ? `${p.value.toFixed(1)}${suffix}  ${ordered[p.dataIndex]?.games ?? 0} 場`
                : `${p.value.toFixed(1)}${suffix}`,
          },
        },
      ],
    }
    // zoom 用 ref 讀，刻意不放進依賴：捲動本身不該觸發重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, suffix, colorBy, baseline, selected, showGames, theme, zoomed])

  const onEvent = useMemo(() => {
    const events: Record<string, (p: never) => void> = {}
    if (onPick) events.click = (p: { name?: string }) => p.name && onPick(p.name)
    if (zoomed) {
      events.datazoom = (p: { start?: number; end?: number; batch?: { start: number; end: number }[] }) => {
        const z = p.batch?.[0] ?? p
        if (zoom.current && z.start !== undefined && z.end !== undefined) Object.assign(zoom.current, { start: z.start, end: z.end })
      }
    }
    return Object.keys(events).length ? events : undefined
  }, [onPick, zoomed])

  const chart = (
    <ResponsiveChart
      option={option}
      height={Math.max(180, (fitAll ? data.length : Math.min(data.length, BAR_VISIBLE)) * BAR_ROW)}
      onEvent={onEvent}
    />
  )
  // 捲動容器包在圖外面：滾輪先捲這一格、到底了再帶動頁面，和瀏覽器平常一樣
  return fitAll ? (
    <div ref={box} className="overflow-y-auto" style={{ maxHeight: BAR_VISIBLE * BAR_ROW }}>
      {chart}
    </div>
  ) : (
    chart
  )
}


// ─────────────────────────────────────────── 散布圖（找離群值）

export type RadarDatum = { label: string; games: number; wins: number; winrate: number | null }

/** 量文字寬度（px）。雷達圖要知道頂點標籤多寬，才算得出半徑能開多大。 */
let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string, font: string) {
  measureCtx ??= document.createElement("canvas").getContext("2d")
  if (!measureCtx) return text.length * 7
  measureCtx.font = font
  return measureCtx.measureText(text).width
}

const RADAR_NAME_GAP = 10
/** 頂點標籤兩行（名稱 18px 行高 + 數字 14px）的高度 */
const RADAR_LABEL_H = 34

/** 雷達圖的圓心與半徑（px）。
 *
 *  原本半徑固定是寬高較小者的 70%：英雄頁左欄只有 340px 寬時，左右兩個頂點的標籤
 *  （「法師 34.3% 35 場」）會超出圖的邊界被切掉。改成反過來算：先量最寬的標籤，
 *  左右各留「間距 + 標籤寬」，上下各留兩行標籤高，剩下的空間才是半徑。
 *  點擊換算方向也用這一份，兩邊的圓心與半徑才會一致。 */
function radarGeometry(w: number, h: number, n: number, labelW: number) {
  const cx = w / 2
  const cy = h / 2
  // 除了正上、正下之外的頂點，水平方向伸出去 r·|cos θ|，標籤再往外長一整個寬度
  let side = 0
  for (let i = 0; i < n; i++) {
    const c = Math.abs(Math.cos(((90 + (i * 360) / n) * Math.PI) / 180))
    if (c > 0.05) side = Math.max(side, c)
  }
  const byWidth = side ? (w / 2 - RADAR_NAME_GAP - labelW - 6) / side : Infinity
  const byHeight = h / 2 - RADAR_NAME_GAP - RADAR_LABEL_H - 6
  return { cx, cy, r: Math.max(40, Math.min(byWidth, byHeight)) }
}

/** 六邊形（雷達）圖：一個類別一個頂點，例如英雄的六種定位。
 *
 *  形狀只畫一個指標（場次或勝率），不把兩個量級不同的數字疊在同一張圖上——
 *  和「不准雙 y 軸」同一個道理。另一個指標寫在頂點的標籤裡：
 *  勝率依場次往平均收縮後，比平均高或低才上勝／敗色，否則是灰字，
 *  所以兩場全勝的那一類不會看起來最強。
 *  點某一類那個方向的任何位置就是選它（交叉篩選）：只能點頂點上的小字太難點中。
 *  選中的那類用介面強調色，其他淡掉。 */
export function RadarChart({
  data,
  mode,
  baseline,
  total,
  height = 340,
  selected = null,
  onPick,
}: {
  data: RadarDatum[]
  /** 形狀依場次或勝率 */
  mode: "games" | "winrate"
  /** 勝率的比較基準（你的整體勝率）。勝率模式畫成虛線環 */
  baseline: number | null
  /** 總場次，提示框換算各類佔比用 */
  total: number
  height?: number
  selected?: string | null
  onPick?: (label: string) => void
}) {
  const theme = useTheme()
  // 自己量寬度：半徑要跟著寬度算（見 radarGeometry）。量到之前不畫，免得第一次用錯的半徑長出來再縮
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const sync = () => setWidth(box.clientWidth)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  // 最寬的頂點標籤：名稱一行、「勝率 場次」一行，取兩行裡寬的那個
  const labelW = useMemo(
    () =>
      Math.max(
        0,
        ...data.map((d) =>
          Math.max(
            textWidth(d.label, "600 13px sans-serif"),
            textWidth(d.winrate === null ? "—" : `${d.winrate.toFixed(1)}%`, `600 11px ${MONO}`) +
              textWidth(` ${d.games} 場`, `11px ${MONO}`),
          ),
        ),
      ),
    [data],
  )
  const geo = radarGeometry(width, height, data.length, labelW)

  const option = useMemo(() => {
    const base = baseline ?? 50
    const maxGames = Math.max(1, ...data.map((d) => d.games))
    // 場次的外框取「比最多那類再多一點」的整數，最多那類才不會貼在框上看不出形狀
    const step = maxGames > 50 ? 20 : maxGames > 20 ? 10 : 5
    const max = mode === "games" ? Math.ceil((maxGames * 1.1) / step) * step : 100
    const rich: Record<string, object> = {}
    data.forEach((d, i) => {
      const dimmed = selected !== null && selected !== d.label
      const adj = shrunk(d.games, d.winrate, base)
      // 收縮後偏離不到 2 個百分點就不上色：那種差距在這個樣本量下看不出來
      const tone = !d.games || Math.abs(adj - base) < 2 ? theme.muted : adj > base ? theme.win : theme.loss
      const opacity = dimmed ? DIM_OPACITY : 1
      rich[`n${i}`] = {
        color: selected === d.label ? theme.primary : theme.text,
        fontSize: 13,
        fontWeight: 600,
        opacity,
        lineHeight: 18,
      }
      rich[`w${i}`] = { color: tone, fontSize: 11, fontFamily: MONO, fontWeight: 600, opacity }
      rich[`g${i}`] = { color: theme.muted, fontSize: 11, fontFamily: MONO, opacity }
    })
    const byName = new Map(data.map((d, i) => [d.label, i]))

    return {
      tooltip: {
        ...baseTooltip(theme),
        trigger: "item",
        formatter: () =>
          data
            .map((d) =>
              d.games
                ? `${d.label}　${d.games} 場（佔 ${Math.round((100 * d.games) / Math.max(1, total))}%）· ${d.winrate === null ? "—" : `${d.winrate.toFixed(1)}%`}　${d.wins} 勝 ${d.games - d.wins} 敗`
                : `${d.label}　沒玩過`,
            )
            .join("<br/>") +
          (baseline !== null ? `<br/><span style="opacity:.7">你的整體勝率 ${baseline.toFixed(1)}%</span>` : ""),
      },
      radar: {
        indicator: data.map((d) => ({ name: d.label, max, min: 0 })),
        shape: "polygon",
        splitNumber: 4,
        radius: geo.r,
        center: [geo.cx, geo.cy],
        axisName: {
          formatter: (name: string) => {
            const i = byName.get(name) ?? 0
            const d = data[i]
            const wr = d.winrate === null ? "—" : `${d.winrate.toFixed(1)}%`
            return `{n${i}|${name}}\n{w${i}|${wr}} {g${i}|${d.games} 場}`
          },
          rich,
        },
        axisNameGap: RADAR_NAME_GAP,
        splitLine: { lineStyle: { color: alpha(theme.muted, 0.18) } },
        splitArea: {
          areaStyle: { color: [alpha(theme.muted, theme.isDark ? 0.03 : 0.04), "transparent"] },
        },
        axisLine: { lineStyle: { color: alpha(theme.muted, 0.22) } },
      },
      series: [
        {
          type: "radar",
          symbol: "circle",
          symbolSize: 7,
          data: [
            {
              name: mode === "games" ? "場次" : "勝率",
              value: data.map((d) => (mode === "games" ? d.games : (d.winrate ?? 0))),
              lineStyle: { color: theme.data, width: 2 },
              itemStyle: { color: theme.data, borderColor: theme.card, borderWidth: 1.5 },
              areaStyle: { color: alpha(theme.data, 0.28) },
            },
          ],
          emphasis: { lineStyle: { width: 3 }, areaStyle: { color: alpha(theme.data, 0.4) } },
          z: 3,
        },
        // 勝率模式：你的整體勝率畫成一圈虛線，在圈外的類別就是比平常會贏
        ...(mode === "winrate" && baseline !== null
          ? [
              {
                type: "radar",
                silent: true,
                symbol: "none",
                // 等形狀長得差不多了才出現，和長條圖的平均線同一個節奏
                animationDelay: CHART_GROW_MS * 0.7,
                animationDuration: 400,
                data: [
                  {
                    name: "你的整體勝率",
                    value: data.map(() => baseline),
                    lineStyle: { color: alpha(theme.primary, 0.8), type: "dashed", width: 1 },
                  },
                ],
                z: 2,
              },
            ]
          : []),
      ],
    }
  }, [data, mode, baseline, total, selected, theme, geo.r, geo.cx, geo.cy])

  // 點擊換算成方向：ECharts 的頂點從正上方開始、逆時針排，第 i 個在 90° + i·(360/n)。
  // 離圓心太近分不出方向，太遠（圖的角落）不算點到。
  const pixelClick = onPick
    ? (chart: EChartsInstance, x: number, y: number) => {
        const { cx, cy, r } = radarGeometry(chart.getWidth(), chart.getHeight(), data.length, labelW)
        const dx = x - cx
        const dy = cy - y
        const dist = Math.hypot(dx, dy)
        if (dist < r * 0.12 || dist > r * 1.6) return
        const step = 360 / data.length
        const deg = (Math.atan2(dy, dx) * 180) / Math.PI - 90
        const i = ((Math.round(deg / step) % data.length) + data.length) % data.length
        if (data[i]) onPick(data[i].label)
      }
    : undefined

  return (
    <div ref={boxRef} className={onPick ? "cursor-pointer" : undefined}>
      {width > 0 ? (
        <ResponsiveChart option={option} height={height} onPixelClick={pixelClick} />
      ) : (
        <div style={{ height }} />
      )}
    </div>
  )
}

export type ContribRadarDatum = { label: string; hint: string; value: number | null }

/** 貢獻六項的雷達：六個頂點各是一項百分位（0～100，外框 100），50 那一圈畫成虛線——
 *  形狀在虛線圈外的那一項就是比同出裝定位、同勝負的一般人多，圈內是少。
 *  頂點標籤是名稱與數字，數字偏離 50 達 gap（預設 CONTRIB_GAP，表現分傳 PERF_GAP）才上勝／敗色（和 ContribScore 同一套）。
 *  形狀用資料色，不用勝敗色：雷達整體不是「好壞」，好壞由虛線圈和數字顏色表達。 */
export function ContribRadarChart({ data: all, height = 280, gap = CONTRIB_GAP }: { data: ContribRadarDatum[]; height?: number; gap?: number }) {
  const theme = useTheme()
  // 沒有值的項目（例如沒有治療到隊友的場次沒有治療軸）直接略過那個頂點，畫成 0 會被讀成「完全沒做」
  const data = useMemo(() => all.filter((d) => d.value !== null), [all])
  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const sync = () => setWidth(box.clientWidth)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  const labelW = useMemo(
    () => Math.max(0, ...data.map((d) => Math.max(textWidth(d.label, "600 13px sans-serif"), textWidth("100", `600 11px ${MONO}`)))),
    [data],
  )
  const geo = radarGeometry(width, height, data.length, labelW)

  const option = useMemo(() => {
    const rich: Record<string, object> = {}
    data.forEach((d, i) => {
      const dev = d.value === null ? 0 : d.value - 50
      rich[`n${i}`] = { color: theme.text, fontSize: 13, fontWeight: 600, lineHeight: 18 }
      rich[`v${i}`] = {
        color: d.value === null || Math.abs(dev) < gap ? theme.muted : dev > 0 ? theme.win : theme.loss,
        fontSize: 11,
        fontFamily: MONO,
        fontWeight: 600,
      }
    })
    const byName = new Map(data.map((d, i) => [d.label, i]))
    return {
      tooltip: {
        ...baseTooltip(theme),
        trigger: "item",
        formatter: () =>
          data
            .map((d) => `${d.label}　${d.value === null ? "—" : Math.round(d.value)}<span style="opacity:.6">　${d.hint}</span>`)
            .join("<br/>") + `<br/><span style="opacity:.7">百分位，50＝同出裝定位、同勝負的一般人</span>`,
      },
      radar: {
        indicator: data.map((d) => ({ name: d.label, max: 100, min: 0 })),
        shape: "polygon",
        splitNumber: 4, // 25、50、75、100
        radius: geo.r,
        center: [geo.cx, geo.cy],
        axisName: {
          formatter: (name: string) => {
            const i = byName.get(name) ?? 0
            const v = data[i].value
            return `{n${i}|${name}}
{v${i}|${v === null ? "—" : Math.round(v)}}`
          },
          rich,
        },
        axisNameGap: RADAR_NAME_GAP,
        splitLine: { lineStyle: { color: alpha(theme.muted, 0.18) } },
        splitArea: { areaStyle: { color: [alpha(theme.muted, theme.isDark ? 0.03 : 0.04), "transparent"] } },
        axisLine: { lineStyle: { color: alpha(theme.muted, 0.22) } },
      },
      series: [
        {
          type: "radar",
          symbol: "circle",
          symbolSize: 7,
          data: [
            {
              name: "貢獻",
              value: data.map((d) => d.value ?? 0),
              lineStyle: { color: theme.data, width: 2 },
              itemStyle: { color: theme.data, borderColor: theme.card, borderWidth: 1.5 },
              areaStyle: { color: alpha(theme.data, 0.28) },
            },
          ],
          emphasis: { lineStyle: { width: 3 }, areaStyle: { color: alpha(theme.data, 0.4) } },
          z: 3,
        },
        // 一般人（50）：等形狀長得差不多了才出現，和長條圖的平均線同一個節奏
        {
          type: "radar",
          silent: true,
          symbol: "none",
          animationDelay: CHART_GROW_MS * 0.7,
          animationDuration: 400,
          data: [
            {
              name: "一般人",
              value: data.map(() => 50),
              lineStyle: { color: alpha(theme.primary, 0.8), type: "dashed", width: 1 },
            },
          ],
          z: 2,
        },
      ],
    }
  }, [data, theme, gap, geo.r, geo.cx, geo.cy])

  return (
    <div ref={boxRef}>
      {width > 0 ? <ResponsiveChart option={option} height={height} /> : <div style={{ height }} />}
    </div>
  )
}

export type ScatterPoint = {
  label: string
  x: number
  y: number
  size: number
}

/** 兩個指標交叉看，泡泡大小是場次。用來找「輸出高但贏不了」這種矛盾組合。 */
export function ScatterChart({
  points,
  xName,
  yName,
  xSuffix = "",
  ySuffix = "",
  onPick,
}: {
  points: ScatterPoint[]
  xName: string
  yName: string
  xSuffix?: string
  ySuffix?: string
  onPick?: (label: string) => void
}) {
  const theme = useTheme()

  const option = useMemo(() => {
    const maxSize = Math.max(1, ...points.map((p) => p.size))
    return {
      grid: { left: 56, right: 28, top: 24, bottom: 44 },
      tooltip: {
        ...baseTooltip(theme),
        formatter: (p: { data: { value: number[]; name: string } }) =>
          `${p.data.name}<br/>${xName} ${p.data.value[0].toFixed(1)}${xSuffix}` +
          `<br/>${yName} ${p.data.value[1].toFixed(1)}${ySuffix}` +
          `<br/>${p.data.value[2]} 場`,
      },
      xAxis: {
        type: "value",
        name: xName,
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: theme.muted, fontSize: 11 },
        axisLabel: axisLabel(theme),
        splitLine: splitLine(theme),
      },
      yAxis: {
        type: "value",
        name: yName,
        nameTextStyle: { color: theme.muted, fontSize: 11 },
        axisLabel: axisLabel(theme),
        splitLine: splitLine(theme),
      },
      series: [
        {
          type: "scatter",
          data: points.map((p) => ({ name: p.label, value: [p.x, p.y, p.size] })),
          symbolSize: (v: number[]) => 8 + 26 * Math.sqrt(v[2] / maxSize),
          // 2px 卡片色外環：泡泡重疊時仍分得出邊界
          itemStyle: { color: alpha(theme.data, 0.55), borderColor: theme.data, borderWidth: 1.5, shadowBlur: 8, shadowColor: alpha(theme.data, 0.45) },
          emphasis: { itemStyle: { color: theme.data, borderColor: theme.text, shadowBlur: 16 } },
          // 泡泡從中心彈出來，依序錯開
          animationEasing: "backOut",
          animationDuration: 700,
          animationDelay: (idx: number) => stagger(idx, 20),
          animationDelayUpdate: 0,
          label: {
            show: true,
            position: "top",
            color: theme.muted,
            fontSize: 10,
            formatter: (p: { data: { name: string; value: number[] } }) =>
              // 只標樣本較大的點，否則標籤會糊成一團
              p.data.value[2] >= Math.max(3, maxSize * 0.4) ? p.data.name : "",
          },
        },
      ],
    }
  }, [points, xName, yName, xSuffix, ySuffix, theme])

  return (
    <ResponsiveChart
      option={option}
      height={380}
      onEvent={onPick ? { click: (p: { data?: { name?: string } }) => p.data?.name && onPick(p.data.name) } : undefined}
    />
  )
}

// ─────────────────────────────────────────── 佔比樹狀圖

export function TreemapChart({
  items,
  onPick,
}: {
  items: { label: string; value: number; winrate: number | null }[]
  onPick?: (label: string) => void
}) {
  const theme = useTheme()

  const option = useMemo(
    () => ({
      tooltip: {
        ...baseTooltip(theme),
        formatter: (p: { name: string; value: number; data: { winrate: number | null } }) =>
          `${p.name}<br/>${p.value} 次` +
          (p.data.winrate === null ? "" : `<br/>勝率 ${p.data.winrate.toFixed(1)}%`),
      },
      series: [
        {
          type: "treemap",
          roam: false,
          nodeClick: false,
          breadcrumb: { show: false },
          label: { color: theme.text, fontSize: 11, overflow: "truncate" },
          itemStyle: { borderColor: theme.card, borderWidth: 2, gapWidth: 2 },
          data: items.map((i) => ({
            name: i.label,
            value: i.value,
            winrate: i.winrate,
            // 用勝率上色，面積是使用次數：一眼看出「常用但不太贏」的組合
            itemStyle: {
              color:
                i.winrate === null
                  ? theme.muted
                  : i.winrate >= 50
                    ? theme.win
                    : theme.loss,
              opacity: 0.35 + Math.min(Math.abs((i.winrate ?? 50) - 50) / 50, 1) * 0.5,
            },
          })),
        },
      ],
    }),
    [items, theme],
  )

  return (
    <ResponsiveChart
      option={option}
      height={380}
      onEvent={onPick ? { click: (p: { name?: string }) => p.name && onPick(p.name) } : undefined}
    />
  )
}

// ─────────────────────────────────────────── 每日戰績（場次 + 勝率）

/** YYYY-MM-DD（本地日期）是星期幾，0 = 週日。用本地時間建日期，不能讓它被當成 UTC 解析而差一天。 */
export const weekdayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number)
  return new Date(y, m - 1, d).getDay()
}

export type DayDatum = { date: string; games: number; wins: number; winrate: number | null }

/** 沒打的日子也要佔一格。
 *
 *  只把有資料的日子一天挨一天排，會把中間隔了三天的兩次遊玩畫成相鄰，
 *  看起來像連續的走勢。補成完整的日期區間之後，空檔就是空檔（場次 0、勝率 null）。
 *  區間大得離譜時（跨年以上）不補，否則幾千根 0 長條會把有資料的日子壓成細線。 */
const MAX_FILLED_DAYS = 400

/** 累積勝率的座標範圍只參考累積場次達到這個數字之後的日子 */
const MIN_CUMULATIVE_GAMES = 10

export function fillDays(days: DayDatum[]): DayDatum[] {
  if (days.length < 2) return days
  const start = new Date(`${days[0].date}T00:00:00`)
  const end = new Date(`${days[days.length - 1].date}T00:00:00`)
  const span = Math.round((end.getTime() - start.getTime()) / 86400000) + 1
  if (span <= days.length || span > MAX_FILLED_DAYS) return days
  const bySeen = new Map(days.map((d) => [d.date, d]))
  const out: DayDatum[] = []
  for (let i = 0; i < span; i++) {
    const at = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`
    out.push(bySeen.get(key) ?? { date: key, games: 0, wins: 0, winrate: null })
  }
  return out
}

/** 一天一組：下面的長條是當天的場次，拆成勝／敗兩段；上面的折線是「累積到那天為止」的勝率。
 *
 *  折線畫累積而不是當天，因為一天只打一兩場時，當天勝率只有 0／50／100 三種值，跳來跳去看不出趨勢；
 *  累積勝率才是「我現在整體多強」的走勢，越往右越穩。當天的勝率改由長條的勝敗兩段表達（高度 = 場次，
 *  兩段各占多少 = 當天勝率），tooltip 再寫出精確數字。沒打的日子累積勝率不變，折線平著走過去。
 *
 *  兩個指標量級不同，所以上下分成兩個座標區、共用日期軸，不用雙 y 軸。 */
export function DailyChart({
  days: played,
  selected,
  focusWeekday = null,
  height = 280,
  onPick,
}: {
  days: DayDatum[]
  selected?: string | null
  /** 交叉篩選：只亮這個星期（0 = 週日）的那幾天 */
  focusWeekday?: number | null
  /** 儀表板的卡片比分頁窄一點，可以調矮 */
  height?: number
  onPick?: (date: string) => void
}) {
  const theme = useTheme()
  // 沒打的日子補成空格，走勢才不會把隔了幾天的兩次遊玩畫成相鄰
  const days = useMemo(() => fillDays(played), [played])
  // 只有「能不能點」會影響 option；直接把 onPick 放進相依會讓每次渲染都重算整份 option
  const clickable = !!onPick

  const option = useMemo(() => {
    const maxGames = Math.max(1, ...days.map((d) => d.games))
    const labels = days.map((d) => d.date.slice(5))

    // 累積勝率：到那天為止的總勝場 / 總場次。還沒打過的日子（開頭的空檔）是 null
    let cw = 0
    let cg = 0
    const cumulative = days.map((d) => {
      cw += d.wins
      cg += d.games
      return { games: cg, wins: cw, rate: cg ? (cw / cg) * 100 : null }
    })

    // 累積勝率大多落在 45~55，用 0~100 畫會變成一條平線，所以座標軸貼著資料縮放；
    // 但一定包含 50%，才看得出「在一半以上還是以下」
    // 前幾天只打了一兩場，累積勝率會是 0% 或 100%，把它們算進範圍會讓後面的走勢扁成一條線；
    // 範圍只看累積到 10 場以上的日子，更早的那一小段會被圖框切掉（tooltip 仍然寫得出）
    const settled = cumulative.filter((c) => c.rate !== null && c.games >= MIN_CUMULATIVE_GAMES)
    const rates = (settled.length ? settled : cumulative).map((c) => c.rate ?? 50)
    const lo = Math.min(...rates, 48)
    const hi = Math.max(...rates, 52)
    const rateStep = hi - lo > 24 ? 10 : 5
    const rateMin = Math.max(0, Math.floor((lo - 1) / rateStep) * rateStep)
    const rateMax = Math.min(100, Math.ceil((hi + 1) / rateStep) * rateStep)

    // 場次軸：刻度取 1、2、5、10… 這種整數，最高那根上方留空間放數字
    const gameStep = [1, 2, 5, 10, 20, 50].find((s) => maxGames / s <= 3) ?? 100
    const gameMax = Math.ceil((maxGames * 1.15) / gameStep) * gameStep
    const showCounts = days.length <= 60

    const xAxisBase = {
      type: "category",
      data: labels,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: alpha(theme.muted, 0.3) } },
    }
    const dimmed = (d: DayDatum) => focusWeekday !== null && weekdayOf(d.date) !== focusWeekday
    // 被點的那天：兩個座標區各亮一條欄位底色，不改長條本身的勝敗配色
    const pickedArea = selected
      ? {
          silent: true,
          itemStyle: { color: alpha(theme.primary, 0.14), borderColor: alpha(theme.primary, 0.7), borderWidth: 1 },
          data: [[{ xAxis: selected.slice(5) }, { xAxis: selected.slice(5) }]],
        }
      : undefined
    const bar = (name: string, color: string, pick: (d: DayDatum) => number) => ({
      type: "bar",
      name,
      stack: "games",
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: days.map((d) => ({
        value: pick(d),
        itemStyle: { opacity: dimmed(d) ? DIM_OPACITY : 1, color: fade(color, false, 0.55) },
      })),
      // 逐筆的漸層色讓圖例抓不到顏色，series 層級另給一個純色給圖例用
      itemStyle: { color },
      barMaxWidth: 22,
      // 從底線往上長，由左到右依序；總錯開時間和上面折線畫完的時間差不多
      animationDelay: (idx: number) => stagger(idx, Math.min(90, (CHART_GROW_MS + 300) / Math.max(1, days.length))),
      animationDelayUpdate: 0,
      emphasis: { itemStyle: { shadowBlur: 10, shadowColor: alpha(color, 0.6) } },
    })

    return {
      axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: alpha(theme.primary, 0.5) } },
      legend: {
        data: ["累積勝率", "勝", "敗"],
        right: 8,
        top: 0,
        icon: "roundRect",
        itemWidth: 12,
        itemHeight: 8,
        itemGap: 14,
        selectedMode: false,
        textStyle: { color: theme.muted, fontSize: 11 },
      },
      grid: [
        { left: 44, right: 16, top: 26, height: "38%" },
        { left: 44, right: 16, top: "62%", bottom: 30 },
      ],
      tooltip: {
        trigger: "axis",
        ...baseTooltip(theme),
        axisPointer: { type: "shadow", shadowStyle: { color: alpha(theme.primary, 0.06) } },
        formatter: (ps: { dataIndex: number }[]) => {
          const i = ps[0].dataIndex
          const d = days[i]
          const c = cumulative[i]
          const total = c.rate === null ? "" : `<br/>累積 ${c.games} 場 · ${c.wins} 勝 · ${c.rate.toFixed(1)}%`
          if (!d.games) return `${d.date}<br/><span style="opacity:.7">這天沒有對局</span>${total}`
          const tail = clickable ? '<br/><span style="opacity:.7">點一下看這天的每一場</span>' : ""
          return `${d.date}<br/>當天 ${d.games} 場 · ${d.wins} 勝 ${d.games - d.wins} 敗 · ${(d.winrate ?? 0).toFixed(1)}%${total}${tail}`
        },
      },
      xAxis: [
        { ...xAxisBase, gridIndex: 0, axisLabel: { show: false } },
        { ...xAxisBase, gridIndex: 1, axisLabel: axisLabel(theme, { rotate: days.length > 12 ? 45 : 0 }) },
      ],
      yAxis: [
        {
          type: "value",
          gridIndex: 0,
          name: "累積勝率",
          nameTextStyle: { color: theme.muted, fontSize: 10, align: "left" },
          min: rateMin,
          max: rateMax,
          interval: rateStep,
          axisLabel: axisLabel(theme, { formatter: "{value}%" }),
          splitLine: splitLine(theme),
        },
        {
          type: "value",
          gridIndex: 1,
          name: "場次",
          nameTextStyle: { color: theme.muted, fontSize: 10, align: "left" },
          min: 0,
          max: gameMax,
          interval: gameStep,
          axisLabel: axisLabel(theme),
          splitLine: splitLine(theme),
        },
      ],
      series: [
        {
          type: "line",
          name: "累積勝率",
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: cumulative.map((c, i) => ({
            value: c.rate,
            // 只有最新一天標出數字：那就是「目前整體勝率」
            label: {
              show: i === cumulative.length - 1 && c.rate !== null,
              formatter: `${(c.rate ?? 0).toFixed(1)}%`,
              position: "top",
              color: theme.primary,
              fontSize: 11,
              fontFamily: MONO,
              fontWeight: 600,
            },
          })),
          lineStyle: { color: theme.data, width: 2, shadowBlur: 10, shadowColor: alpha(theme.data, 0.55) },
          // 暗色：空心點（卡片色填心）發光；亮色：白心在白底上像線斷掉，改成實心點加白框
          // 折線預設的點是 emptyCircle，會無視 itemStyle.color 一律填白；要自己控制填色得指定成 circle
          symbol: "circle",
          itemStyle: theme.isDark ? { color: theme.card, borderColor: theme.data, borderWidth: 2 } : { color: theme.data, borderColor: theme.card, borderWidth: 2 },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: alpha(theme.data, 0.25) },
                { offset: 1, color: alpha(theme.data, 0) },
              ],
            },
          },
          // 只在有打的日子畫點，沒打的日子折線平著走過；點的大小跟著當天場次，一兩場的那天不會看起來和二十場一樣有份量
          symbolSize: (_v: unknown, p: { dataIndex: number }) => {
            const g = days[p.dataIndex]?.games ?? 0
            return g ? 5 + 7 * Math.sqrt(g / maxGames) : 0
          },
          // 勝率線由左往右畫；下面的場次長條同時一根根長上來，兩者節奏對得上
          animationDuration: CHART_GROW_MS + 300,
          animationEasing: "cubicInOut",
          // 50% 是勝負分界：累積勝率在它上面還是下面，比和哪一天比都重要
          markLine: {
            silent: true,
            symbol: "none",
            animationDelay: CHART_GROW_MS * 0.7,
            animationDuration: 400,
            data: [{ yAxis: 50 }],
            lineStyle: { color: alpha(theme.primary, 0.6), type: "dashed", width: 1 },
            label: { show: false },
          },
          markArea: pickedArea,
        },
        { ...bar("勝", theme.win, (d) => d.wins), markArea: pickedArea },
        bar("敗", theme.loss, (d) => d.games - d.wins),
        // 場次數字標在整根長條上方：堆疊長條沒有「總和」的標籤位置，用一個不畫線不畫點的折線系列來放
        {
          type: "line",
          name: "場次合計",
          xAxisIndex: 1,
          yAxisIndex: 1,
          silent: true,
          // symbol 設成 none 的話標籤也不會畫，所以留一個看不見的點
          symbol: "circle",
          symbolSize: 1,
          // 標籤掛在點上，點的 opacity 設 0 標籤會跟著消失，所以改用透明色
          itemStyle: { color: "transparent", borderWidth: 0 },
          lineStyle: { opacity: 0 },
          data: days.map((d) => d.games),
          label: {
            show: showCounts,
            position: "top",
            color: theme.muted,
            fontSize: 10,
            fontFamily: MONO,
            formatter: (p: { value: number }) => (p.value ? String(p.value) : ""),
          },
          tooltip: { show: false },
          animation: false,
        },
      ],
    }
  }, [days, selected, focusWeekday, clickable, theme])

  return (
    <ResponsiveChart
      option={option}
      height={height}
      // 不用 ECharts 的 series click：那要正好點中那根長條（一場的那天只有兩三個像素高）。
      // 改成整張圖接點擊，再用 x 座標換算是哪一天——滑鼠在哪一欄，點下去就是那一天，
      // 和 tooltip 的灰色欄位是同一塊範圍。
      onPixelClick={
        onPick
          ? (chart, x) => {
              // 兩個 grid 的左右邊界一樣，用哪個 x 軸換算結果都相同
              const at = chart.convertFromPixel({ xAxisIndex: 0 }, x)
              const d = Number.isFinite(at) ? days[Math.round(at)] : undefined
              // 補出來的空日子點下去會列出零場，直接忽略
              if (d && d.games) onPick(d.date)
            }
          : undefined
      }
    />
  )
}
