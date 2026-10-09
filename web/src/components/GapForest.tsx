import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { MIN_N, gapOf, type GapRow } from "@/lib/gap"

export type { GapRow }

/** 森林圖的共用零件：陣容、敗因（對局長度）、節奏（逐人落差）三頁都用這組，長得一樣、讀法一樣。
 *
 *  讀法：中線是基準，點是「這組比基準高或低幾個百分點」，線是 95% 區間。
 *  只有區間整段在基準同一邊才上勝敗色，其餘灰色——再大的差距也可能只是運氣。 */

const toneOf = (clear: boolean, diff: number) => (!clear ? "bg-muted-foreground" : diff > 0 ? "bg-win" : "bg-loss")

/** 刻度：-reach、-reach/2、0、+reach/2、+reach */
const ticksOf = (reach: number) => [-reach, -reach / 2, 0, reach / 2, reach]

const pctAt = (v: number, reach: number) => `${((Math.max(-reach, Math.min(reach, v)) + reach) / (2 * reach)) * 100}%`

/** 軌道左右各留一點空，最外側的點和刻度文字才不會被切掉。所有軌道與刻度列共用同一個內縮。 */
const TRACK_INSET = "mx-3"

/** 一列的軌道：格線、中線、區間線（兩端有小橫槓）和點 */
export function ForestTrack({
  diff,
  interval,
  clear,
  reach,
  empty,
}: {
  diff: number | null
  interval: [number, number] | null
  clear: boolean
  reach: number
  /** 沒有點可畫時顯示的字（例如「樣本太少」） */
  empty?: string
}) {
  const tone = toneOf(clear, diff ?? 0)
  return (
    <div className={cn("relative h-9", TRACK_INSET)}>
      {ticksOf(reach).map((t) => (
        <span
          key={t}
          className={cn("absolute inset-y-0", t === 0 ? "w-[2px] -translate-x-1/2 bg-muted-foreground/55" : "w-px -translate-x-1/2 bg-border")}
          style={{ left: pctAt(t, reach) }}
        />
      ))}
      {interval && diff !== null && (
        <>
          <span
            className={cn("absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full", tone, !clear && "opacity-60")}
            style={{ left: pctAt(interval[0], reach), width: `calc(${pctAt(interval[1], reach)} - ${pctAt(interval[0], reach)})` }}
          />
          {interval.map((edge, i) => (
            <span
              key={i}
              className={cn("absolute top-1/2 h-2.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full", tone, !clear && "opacity-60")}
              style={{ left: pctAt(edge, reach) }}
            />
          ))}
          <span
            className={cn("absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card", tone)}
            style={{ left: pctAt(diff, reach) }}
          />
        </>
      )}
      {!interval && empty && (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">{empty}</span>
      )}
    </div>
  )
}

/** 刻度列：數字對齊格線；中間（0）換成基準的名字（「整體 48.9%」），兩端各一句方向提示 */
export function ForestAxis({
  reach,
  center,
  worse = "比整體差",
  better = "比整體好",
  unit = "pp",
  compact = false,
}: {
  reach: number
  center: string
  worse?: string
  better?: string
  unit?: string
  /** 幾張並排、每張很窄時：只標 −reach、基準、+reach，不放兩端的方向提示 */
  compact?: boolean
}) {
  return (
    <div className={cn("relative h-9", TRACK_INSET)} aria-hidden>
      {ticksOf(reach)
        .filter((t) => !compact || t === 0 || Math.abs(t) === reach)
        .map((t) => (
        <span
          key={t}
          className={cn(
            "absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[10px] tabular-nums",
            t === 0 ? "font-semibold text-foreground" : "text-muted-foreground",
            // 窄螢幕只留三個刻度，免得數字互相蓋住
            !compact && t !== 0 && Math.abs(t) !== reach && "hidden sm:block",
          )}
          style={{ left: pctAt(t, reach) }}
        >
          {t === 0 ? center : `${t > 0 ? "+" : "−"}${Math.abs(t)}${unit}`}
        </span>
      ))}
      {!compact && (
        <>
          <span className="absolute bottom-0 left-0 hidden text-[10px] text-muted-foreground sm:block">← {worse}</span>
          <span className="absolute bottom-0 right-0 hidden text-[10px] text-muted-foreground sm:block">{better} →</span>
        </>
      )}
    </div>
  )
}

/** 顏色圖例：三種顏色各代表什麼，放在圖上方 */
export function ForestLegend({ better = "比整體好", worse = "比整體差" }: { better?: string; worse?: string }) {
  const item = (cls: string, text: string) => (
    <span className="flex items-center gap-1.5">
      <span className={cn("size-2.5 rounded-full", cls)} />
      {text}
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {item("bg-win", `${better}（看得出差別）`)}
      {item("bg-loss", `${worse}（看得出差別）`)}
      {item("bg-muted-foreground opacity-60", "還在誤差內，分不出是真的還是運氣")}
    </div>
  )
}

/** 勝率差的森林圖：一列一組，右邊三欄是這組的勝率、比基準高低幾個百分點、場次。 */
export function GapForest({
  rows,
  baseline,
  reach,
  unit = "場",
  selected,
  onPick,
  labelWidth = "minmax(0,7rem)",
  showAxis = true,
  compact = false,
}: {
  rows: GapRow[]
  baseline: number
  reach: number
  unit?: string
  selected?: string | null
  onPick?: (row: GapRow) => void
  /** 第一欄（組名）的寬度，CSS grid 的軌道寫法 */
  labelWidth?: string
  /** 同一欄疊好幾組時，只有最上面那組畫刻度與欄標題 */
  showAxis?: boolean
  /** 窄版（三四張並排）：只留勝率與場次兩欄，差距寫在滑鼠提示裡；軌道可以縮到 6rem */
  compact?: boolean
}) {
  // 手機寬度（< sm）一律用精簡的四欄；sm 以上才有「差距」欄、軌道也比較寬。
  // class 要寫成完整字串（Tailwind 掃不到動態拼出來的），組名欄寬用 CSS 變數帶進來。
  const cols = { "--label": labelWidth } as CSSProperties
  const gridCls = compact
    ? "grid-cols-[var(--label)_minmax(6rem,1fr)_2.5rem_2rem]"
    : "grid-cols-[var(--label)_minmax(6rem,1fr)_2.5rem_2rem] sm:grid-cols-[var(--label)_minmax(14rem,1fr)_3.25rem_3.75rem_2.5rem]"
  const diffCls = "hidden sm:block"
  return (
    <div className={compact ? undefined : "max-w-[60rem]"}>
      {showAxis && (
        <div className={cn("grid items-end gap-x-2", gridCls)} style={cols}>
          <span />
          <ForestAxis reach={reach} center={`整體 ${baseline.toFixed(0)}%`} compact={compact} />
          <span className="pb-0.5 text-right text-[10px] text-muted-foreground">勝率</span>
          {!compact && <span className={cn("pb-0.5 text-right text-[10px] text-muted-foreground", diffCls)}>差距</span>}
          <span className="pb-0.5 text-right text-[10px] text-muted-foreground">{unit === "隊" ? "隊數" : "場次"}</span>
        </div>
      )}
      {rows.map((row) => {
        const g = gapOf(row, baseline)
        const on = selected === row.key
        const shown = Math.round(Math.abs(g.diff))
        const sign = shown === 0 ? "" : g.diff > 0 ? "+" : "−"
        return (
          <button
            key={row.key}
            type="button"
            data-testid="gap-row"
            data-games={row.games}
            data-wins={row.wins}
            disabled={!row.games || !onPick}
            onClick={() => onPick?.(row)}
            aria-label={
              row.games
                ? `${row.label}：勝率 ${g.winrate.toFixed(1)}%，${row.games} ${unit}，比基準 ${g.diff >= 0 ? "+" : ""}${g.diff.toFixed(1)} 個百分點${g.clear ? "，看得出差別" : ""}`
                : `${row.label}：沒有對局`
            }
            title={
              row.games
                ? `${row.label}\n${row.games} ${unit}・${row.wins} 勝 ${row.games - row.wins} 敗・勝率 ${g.winrate.toFixed(1)}%\n` +
                  (g.interval
                    ? `比基準 ${g.diff >= 0 ? "+" : ""}${g.diff.toFixed(1)}pp，95% 區間 ${g.interval[0].toFixed(0)}～${g.interval[1].toFixed(0)}pp${g.clear ? "（看得出差別）" : "（還在運氣範圍內）"}`
                    : `樣本不到 ${MIN_N} ${unit}，不下判斷`)
                : `${row.label}：沒有對局`
            }
            style={cols}
            className={cn(
              "grid w-full items-center gap-x-2 border-b border-border/50 px-0 text-left transition last:border-b-0 enabled:hover:bg-accent/60",
              gridCls,
              on && "rounded bg-primary/10 ring-1 ring-primary",
              g.interval === null && "opacity-70",
            )}
          >
            <span className={cn("truncate pl-1 text-[13px]", g.clear ? "font-semibold" : "font-medium", !row.games && "text-muted-foreground")}>
              {row.label}
            </span>
            <ForestTrack diff={g.interval ? g.diff : null} interval={g.interval} clear={g.clear} reach={reach} empty={row.games ? "樣本太少" : undefined} />
            {row.games ? (
              <>
                <span className={cn("text-right font-mono text-[13px] font-semibold tabular-nums", g.clear ? (g.diff > 0 ? "text-win" : "text-loss") : "text-foreground")}>
                  {g.winrate.toFixed(0)}%
                </span>
                {!compact && (
                  <span className={cn("text-right font-mono text-[11px] tabular-nums", diffCls, g.clear ? (g.diff > 0 ? "text-win" : "text-loss") : "text-muted-foreground")}>
                    {g.interval ? `${sign}${shown}pp` : "—"}
                  </span>
                )}
                <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">{row.games}</span>
              </>
            ) : (
              <span className={cn("col-span-2 text-right text-[11px] text-muted-foreground", !compact && "sm:col-span-3")}>—</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** 看得出差別的組，寫成一句話放在面板最上面：使用者先知道「所以呢」，再看圖 */
export function Findings({ items, empty }: { items: { label: string; diff: number }[]; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <p className="text-sm">
      看得出差別的：
      {items.map((x, i) => (
        <span key={x.label}>
          {i > 0 && "、"}
          <b className={x.diff > 0 ? "text-win" : "text-loss"}>
            {x.label} {x.diff > 0 ? "+" : ""}
            {x.diff.toFixed(0)}pp
          </b>
        </span>
      ))}
    </p>
  )
}
