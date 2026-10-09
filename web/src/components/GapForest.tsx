import { cn } from "@/lib/utils"
import { MIN_N, gapOf, type GapRow } from "@/lib/gap"

export type { GapRow }

/** 勝率差的森林圖：一列一組，點是「這組勝率 − 基準」，線是 95% 區間，中線是基準。
 *  只有區間整段在基準同一邊才上勝敗色——其他再大的差距也可能只是運氣，畫成灰色。
 *  和節奏頁的逐人落差同一種讀法。 */
export function GapForest({
  rows,
  baseline,
  reach,
  unit = "場",
  selected,
  onPick,
  labelWidth = "minmax(0,7rem)",
  showAxis = true,
}: {
  rows: GapRow[]
  baseline: number
  reach: number
  unit?: string
  selected?: string | null
  onPick?: (row: GapRow) => void
  /** 第一欄（組名）的寬度，CSS grid 的軌道寫法 */
  labelWidth?: string
  /** 同一欄疊好幾組時，只有最上面那組畫刻度 */
  showAxis?: boolean
}) {
  const at = (v: number) => `${((Math.max(-reach, Math.min(reach, v)) + reach) / (2 * reach)) * 100}%`
  const cols = { gridTemplateColumns: `${labelWidth} minmax(0,1fr) 5.5rem` }
  return (
    <div>
      {showAxis && (
      <div className="mb-0.5 grid items-end gap-x-2 text-[10px] text-muted-foreground" style={cols}>
        <span />
        <div className="flex justify-between font-mono tabular-nums">
          <span>-{reach}</span>
          <span>{baseline.toFixed(0)}%</span>
          <span>+{reach}</span>
        </div>
        <span />
      </div>
      )}
      {rows.map((row) => {
        const g = gapOf(row, baseline)
        const tone = !g.clear ? "bg-muted-foreground" : g.diff > 0 ? "bg-win" : "bg-loss"
        const on = selected === row.key
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
              "grid w-full items-center gap-x-2 rounded px-0 py-1 text-left transition enabled:hover:bg-accent",
              on && "bg-primary/10 ring-1 ring-primary",
            )}
          >
            <span className={cn("truncate text-[13px]", g.clear ? "font-semibold" : "font-medium", !row.games && "text-muted-foreground")}>
              {row.label}
            </span>
            <div className="relative h-4">
              <span className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/40" />
              {g.interval && (
                <>
                  <span
                    className={cn("absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full", tone, !g.clear && "opacity-60")}
                    style={{ left: at(g.interval[0]), width: `calc(${at(g.interval[1])} - ${at(g.interval[0])})` }}
                  />
                  <span
                    className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card", tone)}
                    style={{ left: at(g.diff) }}
                  />
                </>
              )}
              {!g.interval && row.games > 0 && (
                <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">樣本太少</span>
              )}
            </div>
            <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {row.games ? (
                <>
                  <b className={cn("text-xs", g.clear ? (g.diff > 0 ? "text-win" : "text-loss") : "text-foreground")}>{g.winrate.toFixed(0)}%</b>
                  ・{row.games}
                </>
              ) : (
                "—"
              )}
            </span>
          </button>
        )
      })}
    </div>
  )
}
