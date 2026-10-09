import { useMemo, useState } from "react"
import { ArrowDown, Crosshair, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel, EmptyState, Kpi, QueryError } from "@/components/primitives"
import { CubeMatchList } from "@/components/MatchList"
import {
  DailyChart,
  weekdayOf,
  Heatmap,
  HOURS_24,
  BarChart,
  type DayDatum,
  type HeatCell,
  type BarDatum,
} from "@/components/charts"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, num, type CubeFilter } from "@/lib/cube"
import { useFilters } from "@/lib/filters"
import { usePageWho } from "@/lib/whoState"
import { participantRows, useWhoScope, type Who } from "@/lib/who"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useCrumb } from "@/lib/breadcrumb"
import { BLOCKS, NO_LIMIT, WEEKDAYS, splitRiotId, toBlocks } from "./shared"

type Grain = "hour" | "block"

/** 目前下鑽到哪一塊。date 是某一天，slot 是某個星期幾的某段時間。 */
type Slice =
  | { kind: "date"; date: string }
  | { kind: "slot"; weekday: number; from: number; to: number; label: string }

const sliceLabel = (s: Slice) =>
  s.kind === "date" ? s.date : `${WEEKDAYS[s.weekday]} ${s.label}`

/** 這一塊對應的 Cube 篩選。逐場列表用它向 Cube 查是哪幾場，全域下鑽才會一起套上。 */
const sliceFilters = (s: Slice): CubeFilter[] =>
  s.kind === "date"
    ? [{ member: "matches.local_date", operator: "equals", values: [s.date] }]
    : [
        { member: "matches.weekday", operator: "equals", values: [String(s.weekday)] },
        {
          member: "matches.hour_of_day",
          operator: "equals",
          values: Array.from({ length: s.to - s.from + 1 }, (_, i) => String(s.from + i)),
        },
      ]

/** 「所有人」在時段頁沒有意義：每場兩隊十位都算，勝率必然是 50%，場次分佈也只是把你自己的場次重複十次 */
const NO_ALL = { all: "每場兩隊十位都算，勝率必然是 50%，時段分佈只是把你自己的場次重複十次" }

type PersonRow = { puuid: string; name: string; tag: string; games: number; byDay: number[]; byBlock: number[] }

/** 追蹤對象每個人在什麼時候打：一人一列，左邊七天、右邊四時段，圓點大小是「佔他自己場次的比例」。
 *  合併起來的熱力圖會被打最多場的人帶著走，分開看才知道誰習慣什麼時候上線、哪些時段湊得齊人。
 *
 *  格子固定大小、不隨容器拉伸：原本用長條，格子被拉成又寬又扁的粗條，高低差看不出來，數字也擠在底下。
 *  圓點的面積跟比例成正比（半徑取平方根），人眼比較面積，不是直徑；0 場畫成一個空心小點，
 *  和「有打但很少」分得開。數字放在圓點旁，不放在色塊上，免得每個主題都要重新算對比。 */
const DOT_MAX = 30
const DOT_MIN = 6

function Dot({ n, max, label }: { n: number; max: number; label: string }) {
  const size = n === 0 || !max ? 0 : Math.round(DOT_MIN + (DOT_MAX - DOT_MIN) * Math.sqrt(n / max))
  return (
    <div className="flex h-10 flex-col items-center justify-center" title={`${label}　${n} 場`}>
      <div className="flex size-[30px] items-center justify-center">
        {n === 0 ? (
          <span className="size-1.5 rounded-full border border-muted-foreground/40" />
        ) : (
          <span className="rounded-full bg-data" style={{ width: size, height: size }} />
        )}
      </div>
      <span className={`font-mono text-[10px] tabular-nums leading-none ${n === 0 ? "text-muted-foreground/50" : "text-muted-foreground"}`}>{n}</span>
    </div>
  )
}

function PersonTimes({ rows }: { rows: PersonRow[] }) {
  const grid = "grid grid-cols-[11rem_repeat(7,4rem)_2rem_repeat(4,5.5rem)] items-center gap-x-1"
  return (
    <div className="overflow-x-auto">
      <div className="w-max min-w-full">
        <div className={`${grid} mb-1 text-[11px] font-medium text-muted-foreground`}>
          <span />
          <span className="col-span-7 border-b pb-0.5 text-center">星期</span>
          <span />
          <span className="col-span-4 border-b pb-0.5 text-center">時段</span>
        </div>
        <div className={`${grid} text-[11px] text-muted-foreground`}>
          <span />
          {WEEKDAYS.map((d) => (
            <span key={d} className="text-center">{d}</span>
          ))}
          <span />
          {BLOCKS.map((b) => (
            <span key={b.label} className="text-center" title={b.label}>
              {b.label.split(" ")[0]}
            </span>
          ))}
        </div>
        {rows.map((r) => (
          <div key={r.puuid} data-testid="person-times-row" className={`${grid} border-t first:border-t-0`}>
            <span className="flex min-w-0 flex-col py-1 pr-2 text-sm font-medium">
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="truncate" title={`${r.name}${r.tag}`}>{r.name}</span>
                {r.tag && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{r.tag}</span>}
              </span>
              <span className="font-mono text-[11px] font-normal text-muted-foreground">{r.games} 場</span>
            </span>
            {r.byDay.map((n, i) => (
              <Dot key={`d${i}`} n={n} max={Math.max(...r.byDay)} label={`${r.name} ${WEEKDAYS[i]}`} />
            ))}
            <span />
            {r.byBlock.map((n, i) => (
              <Dot key={`b${i}`} n={n} max={Math.max(...r.byBlock)} label={`${r.name} ${BLOCKS[i].label}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function TimeAnalysis() {
  const { players } = useFilters()
  const [who, setWhoState] = usePageWho(NO_ALL)
  const scope = useWhoScope(who)
  const apply = scope.q
  const [slice, setSlice] = useState<Slice | null>(null)
  const [grain, setGrain] = useState<Grain>("block")
  useCrumb(10, slice ? sliceLabel(slice) : null, () => setSlice(null))

  const daily = useCube(
    apply({
      measures: ["participants.games", "participants.wins", "participants.winrate"],
      dimensions: ["matches.local_date"],
      limit: NO_LIMIT,
    }),
  )

  const heat = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["matches.weekday", "matches.hour_of_day"],
      limit: 400,
    }),
  )

  const byWeekday = useCube(
    apply({
      measures: ["participants.games", "participants.winrate"],
      dimensions: ["matches.weekday"],
      limit: 10,
    }),
  )

  // 追蹤對象才需要逐人拆開
  const byPerson = useCube(
    who === "tracked"
      ? apply({
          measures: ["participants.games"],
          dimensions: ["participants.puuid", "matches.weekday", "matches.hour_of_day"],
          limit: NO_LIMIT,
        })
      : null,
  )
  const personRows: PersonRow[] = useMemo(() => {
    const byId = new Map(players.map((p) => [p.puuid, p]))
    const acc = new Map<string, PersonRow>()
    for (const r of byPerson.rows) {
      const puuid = String(r["participants.puuid"])
      const { name, tag } = splitRiotId(byId.get(puuid)?.riot_id ?? null, puuid)
      const cur = acc.get(puuid) ?? { puuid, name, tag, games: 0, byDay: Array(7).fill(0), byBlock: Array(BLOCKS.length).fill(0) }
      const n = num(r["participants.games"]) ?? 0
      const hour = Number(r["matches.hour_of_day"])
      cur.games += n
      cur.byDay[Number(r["matches.weekday"])] += n
      const block = BLOCKS.findIndex((b) => hour >= b.from && hour <= b.to)
      if (block >= 0) cur.byBlock[block] += n
      acc.set(puuid, cur)
    }
    return [...acc.values()].sort((a, b) => b.games - a.games)
  }, [byPerson.rows, players])

  const queryError = daily.error ?? heat.error ?? byWeekday.error ?? byPerson.error
  const setWho = (next: Who) => {
    setWhoState(next)
    setSlice(null)
  }


  const days: DayDatum[] = useMemo(
    () =>
      daily.rows
        .map((r) => ({
          date: String(r["matches.local_date"] ?? ""),
          games: num(r["participants.games"]) ?? 0,
          wins: num(r["participants.wins"]) ?? 0,
          winrate: num(r["participants.winrate"]),
        }))
        .filter((d) => d.date)
        .sort((a, b) => a.date.localeCompare(b.date)),
    [daily.rows],
  )

  /** 一列一個小時，之後依照粗細度再合併。 */
  const hourly = useMemo(
    () =>
      heat.rows.map((r) => ({
        weekday: Number(r["matches.weekday"]),
        hour: Number(r["matches.hour_of_day"]),
        games: num(r["participants.games"]) ?? 0,
        winrate: num(r["participants.winrate"]),
      })),
    [heat.rows],
  )

  const cells: HeatCell[] = useMemo(() => {
    if (grain === "hour") {
      return hourly.map((h) => ({ weekday: h.weekday, x: h.hour, games: h.games, winrate: h.winrate }))
    }
    return toBlocks(hourly).map((c) => ({ weekday: c.weekday, x: c.block, games: c.games, winrate: c.winrate }))
  }, [hourly, grain])

  const xLabels = grain === "hour" ? HOURS_24 : BLOCKS.map((b) => b.label)
  const totalGames = hourly.reduce((sum, c) => sum + c.games, 0)
  const activeCells = cells.filter((c) => c.games > 0).length
  const busiest = [...hourly].sort((a, b) => b.games - a.games)[0]

  const weekdayBars: BarDatum[] = byWeekday.rows
    .map((r) => ({
      label: WEEKDAYS[Number(r["matches.weekday"])] ?? "—",
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r["participants.games"]) ?? 0,
    }))
    .sort((a, b) => b.value - a.value)

  // ── 交叉篩選：三張圖共用同一個「聚焦」。點每日圖的某天、熱力圖的某格、星期長條的某天，
  //    三張圖都亮起同一個星期、其餘淡掉；下面列出那一塊的每一場。再點一次同一個就取消。
  const focusWeekday = slice === null ? null : slice.kind === "date" ? weekdayOf(slice.date) : slice.weekday
  const pick = (next: Slice) => setSlice((cur) => (cur && sliceLabel(cur) === sliceLabel(next) ? null : next))

  // 聚焦那一塊的場次與勝率：由已經載入的圖表資料加總，不另外查（和下方逐場列表是同一份資料）
  const focusStats = useMemo(() => {
    if (!slice) return null
    if (slice.kind === "date") {
      const d = days.find((x) => x.date === slice.date)
      return d ? { games: d.games, wins: Math.round((d.games * (d.winrate ?? 0)) / 100) } : null
    }
    const hit = hourly.filter((h) => h.weekday === slice.weekday && h.hour >= slice.from && h.hour <= slice.to)
    const games = hit.reduce((a, h) => a + h.games, 0)
    const wins = Math.round(hit.reduce((a, h) => a + (h.games * (h.winrate ?? 0)) / 100, 0))
    return { games, wins }
  }, [slice, days, hourly])

  if (who === "tracked" && !scope.trackedCount) {
    return (
      <div className="space-y-4">
        <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} disabled={NO_ALL} />
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的時段。</EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} disabled={NO_ALL} />
      {queryError && <QueryError error={queryError} />}
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="總場次" value={String(totalGames)} hint={who === "tracked" ? "每位玩家的每一場各算一次" : undefined} loading={heat.loading} />
        <Kpi
          label="打過的日子"
          value={String(days.length)}
          hint={days.length ? `${days[0].date} 起` : undefined}
          loading={daily.loading}
        />
        <Kpi
          label="最常打的時段"
          value={
            busiest ? `${WEEKDAYS[busiest.weekday]} ${String(busiest.hour).padStart(2, "0")}:00` : "—"
          }
          hint={busiest ? `${busiest.games} 場・${activeCells} / ${7 * xLabels.length} 格有資料` : undefined}
          loading={heat.loading}
        />
      </div>

      {/* 目前聚焦在哪一塊。放在圖表上方並黏在頂端，捲到哪一張圖都看得到、都能清除 */}
      <div className="sticky top-[72px] z-10">
        {slice ? (
          <div className="slide-in flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-primary/40 bg-card/95 px-4 py-2.5 text-sm shadow-lg backdrop-blur">
            <span className="flex items-center gap-2">
              <Crosshair className="size-4 text-primary" />
              <span className="text-muted-foreground">聚焦</span>
              <b>{sliceLabel(slice)}</b>
            </span>
            {focusStats && focusStats.games > 0 && (
              <span className="font-mono tabular-nums text-muted-foreground">
                {focusStats.games} 場 · {focusStats.wins} 勝 {focusStats.games - focusStats.wins} 敗 ·{" "}
                <span className={focusStats.wins / focusStats.games >= 0.5 ? "text-win" : "text-loss"}>
                  {((focusStats.wins / focusStats.games) * 100).toFixed(1)}%
                </span>
              </span>
            )}
            <span className="text-xs text-muted-foreground">三張圖已連動，{WEEKDAYS[focusWeekday ?? 0]}以外的資料淡化</span>
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => document.getElementById("focus-matches")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <ArrowDown className="size-3.5" />
                看每一場
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSlice(null)}>
                <X className="size-3.5" />
                清除
              </Button>
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            點下面任一張圖的某天、某格或某個星期，三張圖會一起聚焦到那個星期，並列出那一塊的每一場。
          </p>
        )}
      </div>

      {who === "tracked" && (
        <Panel
          title="每個人在什麼時候打"
          caption="一人一列：左邊是星期幾、右邊是四個時段，圓點越大代表佔他自己場次的比例越高（每個人各自最高的那格最大，面積成正比），旁邊的數字是場次，空心小點是沒打過。合併的圖會被打最多場的人帶著走，分開看才知道誰習慣什麼時候上線、哪些時段湊得齊人"
        >
          {byPerson.loading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : personRows.length ? (
            <PersonTimes rows={personRows} />
          ) : (
            <EmptyState>這個條件下還沒有資料。</EmptyState>
          )}
        </Panel>
      )}

      <Panel title="每天的場次與勝率" caption="折線是累積勝率，虛線是 50%；長條是每天的勝敗場次，上方數字是場次。點一天聚焦">
        {daily.loading ? (
          <Skeleton className="h-[280px] w-full" />
        ) : days.length ? (
          <DailyChart
            days={days}
            selected={slice?.kind === "date" ? slice.date : null}
            focusWeekday={focusWeekday}
            onPick={(date) => pick({ kind: "date", date })}
          />
        ) : (
          <EmptyState>這個條件下還沒有資料。</EmptyState>
        )}
      </Panel>

      <Panel
        title="星期 × 時段"
        caption={
          grain === "hour"
            ? `共 ${totalGames} 場攤在 ${7 * 24} 格裡，單格通常只有個位數——顏色已經依樣本多寡收斂，但這個粗細度主要是看「什麼時候在打」`
            : `共 ${totalGames} 場分成 ${7 * BLOCKS.length} 格，樣本比逐小時集中得多。點一格聚焦`
        }
        action={
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={grain}
            onValueChange={(v) => v && setGrain(v as Grain)}
          >
            <ToggleGroupItem value="block">四時段</ToggleGroupItem>
            <ToggleGroupItem value="hour">逐小時</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        {heat.loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : cells.length ? (
          <Heatmap
            cells={cells}
            xLabels={xLabels}
            focusRow={focusWeekday}
            // 從星期長條點的「全天」只亮整列，不描某一格
            selected={
              slice?.kind === "slot" && !(slice.from === 0 && slice.to === 23)
                ? { weekday: slice.weekday, x: grain === "hour" ? slice.from : BLOCKS.findIndex((b) => b.from === slice.from) }
                : null
            }
            onPick={({ weekday, x }) =>
              pick(
                grain === "hour"
                  ? { kind: "slot", weekday, from: x, to: x, label: `${String(x).padStart(2, "0")}:00` }
                  : { kind: "slot", weekday, from: BLOCKS[x].from, to: BLOCKS[x].to, label: BLOCKS[x].label },
              )
            }
          />
        ) : (
          <EmptyState>這個條件下還沒有資料。</EmptyState>
        )}
      </Panel>

      <Panel title="星期別勝率" caption="點一個星期聚焦到那一整天">
        {byWeekday.loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : weekdayBars.length ? (
          <BarChart
            data={weekdayBars}
            suffix="%"
            selected={focusWeekday === null ? null : WEEKDAYS[focusWeekday]}
            onPick={(label) => {
              const weekday = WEEKDAYS.indexOf(label)
              if (weekday >= 0) pick({ kind: "slot", weekday, from: 0, to: 23, label: "全天" })
            }}
          />
        ) : (
          <EmptyState>還沒有資料。</EmptyState>
        )}
      </Panel>

      {slice && (
        <div id="focus-matches" className="scroll-mt-40">
          <Panel
            title={`${sliceLabel(slice)} 的每一場`}
            action={
              <Button size="sm" variant="ghost" onClick={() => setSlice(null)}>
                <X className="size-3.5" />
                收起
              </Button>
            }
          >
            <CubeMatchList
              gameIdKey="matches.game_id"
              listKey={`${who}|${sliceLabel(slice)}`}
              query={apply({
                measures: ["participants.games"],
                dimensions: [who === "tracked" ? "participants.participant_key" : "matches.game_id"],
                filters: sliceFilters(slice),
                limit: MAX_GAME_IDS,
              })}
              rowsToParams={who === "tracked" ? participantRows : undefined}
              showPlayer={who === "tracked"}
            />
          </Panel>
        </div>
      )}
    </div>
  )
}
