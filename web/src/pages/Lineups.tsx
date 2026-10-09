import { useMemo, useState, type CSSProperties } from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, Panel } from "@/components/primitives"
import { DrillPanel, MAX_GAME_IDS } from "@/components/MatchList"
import { GapForest, Findings, ForestAxis, ForestLegend, ForestTrack } from "@/components/GapForest"
import { binomialP, gapOf, reachOf, strengthOf, zFor, type GapRow, type Strength } from "@/lib/gap"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useCube } from "@/hooks/useCube"
import { num, type CubeFilter, type CubeRow } from "@/lib/cube"
import { useCrumb } from "@/lib/breadcrumb"
import { usePageWho } from "@/lib/whoState"
import { participantRows, useWhoScope, type Who, type WhoScope } from "@/lib/who"
import { BUILD_ROLES, NO_LIMIT } from "./shared"
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
/** level：team 是整隊的陣容（隊伍粒度），player 是某人的出裝（參賽者粒度），逐場列表的列法不同 */
type Focus = { key: string; label: string; filters: CubeFilter[]; level?: "team" | "player" }

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

/** 「這種陣容下出什麼裝」的陣容分組。和上面不同，這裡問的是「你進場時隊上已經有什麼」，
 *  所以隊友前排數不含自己（你出坦克，隊友前排數不會自動 +1）；敵方輸出組成看出裝，不看實際打出的傷害。 */
const BUILD_CONTEXTS = {
  ally_frontline: { label: "隊友前排數", dim: "comp_context.ally_frontline", buckets: ["0 個", "1 個", "2 個以上"], name: (b: string) => `隊友前排 ${b}` },
  enemy_frontline: { label: "敵方前排數", dim: "comp_context.enemy_frontline", buckets: ["0 個", "1 個", "2 個", "3 個以上"], name: (b: string) => `敵方前排 ${b}` },
  enemy_damage_mix: { label: "敵方輸出組成", dim: "comp_context.enemy_damage_mix", buckets: MIX, name: (b: string) => `敵方${b}` },
} as const
type BuildContextId = keyof typeof BUILD_CONTEXTS

/** 一邊（我方或敵方）的三種因素，各自是一組森林圖的列 */
const SIDE_FACETS: FacetId[] = ["front", "mix", "support"]

/** 陣容原型：先用常理定義「什麼樣的陣容應該強或弱」，再拿資料驗證。
 *  定義放在語意層（comp_context.team_archetype），這裡只決定怎麼畫。 */
const ARCHETYPES = [
  {
    id: "前排重",
    def: "坦克＋鬥士 3 個以上（坦克多、輸出少）",
    prior: "預期偏弱",
    why: "坦克多、輸出核心少：撐得久但殺不死人，大亂鬥推塔決勝要靠團戰輸出",
  },
  {
    id: "均衡",
    def: "前排與輸出都有",
    prior: "預期偏強",
    why: "前排扛得住、輸出也夠",
  },
  {
    id: "輸出多",
    def: "輸出核心 4 個以上（前排少）",
    prior: "沒有預期",
    why: "輸出高但前排薄，容易被集火；常理上說不準強弱",
  },
] as const

const VERDICT_CLASS: Record<Strength, string> = {
  強勢: "border-win/50 bg-win/15 text-win font-semibold",
  偏強: "border-dashed border-win/40 text-win",
  看不出: "border-dashed text-muted-foreground",
  偏弱: "border-dashed border-loss/40 text-loss",
  不強勢: "border-loss/50 bg-loss/15 text-loss font-semibold",
}

/** 每種原型的強弱：一個「所有隊伍」（兩隊都算，資料量最大）、一個「你們」（目前看誰的範圍）。
 *  判定只看所有隊伍；強勢／不強勢要區間（已依一次比較三組校正）整段在 50% 的同一邊才給。 */
function Archetypes({ who, scope }: { who: Who; scope: WhoScope }) {
  const allScope = useWhoScope("all")
  const dim = "comp_context.team_archetype"
  const all = useCube(allScope.q({ measures: [GAMES, WINS], dimensions: [dim] }))
  const mine = useCube(who === "all" ? null : scope.q({ measures: [GAMES, WINS], dimensions: [dim] }))
  // 對決實測：一場裡只有一邊是這種原型時，這一邊贏幾場。一場只算一次，不會有「兩隊互相對立、其實是同一個結果」的問題
  const perGame = useCube(allScope.q({ measures: [GAMES, WINS], dimensions: ["matches.game_id", dim], limit: NO_LIMIT }))

  const rowsOf = (rows: CubeRow[]): GapRow[] =>
    ARCHETYPES.map((a) => {
      const r = rows.find((x) => x[dim] === a.id)
      return { key: a.id, label: a.id, games: n0(r, GAMES), wins: n0(r, WINS) }
    })
  const allRows = rowsOf(all.rows)
  const mineRows = rowsOf(mine.rows)
  const total = allRows.reduce((a, r) => a + r.games, 0)
  const base = total ? (100 * allRows.reduce((a, r) => a + r.wins, 0)) / total : 50
  const mineTotal = mineRows.reduce((a, r) => a + r.games, 0)
  const mineBase = mineTotal ? (100 * mineRows.reduce((a, r) => a + r.wins, 0)) / mineTotal : 50
  const z = zFor(ARCHETYPES.length)
  const reach = Math.max(reachOf(allRows, base, z), who === "all" ? 0 : reachOf(mineRows, mineBase, z))

  const paired = ARCHETYPES.map((a) => {
    const lone = perGame.rows.filter((r) => r[dim] === a.id && n0(r, GAMES) === 1)
    const x = lone.reduce((acc, r) => acc + n0(r, WINS), 0)
    return { id: a.id, n: lone.length, x, p: binomialP(x, lone.length) }
  })

  const loading = all.loading || perGame.loading || (who !== "all" && mine.loading)
  const showMine = who !== "all"
  const grid = showMine
    ? "grid-cols-[minmax(0,6.5rem)_minmax(6rem,1fr)_4.5rem] lg:grid-cols-[13rem_5.5rem_minmax(10rem,1fr)_minmax(10rem,1fr)_5rem] lg:gap-x-8"
    : "grid-cols-[minmax(0,6.5rem)_minmax(6rem,1fr)_4.5rem] lg:grid-cols-[13rem_5.5rem_minmax(10rem,1fr)_5rem]"

  const cell = (row: GapRow, baseline: number, unit: string) => {
    const g = gapOf(row, baseline, z)
    return (
      <div>
        <ForestTrack diff={g.interval ? g.diff : null} interval={g.interval} clear={g.clear} reach={reach} empty={row.games ? "樣本太少" : undefined} />
        <div className="-mt-1 text-center font-mono text-[11px] tabular-nums text-muted-foreground">
          <b className={cn("text-xs", g.clear ? (g.diff > 0 ? "text-win" : "text-loss") : "text-foreground")}>{row.games ? `${g.winrate.toFixed(0)}%` : "—"}</b>
          ・{row.games} {unit}
        </div>
      </div>
    )
  }

  return (
    <Panel
      title="陣容強弱：哪些陣容強勢、哪些不強勢"
      caption="先用常理把一隊分成三種原型，再看資料同不同意。判定看「所有隊伍」（每場兩隊都算，資料量最大）；「你們」是目前『看誰』的範圍。區間整段在 50% 同一邊才寫強勢／不強勢，差 3 個百分點以上但還分不出的寫偏強／偏弱"
    >
      {loading ? (
        <Skeleton className="h-[260px] w-full" />
      ) : !total ? (
        <EmptyState>這個條件下還沒有對局。</EmptyState>
      ) : (
        <div className="reveal space-y-4">
          <div className="max-w-[64rem]">
            <div className={cn("grid items-end gap-x-3", grid)}>
              <span className="pb-1 text-[11px] text-muted-foreground">陣容原型</span>
              <span className="hidden pb-1 text-[11px] text-muted-foreground lg:block">常理預期</span>
              <div>
                <div className="text-center text-[11px] font-medium">所有隊伍（兩隊都算）</div>
                <ForestAxis reach={reach} center={`${base.toFixed(0)}%`} compact />
              </div>
              {showMine && (
                <div className="hidden lg:block">
                  <div className="text-center text-[11px] font-medium">你們（目前範圍）</div>
                  <ForestAxis reach={reach} center={`${mineBase.toFixed(0)}%`} compact />
                </div>
              )}
              <span className="pb-1 text-right text-[11px] text-muted-foreground">資料判定</span>
            </div>
            {ARCHETYPES.map((a, i) => {
              const row = allRows[i]
              const g = gapOf(row, base, z)
              const verdict = strengthOf(g)
              return (
                <div
                  key={a.id}
                  data-testid="archetype-row"
                  data-games={row.games}
                  data-wins={row.wins}
                  data-verdict={verdict}
                  className={cn("grid items-center gap-x-3 border-b border-border/50 last:border-b-0", grid)}
                >
                  <div className="min-w-0 py-1.5">
                    <div className="text-[13px] font-semibold">{a.id}</div>
                    <div className="text-[11px] leading-snug text-muted-foreground">{a.def}</div>
                  </div>
                  <span className="hidden lg:block" title={a.why}>
                    <span className="rounded border border-dashed px-1.5 py-0.5 text-[11px] text-muted-foreground">{a.prior}</span>
                  </span>
                  {cell(row, base, "隊")}
                  {showMine && <div className="hidden lg:block">{cell(mineRows[i], mineBase, "隊")}</div>}
                  <span className="text-right">
                    <span className={cn("rounded border px-1.5 py-0.5 text-[11px]", VERDICT_CLASS[verdict])}>{verdict}</span>
                  </span>
                </div>
              )
            })}
          </div>
          <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
            <p data-testid="archetype-paired">
              <b className="text-foreground">對決實測</b>（一場裡只有一邊是這種原型時，這一邊贏幾場；每場只算一次）：
              {paired.map((x, i) => (
                <span key={x.id}>
                  {i > 0 && "；"}
                  {x.id} {x.x}/{x.n}（{x.n ? ((100 * x.x) / x.n).toFixed(0) : "—"}%，p = {x.p.toFixed(3)}）
                </span>
              ))}
              。
            </p>
            <p>
              原型只看出裝定位，不看打出多少傷害（那是結果）。「所有隊伍」的勝率合起來必然是 50%（一場一勝一敗）；
              只有一邊的場次樣本小時，「你們」那欄會很寬，別硬讀。方法與數字見 docs/lineup-winrate.md。
            </p>
          </div>
        </div>
      )}
    </Panel>
  )
}

export function Lineups() {
  const [who, setWhoState] = usePageWho()
  const scope = useWhoScope(who)
  const apply = scope.q
  const [facet, setFacet] = useState<FacetId>("front")
  const [showMatrix, setShowMatrix] = useState(false)
  const [buildCtx, setBuildCtx] = useState<BuildContextId>("ally_frontline")
  const [focus, setFocus] = useState<Focus | null>(null)
  const setWho = (next: Who) => {
    setWhoState(next)
    setFocus(null)
  }
  const pick = (next: Focus) => setFocus((cur) => (cur?.key === next.key ? null : next))
  useCrumb(10, focus?.label ?? null, () => setFocus(null))

  const unit = who === "account" ? "場" : "隊"
  const noTracked = who === "tracked" && !scope.trackedCount

  // ── 一、什麼陣容比較會贏：陣容是整隊的屬性，用隊伍粒度（一隊只算一次，同隊好幾位追蹤對象也是一隊）
  const overall = useCube(apply({ measures: [GAMES, WINS] }))
  const total = n0(overall.rows[0], GAMES)
  const baseline = total ? (100 * n0(overall.rows[0], WINS)) / total : null
  const byFacet = {
    front: useCube(apply({ measures: [GAMES, WINS], dimensions: [FACETS.front.team, FACETS.front.enemy], limit: 10000 })),
    mix: useCube(apply({ measures: [GAMES, WINS], dimensions: [FACETS.mix.team, FACETS.mix.enemy], limit: 10000 })),
    support: useCube(apply({ measures: [GAMES, WINS], dimensions: [FACETS.support.team, FACETS.support.enemy], limit: 10000 })),
  }
  const sideRows = (id: FacetId, side: "team" | "enemy"): GapRow[] => {
    const f = FACETS[id]
    const dim = f[side]
    return f.buckets.map((b) => {
      const rows = byFacet[id as "front" | "mix" | "support"].rows.filter((r) => r[dim] === b)
      return {
        key: `${id}|${side}|${b}`,
        label: id === "front" ? `前排 ${b}` : b,
        games: rows.reduce((a, r) => a + n0(r, GAMES), 0),
        wins: rows.reduce((a, r) => a + n0(r, WINS), 0),
      }
    })
  }
  // 所有人模式下兩隊都算，敵方那一邊就是我方的鏡像（A 打 B 的勝率 + B 打 A 的 = 100%），只畫一邊
  const sides: ("team" | "enemy")[] = who === "all" ? ["team"] : ["team", "enemy"]
  const allSideRows = sides.flatMap((s) => SIDE_FACETS.flatMap((id) => sideRows(id, s)))
  const sideReach = baseline === null ? 20 : reachOf(allSideRows, baseline)
  const sideFindings =
    baseline === null
      ? []
      : sides.flatMap((s) =>
          SIDE_FACETS.flatMap((id) =>
            sideRows(id, s)
              .map((r) => ({ r, g: gapOf(r, baseline) }))
              .filter((x) => x.g.clear)
              .map((x) => ({ label: sideLabel(id, s === "team" ? "我方" : "敵方", x.r.key.split("|")[2]), diff: x.g.diff })),
          ),
        )
  const sideLoading = overall.loading || byFacet.front.loading || byFacet.mix.loading || byFacet.support.loading

  // ── 二、對陣矩陣（細看）
  const matrix = byFacet[facet as "front" | "mix" | "support"]

  // ── 三、這種陣容下出什麼裝：每個人自己的出裝，用參賽者粒度
  const ctx = BUILD_CONTEXTS[buildCtx]
  const playerOverall = useCube(apply({ measures: ["participants.games", "participants.wins"] }))
  const pGames = n0(playerOverall.rows[0], "participants.games")
  const playerBase = pGames ? (100 * n0(playerOverall.rows[0], "participants.wins")) / pGames : null
  const builds = useCube(
    apply({ measures: ["participants.games", "participants.wins"], dimensions: ["builds.build_role", ctx.dim], limit: NO_LIMIT }),
  )
  const buildRows = (bucket: string): GapRow[] =>
    BUILD_ROLES.map((role) => {
      const r = builds.rows.find((x) => x["builds.build_role"] === role && x[ctx.dim] === bucket)
      return { key: `build|${buildCtx}|${bucket}|${role}`, label: role, games: n0(r, "participants.games"), wins: n0(r, "participants.wins") }
    })
  const allBuildRows = ctx.buckets.flatMap((b) => buildRows(b))
  const buildReach = playerBase === null ? 20 : reachOf(allBuildRows, playerBase)
  const buildFindings =
    playerBase === null
      ? []
      : ctx.buckets.flatMap((b) =>
          buildRows(b)
            .map((r) => ({ r, g: gapOf(r, playerBase) }))
            .filter((x) => x.g.clear)
            .map((x) => ({ label: `${ctx.name(b)}時出${x.r.label}`, diff: x.g.diff })),
        )

  // 逐場列表。陣容（隊伍粒度）：只看一個帳號時一場一列，直接用 game_ids；
  // 追蹤對象／所有人時同一場另一隊的人也在 game_ids 裡，改向 Cube 要這一格的參賽者，每隊挑一位（編號最小的）當代表。
  // 出裝（參賽者粒度）：每一列就是「那個人那一場」，追蹤對象／所有人時用參賽者鍵列出圖上算進去的那幾列。
  const drillQuery = !focus
    ? null
    : who === "account"
      ? apply({ measures: [GAMES], dimensions: ["matches.game_id"], filters: focus.filters, limit: MAX_GAME_IDS })
      : apply({
          measures: [GAMES],
          dimensions: focus.level === "player" ? ["participants.participant_key"] : ["participants.participant_key", "participants.team_side"],
          filters: focus.filters,
          limit: focus.level === "player" ? MAX_GAME_IDS : MAX_GAME_IDS * 5,
        })
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

  const pickSide = (row: GapRow) => {
    const [id, side, value] = row.key.split("|") as [FacetId, "team" | "enemy", string]
    pick({ ...sideFocus(id, side, value), key: row.key })
  }
  const pickBuild = (bucket: string) => (row: GapRow) =>
    pick({
      key: row.key,
      label: `${ctx.name(bucket)}・${row.label}`,
      filters: [eq(ctx.dim, bucket), eq("builds.build_role", row.label)],
      level: "player",
    })

  const sideTitle = (s: "team" | "enemy") => (who === "all" ? "一隊的陣容" : s === "team" ? `我方（含${who === "account" ? "你" : "那位玩家"}自己）` : "敵方")
  const facetTitle: Record<FacetId, string> = { front: "前排數", mix: "輸出組成", support: "輔助", comp: "陣容類型" }

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} />
      {noTracked ? (
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的陣容數據。</EmptyState>
      ) : (
        <>
          <Archetypes who={who} scope={scope} />
          <Panel
            title="拆開看：各項陣容條件"
            caption={`每一列是一種陣容：點是那種陣容的勝率比整體 ${baseline === null ? "—" : `${baseline.toFixed(1)}%`} 高或低幾個百分點，線是 95% 區間。${
              who === "account" ? "" : "一隊只算一次（同隊好幾位追蹤對象也是一隊）。"
            }${who === "all" ? "所有人模式下兩隊都算，敵方就是我方的鏡像，所以只畫一邊。" : ""}點一列看那些場次`}
          >
            {sideLoading || baseline === null ? (
              <Skeleton className="h-[420px] w-full" />
            ) : !total ? (
              <EmptyState>這個條件下還沒有對局。</EmptyState>
            ) : (
              <div className="reveal space-y-4">
                <Findings items={sideFindings} empty="目前沒有任何一種陣容看得出差別：差距都還在樣本誤差內，再累積一些場次再看。" />
                <ForestLegend />
                <div className={cn("grid gap-x-8 gap-y-4", sides.length > 1 && "lg:grid-cols-2")}>
                  {sides.map((s) => (
                    <div key={s} className="space-y-2">
                      <div className="text-sm font-semibold">{sideTitle(s)}</div>
                      {SIDE_FACETS.map((id, i) => (
                        <div key={id}>
                          <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{facetTitle[id]}</div>
                          <GapForest rows={sideRows(id, s)} baseline={baseline} reach={sideReach} unit={unit} selected={focus?.key} onPick={pickSide} showAxis={i === 0} />
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  前排＝出裝是坦克、AD 鬥士或 AP 鬥士的人。輸出組成看出裝定位：物理（AD 鬥士／輸出／刺客）比魔法（AP 鬥士／輸出／刺客）多 2 人以上是「物理為主」，
                  反過來是「魔法為主」，其餘「混合」。出裝定位依終場裝備判斷，太早結束沒成形的不算任何一類。
                  這是「出現過這種陣容的場次」，不是因果：前排多的一方也可能是因為打得久、裝備出得齊。
                </p>
              </div>
            )}
          </Panel>

          <Panel
            title="這種陣容下出什麼裝"
            caption={`選一種陣容分組，每一欄是一種情況，列是出裝定位，點是那樣出的勝率比${who === "account" ? "你" : ""}整體 ${playerBase === null ? "—" : `${playerBase.toFixed(1)}%`} 高或低幾個百分點。隊友前排數不含自己（問的是你進場時隊上已經有什麼）。一個人幾百場攤到這麼多格，大部分會是灰色——那是誠實的「還看不出來」，不是沒有差別。點一列看那些場次`}
            action={
              <ToggleGroup type="single" size="sm" variant="outline" value={buildCtx} onValueChange={(v) => {
                if (!v) return
                setBuildCtx(v as BuildContextId)
                setFocus(null)
              }}>
                {(Object.keys(BUILD_CONTEXTS) as BuildContextId[]).map((k) => (
                  <ToggleGroupItem key={k} value={k}>
                    {BUILD_CONTEXTS[k].label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            }
          >
            {builds.loading || playerOverall.loading || playerBase === null ? (
              <Skeleton className="h-[300px] w-full" />
            ) : (
              <div className="reveal space-y-3">
                <Findings items={buildFindings} empty="這種分組下還沒有看得出差別的出裝。" />
                <ForestLegend better={`比${who === "account" ? "你" : ""}整體好`} worse={`比${who === "account" ? "你" : ""}整體差`} />
                <div className={cn("grid gap-x-8 gap-y-4 md:grid-cols-2", ctx.buckets.length === 3 ? "lg:grid-cols-3" : "xl:grid-cols-4")}>
                  {ctx.buckets.map((b) => {
                    const rows = buildRows(b)
                    const n = rows.reduce((a, r) => a + r.games, 0)
                    return (
                      <div key={b} data-testid="build-context">
                        <div className="mb-1 flex items-baseline justify-between text-sm font-semibold">
                          {ctx.name(b)}
                          <span className="font-mono text-[11px] font-normal text-muted-foreground">{n} 場</span>
                        </div>
                        <GapForest rows={rows} baseline={playerBase} reach={buildReach} selected={focus?.key} onPick={pickBuild(b)} labelWidth="4.5rem" compact />
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </Panel>

          {focus && (
            <DrillPanel
              title={focus.label}
              gameIdKey="matches.game_id"
              query={drillQuery}
              showPlayer={who !== "account"}
              rowsToParams={who === "account" ? undefined : focus.level === "player" ? participantRows : oneMemberPerTeam}
              onClose={() => setFocus(null)}
            />
          )}

          <Panel
            title="細看：我方 × 敵方對陣"
            caption={`列是我方的陣容、欄是敵方的陣容，每格是那種對陣下的勝率。格子多、每格場次少，適合找特定組合，不適合下結論。點任一格列出那幾場${
              who === "all" ? "。所有人模式下矩陣對稱：A 打 B 的勝率 + B 打 A 的勝率 = 100%" : ""
            }`}
            action={
              <div className="flex items-center gap-2">
                {showMatrix && (
                  <div role="radiogroup" aria-label="比較的面向" className="flex shrink-0 rounded-lg border bg-muted/40 p-0.5">
                    {SIDE_FACETS.map((id) => (
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
                )}
                <button
                  type="button"
                  onClick={() => setShowMatrix((v) => !v)}
                  className="rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
                >
                  {showMatrix ? "收起" : "展開矩陣"}
                </button>
              </div>
            }
          >
            {!showMatrix ? null : matrix.loading || overall.loading ? (
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
          </Panel>
        </>
      )}
    </div>
  )
}
