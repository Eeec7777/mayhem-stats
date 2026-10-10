import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ChevronLeft, Coins, Swords } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, Panel } from "@/components/primitives"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useCube } from "@/hooks/useCube"
import { usePageWho } from "@/lib/whoState"
import { useWhoScope, type WhoScope } from "@/lib/who"
import { MAX_GAME_IDS, iconUrl, num, type CubeRow } from "@/lib/cube"
import { NO_LIMIT } from "./shared"
import { useFilters } from "@/lib/filters"
import { CubeMatchList, MatchList } from "@/components/MatchList"
import { RoleChip, RoleLegend } from "@/components/RoleChip"
import { ContribRadarChart } from "@/components/charts"
import { ContribBars, ContribInline, ContribMeter, ContribTagBadge } from "@/components/Contribution"
import { CONTRIB_PARTS, PERF_GAP, PERF_PARTS, contribScore, contribTagOf, perfScore, useCardContribution, useContribution, type ContribTag } from "@/hooks/useContribution"
import { participantKey, useBuildRoles } from "@/hooks/useBuildRoles"
import { cn } from "@/lib/utils"

type Item = { slot: number; item_id: number; name: string | null; icon_path: string | null }
/** 同場十個人裡的一個，只要英雄（不帶名稱，列表不列出其他玩家的帳號）。 */
type Mate = { participant_id: number; team_id: number; champion_name: string; champion_icon: string | null }
type Augment = { slot: number; name: string | null; rarity: string | null; icon_path: string | null }

export type MatchRow = {
  platform_id: string
  game_id: number
  participant_id: number
  team_id: number
  game_creation: number
  game_duration: number
  game_mode: string
  ended_surrender: number
  champion_name: string
  champion_icon: string | null
  champ_level: number
  win: number
  kills: number
  deaths: number
  assists: number
  cs: number
  gold_earned: number
  dmg_to_champions: number
  team_kills: number
  penta_kills: number
  quadra_kills: number
  /** 這一列是誰。英雄頁切到「所有人」「追蹤對象」時，每一列可能是不同玩家 */
  puuid?: string
  riot_id?: string | null
  items: Item[]
  augments: Augment[]
  roster: Mate[]
  /** 「和某人同場」的下鑽才有：那個人那場的參賽者編號，卡片上把他的英雄圈出來 */
  with_participant_id?: number | null
}

/** 對局紀錄只有「目前帳號」與「追蹤對象」：所有人的清單和追蹤對象去重後是同一份
 *  （每場至少有一位自己或追蹤對象），多一個選項只會讓人以為有差別。 */
const NO_ALL = { all: "每一場至少有一位你或追蹤對象，所以「追蹤對象」每場只列一張，就已經是資料庫裡的全部場次" }

export type Player = MatchRow & {
  riot_id: string
  is_me: number
  dmg_taken: number
  dmg_physical: number
  dmg_magic: number
  dmg_true: number
  dmg_mitigated: number
  total_heal: number
  gold_spent: number
  time_ccing_others: number
  largest_multi_kill: number
  longest_time_living: number
  dmg_to_objectives: number
  first_blood: number
  first_tower: number
  double_kills: number
  triple_kills: number
}

const RARITY_RING: Record<string, string> = {
  kPrismatic: "ring-prismatic/70",
  kGold: "ring-gold/70",
  kSilver: "ring-silver/60",
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })

/** 麵包屑裡代表單場戰報的那一層：「9/12 22:48 剛普朗克」 */
export const matchCrumbLabel = (m: MatchRow) =>
  `${new Date(m.game_creation).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} ${m.champion_name}`

const fmtDuration = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** 六格裝備 + 飾品，空格也要畫出來，才看得出他沒補滿。 */
function ItemRow({ items, size = "size-7" }: { items: Item[]; size?: string }) {
  const bySlot = new Map(items.map((i) => [i.slot, i]))
  return (
    <div className="flex gap-0.5">
      {[0, 1, 2, 3, 4, 5, 6].map((slot) => {
        const item = bySlot.get(slot)
        return item?.item_id ? (
          <img
            key={slot}
            src={iconUrl(item.icon_path)}
            alt=""
            title={item.name ?? ""}
            className={cn(size, "rounded bg-icon-tile", slot === 6 && "ml-1")}
          />
        ) : (
          <div
            key={slot}
            className={cn(size, "rounded bg-secondary/40", slot === 6 && "ml-1")}
          />
        )
      })}
    </div>
  )
}

/** 增幅：一般是四個，提前結束的對局會少拿。空格也畫出來，列與列才對得齊。
 *  外框顏色代表稀有度（稜彩／金／銀），和單場戰報同一套。 */
function AugmentRow({ augments, size = "size-6" }: { augments: Augment[]; size?: string }) {
  const slots = Math.max(4, augments.length)
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: slots }, (_, i) => {
        const a = augments[i]
        return a ? (
          <img
            key={a.slot}
            src={iconUrl(a.icon_path)}
            alt=""
            title={`${a.name ?? ""}${a.rarity ? `（${a.rarity.replace("k", "")}）` : ""}`}
            className={cn(size, "rounded bg-icon-tile ring-1", a.rarity ? RARITY_RING[a.rarity] : "ring-border")}
          />
        ) : (
          <div key={`empty-${i}`} className={cn(size, "rounded bg-secondary/40")} />
        )
      })}
    </div>
  )
}

/** 同場另外九個人的英雄：我方（不含自己）在左、對手在右。
 *  只放圖示不放名稱——一是排不下，二是列表不應該整排列出其他玩家的帳號。 */
function RosterRow({ roster, teamId, self, withId }: { roster: Mate[]; teamId: number; self: number; withId?: number | null }) {
  const ally = roster.filter((p) => p.team_id === teamId && p.participant_id !== self)
  const foe = roster.filter((p) => p.team_id !== teamId)
  if (!ally.length && !foe.length) return null
  const line = (list: Mate[], label: string, title: string, dim = false) => (
    <div className={cn("flex items-center gap-0.5", dim && "opacity-80")} title={title}>
      <span className="w-3 shrink-0 text-[10px] leading-none text-muted-foreground">{label}</span>
      {list.map((p) => (
        <img
          key={p.participant_id}
          src={iconUrl(p.champion_icon)}
          alt=""
          title={p.participant_id === withId ? `${p.champion_name}（就是這個人）` : p.champion_name}
          // 下鑽的那個人：強調色外框，同隊在「我」那排、敵對在「敵」那排
          className={cn("size-5 rounded bg-icon-tile", p.participant_id === withId && "ring-2 ring-primary")}
        />
      ))}
    </div>
  )
  // 我方在上、對手在下，各一排：比左右並排窄一半，卡片才放得進好友比較的半版面板
  return (
    <div className="flex shrink-0 flex-col gap-0.5">
      {line(ally, "我", "我方")}
      {line(foe, "敵", "對手", true)}
    </div>
  )
}

// ─────────────────────────────────────────── 計分板

function Scoreboard({
  players,
  roleOf,
  contrib,
}: {
  players: Player[]
  roleOf: Map<string, string>
  contrib: Map<string, CubeRow>
}) {
  // 展開六項明細的人（可以同時開幾個互相比）
  const [open, setOpen] = useState<Set<number>>(new Set())
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  // 大數字、MVP／ACE 看當局表現分；小字是隊內排名（在隊裡扛的份量）
  const scoreOf = (p: Player) => perfScore(contrib.get(keyOf(p)))
  const rankOf = (p: Player) => contribScore(contrib.get(keyOf(p)))
  const teams = [100, 200].map((teamId) => {
    const members = players.filter((p) => p.team_id === teamId)
    return {
      scores: members.map(scoreOf),
      teamId,
      members,
      won: members[0]?.win === 1,
      kills: members.reduce((s, p) => s + p.kills, 0),
      deaths: members.reduce((s, p) => s + p.deaths, 0),
      assists: members.reduce((s, p) => s + p.assists, 0),
      gold: members.reduce((s, p) => s + p.gold_earned, 0),
    }
  })

  return (
    <div className="space-y-4">
      {teams.map((team) => (
        <div key={team.teamId} className="overflow-hidden rounded-lg border">
          <div
            className={cn(
              "flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-sm",
              team.won ? "bg-win/10" : "bg-loss/10",
            )}
          >
            <span className={cn("font-semibold", team.won ? "text-win" : "text-loss")}>
              {team.teamId === 100 ? "隊伍 1" : "隊伍 2"} · {team.won ? "勝利" : "失敗"}
            </span>
            <span className="flex items-center gap-1.5 tabular-nums">
              <Swords className="size-3.5 text-muted-foreground" />
              {team.kills} / {team.deaths} / {team.assists}
            </span>
            <span className="flex items-center gap-1.5 tabular-nums">
              <Coins className="size-3.5 text-muted-foreground" />
              {team.gold.toLocaleString()}
            </span>
          </div>

          <div className="divide-y">
            {team.members.map((p) => {
              const score = scoreOf(p)
              const tag: ContribTag | undefined = contribTagOf(score, team.scores, team.won)
              return (
              <div
                key={p.participant_id}
                className={cn(
                  "flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2",
                  p.is_me && "bg-primary/10",
                )}
              >
                <div className="relative shrink-0">
                  <img
                    src={iconUrl(p.champion_icon)}
                    alt=""
                    className="size-10 rounded-md bg-icon-tile"
                  />
                  <span className="absolute -bottom-1 -right-1 rounded bg-background px-1 text-[10px] font-bold tabular-nums">
                    {p.champ_level}
                  </span>
                </div>

                <div className="min-w-[110px] flex-1">
                  <div className="truncate text-sm font-medium">{p.riot_id}</div>
                  <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="truncate">{p.champion_name}</span>
                    {roleOf.get(keyOf(p)) && <RoleChip role={roleOf.get(keyOf(p))!} />}
                  </div>
                </div>

                <AugmentRow augments={p.augments} />
                <ItemRow items={p.items} />

                <div className="w-[92px] text-right text-sm font-semibold tabular-nums">
                  {p.kills} / <span className="text-loss">{p.deaths}</span> / {p.assists}
                </div>
                <div className="w-[70px] text-right text-sm tabular-nums text-muted-foreground">
                  {p.gold_earned.toLocaleString()}
                </div>

                <ContribMeter score={score} rank={rankOf(p)} tag={tag} expanded={open.has(p.participant_id)} onToggle={() => toggle(p.participant_id)} />

                {open.has(p.participant_id) && (
                  // 雷達看形狀、橫條看確切數字；窄了雷達在上、橫條在下
                  <div className="reveal flex w-full basis-full flex-wrap items-center gap-x-6 gap-y-2 rounded-md bg-secondary/30 px-3 py-2">
                    <div className="w-[260px] shrink-0">
                      <ContribRadarChart
                        data={PERF_PARTS.map((c) => {
                          const row = contrib.get(keyOf(p))
                          return { label: c.label, hint: c.hint, value: row ? num(row[c.key]) : null }
                        })}
                        gap={PERF_GAP}
                        height={220}
                      />
                    </div>
                    <div className="min-w-[260px] flex-1 space-y-1.5">
                      <div className="text-[11px] text-muted-foreground">
                        當局表現：每分鐘的實際數值，和同類型、同時長帶的人比（50＝中位數）。隊內 {rankOf(p) === null ? "—" : Math.round(rankOf(p)!)} 是你在隊裡扛的份量。
                      </div>
                      <ContribBars row={contrib.get(keyOf(p))} kind="perf" className="grid gap-x-8 gap-y-1.5 sm:grid-cols-2" />
                    </div>
                  </div>
                )}
              </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────── 數據（十人橫向比較）

type StatRow = { label: string; get: (p: Player) => number; fmt?: (n: number) => string }

const STAT_SECTIONS: { title: string; rows: StatRow[] }[] = [
  {
    title: "對戰",
    rows: [
      { label: "擊殺", get: (p) => p.kills },
      { label: "死亡", get: (p) => p.deaths },
      { label: "助攻", get: (p) => p.assists },
      { label: "最高同時擊殺", get: (p) => p.largest_multi_kill },
      { label: "雙殺 / 三殺", get: (p) => p.double_kills + p.triple_kills },
      { label: "控場分數", get: (p) => p.time_ccing_others },
      { label: "最久存活（秒）", get: (p) => p.longest_time_living },
    ],
  },
  {
    title: "造成傷害",
    rows: [
      { label: "對英雄總傷害", get: (p) => p.dmg_to_champions, fmt: (n) => n.toLocaleString() },
      { label: "對英雄物理傷害", get: (p) => p.dmg_physical, fmt: (n) => n.toLocaleString() },
      { label: "對英雄魔法傷害", get: (p) => p.dmg_magic, fmt: (n) => n.toLocaleString() },
      { label: "對英雄真實傷害", get: (p) => p.dmg_true, fmt: (n) => n.toLocaleString() },
      { label: "對建築物傷害", get: (p) => p.dmg_to_objectives, fmt: (n) => n.toLocaleString() },
    ],
  },
  {
    title: "承受與生存",
    rows: [
      { label: "承受傷害", get: (p) => p.dmg_taken, fmt: (n) => n.toLocaleString() },
      { label: "減免傷害", get: (p) => p.dmg_mitigated, fmt: (n) => n.toLocaleString() },
      { label: "治療量", get: (p) => p.total_heal, fmt: (n) => n.toLocaleString() },
    ],
  },
  {
    title: "資源",
    rows: [
      { label: "取得金錢", get: (p) => p.gold_earned, fmt: (n) => n.toLocaleString() },
      { label: "花費金錢", get: (p) => p.gold_spent, fmt: (n) => n.toLocaleString() },
      { label: "補兵", get: (p) => p.cs },
    ],
  },
]

function StatTable({ players, roleOf, contrib }: { players: Player[]; roleOf: Map<string, string>; contrib: Map<string, CubeRow> }) {
  // 表現與隊內貢獻都是百分位（50＝中位數），不是這場的原始數字；缺值（重開局、沒有治療隊友的治療軸）給 -1，畫成「—」且不會被標成最高
  const pct = (key: string) => (p: Player) => {
    const r = contrib.get(keyOf(p))
    return (r ? num(r[key]) : null) ?? -1
  }
  const fmtPct = (n: number) => (n < 0 ? "—" : String(Math.round(n)))
  const sections = [
    ...STAT_SECTIONS,
    {
      title: "當局表現（每分鐘實際數值，和同類型、同時長帶的人比，50＝中位數）",
      rows: [
        { label: "當局表現分", get: pct("contribution.perf"), fmt: fmtPct },
        ...PERF_PARTS.map((c) => ({ label: c.label, get: pct(c.key), fmt: fmtPct })),
      ] as StatRow[],
    },
    {
      title: "隊內貢獻（占全隊的比例，和同類型的人比，50＝中位數）",
      rows: [
        { label: "隊內貢獻排名", get: pct("contribution.score"), fmt: fmtPct },
        ...CONTRIB_PARTS.map((c) => ({ label: c.label, get: pct(c.key), fmt: fmtPct })),
      ] as StatRow[],
    },
  ]
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[900px] text-sm">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 bg-card px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
              項目
            </th>
            {players.map((p) => (
              <th key={p.participant_id} className="px-2 py-2">
                <div className="flex flex-col items-center gap-1">
                  <img
                    src={iconUrl(p.champion_icon)}
                    alt=""
                    title={p.riot_id}
                    className={cn(
                      "size-8 rounded-md bg-icon-tile",
                      p.is_me && "ring-2 ring-primary",
                      p.team_id === 100 ? "ring-offset-0" : "",
                    )}
                  />
                  <span
                    className={cn(
                      "h-0.5 w-6 rounded-full",
                      p.team_id === 100 ? "bg-chart-2" : "bg-loss",
                    )}
                  />
                  {roleOf.get(keyOf(p)) && <RoleChip role={roleOf.get(keyOf(p))!} className="px-1 text-[10px] font-normal" />}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => (
            // key 要掛在 Fragment 上，掛在裡面的 tr 是無效的
            <Fragment key={section.title}>
              <tr className="bg-secondary/40">
                <td
                  colSpan={players.length + 1}
                  className="px-3 py-1.5 text-xs font-semibold text-muted-foreground"
                >
                  {section.title}
                </td>
              </tr>
              {section.rows.map((row) => {
                const values = players.map(row.get)
                const max = Math.max(...values)
                return (
                  <tr key={`${section.title}-${row.label}`} className="border-b last:border-0">
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-card px-3 py-1.5 text-xs text-muted-foreground">
                      {row.label}
                    </td>
                    {players.map((p, i) => (
                      <td
                        key={p.participant_id}
                        className={cn(
                          "px-2 py-1.5 text-center tabular-nums",
                          // 全場最高的用主色標出來，一眼看得到誰在該項領先
                          values[i] === max && max > 0 ? "font-bold text-primary" : "",
                          p.is_me && "bg-primary/5",
                        )}
                      >
                        {row.fmt ? row.fmt(values[i]) : values[i]}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────── 單場戰報

export function MatchDetail({
  platformId,
  gameId,
  puuid,
  onBack,
  backLabel = "回列表",
}: {
  platformId: string
  gameId: number
  puuid?: string
  onBack: () => void
  /** 從抽屜打開時沒有列表可回，改成「關閉」 */
  backLabel?: string
}) {
  const [data, setData] = useState<{ match: MatchRow; players: Player[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 十個人各自的出裝定位
  const roleOf = useBuildRoles(data ? data.players.map(keyOf) : [])
  // 十個人各自的貢獻分數與六項百分位（語意層 contribution）
  const contrib = useContribution(data ? data.players.map(keyOf) : [], true)

  useEffect(() => {
    setData(null)
    const q = puuid ? `?puuid=${encodeURIComponent(puuid)}` : ""
    fetch(`/api/match/${platformId}/${gameId}${q}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e: Error) => setError(e.message))
  }, [platformId, gameId, puuid])

  if (error) return <div className="text-sm text-destructive">{error}</div>
  if (!data) return <Skeleton className="h-[560px] w-full" />

  const { match, players } = data
  const subject = players.find((p) => p.is_me)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={onBack}>
          <ChevronLeft /> {backLabel}
        </Button>
        <span
          className={cn(
            "text-lg font-bold",
            subject?.win ? "text-win" : "text-loss",
          )}
        >
          {subject?.win ? "勝利" : "失敗"}
        </span>
        <span className="text-sm text-muted-foreground">
          {match.game_mode} · {fmtDuration(match.game_duration)} · {fmtDate(match.game_creation)}
          {match.ended_surrender ? " · 投降結束" : ""}
        </span>
      </div>

      <Tabs defaultValue="board">
        <TabsList className="mb-3">
          <TabsTrigger value="board">計分板</TabsTrigger>
          <TabsTrigger value="stats">數據</TabsTrigger>
        </TabsList>
        <TabsContent value="board">
          <div className="mb-2 flex justify-end">
            <RoleLegend />
          </div>
          <Scoreboard players={players} roleOf={roleOf} contrib={contrib} />
          <p className="mt-2 text-xs text-muted-foreground">
            大數字是「當局表現分」（0～100，50＝同類型、同時長帶的中位數）：這場每分鐘的輸出、承傷、存活（死得少）、參團、控場，
            有治療或護盾隊友時再加治療護盾，各自和「同類型」（出裝定位 × 英雄官方主定位）、同時長的所有人比百分位，再依出裝定位加權（輸出型不看承傷）。
            全隊都打得好，全隊都可以高於 50，所以分數會和勝負相關。小字「隊內」是你在隊裡扛的份量（占全隊的比例，和同類型的人排名），
            份額加起來一定是 100%，所以各隊平均都在 50 附近。橫條以 50 為中線，往右比中位數高、往左較低。
            擊殺與金錢不算分；治療與護盾隊友的量只有開始擷取賽後統計之後的場次才有，舊場次的護盾只做到不扣分；
            6 分鐘內的重開局不計分。MVP＝贏的一隊表現最高、ACE＝輸的一隊表現最高；點一列看六項明細。
          </p>
        </TabsContent>
        <TabsContent value="stats">
          <StatTable players={players} roleOf={roleOf} contrib={contrib} />
          <p className="mt-2 text-xs text-muted-foreground">
            每一列的全場最高值以主色標示。上方色條藍＝隊伍 1、紅＝隊伍 2；色條下是這場的出裝定位。
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─────────────────────────────────────────── 對局列表

/** 每批卡片向 Cube 查一次出裝定位。查詢走 GET，一次帶太多鍵網址會太長；
 *  捲動載入時前面幾批的鍵不變，查詢會命中快取，只有最後一批要重查。 */
const ROLE_CHUNK = 50

const keyOf = (m: { platform_id: string; game_id: number; participant_id: number }) =>
  participantKey(m.platform_id, m.game_id, m.participant_id)

/** 點了哪一張卡片。一場可能有好幾張（「所有人」模式下同一場兩位追蹤的人），所以帶上參賽者與玩家 */
export type MatchPick = { platformId: string; gameId: number; participantId: number; puuid?: string }

/** 一場一張卡片。對局紀錄頁和各頁的下鑽列表（英雄、時段、隊友）共用同一種呈現。
 *  showPlayer：每一列不一定是同一個人時，在英雄名稱旁標出是誰玩的。 */
export function MatchCards({
  rows,
  onPick,
  showPlayer = false,
  headerExtra,
}: {
  rows: MatchRow[]
  onPick: (match: MatchPick) => void
  showPlayer?: boolean
  /** 標頭多放的內容，見 MatchList */
  headerExtra?: (m: MatchRow) => ReactNode
}) {
  const chunks: MatchRow[][] = []
  for (let i = 0; i < rows.length; i += ROLE_CHUNK) chunks.push(rows.slice(i, i + ROLE_CHUNK))
  return (
    <div className="space-y-1.5">
      {chunks.map((chunk, ci) => (
        <MatchCardChunk key={ci} rows={chunk} offset={ci * ROLE_CHUNK} onPick={onPick} showPlayer={showPlayer} headerExtra={headerExtra} />
      ))}
    </div>
  )
}

function MatchCardChunk({
  rows,
  offset,
  onPick,
  showPlayer,
  headerExtra,
}: {
  rows: MatchRow[]
  offset: number
  onPick: (match: MatchPick) => void
  showPlayer: boolean
  headerExtra?: (m: MatchRow) => ReactNode
}) {
  // 這場的出裝定位：向 Cube 查（見 useBuildRoles）
  const roleOf = useBuildRoles(rows.map(keyOf))
  const contrib = useCardContribution(rows)
  return (
    <>
      {rows.map((m, j) => {
        const i = offset + j
        const role = roleOf.get(keyOf(m))
        const { score = null, rank = null, tag } = contrib.get(keyOf(m)) ?? {}
        const kda = m.deaths === 0 ? "Perfect" : ((m.kills + m.assists) / m.deaths).toFixed(2)
        const kp = m.team_kills ? Math.round(((m.kills + m.assists) / m.team_kills) * 100) : 0
        return (
          <button
            key={keyOf(m)}
            onClick={() => onPick({ platformId: m.platform_id, gameId: m.game_id, participantId: m.participant_id, puuid: m.puuid })}
            // 一列一列滑進來；「再顯示 20 場」時新增的那批從 0 開始錯開，不會等上一批的延遲
            style={{ "--stagger": `${(i % 20) * 30}ms` } as CSSProperties}
            className={cn(
              "slide-in",
              // 勝敗靠底色與文字傳達就夠了。先前用高彩度的左側粗邊，
              // 二十列疊起來像斑馬紋，反而蓋過內容。
              "flex w-full flex-wrap items-center gap-y-1.5 rounded-lg border px-3 py-2 text-left transition",
              m.win
                ? "border-win/20 bg-win/[0.06] hover:bg-win/[0.11]"
                : "border-loss/20 bg-loss/[0.06] hover:bg-loss/[0.11]",
            )}
          >
            {/* 每列可能是不同玩家時：誰、出裝定位、英雄、日期收成左上一行標頭（w-full 自成一行），
                下面的數據列就不必再擠右側那一欄 */}
            {showPlayer && (
              <div className="flex w-full min-w-0 items-center gap-2 text-xs">
                <span className="truncate font-semibold" title={m.riot_id ?? undefined}>{m.riot_id ?? "—"}</span>
                {role && <RoleChip role={role} />}
                <span className="shrink-0 text-muted-foreground">{m.champion_name}</span>
                <span className="shrink-0 text-muted-foreground"><ContribInline score={score} rank={rank} /></span>
                {headerExtra?.(m)}
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">{fmtDate(m.game_creation)}</span>
              </div>
            )}

            {/* 單行、兩層堆疊：各區塊寬度固定（合計約 700px），中間兩段彈性空隙平分多出來的寬度。
                容器變寬只會讓空隙變大，結構與順序在整頁、抽屜、好友比較的半版面板都一樣。
                容器不到 700px（768px 寬螢幕扣掉側邊欄、手機）時換行，後半段排到第二行，不會被切掉 */}
            <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
              <div className="relative shrink-0">
                <img src={iconUrl(m.champion_icon)} alt="" title={m.champion_name} className="size-10 rounded-md bg-icon-tile" />
                {tag && <ContribTagBadge tag={tag} className="absolute -left-1 -top-1 shadow-sm ring-1 ring-background" />}
                <span className="absolute -bottom-1 -right-1 rounded bg-background px-1 text-[10px] font-bold tabular-nums">
                  {m.champ_level}
                </span>
              </div>

              <div className="w-[50px] shrink-0">
                <div className={cn("text-sm font-bold", m.win ? "text-win" : "text-loss")}>
                  {m.win ? "勝利" : "戰敗"}
                </div>
                <div className="whitespace-nowrap text-[11px] text-muted-foreground">
                  {fmtDuration(m.game_duration)}
                  {m.penta_kills > 0 && <span className="ml-1 font-semibold text-gold">五殺</span>}
                  {m.penta_kills === 0 && m.quadra_kills > 0 && <span className="ml-1 font-semibold">四殺</span>}
                </div>
              </div>

              <div className="flex shrink-0 flex-col gap-0.5">
                <AugmentRow augments={m.augments ?? []} size="size-5" />
                <ItemRow items={m.items ?? []} size="size-5" />
              </div>

              <div className="min-w-0 flex-1" />

              <div className="w-[100px] shrink-0 text-center">
                <div className="text-sm font-semibold tabular-nums">
                  {m.kills} / <span className="text-loss">{m.deaths}</span> / {m.assists}
                </div>
                <div className="whitespace-nowrap text-[11px] text-muted-foreground">
                  KDA {kda} · 參團 {kp}%
                </div>
              </div>

              <div className="w-[54px] shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
                <div>{m.cs} 補兵</div>
                <div>{k(m.gold_earned)} 金錢</div>
              </div>

              <div className="min-w-0 flex-1" />

              <RosterRow roster={m.roster ?? []} teamId={m.team_id} self={m.participant_id} withId={m.with_participant_id} />

              {!showPlayer && (
                // 固定寬度：晶片有寬有窄，加上貢獻分數後右欄不能跟著變寬，不然每列的敵我頭像會左右錯位
                <div className="w-[118px] shrink-0 text-right">
                  <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                    <ContribInline score={score} rank={rank} />
                    {role && <RoleChip role={role} />}
                  </div>
                  <div className="whitespace-nowrap text-[11px] text-muted-foreground">{fmtDate(m.game_creation)}</div>
                </div>
              )}
            </div>
          </button>
        )
      })}
    </>
  )
}

/** 追蹤對象：一場只列一張卡片。每場至少有一位自己或追蹤對象（採集的就是他們的場次），常常好幾位同隊，
 *  逐人列的話同一場出現好幾次（501 場變成 1397 列）。這裡每場挑一位當主角（優先目前帳號，其次參賽者編號最小的），
 *  其他同場的追蹤對象列在標頭。是哪幾場、誰在場都由 Cube 用和其他頁同一組條件查，後端不再抄一份。 */
function TrackedMatches({ scope }: { scope: WhoScope }) {
  const { account, players, matchParams } = useFilters()
  const rows = useCube(
    scope.q({ measures: ["participants.games"], dimensions: ["participants.participant_key", "participants.puuid"], limit: NO_LIMIT }),
  )
  const built = useMemo(() => {
    const nameOf = new Map(players.map((p) => [p.puuid, String(p.riot_id ?? p.puuid.slice(0, 8)).split("#")[0]]))
    const games = new Map<string, { pid: number; puuid: string }[]>()
    for (const r of rows.rows) {
      const [, game, pid] = String(r["participants.participant_key"]).split(":")
      const list = games.get(game) ?? []
      list.push({ pid: Number(pid), puuid: String(r["participants.puuid"]) })
      games.set(game, list)
    }
    const picks: string[] = []
    const others = new Map<string, string[]>()
    for (const [game, list] of games) {
      const main = list.find((x) => x.puuid === account?.puuid) ?? [...list].sort((a, b) => a.pid - b.pid)[0]
      picks.push(`${game}:${main.pid}`)
      others.set(game, list.filter((x) => x !== main).map((x) => nameOf.get(x.puuid) ?? x.puuid.slice(0, 8)))
    }
    return { picks, others }
  }, [rows.rows, players, account?.puuid])

  if (rows.loading) return <Skeleton className="h-40 w-full" />
  if (rows.error) return <div className="text-sm text-destructive">{rows.error}</div>
  if (!built.picks.length) return <EmptyState>這個條件下沒有對局。</EmptyState>
  const shown = built.picks.slice(0, MAX_GAME_IDS)
  return (
    <div className="space-y-2">
      {built.picks.length > MAX_GAME_IDS && (
        <p className="text-[11px] text-muted-foreground">
          符合的條件超過 {MAX_GAME_IDS} 場，這裡只列出其中 {MAX_GAME_IDS} 場。縮小期間或再加一個條件就能看全。
        </p>
      )}
      <MatchList
        key={shown.length + ":" + shown[0]}
        params={{ ...matchParams(), puuid: "*", participants: shown.join(",") }}
        showPlayer
        headerExtra={(m) => {
          const others = built.others.get(String(m.game_id)) ?? []
          return others.length ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground" title={others.join("、")}>
              ・同場追蹤：{others.join("、")}
            </span>
          ) : null
        }}
      />
    </div>
  )
}

export function Matches() {
  const { account, matchParams, drills, apply } = useFilters()
  const [who, setWho] = usePageWho(NO_ALL)
  const scope = useWhoScope(who)
  // 帳號、模式、期間：和其他頁同一組全域條件（原本漏了期間，選「最近 7 天」仍列出全部場次）
  const params = matchParams()
  const drillKey = drills.map((d) => `${d.member}=${d.values.join(",")}`).join("&")

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} disabled={NO_ALL} />
      <Panel
        title="近期對戰"
        caption={
          who === "tracked"
            ? "由新到舊，每一場只列一張卡片；同場有好幾位追蹤對象時，卡片上的人是主角（優先是目前帳號），其他人列在標頭。點任一場看完整戰報"
            : "由新到舊列出全部場次，捲到底會自動載入更多；點任一場看完整戰報。英雄名稱旁是這場的出裝定位"
        }
        action={<RoleLegend />}
      >
        {!account ? null : who === "tracked" ? (
          <TrackedMatches scope={scope} />
        ) : drills.length ? (
          // 有全域下鑽（英雄、增幅……）時，是哪幾場交給 Cube 用同一組條件查，後端不必認得每一種維度
          <CubeMatchList
            gameIdKey="matches.game_id"
            listKey={`${account.puuid}|${drillKey}`}
            query={apply({
              measures: ["participants.games"],
              dimensions: ["matches.game_id"],
              limit: MAX_GAME_IDS,
            })}
          />
        ) : (
          // key：換帳號時整個列表重來（清掉開著的戰報與捲動位置）
          <MatchList key={account.puuid} params={params} puuid={account.puuid} />
        )}
        {!account && (
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
