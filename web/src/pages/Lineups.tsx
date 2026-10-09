import { useMemo, useState, type CSSProperties } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, Panel } from "@/components/primitives"
import { DrillPanel, MAX_GAME_IDS } from "@/components/MatchList"
import { BarChart, type BarDatum } from "@/components/charts"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useCube } from "@/hooks/useCube"
import { num, type CubeFilter, type CubeRow } from "@/lib/cube"
import { useCrumb } from "@/lib/breadcrumb"
import { usePageWho } from "@/lib/whoState"
import { useWhoScope, type Who } from "@/lib/who"
import { cn } from "@/lib/utils"

// 陣容是「整隊」的屬性，場次一律用隊伍粒度（participants.team_games）：
// 所有人模式下一隊五人各是一列，用 games 會把同一隊算五次。只看一個帳號時兩者相同。
const GAMES = "participants.team_games"
const WINS = "participants.team_wins"

// 分組與「前排」「物理／魔法」的定義在語意層（cube/model/cubes/comp_context.yml），這裡只決定怎麼畫。
// 桶的順序寫在這裡，是因為字串排序會把「3 個以上」「混合」排錯位置。
const MIX = ["物理為主", "混合", "魔法為主"]
const FACETS = {
  front: {
    label: "前排數",
    team: "comp_context.team_frontline",
    enemy: "comp_context.enemy_frontline",
    buckets: ["0 個", "1 個", "2 個", "3 個以上"],
  },
  mix: {
    label: "輸出組成",
    team: "comp_context.team_damage_mix",
    enemy: "comp_context.enemy_damage_mix",
    buckets: MIX,
  },
  support: {
    label: "輔助",
    team: "comp_context.team_support",
    enemy: "comp_context.enemy_support",
    buckets: ["有輔助", "沒有輔助"],
  },
  comp: {
    label: "陣容類型",
    team: "comp_context.team_comp",
    enemy: "comp_context.enemy_comp",
    buckets: ["0", "1", "2", "3+"].flatMap((f) => MIX.map((m) => `${f} 前排・${m}`)),
  },
} as const
type FacetId = keyof typeof FACETS

/** 樣本收斂：場次 = SHRINK 時顏色只有一半強度（和自由探索的交叉矩陣同一套） */
const SHRINK = 5

type Cell = { games: number; wins: number }
/** 聚焦的那一格／那一根長條。key 用來判斷「是不是同一個」（再點一次取消、亮起選中的格子） */
type Focus = { key: string; label: string; filters: CubeFilter[] }

/** 麵包屑與列表標題用的文字：「我方前排 2 個」「敵方物理為主」「我方 2 前排・混合」 */
const sideLabel = (facet: FacetId, side: "我方" | "敵方", value: string) =>
  facet === "front" ? `${side}前排 ${value}` : facet === "comp" ? `${side} ${value}` : `${side}${value}`

const n0 = (r: CubeRow | undefined, k: string) => (r ? (num(r[k]) ?? 0) : 0)
const wr = (c: Cell | undefined) => (c && c.games ? (100 * c.wins) / c.games : null)
const eq = (member: string, value: string): CubeFilter => ({ member, operator: "equals", values: [value] })

/** 只看一邊（合計格、陣容類型長條）的聚焦 */
function sideFocus(facet: FacetId, side: "team" | "enemy", value: string): Focus {
  return {
    key: `${facet}|${side}|${value}`,
    label: sideLabel(facet, side === "team" ? "我方" : "敵方", value),
    filters: [eq(FACETS[facet][side], value)],
  }
}

/** 相對整體勝率的好壞 → 勝／敗色，差 30 個百分點算滿強度，場次少的變淡。 */
function tint(cell: Cell | undefined, baseline: number | null): CSSProperties | undefined {
  const v = wr(cell)
  if (!cell || v === null || baseline === null) return undefined
  const strength = Math.min(1, Math.abs(v - baseline) / 30) * (cell.games / (cell.games + SHRINK))
  const color = v >= baseline ? "var(--win)" : "var(--loss)"
  return { backgroundColor: `color-mix(in oklab, ${color} ${Math.round(strength * 55)}%, transparent)` }
}

/** 一格：勝率 + 場次。點下去列出那幾場。 */
function MatrixCell({
  cell,
  baseline,
  unit,
  title,
  selected,
  strong,
  onPick,
}: {
  cell: Cell | undefined
  baseline: number | null
  unit: string
  title: string
  selected: boolean
  strong?: boolean
  onPick: () => void
}) {
  if (!cell || !cell.games) return <td className="px-2 py-1.5 text-center text-muted-foreground">·</td>
  const v = wr(cell)
  return (
    <td className="p-0.5">
      <button
        onClick={onPick}
        style={tint(cell, baseline)}
        title={`${title}：${cell.games} ${unit} ${cell.wins} 勝`}
        className={cn(
          "flex w-full flex-col items-center rounded px-1.5 py-1 font-mono tabular-nums transition",
          "hover:ring-1 hover:ring-primary focus-visible:ring-1 focus-visible:ring-primary",
          selected && "ring-2 ring-primary",
        )}
      >
        <span className={cn("text-[13px]", strong ? "font-bold" : "font-semibold")}>{v === null ? "—" : `${v.toFixed(0)}%`}</span>
        <span className="text-[10px] text-muted-foreground">
          {cell.games} {unit}
        </span>
      </button>
    </td>
  )
}

/** 我方 × 敵方的對陣矩陣，外加兩個合計：每一列最右邊是「我方這種陣容」整體，最下面一列是「遇到這種敵方」整體。
 *  一隊只會落在一格（陣容是整隊的屬性），所以合計可以直接由格子加總。 */
function Matrix({
  facet,
  rows,
  baseline,
  unit,
  focus,
  onPick,
}: {
  facet: FacetId
  rows: CubeRow[]
  baseline: number | null
  unit: string
  focus: Focus | null
  onPick: (focus: Focus) => void
}) {
  const f = FACETS[facet]
  const grid = useMemo(() => {
    const cells = new Map<string, Cell>()
    const mine = new Map<string, Cell>()
    const theirs = new Map<string, Cell>()
    const add = (m: Map<string, Cell>, k: string, g: number, w: number) => {
      const c = m.get(k) ?? { games: 0, wins: 0 }
      m.set(k, { games: c.games + g, wins: c.wins + w })
    }
    for (const r of rows) {
      const t = String(r[f.team])
      const e = String(r[f.enemy])
      const g = n0(r, GAMES)
      const w = n0(r, WINS)
      cells.set(JSON.stringify([t, e]), { games: g, wins: w })
      add(mine, t, g, w)
      add(theirs, e, g, w)
    }
    // 沒出現過的類型整列／整欄省掉（陣容類型有 12 種，只看自己時常常缺幾種）
    return {
      cells,
      mine,
      theirs,
      rowKeys: f.buckets.filter((b) => mine.has(b)),
      colKeys: f.buckets.filter((b) => theirs.has(b)),
    }
  }, [rows, f])

  const isFocus = (key: string) => focus?.key === key
  const pickCell = (t: string, e: string) =>
    onPick({
      key: `${facet}|${t}|${e}`,
      label: `${sideLabel(facet, "我方", t)} × ${sideLabel(facet, "敵方", e)}`,
      filters: [eq(f.team, t), eq(f.enemy, e)],
    })
  const pickRow = (t: string) => onPick(sideFocus(facet, "team", t))
  const pickCol = (e: string) => onPick(sideFocus(facet, "enemy", e))

  return (
    <div className="max-h-[620px] overflow-auto rounded-lg border">
      <table className="border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 top-0 z-20 border-b border-r bg-card px-3 py-2 text-left font-medium whitespace-nowrap text-muted-foreground">
              我方{f.label} ╲ 敵方{f.label}
            </th>
            {grid.colKeys.map((e) => (
              <th key={e} className="sticky top-0 z-10 min-w-[76px] border-b bg-card px-2 py-2 text-center font-medium whitespace-nowrap text-muted-foreground">
                {e}
              </th>
            ))}
            <th className="sticky top-0 z-10 min-w-[76px] border-b border-l bg-card px-2 py-2 text-center font-semibold whitespace-nowrap">
              我方合計
            </th>
          </tr>
        </thead>
        <tbody>
          {grid.rowKeys.map((t) => (
            <tr key={t}>
              <th className="sticky left-0 z-10 border-r bg-card px-3 py-1.5 text-left font-medium whitespace-nowrap">{t}</th>
              {grid.colKeys.map((e) => (
                <MatrixCell
                  key={e}
                  cell={grid.cells.get(JSON.stringify([t, e]))}
                  baseline={baseline}
                  unit={unit}
                  title={`我方 ${t} × 敵方 ${e}`}
                  selected={isFocus(`${facet}|${t}|${e}`)}
                  onPick={() => pickCell(t, e)}
                />
              ))}
              <MatrixCell
                cell={grid.mine.get(t)}
                baseline={baseline}
                unit={unit}
                title={`我方 ${t}（不論敵方）`}
                selected={isFocus(sideFocus(facet, "team", t).key)}
                strong
                onPick={() => pickRow(t)}
              />
            </tr>
          ))}
          <tr>
            <th className="sticky left-0 z-10 border-r border-t bg-card px-3 py-1.5 text-left font-semibold whitespace-nowrap">遇到的敵方合計</th>
            {grid.colKeys.map((e) => (
              <MatrixCell
                key={e}
                cell={grid.theirs.get(e)}
                baseline={baseline}
                unit={unit}
                title={`敵方 ${e}（不論我方）`}
                selected={isFocus(sideFocus(facet, "enemy", e).key)}
                strong
                onPick={() => pickCol(e)}
              />
            ))}
            <td className="border-l" />
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function Lineups() {
  const [who, setWhoState] = usePageWho()
  const scope = useWhoScope(who)
  const apply = scope.q
  const [facet, setFacet] = useState<FacetId>("front")
  const [focus, setFocus] = useState<Focus | null>(null)
  const setWho = (next: Who) => {
    setWhoState(next)
    setFocus(null)
  }
  const pick = (next: Focus) => setFocus((cur) => (cur?.key === next.key ? null : next))
  useCrumb(10, focus?.label ?? null, () => setFocus(null))

  const f = FACETS[facet]
  const unit = who === "account" ? "場" : "隊"
  const noTracked = who === "tracked" && !scope.trackedCount

  const overall = useCube(apply({ measures: [GAMES, WINS] }))
  const total = n0(overall.rows[0], GAMES)
  const baseline = total ? (100 * n0(overall.rows[0], WINS)) / total : null

  const matrix = useCube(apply({ measures: [GAMES, WINS], dimensions: [f.team, f.enemy], limit: 10000 }))
  const mineByType = useCube(apply({ measures: [GAMES, WINS], dimensions: [FACETS.comp.team], limit: 100 }))
  const theirsByType = useCube(apply({ measures: [GAMES, WINS], dimensions: [FACETS.comp.enemy], limit: 100 }))
  const bars = (rows: CubeRow[], dim: string): BarDatum[] =>
    rows
      .map((r) => ({ label: String(r[dim]), value: wr({ games: n0(r, GAMES), wins: n0(r, WINS) }) ?? 0, games: n0(r, GAMES) }))
      .sort((a, b) => b.value - a.value || b.games - a.games)

  // 逐場列表。只看一個帳號：一場就是一列，直接用 game_ids。
  // 追蹤對象／所有人：一格要列的是「那一隊」，但同一場另一隊的人也在 game_ids 裡。
  // 改成向 Cube 要這一格的參賽者，每隊挑一位（編號最小的）當代表，用 participants 精準列出；
  // 列數因此等於格子上的隊伍數。
  const drillQuery = focus
    ? who === "account"
      ? apply({ measures: [GAMES], dimensions: ["matches.game_id"], filters: focus.filters, limit: MAX_GAME_IDS })
      : apply({
          measures: [GAMES],
          dimensions: ["participants.participant_key", "participants.team_side"],
          filters: focus.filters,
          limit: MAX_GAME_IDS * 5,
        })
    : null
  const oneMemberPerTeam = (rows: CubeRow[]) => {
    const best = new Map<string, [number, number]>()
    for (const r of rows) {
      const [, game, pid] = String(r["participants.participant_key"]).split(":")
      const team = `${game}|${r["participants.team_side"]}`
      const cur = best.get(team)
      if (!cur || Number(pid) < cur[1]) best.set(team, [Number(game), Number(pid)])
    }
    const picks = [...best.values()].slice(0, MAX_GAME_IDS)
    return picks.length ? { params: { puuid: "*", participants: picks.map(([g, p]) => `${g}:${p}`).join(",") }, count: picks.length } : null
  }

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} />
      {noTracked ? (
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的陣容數據。</EmptyState>
      ) : (
        <>
          <Panel
            title="陣容對陣"
            caption={`列是我方（含${who === "account" ? "你" : "那位玩家"}自己）的陣容、欄是敵方的陣容，每格是那種對陣下的勝率。顏色和整體 ${baseline === null ? "—" : `${baseline.toFixed(1)}%`} 比，場次少的格子顏色會變淡。最右一欄、最下一列是合計。點任一格列出那幾場${
              who === "all" ? "。「所有人」是每一場的兩隊都算，所以矩陣對稱：A 打 B 的勝率 + B 打 A 的勝率 = 100%，對角線是 50%" : ""
            }`}
            action={
              <div role="radiogroup" aria-label="比較的面向" className="flex shrink-0 rounded-lg border bg-muted/40 p-0.5">
                {(Object.keys(FACETS) as FacetId[]).map((id) => (
                  <button
                    key={id}
                    role="radio"
                    aria-checked={facet === id}
                    onClick={() => {
                      setFacet(id)
                      setFocus(null)
                    }}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium whitespace-nowrap transition",
                      facet === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {FACETS[id].label}
                  </button>
                ))}
              </div>
            }
          >
            {matrix.loading || overall.loading ? (
              <Skeleton className="h-[260px] w-full" />
            ) : matrix.error ? (
              <div className="text-sm text-destructive">{matrix.error}</div>
            ) : !matrix.rows.length ? (
              <EmptyState>這個條件下還沒有對局。</EmptyState>
            ) : (
              <div className="reveal">
                <Matrix facet={facet} rows={matrix.rows} baseline={baseline} unit={unit} focus={focus} onPick={pick} />
              </div>
            )}
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              前排＝出裝是坦克、AD 鬥士或 AP 鬥士的人。輸出組成看出裝定位：物理（AD 鬥士／輸出／刺客）比魔法（AP 鬥士／輸出／刺客）多 2 人以上是「物理為主」，
              反過來是「魔法為主」，其餘「混合」。出裝定位依終場裝備判斷，太早結束沒成形的不算任何一類。
              這是「出現過這種陣容的場次」，不是因果：前排多的一方也可能是因為打得久、裝備出得齊。
            </p>
          </Panel>

          {focus && (
            <DrillPanel
              title={focus.label}
              gameIdKey="matches.game_id"
              query={drillQuery}
              showPlayer={who !== "account"}
              rowsToParams={who === "account" ? undefined : oneMemberPerTeam}
              onClose={() => setFocus(null)}
            />
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="我方陣容類型"
              caption="前排數 × 輸出組成。長條末端是場次（追蹤對象、所有人模式下一隊算一場）；顏色和整體勝率比，場次少的往平均收斂。點長條列出那幾場"
              index={1}
            >
              {mineByType.loading ? (
                <Skeleton className="h-[320px] w-full" />
              ) : (
                <BarChart
                  data={bars(mineByType.rows, FACETS.comp.team)}
                  suffix="%"
                  showGames
                  baseline={baseline ?? undefined}
                  selected={focus?.key.startsWith("comp|team|") ? focus.key.slice("comp|team|".length) : null}
                  onPick={(label) => pick(sideFocus("comp", "team", label))}
                />
              )}
            </Panel>
            <Panel
              title="遇到的敵方陣容類型"
              caption="對上這種敵方陣容時（不論我方）的勝率。點長條列出那幾場"
              index={2}
            >
              {theirsByType.loading ? (
                <Skeleton className="h-[320px] w-full" />
              ) : (
                <BarChart
                  data={bars(theirsByType.rows, FACETS.comp.enemy)}
                  suffix="%"
                  showGames
                  baseline={baseline ?? undefined}
                  selected={focus?.key.startsWith("comp|enemy|") ? focus.key.slice("comp|enemy|".length) : null}
                  onPick={(label) => pick(sideFocus("comp", "enemy", label))}
                />
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}
