import { lazy, Suspense, useEffect, useMemo, useState, type CSSProperties } from "react"
import { ArrowDownRight, ArrowRight, ArrowUpRight, Flame } from "lucide-react"
import { CountUp } from "@/components/CountUp"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Kpi, Panel, EmptyState, QueryError } from "@/components/primitives"
import { DailyChart, RadarChart, type DayDatum, type RadarDatum } from "@/components/charts"
import { DetailDrawer, useDrawerSettled } from "@/components/DetailDrawer"
import type { PageId } from "@/components/AppShell"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, iconUrl, num, type CubeRow } from "@/lib/cube"
import { useFilters, type Drill } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { useNavigate } from "@/lib/nav"
import { cn } from "@/lib/utils"
import type { MatchRow } from "./Matches"
import { BLOCKS, MIN_GAMES, NO_LIMIT, WEEKDAYS, round0, round1, round2, toBlocks } from "./shared"
import { ROLE_SPEC } from "@/lib/roleBasis"

/** 逐場列表與單場戰報只有點了才用得到，延後載入：儀表板是首屏，
 *  直接靜態引入會把對局卡片與戰報（約 20KB）併進主程式。
 *  那個 chunk 本來就會在瀏覽器閒下來時預先抓好（App 的 usePrefetchPages）。 */
const CubeMatchList = lazy(() => import("@/components/MatchList").then((m) => ({ default: m.CubeMatchList })))
const MatchDetail = lazy(() => import("./Matches").then((m) => ({ default: m.MatchDetail })))

/** 最近幾場要列幾場；連勝連敗往回數到幾場為止（超過就顯示「20+」） */
const RECENT_SHOWN = 10
const RECENT_FETCHED = 20

/** 儀表板只放總覽。細節各有分頁，這裡的每張卡右上角都連過去——
 *  原本儀表板和分頁各畫一份一樣的熱力圖、每日趨勢、勝率長條。 */
function SeeAll({ page, label = "看全部" }: { page: PageId; label?: string }) {
  const go = useNavigate()
  return (
    <Button size="sm" variant="ghost" className="h-7 shrink-0 text-xs" onClick={() => go(page)}>
      {label}
      <ArrowRight className="size-3.5" />
    </Button>
  )
}

/** 最常用的英雄／增幅：一列一個，點了就下鑽。 */
function TopList({
  rows,
  nameKey,
  iconKey,
  drill,
}: {
  rows: CubeRow[]
  nameKey: string
  iconKey: string
  drill: (name: string) => Drill
}) {
  const { addDrill } = useFilters()
  if (!rows.length) return <EmptyState>還沒有資料。</EmptyState>
  return (
    <div className="space-y-1">
      {rows.slice(0, 8).map((r, i) => {
        const name = String(r[nameKey] ?? "—")
        const wr = num(r["participants.winrate"]) ?? 0
        const n = num(r["participants.games"]) ?? 0
        return (
          <button
            key={name}
            onClick={() => addDrill(drill(name))}
            style={{ "--stagger": `${i * 40}ms` } as CSSProperties}
            className="slide-in flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition hover:bg-accent"
          >
            <img src={iconUrl(r[iconKey] as string)} alt="" className="size-7 shrink-0 rounded-md bg-icon-tile" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
            <CountUp text={`${n} 場`} className="text-xs text-muted-foreground" />
            <Badge
              variant="outline"
              className={
                n < MIN_GAMES
                  ? "w-[62px] justify-center text-muted-foreground"
                  : wr >= 50
                    ? "w-[62px] justify-center border-win/30 bg-win/10 text-win"
                    : "w-[62px] justify-center border-loss/30 bg-loss/10 text-loss"
              }
            >
              <CountUp text={`${wr.toFixed(1)}%`} />
            </Badge>
          </button>
        )
      })}
    </div>
  )
}

type PeriodSummary = { games: number; winrate: number | null }

function summarizePeriod(points: DayDatum[]): PeriodSummary {
  const games = points.reduce((sum, point) => sum + point.games, 0)
  if (!games) return { games: 0, winrate: null }
  const wins = points.reduce((sum, point) => sum + point.wins, 0)
  return { games, winrate: (wins / games) * 100 }
}

/** 第一眼要看到的：勝率大字、勝敗比例條、最近一週比前一週是變好還是變差。
 *
 *  原本七個 KPI 一樣大排成一排，勝率和「每分鐘經濟」一樣顯眼；
 *  近期動能又放在頁面最底下，還要自己拿去和上面的勝率對照。 */
function RecordHero({
  winrate,
  wins,
  losses,
  recent,
  previous,
  loading,
}: {
  winrate: number | null
  wins: number
  losses: number
  recent: PeriodSummary
  previous: PeriodSummary
  loading: boolean
}) {
  const delta = recent.winrate !== null && previous.winrate !== null ? recent.winrate - previous.winrate : null
  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">整體勝率</div>
          {loading ? (
            <Skeleton className="mt-2 h-12 w-40" />
          ) : (
            <div
              className={cn(
                "font-mono text-5xl font-bold tabular-nums leading-none tracking-tight",
                winrate === null ? "text-muted-foreground" : winrate >= 50 ? "text-win" : "text-loss",
              )}
            >
              <CountUp text={winrate === null ? "—" : `${winrate.toFixed(1)}%`} />
            </div>
          )}
        </div>
        <div className="text-right text-sm tabular-nums text-muted-foreground">
          <CountUp text={`${wins + losses} 場`} className="block font-mono text-base font-semibold text-foreground" />
          <CountUp text={`${wins} 勝 ${losses} 敗`} />
        </div>
      </div>

      {/* 勝／敗兩段，勝段的比例就是勝率；下方小刻度是 50%，和表格裡的戰績條同一種讀法 */}
      <div className="relative flex h-2.5 gap-0.5">
        {wins > 0 && <span className="bar-grow rounded-full bg-win" style={{ flexGrow: wins }} />}
        {losses > 0 && <span className="bar-grow rounded-full bg-loss" style={{ flexGrow: losses }} />}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-full mt-0.5 h-1.5 w-0.5 -translate-x-1/2 rounded-full bg-muted-foreground"
        />
      </div>

      <div className="mt-auto grid grid-cols-2 gap-3 border-t pt-3">
        <div>
          <div className="text-[11px] text-muted-foreground">最近 7 個有資料的日子</div>
          <div
            className={cn(
              "font-mono text-xl font-semibold tabular-nums",
              recent.winrate === null ? "text-muted-foreground" : recent.winrate >= 50 ? "text-win" : "text-loss",
            )}
          >
            <CountUp text={recent.winrate === null ? "—" : `${recent.winrate.toFixed(1)}%`} />
          </div>
          <div className="text-[11px] text-muted-foreground">{recent.games} 場</div>
        </div>
        <div>
          <div className="text-[11px] text-muted-foreground">比前 7 個有資料的日子</div>
          <div
            className={cn(
              "flex items-center gap-1 font-mono text-xl font-semibold tabular-nums",
              delta === null ? "text-muted-foreground" : delta >= 0 ? "text-win" : "text-loss",
            )}
          >
            {delta !== null && (delta >= 0 ? <ArrowUpRight className="size-4" /> : <ArrowDownRight className="size-4" />)}
            <CountUp text={delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`} />
          </div>
          <div className="text-[11px] text-muted-foreground">
            {previous.games ? `前期 ${previous.winrate?.toFixed(1)}%・${previous.games} 場` : "前期資料不足"}
          </div>
        </div>
      </div>
    </div>
  )
}

const shortDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/** 最近幾場：英雄頭像一排，外框是勝敗色，底下是 KDA。點一場開右側抽屜看戰報。
 *
 *  是哪幾場照規則走：先用全域條件向 Cube 查 game_id，再交給 /api/matches 列出來（後端依時間新到舊排）。
 *  直接打 /api/matches 的話，其他頁加的全域下鑽（例如「只看某隻英雄」）不會套上，
 *  儀表板上其他卡片都篩了、只有這一排沒篩。 */
function RecentForm({ onPick }: { onPick: (m: MatchRow) => void }) {
  const { apply, matchParams } = useFilters()
  const ids = useCube(apply({ measures: ["participants.games"], dimensions: ["matches.game_id"], limit: MAX_GAME_IDS }))
  const gameIds = ids.rows.map((r) => String(r["matches.game_id"])).join(",")
  const params = new URLSearchParams({ ...matchParams(), game_ids: gameIds, limit: String(RECENT_FETCHED) }).toString()
  const [state, setState] = useState<{ key: string; rows: MatchRow[] | null; error: string | null }>({ key: "", rows: null, error: null })

  useEffect(() => {
    if (ids.loading || ids.error || !gameIds) return
    const ctrl = new AbortController()
    fetch(`/api/matches?${params}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((d) => setState({ key: params, rows: d.matches ?? [], error: d.error ?? null }))
      .catch((e: Error) => e.name !== "AbortError" && setState({ key: params, rows: null, error: e.message }))
    return () => ctrl.abort()
  }, [params, ids.loading, ids.error, gameIds])

  if (ids.error || state.error) return <div className="text-sm text-destructive">{ids.error ?? state.error}</div>
  if (!ids.loading && !gameIds) return <EmptyState>這個條件下還沒有對局。</EmptyState>
  const rows = state.key === params ? state.rows : null
  if (!rows) return <Skeleton className="h-[176px] w-full" />

  const shown = rows.slice(0, RECENT_SHOWN)
  const wins = shown.filter((m) => m.win).length
  let streak = 0
  while (streak < rows.length && rows[streak].win === rows[0].win) streak++
  const capped = streak === rows.length && rows.length === RECENT_FETCHED

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono tabular-nums">
          最近 {shown.length} 場 <span className="font-semibold text-win">{wins} 勝</span>{" "}
          <span className="font-semibold text-loss">{shown.length - wins} 敗</span>
        </span>
        {rows.length > 0 && streak >= 2 && (
          <Badge
            variant="outline"
            className={rows[0].win ? "border-win/30 bg-win/10 text-win" : "border-loss/30 bg-loss/10 text-loss"}
          >
            <Flame className="size-3" />
            目前 {streak}
            {capped ? "+" : ""} {rows[0].win ? "連勝" : "連敗"}
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">左邊是最新的一場・點一場看戰報</span>
      </div>
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {shown.map((m, i) => (
          <button
            key={`${m.platform_id}:${m.game_id}`}
            onClick={() => onPick(m)}
            title={`${m.champion_name}・${m.win ? "勝利" : "戰敗"}・${shortDate(m.game_creation)}`}
            style={{ "--stagger": `${i * 35}ms` } as CSSProperties}
            className={cn(
              "slide-in flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2 transition",
              m.win ? "border-win/25 bg-win/[0.06] hover:bg-win/[0.12]" : "border-loss/25 bg-loss/[0.06] hover:bg-loss/[0.12]",
            )}
          >
            <img
              src={iconUrl(m.champion_icon)}
              alt=""
              className={cn("size-11 rounded-md bg-icon-tile ring-2", m.win ? "ring-win/70" : "ring-loss/70")}
            />
            <span className={cn("text-[11px] font-bold", m.win ? "text-win" : "text-loss")}>{m.win ? "勝" : "敗"}</span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {m.kills}/{m.deaths}/{m.assists}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 抽屜裡的單場戰報。等抽屜滑完才掛（戰報含兩張十人的表）。 */
function MatchDrawerBody({ match, puuid, onClose }: { match: MatchRow; puuid?: string; onClose: () => void }) {
  const settled = useDrawerSettled()
  if (!settled) return <Skeleton className="h-[560px] w-full" />
  return (
    <Suspense fallback={<Skeleton className="h-[560px] w-full" />}>
      <MatchDetail platformId={match.platform_id} gameId={match.game_id} puuid={puuid} onBack={onClose} backLabel="關閉" />
    </Suspense>
  )
}

/** 抽屜裡某一天的每一場。 */
function DayDrawerBody({ day }: { day: string }) {
  const { apply } = useFilters()
  const settled = useDrawerSettled()
  if (!settled) return <Skeleton className="h-[320px] w-full" />
  return (
    <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
      {/* 是哪幾場由 Cube 用和每日圖同一組條件查：全域下鑽（例如某隻英雄）才會一起套上，
          否則圖上那天 5 場、點進去卻列出那天全部 28 場 */}
      <CubeMatchList
        gameIdKey="matches.game_id"
        listKey={day}
        query={apply({
          measures: ["participants.games"],
          dimensions: ["matches.game_id"],
          filters: [{ member: "matches.local_date", operator: "equals", values: [day] }],
          limit: MAX_GAME_IDS,
        })}
      />
    </Suspense>
  )
}

export function Dashboard() {
  const { apply, account } = useFilters()
  // 點每日圖的某一天、或最近戰績的某一場，右邊滑出抽屜（和英雄頁同一種）
  const [day, setDay] = useState<string | null>(null)
  const [match, setMatch] = useState<MatchRow | null>(null)
  useCrumb(10, day, () => setDay(null))

  const totals = useCube(
    apply({
      measures: [
        "participants.games",
        "participants.wins",
        "participants.losses",
        "participants.winrate",
        "participants.kda",
        "participants.dpm",
        "participants.gpm",
        "participants.kill_participation",
      ],
    }),
  )

  // 和時段頁同一個查詢（按採集時存好的本地日期分組），兩頁的每日數字保證一樣，快取也共用
  const daily = useCube(
    apply({
      measures: ["participants.games", "participants.wins", "participants.winrate"],
      dimensions: ["matches.local_date"],
      limit: NO_LIMIT,
    }),
  )

  const champions = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["champions.name", "champions.icon_path"],
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )

  const augments = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["augments.name", "augments.icon_path"],
      order: { "participants.games": "desc" },
      limit: 8,
    }),
  )

  // 和英雄頁的出裝定位雷達同一個查詢，快取共用
  const spec = ROLE_SPEC
  const roles = useCube(
    apply({
      measures: ["participants.games", "participants.wins", "participants.winrate"],
      dimensions: [spec.dimension],
      limit: NO_LIMIT,
    }),
  )

  // 和時段頁的熱力圖同一個查詢，這裡只摘要成三句話
  const heat = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["matches.weekday", "matches.hour_of_day"],
      limit: 400,
    }),
  )

  const queryError = totals.error ?? daily.error ?? champions.error ?? augments.error ?? heat.error ?? roles.error

  const row = totals.rows[0] ?? {}
  const metric = (key: string, fmt: (n: number) => string, suffix = "") => {
    const parsed = num(row[key])
    return parsed === null ? "—" : `${fmt(parsed)}${suffix}`
  }
  const winrate = num(row["participants.winrate"])
  const games = num(row["participants.games"]) ?? 0

  // useMemo：點某一天會讓整頁重新渲染，每次都給圖表一份新陣列的話，
  // ECharts 會把整份 option 當成新資料再過渡一次（長條會跟著抖一下）
  const points: DayDatum[] = useMemo(
    () =>
      daily.rows
        .map((r) => ({
          date: String(r["matches.local_date"] ?? ""),
          games: num(r["participants.games"]) ?? 0,
          wins: num(r["participants.wins"]) ?? 0,
          winrate: num(r["participants.winrate"]),
        }))
        .filter((p) => p.date)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [daily.rows],
  )
  const recentPeriod = summarizePeriod(points.slice(-7))
  const previousPeriod = summarizePeriod(points.slice(-14, -7))

  const roleData: RadarDatum[] = useMemo(
    () =>
      spec.labels.map((label) => {
        const r = roles.rows.find((x) => x[spec.dimension] === label)
        return {
          label,
          games: r ? (num(r["participants.games"]) ?? 0) : 0,
          wins: r ? (num(r["participants.wins"]) ?? 0) : 0,
          winrate: r ? num(r["participants.winrate"]) : null,
        }
      }),
    [roles.rows, spec],
  )
  const topRole = [...roleData].sort((a, b) => b.games - a.games)[0]

  const blocks = toBlocks(
    heat.rows.map((r) => ({
      weekday: Number(r["matches.weekday"]),
      hour: Number(r["matches.hour_of_day"]),
      games: num(r["participants.games"]) ?? 0,
      winrate: num(r["participants.winrate"]),
    })),
  )
  const busiest = [...blocks].sort((a, b) => b.games - a.games)[0]
  const enough = blocks.filter((b) => b.games >= MIN_GAMES)
  const best = [...enough].sort((a, b) => (b.winrate ?? 0) - (a.winrate ?? 0))[0]
  const worst = [...enough].sort((a, b) => (a.winrate ?? 0) - (b.winrate ?? 0))[0]
  const slotName = (b: { weekday: number; block: number }) => `${WEEKDAYS[b.weekday]} ${BLOCKS[b.block].label}`

  return (
    <div className="space-y-4">
      {queryError && <QueryError error={queryError} />}

      {/* 第一排：整體戰績（勝率 + 近期變化）與最近幾場。首頁最常被問的兩件事：「我整體怎樣」「最近怎樣」 */}
      <div className="grid gap-4 xl:grid-cols-12">
        <Panel className="xl:col-span-5" title="整體戰績" index={0}>
          <RecordHero
            winrate={winrate}
            wins={num(row["participants.wins"]) ?? 0}
            losses={num(row["participants.losses"]) ?? 0}
            recent={recentPeriod}
            previous={previousPeriod}
            loading={totals.loading || daily.loading}
          />
        </Panel>
        <Panel className="xl:col-span-7" title="最近戰績" index={1} action={<SeeAll page="matches" label="對局紀錄" />}>
          <RecentForm onPick={setMatch} />
        </Panel>
      </div>

      {/* 次要數字：打法的總量指標，比勝率次要，縮成一排小卡 */}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <Kpi index={2} label="KDA" value={metric("participants.kda", round2)} loading={totals.loading} />
        <Kpi index={3} label="每分鐘傷害" value={metric("participants.dpm", round0)} loading={totals.loading} />
        <Kpi index={4} label="每分鐘經濟" value={metric("participants.gpm", round0)} loading={totals.loading} />
        <Kpi index={5} label="參團率" value={metric("participants.kill_participation", round1, "%")} loading={totals.loading} />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel
          className="xl:col-span-8"
          title="每日勝率趨勢"
          caption="上面是累積勝率（打到那天為止的總勝率），虛線是 50%；下面是每天的場次，分成勝、敗兩段。點一天看那天的每一場"
          action={<SeeAll page="time" label="時段分析" />}
        >
          {daily.loading ? (
            <Skeleton className="h-[340px] w-full" />
          ) : points.length < 2 ? (
            <EmptyState>資料還不夠畫趨勢（至少要兩天）。</EmptyState>
          ) : (
            // 和時段頁同一個元件：兩頁的每日圖讀法一致，只有高度為了卡片版面矮一點
            <DailyChart
              days={points}
              height={340}
              selected={day}
              onPick={(picked) => setDay((cur) => (cur === picked ? null : picked))}
            />
          )}
        </Panel>

        <Panel
          className="xl:col-span-4"
          title="最常用英雄"
          caption={champions.loading ? "點一列可下鑽" : `共用過 ${champions.rows.length} 隻・點一列可下鑽`}
          action={<SeeAll page="champions" />}
        >
          {champions.loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <TopList
              rows={champions.rows}
              nameKey="champions.name"
              iconKey="champions.icon_path"
              drill={(name) => ({ member: "champions.name", operator: "equals", values: [name], label: `英雄：${name}` })}
            />
          )}
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Panel
          title="出裝定位"
          caption={
            topRole?.games
              ? `最常出${topRole.label}（${Math.round((100 * topRole.games) / Math.max(1, games))}%）・依終場出裝`
              : "依終場出裝"
          }
          action={<SeeAll page="champions" />}
        >
          {roles.loading || totals.loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : !games ? (
            <EmptyState>還沒有資料。</EmptyState>
          ) : (
            <RadarChart data={roleData} mode="games" baseline={winrate} total={games} height={300} />
          )}
        </Panel>

        <Panel title="最常選的增幅" caption="點一列可下鑽" action={<SeeAll page="augments" />}>
          {augments.loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : (
            <TopList
              rows={augments.rows}
              nameKey="augments.name"
              iconKey="augments.icon_path"
              drill={(name) => ({ member: "augments.name", operator: "equals", values: [name], label: `增幅：${name}` })}
            />
          )}
        </Panel>

        <Panel
          title="什麼時候打"
          caption={`以星期 × 四時段分組；比較好壞只看 ${MIN_GAMES} 場以上的時段`}
          action={<SeeAll page="time" label="看熱力圖" />}
        >
          {heat.loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : !busiest ? (
            <EmptyState>還沒有資料。</EmptyState>
          ) : (
            <div className="grid gap-3">
              <Kpi label="最常打" value={slotName(busiest)} hint={`${busiest.games} 場`} />
              <Kpi
                label="表現最好"
                value={best ? slotName(best) : "—"}
                hint={best ? `勝率 ${best.winrate?.toFixed(1)}%・${best.games} 場` : `還沒有時段累積到 ${MIN_GAMES} 場`}
                tone={best ? "win" : undefined}
              />
              <Kpi
                label="表現最差"
                value={worst && worst !== best ? slotName(worst) : "—"}
                hint={worst && worst !== best ? `勝率 ${worst.winrate?.toFixed(1)}%・${worst.games} 場` : undefined}
                tone={worst && worst !== best ? "loss" : undefined}
              />
            </div>
          )}
        </Panel>
      </div>

      <DetailDrawer
        open={!!day}
        onClose={() => setDay(null)}
        title={day ?? ""}
        subtitle="這一天的每一場（點一場看戰報）"
      >
        {day && <DayDrawerBody key={day} day={day} />}
      </DetailDrawer>

      <DetailDrawer
        open={!!match}
        onClose={() => setMatch(null)}
        title={match ? `${match.champion_name}・${match.win ? "勝利" : "戰敗"}` : ""}
        subtitle={match ? `${shortDate(match.game_creation)}・${match.kills}/${match.deaths}/${match.assists}` : undefined}
        icon={match ? iconUrl(match.champion_icon) : undefined}
      >
        {match && (
          <MatchDrawerBody key={`${match.platform_id}:${match.game_id}`} match={match} puuid={account?.puuid} onClose={() => setMatch(null)} />
        )}
      </DetailDrawer>
    </div>
  )
}
