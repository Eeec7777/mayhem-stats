import { useMemo, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Kpi, Panel, EmptyState, QueryError } from "@/components/primitives"
import { BarChart, type BarDatum } from "@/components/charts"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, num, type CubeRow } from "@/lib/cube"
import { useFilters } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { usePageWho } from "@/lib/whoState"
import { participantRows, useWhoScope, type Who } from "@/lib/who"
import { cn } from "@/lib/utils"
import { DrillPanel } from "@/components/MatchList"
import { MIN_GAMES, NO_LIMIT, splitRiotId } from "./shared"

/** 下鑽的分組。kind 同時是 participant_context 的維度名。 */
type TiltFocus = { kind: "prev_result" | "session_stage" | "game_in_session"; value: string; label: string }

const STAGE_ORDER = ["第 1-2 場", "第 3-5 場", "第 6-9 場", "第 10 場以後"]

const G = "participants.games"
const W = "participants.wins"

type Counts = { g: number; w: number }
const countsOf = (r: CubeRow | undefined): Counts => ({ g: num(r?.[G] ?? null) ?? 0, w: num(r?.[W] ?? null) ?? 0 })

/** 兩個勝率差（a − b，百分點）的 95% 區間，常態近似。樣本不夠時回傳 null。
 *  用來決定「落差」要不要上色：區間跨過 0 就只描述、不下結論。 */
function diffInterval(a: Counts, b: Counts): [number, number] | null {
  if (a.g < MIN_GAMES || b.g < MIN_GAMES) return null
  const pa = a.w / a.g
  const pb = b.w / b.g
  const se = Math.sqrt((pa * (1 - pa)) / a.g + (pb * (1 - pb)) / b.g) * 100
  const d = (pa - pb) * 100
  return [d - 1.96 * se, d + 1.96 * se]
}

/** 「前一場輸之後」減「前一場贏之後」的勝率（百分點）。任何一邊沒有場次就是 null */
const gap = (loss: Counts, win: Counts) => (loss.g && win.g ? (loss.w / loss.g - win.w / win.g) * 100 : null)

/** 區間不跨 0 才算看得出方向 */
const isClear = (interval: [number, number] | null) => interval !== null && (interval[1] < 0 || interval[0] > 0)

type Person = { key: string; name: string; tag: string; loss: Counts; win: Counts; delta: number | null; interval: [number, number] | null }

const personOf = (key: string, name: string, tag: string, loss: Counts, win: Counts): Person => ({
  key,
  name,
  tag,
  loss,
  win,
  delta: gap(loss, win),
  interval: diffInterval(loss, win),
})

const pctOf = (c: Counts) => (c.g ? `${((100 * c.w) / c.g).toFixed(0)}%` : "—")

/** 每個人一列的森林圖：點是落差，線是 95% 區間，中間那條是 0。
 *
 *  合併數字會被打最多場的人拉著走，而且追蹤對象常常同隊，同一場被每個人各算一次；
 *  逐人看才分得出是大家都這樣，還是只有一個人這樣。樣本不夠（輸後或贏後不到 MIN_GAMES 場）的人
 *  不畫區間，只列場次。 */
function ForestPlot({ people, pooled }: { people: Person[]; pooled: Person }) {
  const drawn = people.filter((p) => p.interval)
  const reach = Math.min(
    60,
    Math.max(20, Math.ceil(Math.max(0, ...drawn.flatMap((p) => [Math.abs(p.interval![0]), Math.abs(p.interval![1])])) / 10) * 10),
  )
  const at = (v: number) => `${((Math.max(-reach, Math.min(reach, v)) + reach) / (2 * reach)) * 100}%`

  const row = (p: Person, bold = false) => {
    const clear = isClear(p.interval)
    const tone = !clear ? "bg-muted-foreground" : p.delta! < 0 ? "bg-loss" : "bg-win"
    return (
      <div
        key={p.key}
        role="img"
        aria-label={
          p.interval
            ? `${p.name}：落差 ${p.delta!.toFixed(1)} pp，95% 區間 ${p.interval[0].toFixed(0)} 到 ${p.interval[1].toFixed(0)}`
            : `${p.name}：樣本太少`
        }
        className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 py-1.5 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,19rem)]"
      >
        <span className={cn("flex min-w-0 items-baseline gap-1 text-sm", bold ? "font-semibold" : "font-medium")}>
          <span className="truncate">{p.name}</span>
          {p.tag && <span className="shrink-0 text-[11px] font-normal text-muted-foreground">{p.tag}</span>}
        </span>
        {p.interval ? (
          <div className="relative h-5">
            <span className="absolute inset-y-0 left-1/2 w-px bg-muted-foreground/40" />
            <span
              className={cn("absolute top-1/2 h-0.5 -translate-y-1/2 rounded-full", tone, !clear && "opacity-70")}
              style={{ left: at(p.interval[0]), width: `calc(${at(p.interval[1])} - ${at(p.interval[0])})` }}
            />
            <span
              className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card", tone)}
              style={{ left: at(p.delta!) }}
            />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">樣本太少，輸後 {p.loss.g} 場・贏後 {p.win.g} 場</span>
        )}
        <span className="col-span-2 font-mono text-[11px] tabular-nums text-muted-foreground sm:col-span-1">
          {p.delta === null ? "—" : <b className={cn("text-xs", clear ? (p.delta < 0 ? "text-loss" : "text-win") : "text-foreground")}>{p.delta > 0 ? "+" : ""}{p.delta.toFixed(1)} pp</b>}
          {"  "}輸後 {pctOf(p.loss)}（{p.loss.g}）・贏後 {pctOf(p.win)}（{p.win.g}）
        </span>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1 grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 text-[11px] text-muted-foreground sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_minmax(0,19rem)]">
        <span />
        <div className="flex justify-between font-mono tabular-nums">
          <span>← 更差 {-reach}</span>
          <span>0</span>
          <span>+{reach} 更好 →</span>
        </div>
      </div>
      <div className="divide-y">{people.map((p) => row(p))}</div>
      <div className="mt-1 border-t-2 pt-1">{row(pooled, true)}</div>
    </div>
  )
}

/** 節奏頁只能看「有完整歷史」的人：「前一場」「一輪」要靠這個人在資料庫裡的每一場排出順序。
 *  追蹤對象的場次是整批抓的；路人只在碰到你的那幾場出現，他的「上一場」其實是別人的某一場，算出來沒有意義
 *  （實測：路人 3600 列裡只有 570 列有「前一場」，追蹤對象與自己 1397 列有 1389 列）。 */
const NO_ALL = { all: "路人在資料庫裡只有碰到你的那幾場，沒有完整歷史，排不出他的「上一場」與「一輪」" }

export function Tilt() {
  const { players } = useFilters()
  const [who, setWhoState] = usePageWho(NO_ALL)
  const scope = useWhoScope(who)
  const apply = scope.q
  const [focus, setFocus] = useState<TiltFocus | null>(null)
  useCrumb(10, focus?.label ?? null, () => setFocus(null))
  const setWho = (next: Who) => {
    setWhoState(next)
    setFocus(null)
  }
  const noTracked = who === "tracked" && !scope.trackedCount
  // 「一輪打到第幾場」同一個維度的粗細兩種，和時段頁「四時段／逐小時」一樣用切換鈕。
  const [grain, setGrain] = useState<"stage" | "index">("stage")

  // participant_context 和 participants 一對一，所以直接走 apply()：
  // 帳號、模式、期間、全域下鑽（例如某隻英雄）都會一起套上。
  // 序列（前一場、第幾場）是在完整歷史上先算好的，篩選不會讓它重新編號。
  const byPrev = useCube(
    apply({ measures: [G, W, "participants.winrate"], dimensions: ["participant_context.prev_result"], limit: 10 }),
  )
  const byStage = useCube(
    apply({ measures: [G, W, "participants.winrate"], dimensions: ["participant_context.session_stage"], limit: 10 }),
  )
  const byIndex = useCube(
    grain === "index"
      ? apply({ measures: [G, W, "participants.winrate"], dimensions: ["participant_context.game_in_session"], limit: NO_LIMIT })
      : null,
  )

  // 追蹤對象才需要逐人拆開
  const byPerson = useCube(
    who === "tracked"
      ? apply({ measures: [G, W], dimensions: ["participants.puuid", "participant_context.prev_result"], limit: NO_LIMIT })
      : null,
  )

  const pick = (label: string) => byPrev.rows.find((r) => r["participant_context.prev_result"] === label)
  const afterLoss = pick("前一場輸")
  const afterWin = pick("前一場贏")
  const lossWr = num(afterLoss?.["participants.winrate"] ?? null)
  const winWr = num(afterWin?.["participants.winrate"] ?? null)
  const delta = lossWr !== null && winWr !== null ? lossWr - winWr : null
  const interval = diffInterval(countsOf(afterLoss), countsOf(afterWin))
  const clear = isClear(interval)

  const people: Person[] = useMemo(() => {
    const tally = new Map<string, { loss: Counts; win: Counts }>()
    for (const r of byPerson.rows) {
      const puuid = String(r["participants.puuid"])
      const kind = r["participant_context.prev_result"]
      if (kind !== "前一場輸" && kind !== "前一場贏") continue
      const cur = tally.get(puuid) ?? { loss: { g: 0, w: 0 }, win: { g: 0, w: 0 } }
      cur[kind === "前一場輸" ? "loss" : "win"] = countsOf(r)
      tally.set(puuid, cur)
    }
    const byId = new Map(players.map((p) => [p.puuid, p]))
    return [...tally.entries()]
      .map(([puuid, c]) => {
        const { name, tag } = splitRiotId(byId.get(puuid)?.riot_id ?? null, puuid)
        return personOf(puuid, name, tag, c.loss, c.win)
      })
      // 畫得出區間的在前，再依樣本多寡
      .sort((a, b) => Number(!!b.interval) - Number(!!a.interval) || b.loss.g + b.win.g - (a.loss.g + a.win.g))
  }, [byPerson.rows, players])
  const pooled = personOf("pooled", `合併（${people.length} 位）`, "", countsOf(afterLoss), countsOf(afterWin))

  // 平均線用這個條件下的整體勝率（含「沒有前一場」那場），不要用長條自己的加權平均——
  // 拿掉一組之後平均會偏掉，同一頁兩張圖的「平均」就對不上
  const totalGames = byPrev.rows.reduce((a, r) => a + (num(r[G]) ?? 0), 0)
  const totalWins = byPrev.rows.reduce((a, r) => a + (num(r[W]) ?? 0), 0)
  const overall = totalGames ? (100 * totalWins) / totalGames : undefined

  const prevBars: BarDatum[] = byPrev.rows
    .filter((r) => r["participant_context.prev_result"] !== "沒有前一場")
    .map((r) => ({
      label: String(r["participant_context.prev_result"]),
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r[G]) ?? 0,
    }))

  const stageBars: BarDatum[] = byStage.rows
    .map((r) => ({
      label: String(r["participant_context.session_stage"]),
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r[G]) ?? 0,
    }))
    .sort((a, b) => STAGE_ORDER.indexOf(a.label) - STAGE_ORDER.indexOf(b.label))

  const indexBars: BarDatum[] = byIndex.rows
    .map((r) => ({
      label: `第 ${r["participant_context.game_in_session"]} 場`,
      index: Number(r["participant_context.game_in_session"]),
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r[G]) ?? 0,
    }))
    .filter((r) => r.games >= MIN_GAMES)
    .sort((a, b) => a.index - b.index)

  // 點長條 → 下面列出那一組的每一場。再點一次同一根取消。
  const toggleFocus = (next: TiltFocus) =>
    setFocus((cur) => (cur && cur.kind === next.kind && cur.value === next.value ? null : next))

  const dayChart = grain === "stage" ? byStage : byIndex
  const dayBars = grain === "stage" ? stageBars : indexBars

  const switcher = <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} disabled={NO_ALL} />
  if (noTracked) {
    return (
      <div className="space-y-4">
        {switcher}
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的節奏數據。</EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {switcher}
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="前一場輸之後"
          value={lossWr === null ? "—" : `${lossWr.toFixed(1)}%`}
          hint={afterLoss ? `${num(afterLoss[G])} 場` : undefined}
          loading={byPrev.loading}
        />
        <Kpi
          label="前一場贏之後"
          value={winWr === null ? "—" : `${winWr.toFixed(1)}%`}
          hint={afterWin ? `${num(afterWin[G])} 場` : undefined}
          loading={byPrev.loading}
        />
        <Kpi
          label="落差"
          value={delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pp`}
          hint={
            interval === null
              ? delta === null
                ? undefined
                : "樣本太少，先不解讀"
              : `95% 區間 ${interval[0].toFixed(0)}～${interval[1].toFixed(0)} pp・${clear ? "區間不含 0" : "還在樣本誤差內"}${who === "tracked" ? "・同場重複算，區間偏窄" : ""}`
          }
          // 只有區間不跨 0 才上色；跨 0 時再大的落差也只是描述
          tone={clear && delta !== null ? (delta < 0 ? "loss" : "win") : undefined}
          loading={byPrev.loading}
        />
      </div>

      {who === "tracked" && (
        <Panel
          title="每個人的落差"
          caption={`點是「前一場輸之後的勝率 − 前一場贏之後的勝率」，線是 95% 區間（往左是輸之後更差、往右是更好），只有區間不跨 0 才上色；輸後或贏後不到 ${MIN_GAMES} 場的人不畫。最下面「合併」是把大家的場次加在一起，被打得最多場的人拉著走，而且追蹤對象常常同隊，同一場被每個人各算一次、區間比實際窄——以逐人為準`}
        >
          {byPerson.loading ? (
            <Skeleton className="h-[240px] w-full" />
          ) : byPerson.error ? (
            <QueryError error={byPerson.error} />
          ) : people.length ? (
            <ForestPlot people={people} pooled={pooled} />
          ) : (
            <EmptyState>還沒有資料。</EmptyState>
          )}
        </Panel>
      )}

      <Panel
        title="前一場的結果，和這一場的勝率"
        caption="兩組的勝率並排比較。這是關聯不是因果：連勝連敗也可能來自同一段時間的隊友與對手，不一定是心態。點一根看那些場次"
      >
        {byPrev.loading ? (
          <Skeleton className="h-[180px] w-full" />
        ) : byPrev.error ? (
          <QueryError error={byPrev.error} />
        ) : prevBars.length ? (
          <BarChart
            data={prevBars}
            suffix="%"
            showGames
            baseline={overall}
            selected={focus?.kind === "prev_result" ? focus.value : null}
            onPick={(label) => toggleFocus({ kind: "prev_result", value: label, label })}
          />
        ) : (
          <EmptyState>還沒有資料。</EmptyState>
        )}
      </Panel>

      <Panel
        title="同一輪連續打到第幾場"
        caption={
          grain === "stage"
            ? "一輪 = 前一場結束後不到 60 分鐘就接著打，跨過午夜也算同一輪。以輪內第幾場分組，點一根看那些場次"
            : `逐場拆開，只列出累積 ${MIN_GAMES} 場以上的場次序號。點一根看那些場次`
        }
        action={
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={grain}
            onValueChange={(v) => v && setGrain(v as "stage" | "index")}
          >
            <ToggleGroupItem value="stage">分段</ToggleGroupItem>
            <ToggleGroupItem value="index">逐場</ToggleGroupItem>
          </ToggleGroup>
        }
      >
        {dayChart.loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : dayChart.error ? (
          <QueryError error={dayChart.error} />
        ) : dayBars.length ? (
          <BarChart
            data={dayBars}
            suffix="%"
            showGames
            baseline={overall}
            selected={
              grain === "stage" && focus?.kind === "session_stage"
                ? focus.value
                : grain === "index" && focus?.kind === "game_in_session"
                  ? `第 ${focus.value} 場`
                  : null
            }
            onPick={(label) =>
              grain === "stage"
                ? toggleFocus({ kind: "session_stage", value: label, label: `當輪${label}` })
                : toggleFocus({ kind: "game_in_session", value: label.replace(/\D/g, ""), label: `當輪${label}` })
            }
          />
        ) : (
          <EmptyState>
            {grain === "stage" ? "還沒有資料。" : `單一場次序號還沒累積到 ${MIN_GAMES} 場，切回「分段」看看。`}
          </EmptyState>
        )}
      </Panel>

      {focus && (
        // 「是哪幾場」用和上面圖表同一組條件向 Cube 查，後端不必再抄一份視窗函數
        <DrillPanel
          title={focus.label}
          gameIdKey="matches.game_id"
          query={apply({
            measures: [G],
            dimensions: [who === "tracked" ? "participants.participant_key" : "matches.game_id"],
            filters: [{ member: `participant_context.${focus.kind}`, operator: "equals", values: [focus.value] }],
            limit: MAX_GAME_IDS,
          })}
          rowsToParams={who === "tracked" ? participantRows : undefined}
          showPlayer={who === "tracked"}
          onClose={() => setFocus(null)}
        />
      )}

      <p className="text-xs leading-relaxed text-muted-foreground">
        「前一場」與「一輪」都在同一個模式內算——這樣切是為了讓上方的模式篩選有意義，
        否則篩到 Mayhem 時，前一場可能指向畫面上根本看不到的其他模式對局。
        60 分鐘是分析上的切法，不是遊戲提供的欄位。這類差距在一兩百場的樣本下波動很大，看落差旁的區間再下判斷。
      </p>
    </div>
  )
}
