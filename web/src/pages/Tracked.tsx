import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"
import { Plus, X, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { CountUp } from "@/components/CountUp"
import { MatchList } from "@/components/MatchList"
import { Panel, EmptyState, Kpi, QueryError } from "@/components/primitives"
import { useCollectorStatus, useCube } from "@/hooks/useCube"
import { useCrumb } from "@/lib/breadcrumb"
import { iconUrl, num, type CubeQuery } from "@/lib/cube"
import { useFilters } from "@/lib/filters"
import { cn } from "@/lib/utils"
import { participantRows } from "@/lib/who"
import { NO_LIMIT, splitRiotId } from "./shared"

type Account = { puuid: string; riot_id: string | null; games: number; shared?: number }
type AccountsPayload = {
  me: { puuid: string; riot_id: string }[]
  tracked: Account[]
  candidates: Account[]
}

// ── 單場每分鐘紀錄 ──────────────────────────────────────────────────────────
// 範圍是「目前帳號也在場的那些對局」：追蹤對象自己單獨打、你沒參與的場次不算進來
// （那些場次照樣會被採集，只是不在這個榜上）。條件就是語意層的 game_players.puuid
// 等於目前帳號——一對多 join，SQLite 先用 puuid 索引找出他的每一場再接回來。
// 人則是「他自己 ＋ 追蹤中的帳號」。
//
// 指標一律用語意層的 participants.best_*（max）。卡片上的「最高是多少」和清單裡的
// 「是哪幾場」是同一個指標查出來的：以參賽者鍵（participant_key）分組時一組只有一列，
// max 就等於那一場自己的值，所以兩邊不可能對不上，前端也不必自己再算一次每分鐘。
// max 也不怕一對多 join 的重複列，所以上面那個篩選不會讓數字變樣。
//
// 模式、期間與全域下鑽照樣套用（apply(query, "all")），和其他頁的數字是同一組條件。

/** 清單一次列幾場 */
const TOP_N = 10

type Metric = {
  /** 語意層的 max 指標 */
  key: string
  label: string
  unit?: string
  decimals: number
  /** 這個紀錄是好事還是壞事：死亡最高的那一場是慘案，不要上成好成績的顏色 */
  tone: "good" | "bad" | "plain"
  hint: string
}

const METRICS: Metric[] = [
  { key: "participants.best_kills_per_min", label: "每分鐘擊殺", decimals: 2, tone: "good", hint: "擊殺 ÷ 對局分鐘數" },
  { key: "participants.max_deaths_per_min", label: "每分鐘死亡", decimals: 2, tone: "bad", hint: "死亡 ÷ 對局分鐘數，死最快的一場" },
  { key: "participants.best_assists_per_min", label: "每分鐘助攻", decimals: 2, tone: "good", hint: "助攻 ÷ 對局分鐘數" },
  { key: "participants.max_dpm", label: "每分鐘對英雄傷害", decimals: 0, tone: "good", hint: "對敵方英雄的傷害 ÷ 對局分鐘數" },
  { key: "participants.best_taken_per_min", label: "每分鐘承受傷害", decimals: 0, tone: "plain", hint: "承受的總傷害 ÷ 對局分鐘數" },
  { key: "participants.best_mitigated_per_min", label: "每分鐘減免傷害", decimals: 0, tone: "plain", hint: "靠護甲、魔抗、護盾擋下的 ÷ 對局分鐘數" },
  { key: "participants.best_heal_per_min", label: "每分鐘治療", decimals: 0, tone: "plain", hint: "治療總量（含治療自己）÷ 對局分鐘數" },
  { key: "participants.best_cc_time_per_min", label: "每分鐘控場", unit: "秒", decimals: 1, tone: "good", hint: "控住敵人的秒數 ÷ 對局分鐘數" },
  { key: "participants.max_gpm", label: "每分鐘經濟", decimals: 0, tone: "good", hint: "獲得的金錢 ÷ 對局分鐘數" },
  { key: "participants.best_cs_per_min", label: "每分鐘補兵", decimals: 1, tone: "good", hint: "補到的兵 ÷ 對局分鐘數" },
  { key: "participants.best_objective_damage_per_min", label: "每分鐘建築傷害", decimals: 0, tone: "good", hint: "對防禦塔與兵營的傷害 ÷ 對局分鐘數" },
  { key: "participants.best_minion_damage_per_min", label: "每分鐘小兵傷害（估）", decimals: 0, tone: "plain", hint: "總輸出 − 對英雄 − 對建築，再 ÷ 對局分鐘數" },
]

const METRIC_KEYS = METRICS.map((m) => m.key)

const fmtValue = (m: Metric, v: number) =>
  `${m.decimals === 0 ? Math.round(v).toLocaleString() : v.toFixed(m.decimals)}${m.unit ? ` ${m.unit}` : ""}`

/** 對局長度（分鐘，含小數）寫成 mm:ss。先換算成整秒再拆，避免 14.999 分變成 14:60 */
const asClock = (minutes: number) => {
  const total = Math.round(minutes * 60)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

/** 紀錄數字的顏色：只有「死亡」這種壞紀錄上敗色。
 *  其餘一律前景色——十二張卡全部上勝色會變成一整片綠，而且「承受傷害最高」本來就不分好壞。 */
const toneClass = (m: Metric) => (m.tone === "bad" ? "text-loss" : "text-foreground")

/** 紀錄保持人的大數字卡。點一下看那個指標最高的幾場 */
function RecordCard({
  metric,
  holder,
  loading,
  selected,
  index,
  onPick,
}: {
  metric: Metric
  holder: { name: string; value: number } | null
  loading: boolean
  selected: boolean
  index: number
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      data-testid="record-card"
      data-metric={metric.key}
      title={`${metric.label}：${metric.hint}。點一下看最高的 ${TOP_N} 場`}
      style={{ "--stagger": `${Math.min(index * 40, 240)}ms` } as CSSProperties}
      className={cn(
        "rise flex flex-col gap-0.5 rounded-lg border bg-card px-3 py-2.5 text-left transition",
        "hover:border-primary/40 hover:bg-accent/40",
        selected && "border-primary bg-primary/10 ring-1 ring-primary hover:bg-primary/15",
      )}
    >
      {/* 不截斷：「每分鐘小兵傷害（估）」在窄欄裡會被切掉，讓它換行就好 */}
      <span className="text-[11px] leading-tight text-muted-foreground">{metric.label}</span>
      {loading ? (
        <Skeleton className="my-1 h-6 w-20" />
      ) : holder ? (
        <CountUp text={fmtValue(metric, holder.value)} className={cn("font-mono text-xl font-bold leading-tight tabular-nums", toneClass(metric))} />
      ) : (
        <span className="font-mono text-xl font-bold leading-tight text-muted-foreground">—</span>
      )}
      <span className="truncate text-[11px] text-muted-foreground">{holder ? holder.name : "沒有對局"}</span>
    </button>
  )
}

/** 某個指標最高的幾場：一列一場（誰、哪隻英雄、多少、哪天、打多久） */
function TopGames({ metric, rows }: { metric: Metric; rows: Record<string, string | number | null>[] }) {
  return (
    <ol className="divide-y divide-border/50">
      {rows.map((r, i) => {
        const value = num(r[metric.key])
        const minutes = num(r["matches.duration_minutes"])
        const { name, tag } = splitRiotId(r["participants.riot_id"] as string | null, "—")
        return (
          <li
            key={String(r["participants.participant_key"])}
            data-testid="record-game"
            className="slide-in flex items-center gap-3 py-2"
            style={{ "--stagger": `${Math.min(i * 30, 400)}ms` } as CSSProperties}
          >
            <span className="w-5 shrink-0 text-right font-mono text-xs font-bold tabular-nums text-muted-foreground">{i + 1}</span>
            <img
              src={iconUrl(r["champions.icon_path"] as string | null)}
              alt={String(r["champions.name"] ?? "")}
              className="size-8 shrink-0 rounded-md bg-icon-tile"
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-1">
                <span className="truncate text-sm font-medium">{name}</span>
                {tag && <span className="shrink-0 text-[11px] text-muted-foreground">{tag}</span>}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {String(r["champions.name"] ?? "—")} · {String(r["matches.local_date"] ?? "—")}
                {minutes !== null && ` · ${asClock(minutes)}`}
              </span>
            </span>
            <span data-testid="record-value" className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", toneClass(metric))}>
              {value === null ? "—" : fmtValue(metric, value)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type Best = { puuid: string; name: string; isCenter: boolean; values: Record<string, number | null> }

/** 每個人的單場最高：一列一個指標、一欄一個人，那一列最高的上色（就是紀錄保持人） */
function PerPlayerTable({ people }: { people: Best[] }) {
  return (
    // 人多時整張表橫向捲動，不要讓欄位擠到字被截斷
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th scope="col" className="py-1.5 pr-3 text-left text-[11px] font-medium text-muted-foreground">
              每分鐘指標
            </th>
            {people.map((p) => (
              <th key={p.puuid} scope="col" className="min-w-[5.5rem] px-2 py-1.5 text-right text-[11px] font-medium">
                <span className="truncate">{p.name}</span>
                {p.isCenter && (
                  <span className="ml-1 text-[10px] text-primary" title="這個榜只算他也在場的對局">
                    中心
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {METRICS.map((m) => {
            const values = people.map((p) => p.values[m.key] ?? null)
            const best = Math.max(...values.map((v) => (v === null ? -Infinity : v)))
            return (
              <tr key={m.key} data-testid="per-player-row" data-metric={m.key} className="border-b border-border/50 last:border-0">
                <th scope="row" className="py-1.5 pr-3 text-left text-xs font-normal" title={m.hint}>
                  {m.label}
                </th>
                {values.map((v, i) => (
                  <td
                    key={people[i].puuid}
                    className={cn(
                      "px-2 py-1.5 text-right font-mono text-xs tabular-nums",
                      v !== null && v === best
                        ? cn("font-bold", m.tone === "bad" ? "text-loss" : "text-win")
                        : "text-muted-foreground",
                    )}
                    title={v !== null && v === best ? `${people[i].name} 保持著這項紀錄` : undefined}
                  >
                    {v === null ? "—" : fmtValue(m, v)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function MinuteRecords() {
  const { players, matchParams, account, apply } = useFilters()
  const [picked, setPicked] = useState<Metric | null>(null)
  /** 展開了戰報的那個指標（換指標就收起來，不用額外的 effect） */
  const [cardsFor, setCardsFor] = useState<string | null>(null)
  useCrumb(10, picked?.label ?? null, () => setPicked(null))

  // 中心帳號：帳號切換器目前選的那個（預設是本機帳號）。只算他也在場的對局。
  const center = account
  const centerName = center ? splitRiotId(center.riot_id, center.puuid).name : ""
  // 算誰的紀錄：中心帳號自己 ＋ 追蹤中的帳號（crew，和「看誰的數據：追蹤對象」同一群）
  const subjects = useMemo(() => {
    const ids = players.filter((p) => p.crew).map((p) => p.puuid)
    return center && !ids.includes(center.puuid) ? [center.puuid, ...ids] : ids
  }, [players, center])

  /** 這一節共用的條件：中心帳號也在場、只算這幾個人，外加全域的模式／期間／下鑽。
   *  條件還沒備妥（還沒有帳號）時回 null，useCube 就不會送出查詢。 */
  const scoped = (query: CubeQuery): CubeQuery | null =>
    center && subjects.length
      ? apply(
          {
            ...query,
            filters: [
              { member: "participants.puuid", operator: "equals", values: subjects },
              // 「這一場中心帳號也在」。一對多 join 的等值篩選，說明在 cube/model/cubes/dimensions.yml
              // 的 game_players；max 指標不怕它造成的重複列
              { member: "game_players.puuid", operator: "equals", values: [center.puuid] },
              ...(query.filters ?? []),
            ],
          },
          "all",
        )
      : null

  // 一次查完所有指標：一人一列、每個指標一欄（max）。紀錄保持人就是每一欄的最大值。
  // 人數少（中心帳號 ＋ 追蹤名單），所以一個查詢就夠，不必每個指標各查一次。
  const bests = useCube(scoped({ measures: METRIC_KEYS, dimensions: ["participants.puuid"], limit: NO_LIMIT }))

  // 點了某個指標才查是哪幾場。用同一個 best_* 指標 + 參賽者鍵分組：一組一列，max 等於那場的值
  const top = useCube(
    picked
      ? scoped({
          measures: [picked.key],
          dimensions: [
            "participants.participant_key",
            "participants.riot_id",
            "champions.name",
            "champions.icon_path",
            "matches.local_date",
            "matches.duration_minutes",
          ],
          order: { [picked.key]: "desc" },
          limit: TOP_N,
        })
      : null,
  )

  const people = useMemo<Best[]>(() => {
    // 名稱用 /api/players 那份（公開鏡像已經遮罩過），不另外向 Cube 查一次
    const byId = new Map(players.map((p) => [p.puuid, p]))
    return bests.rows
      .map((r) => {
        const puuid = String(r["participants.puuid"])
        return {
          puuid,
          name: splitRiotId(byId.get(puuid)?.riot_id ?? null, puuid).name,
          isCenter: puuid === center?.puuid,
          values: Object.fromEntries(METRIC_KEYS.map((k) => [k, num(r[k])])),
        }
      })
      // 完全沒有數字的人（這個期間沒和中心帳號同場）不占一整欄
      .filter((p) => METRIC_KEYS.some((k) => p.values[k] !== null))
      .sort((a, b) => Number(b.isCenter) - Number(a.isCenter) || a.name.localeCompare(b.name, "zh-Hant"))
  }, [bests.rows, players, center])

  const holders = useMemo(() => {
    const out = new Map<string, { name: string; value: number }>()
    for (const key of METRIC_KEYS) {
      let best: { name: string; value: number } | null = null
      for (const p of people) {
        const v = p.values[key]
        if (v !== null && (!best || v > best.value)) best = { name: p.name, value: v }
      }
      if (best) out.set(key, best)
    }
    return out
  }, [people])

  const drill = top.rows.length ? participantRows(top.rows) : null

  return (
    <>
      <Panel
        title="單場每分鐘紀錄"
        caption={`以 ${centerName || "目前帳號"} 為中心：只算他也在場的對局，比的是他自己和追蹤中的人共 ${subjects.length} 位。跟著上方的模式與期間篩選。`}
      >
        {bests.error ? (
          <QueryError error={bests.error} />
        ) : !center || !subjects.length ? (
          <EmptyState>還沒有可以統計的帳號。</EmptyState>
        ) : !bests.loading && !people.length ? (
          <EmptyState>這個模式與期間裡，{centerName} 沒有對局。</EmptyState>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {METRICS.map((m, i) => (
                <RecordCard
                  key={m.key}
                  metric={m}
                  index={i}
                  holder={holders.get(m.key) ?? null}
                  loading={bests.loading}
                  selected={picked?.key === m.key}
                  onPick={() => {
                    setPicked((cur) => (cur?.key === m.key ? null : m))
                    setCardsFor(null)
                  }}
                />
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              只算{centerName}也在場的對局——追蹤對象自己單獨打的場次雖然也採集了，但不在這個榜上。同隊、敵對都算。
              每分鐘是「整場平均」：短局的值天生偏高（前期人頭密、補兵和建築傷害少），所以清單裡會一併列出那場打了多久。
              重開局不算。點任一張卡看是哪幾場。
            </p>
          </>
        )}
      </Panel>

      {picked && (
        <Panel
          title={`${picked.label}：最高的 ${TOP_N} 場`}
          caption={`${picked.hint}。這幾場是用卡片上同一個指標排出來的。`}
          action={
            <div className="flex shrink-0 items-center gap-2">
              {drill && (
                <Button
                  size="sm"
                  variant={cardsFor === picked.key ? "secondary" : "outline"}
                  onClick={() => setCardsFor((cur) => (cur === picked.key ? null : picked.key))}
                >
                  {cardsFor === picked.key ? "收起戰報" : "列出這幾場的戰報"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
                <X className="size-3.5" />
                收起
              </Button>
            </div>
          }
        >
          {top.error ? (
            <QueryError error={top.error} />
          ) : top.loading ? (
            <Skeleton className="h-[460px] w-full" />
          ) : !top.rows.length ? (
            <EmptyState>這個條件下沒有對局。</EmptyState>
          ) : (
            <>
              <TopGames metric={picked} rows={top.rows} />
              {cardsFor === picked.key && drill && (
                <div className="reveal mt-3 border-t pt-3">
                  {/* 逐場卡片一律走 /api/matches；是哪幾場由上面那個 Cube 查詢決定（participants=遊戲:參賽者） */}
                  <MatchList params={{ ...matchParams(), ...drill.params }} showPlayer />
                </div>
              )}
            </>
          )}
        </Panel>
      )}

      <Panel
        title="每個人的單場最高"
        caption={`一列一個指標、一欄一個人，同樣只算和 ${centerName || "目前帳號"} 同場的對局。那一列上色的就是紀錄保持人（死亡那列是最慘的一場，所以用敗色）。`}
      >
        {bests.loading ? (
          <Skeleton className="h-[320px] w-full" />
        ) : people.length ? (
          <PerPlayerTable people={people} />
        ) : (
          <EmptyState>這個模式與期間裡沒有對局。</EmptyState>
        )}
      </Panel>
    </>
  )
}

export function Tracked() {
  const [data, setData] = useState<AccountsPayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [ingesting, setIngesting] = useState(false)
  const status = useCollectorStatus()

  const load = useCallback(async () => {
    const res = await fetch("/api/accounts")
    setData(await res.json())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggle = async (puuid: string, tracked: boolean) => {
    setBusy(puuid)
    setError(null)
    try {
      const res = await fetch("/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ puuid, tracked }),
      })
      const body = await res.json()
      if (body.error) setError(body.error)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const collectNow = async () => {
    setIngesting(true)
    try {
      await fetch("/api/ingest", { method: "POST" })
      await load()
    } finally {
      setIngesting(false)
    }
  }

  // 對外開放的唯讀模式：寫入端點會回 403，這頁的入口就不要留著讓人白按
  const readOnly = !!status?.public
  const trackedIds = new Set(data?.tracked.map((a) => a.puuid) ?? [])
  const candidates = (data?.candidates ?? []).filter(
    (c) => !trackedIds.has(c.puuid) && (c.riot_id ?? "").toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="我的 Mayhem 場次"
          value={status ? String(status.myMayhemMatches ?? "—") : "—"}
          hint="分析頁面看的是這個數字"
          loading={!status}
        />
        <Kpi
          label="資料庫全部對局"
          value={status ? String(status.totalMatches) : "—"}
          hint="含好友帶進來、你沒參與的場次"
          loading={!status}
        />
        <Kpi
          label="追蹤中的對象"
          value={String(data?.tracked.length ?? 0)}
          hint="每輪採集會一併掃描"
          loading={!data}
        />
      </div>

      {readOnly && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
          這個站台是<b>對外開放的唯讀模式</b>：採集與追蹤名單只能在這台電腦上操作
          （開 127.0.0.1:5057）。其他玩家的名稱也已經換成代號。
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Panel
        title="追蹤中"
        caption="每次採集會順便掃這些人的紀錄。他們打了你沒參與的對局也會被收進來。"
        action={
          readOnly ? undefined : (
            <Button size="sm" variant="outline" onClick={collectNow} disabled={ingesting}>
              <RefreshCw className={ingesting ? "animate-spin" : ""} />
              {ingesting ? "採集中…" : "立即採集"}
            </Button>
          )
        }
      >
        {!data ? (
          <Skeleton className="h-24 w-full" />
        ) : !data.tracked.length ? (
          <EmptyState>還沒有追蹤任何人。從下面的清單加入。</EmptyState>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.tracked.map((a) => (
              <Badge key={a.puuid} variant="secondary" className="gap-2 py-1.5 pl-3 pr-1.5">
                <span className="font-medium">{a.riot_id ?? a.puuid.slice(0, 8)}</span>
                <span className="text-muted-foreground">
                  同場 {a.shared ?? a.games}
                  {a.shared !== undefined && a.games > a.shared && (
                    <span className="ml-1 text-[10px]">＋{a.games - a.shared} 場你沒參與</span>
                  )}
                </span>
                <button
                  onClick={() => toggle(a.puuid, false)}
                  disabled={busy === a.puuid || readOnly}
                  className="rounded-sm opacity-60 transition hover:opacity-100"
                  aria-label="取消追蹤"
                >
                  <X className="size-3.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </Panel>

      <MinuteRecords />

      <Panel
        title="可加入的對象"
        caption="只列得出曾經和你同場過的人——客戶端沒有提供公開的名稱查詢，完全沒同場過的帳號查不到。"
      >
        <Input
          placeholder="搜尋名稱…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3 max-w-xs"
        />
        {!data ? (
          <Skeleton className="h-40 w-full" />
        ) : !candidates.length ? (
          <EmptyState>沒有符合的對象。</EmptyState>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.map((c) => (
              <button
                key={c.puuid}
                onClick={() => toggle(c.puuid, true)}
                disabled={busy === c.puuid || readOnly}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-accent disabled:opacity-50"
              >
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.riot_id ?? c.puuid.slice(0, 8)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.games} 場</span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          <b className="text-foreground">別人的紀錄只給最新 20 場</b>（你自己是 100 場），
          而且一樣不能翻頁。所以追蹤對象的歷史深度比你自己淺很多，也更容易被時間擠掉——
          想累積就得讓採集持續跑。
        </p>
        <p>
          <b className="text-foreground">對常一起玩的人，這通常收不到什麼新東西。</b>
          因為你們的對局你早就有了（而且是完整 10 人版本）。真正會有新資料的，
          是那些偶爾才跟你同隊、大部分時間自己玩的朋友。
        </p>
        <p>
          重複採集不會產生重複資料：對局以 (platform_id, game_id) 為主鍵，
          寫入用 INSERT OR IGNORE，而且抓明細之前會先問資料庫有沒有了。
          同一場不論從誰的清單掃到，都只會存一份。
        </p>
      </div>
    </div>
  )
}
