import { createContext, useContext, useMemo, useState, type CSSProperties } from "react"
import { BarCell, RecordCell, StatCell, solidMax, weightedAvg } from "@/components/cells"
import { ContribScore } from "@/components/Contribution"
import { PERF_GAP } from "@/hooks/useContribution"
import { Filter, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Kpi, Panel, EmptyState } from "@/components/primitives"
import { AgTable, type GridColumn } from "@/components/AgTable"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { CubeMatchList } from "@/components/MatchList"
import { RadarChart, type RadarDatum } from "@/components/charts"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, iconUrl, num, type CubeFilter, type CubeRow } from "@/lib/cube"
import { useFilters } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { DetailDrawer, useDrawerSettled } from "@/components/DetailDrawer"
import { cn } from "@/lib/utils"
import { MIN_GAMES, NO_LIMIT, round0, round1, round2 } from "./shared"
import { ROLE_SPEC, type RoleSpec } from "@/lib/roleBasis"
import { RoleChip } from "@/components/RoleChip"
import { WhoSwitch } from "@/components/WhoSwitch"
import { usePageWho } from "@/lib/whoState"
import { WHO_LABEL, useWhoScope, type Who, type WhoScope } from "@/lib/who"

const WhoContext = createContext<WhoScope | null>(null)
const useWho = () => {
  const ctx = useContext(WhoContext)
  if (!ctx) throw new Error("useWho 必須在英雄頁內使用")
  return ctx
}

/** 每隻英雄出過哪些出裝定位、各幾場（多到少） */
type RoleMix = Map<string, { role: string; games: number }[]>

const MEASURES = [
  "participants.games",
  "participants.wins",
  "participants.losses",
  "participants.winrate",
  "participants.kda",
  "participants.avg_kills",
  "participants.avg_deaths",
  "participants.avg_assists",
  "participants.dpm",
  "participants.gpm",
  "participants.kill_participation",
  "participants.damage_share",
  "participants.taken_per_min",
  "participants.mitigated_per_min",
  "participants.tank_share",
  "participants.cc_time_per_min",
  "participants.heal_per_min",
  "participants.multikill_rate",
  "participants.first_blood_rate",
  "participants.pentas",
  "contribution.perf",
  "contribution.score",
]

const n0 = (r: Record<string, unknown>, k: string) => num(r[k] as string | number | null) ?? 0
const opt = (r: Record<string, unknown>, k: string) => num(r[k] as string | number | null)

/** 10 欄一格一個數字 → 5 欄複合格子。被合併的原始欄位留成隱藏欄，匯出 CSV 仍帶得出來。
 *  資料條的最大值與平均線依目前資料算，所以欄位定義要跟著資料重建。 */
function buildColumns(rows: CubeRow[], overallWr: number | null, roleMix: RoleMix, baselineLabel: string): GridColumn[] {
  // 最大值只看樣本夠的英雄，免得一場打出 5000 的把整欄的條壓扁
  const solid = rows.filter((r) => n0(r, "participants.games") >= MIN_GAMES)
  const pool = solid.length ? solid : rows
  const maxDpm = Math.max(1, ...pool.map((r) => n0(r, "participants.dpm")))
  const totalGames = rows.reduce((a, r) => a + n0(r, "participants.games"), 0)
  const avgDpm = totalGames
    ? rows.reduce((a, r) => a + n0(r, "participants.dpm") * n0(r, "participants.games"), 0) / totalGames
    : null
  const maxTaken = solidMax(rows, "participants.taken_per_min", "participants.games", MIN_GAMES)
  const avgTaken = weightedAvg(rows, "participants.taken_per_min", "participants.games")
  // 戰績刻度一律是「整體勝率」（你的、追蹤對象的或所有人的），不從表格各列回推：六邊形篩成某一類之後，
  // 回推出來的會變成那一類的平均，刻度跟著移動，就看不出這一類整體是高是低
  const avgWr = overallWr

  return [
    {
      key: "champions.name",
      title: "英雄",
      kind: "dimension",
      iconKey: "champions.icon_path",
      flex: 1.4,
      minWidth: 150,
      pinned: "left",
      // 名稱下面是「你最常把它出成什麼」：同一隻英雄不同場可能不同，只列最多的那種，其餘寫在 title
      cell: (r) => {
        const name = String(r["champions.name"] ?? "—")
        const mix = roleMix.get(name) ?? []
        const total = mix.reduce((a, m) => a + m.games, 0)
        return (
          <span
            className="flex min-w-0 items-center gap-2"
            title={mix.length ? `出裝定位：${mix.map((m) => `${m.role} ${m.games} 場`).join("、")}` : undefined}
          >
            <img src={iconUrl(r["champions.icon_path"] as string)} alt="" className="size-7 shrink-0 rounded bg-icon-tile" />
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="truncate font-medium">{name}</span>
              {mix[0] && (
                <span className="flex items-center gap-1">
                  <RoleChip role={mix[0].role} className="text-[10px] leading-4" />
                  {mix.length > 1 && (
                    <span className="text-[10px] text-muted-foreground">{Math.round((100 * mix[0].games) / Math.max(1, total))}%</span>
                  )}
                </span>
              )}
            </span>
          </span>
        )
      },
    },
    { key: "participants.games", title: "場次", kind: "metric", format: round0, flex: 0.5, minWidth: 70 },
    {
      key: "participants.winrate",
      title: "戰績",
      kind: "metric",
      flex: 1.5,
      minWidth: 160,
      cell: (r) => (
        <RecordCell
          winrate={opt(r, "participants.winrate")}
          wins={n0(r, "participants.wins")}
          losses={n0(r, "participants.losses")}
          baseline={avgWr}
          baselineLabel={baselineLabel}
        />
      ),
    },
    {
      key: "participants.kda",
      title: "KDA",
      kind: "metric",
      flex: 1.2,
      minWidth: 150,
      cell: (r) => (
        <StatCell
          main={opt(r, "participants.kda")?.toFixed(2) ?? "—"}
          sub={`${round1(n0(r, "participants.avg_kills"))}/${round1(n0(r, "participants.avg_deaths"))}/${round1(n0(r, "participants.avg_assists"))} · 參團 ${Math.round(n0(r, "participants.kill_participation"))}%`}
        />
      ),
    },
    {
      key: "participants.dpm",
      title: "輸出（每分鐘傷害）",
      kind: "metric",
      flex: 2,
      minWidth: 195,
      cell: (r) => (
        <BarCell
          value={opt(r, "participants.dpm")}
          max={maxDpm}
          reference={avgDpm}
          label={round0(n0(r, "participants.dpm"))}
          sub={`傷害佔 ${round1(n0(r, "participants.damage_share"))}% · 經濟 ${round0(n0(r, "participants.gpm"))}`}
        />
      ),
    },
    {
      // 當局表現分：和同類型、同時長帶的人比，50 是中位數；隊內排名是另一個零和的分數，放在補充裡對照
      key: "contribution.perf",
      title: "表現",
      kind: "metric",
      flex: 0.7,
      minWidth: 90,
      cell: (r) => {
        const perf = opt(r, "contribution.perf")
        const rank = opt(r, "contribution.score")
        return (
          <StatCell
            main={<ContribScore dev={perf === null ? null : perf - 50} gap={PERF_GAP} className="text-sm font-semibold" />}
            sub={`隊內 ${rank === null ? "—" : Math.round(rank)}`}
          />
        )
      },
    },
    {
      key: "participants.taken_per_min",
      title: "承受（每分鐘傷害）",
      kind: "metric",
      flex: 1.6,
      minWidth: 190,
      cell: (r) => (
        <BarCell
          value={opt(r, "participants.taken_per_min")}
          max={maxTaken}
          reference={avgTaken}
          label={round0(n0(r, "participants.taken_per_min"))}
          sub={`減免 ${round0(n0(r, "participants.mitigated_per_min"))}/分 · 佔隊 ${round1(n0(r, "participants.tank_share"))}%`}
        />
      ),
    },
    {
      key: "participants.cc_time_per_min",
      title: "控場・治療",
      kind: "metric",
      flex: 1,
      minWidth: 120,
      cell: (r) => (
        <StatCell
          main={`${round1(n0(r, "participants.cc_time_per_min"))} 秒/分`}
          sub={`治療 ${round0(n0(r, "participants.heal_per_min"))}/分`}
        />
      ),
    },
    {
      key: "participants.multikill_rate",
      title: "多殺・首殺",
      kind: "metric",
      flex: 1,
      minWidth: 140,
      cell: (r) => (
        <StatCell
          main={`多殺 ${Math.round(n0(r, "participants.multikill_rate"))}%`}
          sub={`首殺 ${Math.round(n0(r, "participants.first_blood_rate"))}% · 五殺 ${round0(n0(r, "participants.pentas"))}`}
        />
      ),
    },
    { key: "participants.wins", title: "勝場", kind: "metric", hide: true },
    { key: "participants.losses", title: "敗場", kind: "metric", hide: true },
    { key: "participants.mitigated_per_min", title: "每分鐘減免傷害", kind: "metric", hide: true },
    { key: "participants.tank_share", title: "承受佔比", kind: "metric", hide: true },
    { key: "participants.heal_per_min", title: "每分鐘治療", kind: "metric", hide: true },
    { key: "participants.first_blood_rate", title: "首殺率", kind: "metric", hide: true },
    { key: "participants.pentas", title: "五殺次數", kind: "metric", hide: true },
    { key: "contribution.score", title: "隊內貢獻排名", kind: "metric", hide: true },
    { key: "participants.avg_kills", title: "平均擊殺", kind: "metric", hide: true },
    { key: "participants.avg_deaths", title: "平均死亡", kind: "metric", hide: true },
    { key: "participants.avg_assists", title: "平均助攻", kind: "metric", hide: true },
    { key: "participants.kill_participation", title: "參團率", kind: "metric", hide: true },
    { key: "participants.gpm", title: "每分鐘經濟", kind: "metric", hide: true },
    { key: "participants.damage_share", title: "傷害佔比", kind: "metric", hide: true },
  ]
}

/** 這隻英雄的出裝或增幅：一列一項，場次 + 那幾場的勝率。
 *
 *  勝率的比較基準是「這隻英雄的整體勝率」，不是 50%——寫在標題裡，
 *  不然 40% 看起來像很差，但這隻英雄本來就只有 35%。
 *  一律全部列出（查詢不設上限），太長就在框裡捲動。 */
function BuildList({
  title,
  caption,
  rows,
  loading,
  error,
  nameKey,
  iconKey,
  baseline,
}: {
  title: string
  caption: string
  rows: CubeRow[]
  loading: boolean
  error: string | null
  nameKey: string
  iconKey: string
  baseline: number | null
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-[11px] text-muted-foreground">{caption}</div>
      </div>
      {loading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : !rows.length ? (
        <EmptyState>這個條件下沒有資料。</EmptyState>
      ) : (
        <div className="max-h-[300px] space-y-1 overflow-y-auto pr-1">
          {rows.map((r, i) => {
            const label = String(r[nameKey] ?? "—")
            const games = n0(r, "participants.games")
            const wr = opt(r, "participants.winrate")
            const above = wr !== null && baseline !== null && wr >= baseline
            return (
              <div
                key={label}
                style={{ "--stagger": `${Math.min(i, 10) * 30}ms` } as CSSProperties}
                className="slide-in flex items-center gap-2.5 rounded-md px-1.5 py-1"
              >
                <img src={iconUrl(r[iconKey] as string)} alt="" className="size-7 shrink-0 rounded bg-icon-tile" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{games} 場</span>
                <span
                  className={cn(
                    "w-[52px] shrink-0 rounded border px-1 text-right text-[11px] tabular-nums",
                    wr === null || baseline === null
                      ? "border-border text-muted-foreground"
                      : above
                        ? "border-win/30 bg-win/10 text-win"
                        : "border-loss/30 bg-loss/10 text-loss",
                  )}
                >
                  {wr === null ? "—" : `${round1(wr)}%`}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 點了某隻英雄之後：右側抽屜（共用的 DetailDrawer），裡面是摘要 + 出裝與增幅 + 這隻英雄的每一場。
 *  表格留在原位、那一列保持選取，關掉就回到剛才的位置，也不會打亂六邊形的篩選。 */
function ChampionDrawer({ row, onClose }: { row: CubeRow | undefined; onClose: () => void }) {
  const { addDrill, drills } = useFilters()
  const { who } = useWho()
  const name = row ? String(row["champions.name"]) : ""
  const drilled = drills.some((d) => d.member === "champions.name" && d.values[0] === name)
  const games = row ? num(row["participants.games"]) : null
  return (
    <DetailDrawer
      open={!!row}
      onClose={onClose}
      title={name}
      subtitle={`${who === "account" ? "" : `${WHO_LABEL[who]} · `}${games === null ? "—" : round0(games)} 場 · 出裝、增幅與每一場`}
      icon={row ? iconUrl(row["champions.icon_path"] as string) : undefined}
      actions={
        <Button
          size="sm"
          variant="outline"
          disabled={drilled}
          onClick={() => addDrill({ member: "champions.name", operator: "equals", values: [name], label: `英雄：${name}` })}
        >
          <Filter className="size-3.5" />
          {drilled ? "其他頁已只看這隻" : "其他頁也只看這隻"}
        </Button>
      }
    >
      {row && <ChampionDetail key={name} row={row} />}
    </DetailDrawer>
  )
}

function ChampionDetail({ row }: { row: CubeRow }) {
  const { q: apply, who, matchParams } = useWho()
  const name = String(row["champions.name"])
  const onlyThis = useMemo(
    () => [{ member: "champions.name", operator: "equals" as const, values: [name] }],
    [name],
  )
  // 裝備排除第 7 格（飾品）：那格每場都一樣，擺進來只會佔掉第一名
  const items = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["items.name", "items.icon_path"],
      filters: [...onlyThis, { member: "items.slot", operator: "lt", values: ["6"] }],
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )
  const augments = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["augments.name", "augments.icon_path"],
      filters: onlyThis,
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )
  const metric = (key: string, fmt: (n: number) => string, suffix = "") => {
    const n = num(row[key])
    return n === null ? "—" : `${fmt(n)}${suffix}`
  }
  const winrate = num(row["participants.winrate"])
  // 逐場卡片等抽屜滑完才掛
  const slid = useDrawerSettled()

  return (
    <>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-5">
          <Kpi
            label="勝率"
            value={metric("participants.winrate", round1, "%")}
            hint={`${metric("participants.wins", round0)} 勝 ${metric("participants.losses", round0)} 敗`}
            tone={winrate === null ? undefined : winrate >= 50 ? "win" : "loss"}
          />
          <Kpi label="KDA" value={metric("participants.kda", round2)} />
          <Kpi label="每分鐘傷害" value={metric("participants.dpm", round0)} />
          <Kpi label="每分鐘經濟" value={metric("participants.gpm", round0)} />
          <Kpi label="傷害佔比" value={metric("participants.damage_share", round1, "%")} />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <BuildList
            title="最常出的裝備"
            caption={`對局結束時身上的裝備（不含飾品），依出現場次排序。勝率是帶著這件裝備收場的那幾場，和這隻英雄的整體 ${metric("participants.winrate", round1, "%")} 比`}
            rows={items.rows}
            loading={items.loading}
            error={items.error}
            nameKey="items.name"
            iconKey="items.icon_path"
            baseline={winrate}
          />
          <BuildList
            title="最常選的增幅"
            caption={`依選到的場次排序。勝率是選了這個增幅的那幾場，和這隻英雄的整體 ${metric("participants.winrate", round1, "%")} 比`}
            rows={augments.rows}
            loading={augments.loading}
            error={augments.error}
            nameKey="augments.name"
            iconKey="augments.icon_path"
            baseline={winrate}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          這兩份清單是「出現過這件裝備／這個增幅的場次」，不是因果：終場裝備同時受對局長短、經濟與勝負過程影響，
          場次少的那幾列只能當成看過什麼，不能當成建議。
        </p>
        {/* 是哪幾場由 Cube 用同一組條件查，上方的全域下鑽（增幅等）也會套到列表上 */}
        {slid ? (
          <CubeMatchList
            gameIdKey="matches.game_id"
            listKey={`${who}|${name}`}
            // 目前帳號以外：每一列是「那場玩這隻英雄的人」，卡片上標出是誰
            params={matchParams({ champion: name })}
            showPlayer={who !== "account"}
            query={apply({
              measures: ["participants.games"],
              dimensions: ["matches.game_id"],
              filters: onlyThis,
              limit: MAX_GAME_IDS,
            })}
          />
        ) : (
          <Skeleton className="h-[240px] w-full" />
        )}
    </>
  )
}


type RadarMode = "games" | "winrate"

/** 依定位篩的條件（給下面的表格用）。 */
function roleFilters(role: string | null, spec: RoleSpec): CubeFilter[] {
  return role ? spec.filterFor(role) : []
}

/** 左半邊：出裝定位雷達。點某一類（點那個方向的任何位置），右邊的英雄勝率與下面的表格就只剩那一類。 */
function RoleRadar({
  role,
  spec,
  baseline,
  totalGames,
  onRole,
}: {
  role: string | null
  spec: RoleSpec
  baseline: number | null
  totalGames: number
  onRole: (role: string | null) => void
}) {
  const { q: apply, baselineLabel } = useWho()
  const [mode, setMode] = useState<RadarMode>("games")
  const byRole = useCube(
    apply({
      measures: ["participants.games", "participants.wins", "participants.winrate"],
      dimensions: [spec.dimension],
      limit: NO_LIMIT,
    }),
  )

  // 沒玩過的類別也要留一個頂點（場次 0），雷達才不會少一角、換篩選時形狀才對得起來
  const data: RadarDatum[] = useMemo(
    () =>
      spec.labels.map((label) => {
        const r = byRole.rows.find((x) => x[spec.dimension] === label)
        return {
          label,
          games: r ? n0(r, "participants.games") : 0,
          wins: r ? n0(r, "participants.wins") : 0,
          winrate: r ? opt(r, "participants.winrate") : null,
        }
      }),
    [byRole.rows, spec],
  )

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">出裝定位</div>
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as RadarMode)}>
          <ToggleGroupItem value="games">形狀：場次</ToggleGroupItem>
          <ToggleGroupItem value="winrate">形狀：勝率</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {byRole.loading ? (
        <Skeleton className="h-[420px] w-full" />
      ) : byRole.error ? (
        <div className="text-sm text-destructive">{byRole.error}</div>
      ) : (
        <RadarChart
          data={data}
          mode={mode}
          baseline={baseline}
          total={totalGames}
          height={420}
          selected={role}
          onPick={(label) => onRole(role === label ? null : label)}
        />
      )}
      <p className="text-center text-[11px] text-muted-foreground">
        {mode === "games"
          ? `形狀是場次；頂點下是勝率與場次，比${baselineLabel}明顯高／低才上色（場次少的先往平均收斂）`
          : `形狀是勝率（外框 100%）；虛線圈是${baselineLabel} ${baseline?.toFixed(1) ?? "—"}%，頂點在圈外就是這類比平常會贏`}
        。點某一類的方向就篩選，再點一次取消
      </p>
    </div>
  )
}

export function Champions() {
  const [who, setWhoState] = usePageWho()
  const scope = useWhoScope(who)
  return (
    <WhoContext.Provider value={scope}>
      <ChampionsBody onWho={setWhoState} />
    </WhoContext.Provider>
  )
}

function ChampionsBody({ onWho }: { onWho: (who: Who) => void }) {
  const { q: apply, who, baselineLabel, trackedCount } = useWho()
  const [picked, setPicked] = useState<string | null>(null)
  const [role, setRoleState] = useState<string | null>(null)
  const spec = ROLE_SPEC
  // 定位是比英雄高一層的聚焦：換定位時，原本點開的那隻英雄可能已經不在這一類裡
  const setRole = (next: string | null) => {
    setRoleState(next)
    setPicked(null)
  }
  // 換「看誰」時開著的那隻英雄的數字整個不同了，關掉抽屜；定位篩選留著
  const setWho = (next: Who) => {
    onWho(next)
    setPicked(null)
  }
  const activeRole = role && spec.labels.includes(role) ? role : null
  const roleLabel = activeRole ? `出裝是${activeRole}` : null
  useCrumb(10, roleLabel, () => setRole(null))
  useCrumb(20, picked, () => setPicked(null))
  const { rows, loading, error } = useCube(
    apply({
      measures: MEASURES,
      dimensions: ["champions.name", "champions.icon_path"],
      filters: roleFilters(activeRole, spec),
      // 預設依場次：85 隻裡有 49 隻只玩過一場，依勝率排時前面全是一場 100% 的。表頭可以再改排序
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )
  // 比較基準另外查、不跟著定位篩選：六邊形的虛線圈與表格戰績條上的刻度是同一條「你的整體勝率」，
  // 篩成坦克之後才看得出坦克整體是高是低
  const overall = useCube(apply({ measures: ["participants.games", "participants.wins"] }))
  const totalGames = n0(overall.rows[0] ?? {}, "participants.games")
  const baseline = totalGames ? (100 * n0(overall.rows[0], "participants.wins")) / totalGames : null
  const pickedRow = picked ? rows.find((r) => r["champions.name"] === picked) : undefined
  // 欄位定義只在資料換了才重建，不然每次重畫 AG Grid 都會重新套欄位
  // 每隻英雄出過的出裝定位（不跟著定位篩選：篩成某一類時仍看得出這隻平常主要出什麼）
  const mixQuery = useCube(
    apply({ measures: ["participants.games"], dimensions: ["champions.name", "builds.build_role"], limit: NO_LIMIT }),
  )
  const roleMix: RoleMix = useMemo(() => {
    const m: RoleMix = new Map()
    for (const r of mixQuery.rows) {
      const name = String(r["champions.name"])
      const list = m.get(name) ?? []
      list.push({ role: String(r["builds.build_role"]), games: n0(r, "participants.games") })
      m.set(name, list)
    }
    for (const list of m.values()) list.sort((a, b) => b.games - a.games || a.role.localeCompare(b.role, "zh-Hant"))
    return m
  }, [mixQuery.rows])
  const columns = useMemo(() => buildColumns(rows, baseline, roleMix, baselineLabel), [rows, baseline, roleMix, baselineLabel])
  const noTracked = who === "tracked" && !trackedCount

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={trackedCount} />
      <ChampionDrawer row={pickedRow} onClose={() => setPicked(null)} />

      {/* 雷達與英雄表並排：原本右側還有一份「各英雄勝率」排行，和下面的表格是同一份 85 隻英雄、
          同樣的場次與戰績，只是少了 KDA、輸出、排序與匯出。拿掉它，雷達直接篩這張表 */}
      <Panel
        title="英雄"
        caption={`左邊雷達圖的分類：${spec.caption}。點某一類的方向，右邊的表就只剩那一類。點表格的一列看那隻英雄的出裝、增幅與每一場`}
      >
        {noTracked ? (
          <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的英雄數據。</EmptyState>
        ) : overall.error ? (
          <div className="text-sm text-destructive">{overall.error}</div>
        ) : !overall.loading && !totalGames ? (
          <EmptyState>這個條件下還沒有對局。</EmptyState>
        ) : (
          <div className="grid gap-6 min-[1500px]:grid-cols-[340px_minmax(0,1fr)]">
            {/* 表格欄位最小寬度加總約 1200px（KDA、輸出、承受的補充文字實測要 146／190px 才不被截斷），
                比容器寬的時候表格橫向捲動，英雄名那欄釘在左邊；1500px 以上的視窗雷達與表格並排，更窄就上下排 */}
            <RoleRadar role={activeRole} spec={spec} baseline={baseline} totalGames={totalGames} onRole={setRole} />

            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex min-h-8 flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">英雄表現</span>
                {activeRole ? (
                  // 聚焦狀態一定要有文字說明與看得到的清除鈕，不能只靠六邊形上的顏色
                  <button
                    onClick={() => setRole(null)}
                    className="flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs text-primary transition hover:bg-primary/15"
                  >
                    <Filter className="size-3" />
                    只看{roleLabel}
                    <X className="size-3" />
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">全部類型</span>
                )}
              </div>
              {loading ? (
                <Skeleton className="h-[560px] w-full" />
              ) : error ? (
                <div className="text-sm text-destructive">{error}</div>
              ) : (
                <AgTable
                  columns={columns}
                  rowHeight={54}
                  rows={rows}
                  height={560}
                  fileName="champions"
                  drillOn="click"
                  highlight={picked ? { key: "champions.name", value: picked } : null}
                  onDrill={(_col, value) => setPicked(value)}
                />
              )}
              <p className="text-[11px] text-muted-foreground">
                預設依場次由多到少。戰績條的刻度是{baselineLabel}，輸出與承受條的刻度是表中英雄的平均；表現是當局表現分（50＝同類型的中位數），小字是隊內排名
              </p>
            </div>
          </div>
        )}
      </Panel>
    </div>
  )
}
