import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowRight, Check, ChevronDown, ChevronsUpDown, Search } from "lucide-react"
import { RecordCell } from "@/components/cells"
import { ContribBars, ContribScore } from "@/components/Contribution"
import { CONTRIB_GAP, CONTRIB_MEASURES, CONTRIB_PARTS } from "@/hooks/useContribution"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, Panel, QueryError } from "@/components/primitives"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ContribRadarChart, RadarChart, SHRINK_K, shrunk } from "@/components/charts"
import { DetailDrawer, useDrawerSettled } from "@/components/DetailDrawer"
import { ForestAxis, ForestTrack } from "@/components/GapForest"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, iconUrl, num, type CubeFilter, type CubeQuery, type CubeRow } from "@/lib/cube"
import { MatchList } from "@/components/MatchList"
import { useFilters, type Player } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { useNavigate } from "@/lib/nav"
import { cn } from "@/lib/utils"
import {
  MIN_N,
  STRENGTH_CLASS,
  gapOf,
  scoreGapOf,
  scoreStrengthOf,
  strengthOf,
  zFor,
  type Gap,
  type ScoreGap,
  type Strength,
} from "@/lib/gap"
import { BUILD_ROLES, BUILD_SHORT, NO_LIMIT, round0, splitRiotId } from "./shared"

// ── 判斷：和陣容、敗因、節奏三頁同一套「區間」講法 ─────────────────────────────
// 隊內貢獻（contribution.score）是同類型（出裝定位 × 英雄官方主定位）裡的名次百分位，同類型的中位數＝50；
// 不用擊殺、金錢、勝負當輸入，不受輸贏影響，所以判斷以它為主。
//   和 50 比，95% 區間（標準誤＝單場標準差 27 ÷ √有分數的場數）整段高於 50 是「強勢」、整段低於 50 是「不強勢」；
//   差 CONTRIB_GAP（6）分以上但區間還跨過 50 是「偏強／偏弱」；其餘「看不出」；不到 MIN_N 場不下判斷。
//   同一個人同時比好幾種出裝（或好幾隻英雄）時用 zFor(k) 放寬區間——一次比二十隻，總會有一兩隻只是運氣。
// 勝率只當補充：和他自己的整體勝率比，區間（同樣放寬）整段在一邊才標 ▲▼，以及「非戰之罪」（貢獻強勢但勝率明顯低）、
//   「靠隊友」（貢獻不強勢但勝率明顯高）。好友多半一起打、勝率互相牽動，2026-10 實測每個人的整體勝率都和 50% 分不出差別。
// 舊版用固定門檻（貢獻差 6 分、勝率差 3／5pp），不管場次：89% 的出裝、82% 的英雄都被貼上「適合／不適合」，
//   而且幾乎全部跟著這個人的整體水準走（整體強的人每個出裝都「適合」）。改成區間之後，看得出的只剩真的看得出的。
//   依據見 analysis/crew_verdicts.py。

/** 一覽表「英雄」分頁每邊最多放幾隻頭像；其餘寫「還有 N 隻」，完整排名在點開的抽屜裡 */
const CHAMPS_SHOWN = 5
/** 場次、勝負、隊內貢獻，以及算區間要用的「有隊內貢獻的場次」（重開局沒有分數） */
const STAT_MEASURES = [
  "participants.games",
  "participants.wins",
  "participants.losses",
  "participants.winrate",
  "contribution.score",
  "contribution.scored_games",
]

const n0 = (r: CubeRow | undefined, k: string) => (r ? (num(r[k]) ?? 0) : 0)
const opt = (r: CubeRow | undefined, k: string) => (r ? num(r[k]) : null)
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`
/** 隊內貢獻換成「和同類型中位數（50）的差距」 */
const dev = (r: CubeRow | undefined) => {
  const v = opt(r, "contribution.score")
  return v === null ? null : v - 50
}

const splitId = splitRiotId

function PlayerName({ player, className }: { player: Player; className?: string }) {
  const { name, tag } = splitId(player.riot_id, player.puuid)
  return (
    <span className={cn("flex min-w-0 items-baseline gap-1", className)}>
      <span className="truncate font-medium">{name}</span>
      {tag && <span className="shrink-0 text-[11px] text-muted-foreground">{tag}</span>}
      {!!player.is_me && (
        <Badge variant="outline" className="shrink-0 border-primary/40 px-1 py-0 text-[10px] text-primary">
          我
        </Badge>
      )}
    </span>
  )
}

// ── 每一組（一種出裝、一隻英雄、或整體）的數字與判斷 ─────────────────────────

type Stat = { key: string; label: string; icon?: string; games: number; wins: number; winrate: number | null; score: number | null; scored: number }
type Judged = Stat & {
  /** 隊內貢獻和 50 比（區間已依同時比幾組放寬）；沒有分數是 null */
  g: ScoreGap | null
  strength: Strength
  /** 勝率和他自己的整體勝率比（區間同樣放寬）；只用來標 ▲▼ 與「非戰之罪／靠隊友」 */
  wr: Gap | null
  /** 排序用：隊內貢獻往他自己的平均收縮（SHRINK_K 場虛擬場次），一兩場的不會排到最前面 */
  est: number | null
}
type Own = { score: number | null; winrate: number | null }
type Profile = {
  overall: Judged
  /** 整體勝率和 50% 比 */
  overallWr: Gap | null
  roles: Judged[]
  /** 同時比了幾種出裝（樣本夠的），區間依它放寬 */
  roleK: number
  champs: Judged[]
  champK: number
}

const statOf = (r: CubeRow | undefined, key: string, label: string, icon?: string): Stat => ({
  key,
  label,
  icon,
  games: n0(r, "participants.games"),
  wins: n0(r, "participants.wins"),
  winrate: opt(r, "participants.winrate"),
  score: opt(r, "contribution.score"),
  scored: n0(r, "contribution.scored_games"),
})

function judge(s: Stat, own: Own, z: number): Judged {
  const g = s.score === null ? null : scoreGapOf(s.score, s.scored, z)
  const wr = own.winrate === null || !s.games ? null : gapOf({ key: s.key, label: s.label, games: s.games, wins: s.wins }, own.winrate, z)
  const est = s.score === null || own.score === null ? null : (s.scored * s.score + SHRINK_K * own.score) / (s.scored + SHRINK_K)
  return { ...s, g, strength: g ? scoreStrengthOf(g, CONTRIB_GAP) : "看不出", wr, est }
}

/** 一個人的一組（他的幾種出裝，或他玩過的英雄）一起判斷：樣本夠的有 k 組，區間就放寬到「這 k 組一起看還是 95%」 */
function judgeAll(stats: Stat[], own: Own) {
  const k = stats.filter((s) => s.score !== null && s.scored >= MIN_N).length
  const z = zFor(k)
  return { k, items: stats.map((s) => judge(s, own, z)) }
}

const wrFlag = (j: Judged) => (j.wr?.clear ? (j.wr.diff > 0 ? "up" : "down") : null)

/** 勝率的補充說明：只有勝率的區間也整段在一邊才講 */
function extraOf(j: Judged) {
  const f = wrFlag(j)
  if (!f) return null
  if (j.strength === "強勢" && f === "down") return "非戰之罪"
  if (j.strength === "不強勢" && f === "up") return "靠隊友"
  return f === "up" ? "勝率明顯高" : "勝率明顯低"
}

const isPos = (s: Strength) => s === "強勢" || s === "偏強"
const isNeg = (s: Strength) => s === "不強勢" || s === "偏弱"
const isClear = (s: Strength) => s === "強勢" || s === "不強勢"

function tipOf(j: Judged, ownWr: number | null) {
  const lines = [`${j.label}・${j.games} 場${j.scored !== j.games ? `（有隊內貢獻的 ${j.scored} 場）` : ""}`]
  if (j.g) {
    lines.push(
      `隊內貢獻 ${Math.round(j.g.mean)}（50＝同類型的中位數）` +
        (j.g.interval
          ? `，區間 ${Math.round(50 + j.g.interval[0])}～${Math.round(50 + j.g.interval[1])} → ${j.strength}`
          : `；不到 ${MIN_N} 場，不下判斷`),
    )
  }
  if (j.games && j.winrate !== null) {
    lines.push(
      `勝率 ${j.winrate.toFixed(1)}%（${j.wins} 勝 ${j.games - j.wins} 敗）` +
        (ownWr !== null ? `，他自己的整體 ${ownWr.toFixed(1)}%` : "") +
        (j.wr?.interval
          ? `，差 ${signed(j.wr.diff)}pp、區間 ${signed(j.wr.interval[0], 0)}～${signed(j.wr.interval[1], 0)}pp${j.wr.clear ? "（看得出差別）" : "（還在誤差內）"}`
          : ""),
    )
  }
  const x = extraOf(j)
  if (x === "非戰之罪") lines.push("貢獻比同類型高，但勝率比他平常低：輸多半不是他的問題")
  if (x === "靠隊友") lines.push("貢獻比同類型低，但勝率比他平常高：贏多半是隊友或陣容")
  return lines.join("\n")
}

/** 判定標籤：五級（實心＝看得出、虛線＝還在誤差內），勝率也看得出時在後面補一句 */
function StrengthChip({ j }: { j: Judged }) {
  const x = extraOf(j)
  const f = wrFlag(j)
  // 不到 MIN_N 場沒有區間：和「場次夠、差距在誤差內」的看不出分開講
  if (!j.g?.interval && !x) return <span className="text-[11px] text-muted-foreground/80">場次不夠</span>
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span data-testid="strength-chip" className={cn("rounded border px-1.5 text-[11px]", STRENGTH_CLASS[j.strength])}>
        {j.strength}
      </span>
      {x && (
        <span className="text-[11px] text-muted-foreground">
          <span className={f === "up" ? "text-win" : "text-loss"}>{f === "up" ? "▲" : "▼"}</span>
          {x}
        </span>
      )}
    </span>
  )
}

// ── 全員一覽：一人一列（迷你雷達、出裝標籤、英雄頭像）────────────────────────

const DOT_CLASS: Record<Strength, string> = {
  強勢: "fill-win",
  偏強: "fill-win",
  看不出: "fill-muted-foreground",
  偏弱: "fill-loss",
  不強勢: "fill-loss",
}
const NUM_CLASS: Record<Strength, string> = {
  強勢: "text-win",
  偏強: "text-win",
  看不出: "text-foreground",
  偏弱: "text-loss",
  不強勢: "text-loss",
}

/** 一人一列的格線，class 寫成完整字串（Tailwind 掃不到拼出來的） */
const ROW_COLS = "grid-cols-[13rem_6rem_minmax(0,1fr)_minmax(0,1fr)]"

type HexDatum = { label: string; games: number; strength: Strength | null }

/** 迷你雷達（出裝定位八個頂點）：形狀是各出裝定位佔他自己場次的比例（偏好怎麼玩），頂點顏色是判定。
 *
 *  一覽表裡每人一個，上下排成一欄就能一眼比形狀。用 SVG 而不是 ECharts：七個 canvas 實例的成本不值得，
 *  這裡也不需要互動。外框是「他自己最常用的那種出裝」，形狀才撐得開。 */
function MiniHex({ data, total, size = 96 }: { data: HexDatum[]; total: number; size?: number }) {
  const c = size / 2
  const r = size / 2 - 14 // 留位置給標籤
  const n = data.length
  const at = (i: number, frac: number) => {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180 // 和 ECharts 雷達同方向：正上方開始、逆時針
    return [c + Math.cos(a) * r * frac, c - Math.sin(a) * r * frac] as const
  }
  const ring = (frac: number) => data.map((_, i) => at(i, frac).join(",")).join(" ")
  const share = data.map((d) => (total ? d.games / total : 0))
  const scaleMax = Math.max(0.01, ...share)
  const tone = (d: HexDatum) => (d.strength ? DOT_CLASS[d.strength] : "fill-muted-foreground")
  const text = data
    .map((d, i) => `${d.label} ${Math.round(share[i] * 100)}%（${d.games} 場${d.strength && d.strength !== "看不出" ? `，${d.strength}` : ""}）`)
    .join("\n")
  return (
    // 八個頂點時左右兩端的標籤會貼到邊，overflow 放出去（欄與欄之間有 gap，不會壓到別人）
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0 overflow-visible">
      <title>{`各出裝定位佔他場次的比例\n${text}`}</title>
      <polygon points={ring(1)} className="fill-muted/30 stroke-muted-foreground/40" strokeWidth={1} />
      <polygon points={ring(0.5)} className="fill-none stroke-muted-foreground/25" strokeWidth={0.75} />
      {data.map((_, i) => {
        const [x, y] = at(i, 1)
        return <line key={i} x1={c} y1={c} x2={x} y2={y} className="stroke-muted-foreground/25" strokeWidth={0.75} />
      })}
      <polygon
        points={share.map((v, i) => at(i, Math.min(1, v / scaleMax)).join(",")).join(" ")}
        className="fill-data/30 stroke-data"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {data.map((d, i) => {
        const [x, y] = at(i, Math.min(1, share[i] / scaleMax))
        const [lx, ly] = at(i, 1.3)
        const shown = d.strength && d.strength !== "看不出"
        return (
          <g key={d.label}>
            <circle cx={x} cy={y} r={d.strength && isClear(d.strength) ? 3.2 : shown ? 2.6 : 1.8} className={tone(d)} />
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="central" className={cn("text-[9px] font-semibold", tone(d))}>
              {BUILD_SHORT[d.label] ?? d.label.slice(0, 1)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 出裝定位的判定標籤：「1 強勢 AD 輸出」，實心是看得出的、虛線框是還在誤差內 */
function RoleChips({ items, ownWr }: { items: Judged[]; ownWr: number | null }) {
  if (!items.length) return <span className="text-[11px] text-muted-foreground">—</span>
  return (
    <span className="flex flex-wrap content-start items-start gap-1">
      {items.map((j, n) => (
        <span
          key={j.key}
          data-testid="crew-role-chip"
          data-label={j.label}
          data-strength={j.strength}
          title={`第 ${n + 1} 名・${tipOf(j, ownWr)}`}
          className={cn("rounded border px-1.5 py-0.5 text-[11px]", STRENGTH_CLASS[j.strength])}
        >
          <span className="mr-1 font-mono font-bold">{n + 1}</span>
          <span className="opacity-80">{j.strength}</span> {j.label}
          {wrFlag(j) && <span className={wrFlag(j) === "up" ? "ml-0.5 text-win" : "ml-0.5 text-loss"}>{wrFlag(j) === "up" ? "▲" : "▼"}</span>}
        </span>
      ))}
    </span>
  )
}

function RowLegend() {
  const chip = (s: Strength, text: string) => (
    <span className="flex items-center gap-1.5">
      <span className={cn("rounded border px-1 text-[10px]", STRENGTH_CLASS[s])}>{s}</span>
      {text}
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {chip("強勢", "比同類型強（看得出）")}
      {chip("偏強", "高 6 分以上，還在誤差內")}
      {chip("偏弱", "低 6 分以上，還在誤差內")}
      {chip("不強勢", "比同類型弱（看得出）")}
      <span>
        <span className="text-win">▲</span>
        <span className="text-loss">▼</span> 勝率比他自己的平均明顯高／低
      </span>
    </div>
  )
}

/** 全員一覽的「怎麼判斷的」：預設收起，標題列只留一句話 */
function HowWeJudge({ children }: { children: ReactNode }) {
  return (
    <details className="rounded-lg border bg-muted/10 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer text-xs font-medium text-foreground">怎麼判斷的、為什麼不再用「適合／不適合」</summary>
      <div className="mt-2 space-y-1.5">{children}</div>
    </details>
  )
}

// ── 全員一覽：英雄 ──────────────────────────────────────────────────────────

function ChampBadge({ j, rank, ownWr }: { j: Judged; rank: number; ownWr: number | null }) {
  const p = isPos(j.strength)
  const clear = isClear(j.strength)
  return (
    <span title={`第 ${rank} 名・${tipOf(j, ownWr)}`} className="relative shrink-0" data-testid="crew-champ" data-strength={j.strength}>
      <span
        className={cn(
          "absolute -left-1 -top-1 z-10 flex size-4 items-center justify-center rounded-full font-mono text-[9px] font-bold text-background ring-1 ring-background",
          p ? "bg-win" : "bg-loss",
        )}
      >
        {rank}
      </span>
      <img
        src={iconUrl(j.icon)}
        alt={j.label}
        className={cn(
          "size-8 rounded-md bg-icon-tile",
          clear && p && "ring-2 ring-win/80",
          clear && !p && "ring-2 ring-loss/80",
          !clear && p && "outline-1 outline-offset-1 outline-dashed outline-win/60",
          !clear && !p && "outline-1 outline-offset-1 outline-dashed outline-loss/60",
        )}
      />
      <span
        className={cn(
          "absolute -bottom-1.5 left-1/2 -translate-x-1/2 rounded bg-background px-0.5 font-mono text-[9px] leading-tight",
          p ? "text-win" : "text-loss",
        )}
      >
        {Math.round(j.score ?? 50)}
      </span>
    </span>
  )
}

/** 比同類型強（或弱）的英雄：看得出的排前面，同一級依差距大小、再依場次 */
function sideOf(champs: Judged[], side: "pos" | "neg") {
  const pick = side === "pos" ? isPos : isNeg
  const dir = side === "pos" ? -1 : 1
  return champs
    .filter((j) => pick(j.strength))
    .sort(
      (a, b) =>
        Number(isClear(b.strength)) - Number(isClear(a.strength)) ||
        dir * ((a.g?.diff ?? 0) - (b.g?.diff ?? 0)) ||
        b.games - a.games ||
        a.label.localeCompare(b.label, "zh-Hant"),
    )
}

function ChampSide({ items, ownWr, onMore }: { items: Judged[]; ownWr: number | null; onMore?: () => void }) {
  if (!items.length) return <span className="text-[11px] text-muted-foreground">—</span>
  const rest = items.length - CHAMPS_SHOWN
  return (
    <span className="flex flex-wrap items-center gap-1.5 gap-y-3">
      {items.slice(0, CHAMPS_SHOWN).map((j, i) => (
        <ChampBadge key={j.key} j={j} rank={i + 1} ownWr={ownWr} />
      ))}
      {rest > 0 &&
        (onMore ? (
          <button type="button" onClick={onMore} className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            還有 {rest} 隻
          </button>
        ) : (
          <span className="text-[11px] text-muted-foreground" title="點這一列看完整排名">
            還有 {rest} 隻
          </span>
        ))}
    </span>
  )
}

// ── 抽屜 ────────────────────────────────────────────────────────────────────

/** 某個人在某些條件下（某隻英雄、某種出裝）的每一場。
 *  是哪幾場交給 Cube 用同一組條件查（和列表上方的場次同一個來源），再送 /api/matches 列出；
 *  帳號換成這個人（matchParams 預設是目前選的帳號），戰報也以他為主角。 */
function PlayerMatches({ puuid, filters }: { puuid: string; filters: CubeFilter[] }) {
  const { apply, matchParams } = useFilters()
  const ids = useCube(
    apply(
      {
        measures: ["participants.games"],
        dimensions: ["matches.game_id"],
        filters: [{ member: "participants.puuid", operator: "equals", values: [puuid] }, ...filters],
        limit: MAX_GAME_IDS,
      },
      "all",
    ),
  )
  if (ids.loading) return <Skeleton className="h-40 w-full" />
  if (ids.error) return <div className="text-sm text-destructive">{ids.error}</div>
  const gameIds = ids.rows.map((r) => String(r["matches.game_id"]))
  if (!gameIds.length) return <EmptyState>這個條件下沒有對局。</EmptyState>
  return <MatchList params={{ ...matchParams(), puuid, game_ids: gameIds.join(",") }} puuid={puuid} />
}

/** 可展開的一列：點了在正下方列出每一場，再點一次收起。箭頭轉向表示展開狀態 */
function ExpandRow({
  open,
  onToggle,
  className,
  style,
  children,
  label,
}: {
  open: boolean
  onToggle: () => void
  className: string
  style?: CSSProperties
  children: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? `收起${label}的每一場` : `展開${label}的每一場`}
      style={style}
      className={cn(className, "w-full text-left transition hover:bg-accent", open && "bg-primary/10 hover:bg-primary/15")}
    >
      {children}
    </button>
  )
}

type DrawerTab = "overview" | "roles" | "champs" | "contrib"

/** 總覽分頁上的一張數字卡：主數字、區間、判定與一句說明 */
function SummaryCard({ title, main, sub, strength, note }: { title: string; main: string; sub: string; strength: Strength; note: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span className={cn("rounded border px-1.5 text-[11px]", STRENGTH_CLASS[strength])}>{strength}</span>
      </div>
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{main}</div>
      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">{sub}</div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  )
}

/** 一句話講這個人整體的情形：只根據看得出的差別 */
function readingOf(p: Profile) {
  const s = p.overall.strength
  const w = p.overallWr ? strengthOf(p.overallWr) : "看不出"
  if (s === "強勢")
    return w === "強勢"
      ? "隊內扛得比同類型的人多，勝率也明顯高於 50%。"
      : "隊內扛得比同類型的人多，但勝率和 50% 分不出差別：輸贏很大一部分取決於隊友與隨機拿到的陣容。"
  if (s === "不強勢")
    return w === "不強勢" ? "隊內扛得比同類型的人少，勝率也明顯低於 50%。" : "隊內扛得比同類型的人少，但勝率沒有跟著變低：隊友補上了不少。"
  return "隊內貢獻和同類型的人差不多（差距還在誤差內）。"
}

/** 總覽分頁的「看得出的強項／弱項」：只列區間整段在一邊的，其餘只講有幾項 */
function Highlights({ profile, onRole, onChamps }: { profile: Profile; onRole: (r: string) => void; onChamps: () => void }) {
  const ownWr = profile.overall.winrate
  const block = (title: string, s: Strength, tone: string) => {
    const roles = profile.roles.filter((j) => j.strength === s)
    const champs = sideOf(profile.champs, s === "強勢" ? "pos" : "neg").filter((j) => j.strength === s)
    return (
      <div>
        <div className={cn("mb-1 text-[11px] font-semibold", tone)}>{title}</div>
        {!roles.length && !champs.length ? (
          <div className="text-[11px] text-muted-foreground">沒有看得出的（場次不夠，或差距都在誤差內）</div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {roles.map((j) => (
              <button
                key={j.key}
                type="button"
                title={tipOf(j, ownWr)}
                onClick={() => onRole(j.label)}
                className={cn("rounded border px-1.5 py-0.5 text-[11px]", STRENGTH_CLASS[j.strength])}
              >
                {j.label}
              </button>
            ))}
            {champs.slice(0, 8).map((j, i) => (
              <ChampBadge key={j.key} j={j} rank={i + 1} ownWr={ownWr} />
            ))}
            {champs.length > 8 && (
              <button type="button" onClick={onChamps} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                還有 {champs.length - 8} 隻
              </button>
            )}
          </div>
        )}
      </div>
    )
  }
  const leans = [...profile.roles, ...profile.champs]
  const leanUp = leans.filter((j) => j.strength === "偏強").length
  const leanDown = leans.filter((j) => j.strength === "偏弱").length
  return (
    <div className="grid content-start gap-3">
      {block("看得出的強項", "強勢", "text-win")}
      {block("看得出的弱項", "不強勢", "text-loss")}
      <p className="text-[11px] text-muted-foreground">
        另有 {leanUp} 項偏強、{leanDown} 項偏弱，差距還在誤差內；出裝定位、英雄分頁看得到全部。
      </p>
    </div>
  )
}

/** 出裝定位分頁：一種出裝一列，隊內貢獻畫成區間（中線＝同類型的中位數 50），右邊是勝率與判定 */
function RoleForest({ profile, selected, onPick }: { profile: Profile; selected: string | null; onPick: (role: string) => void }) {
  const ownWr = profile.overall.winrate
  const far = profile.roles.flatMap((j) => (j.g?.interval ? [Math.abs(j.g.interval[0]), Math.abs(j.g.interval[1])] : []))
  const reach = Math.min(50, Math.max(20, Math.ceil(Math.max(0, ...far) / 10) * 10))
  const total = profile.overall.games
  const cols = "grid-cols-[5.5rem_minmax(8rem,1fr)_2.5rem_3.25rem_minmax(6.5rem,9rem)_7.5rem]"
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        點是他這種出裝的隊內貢獻、線是區間（同時比 {profile.roleK} 種出裝，已放寬）；區間整段在中線同一邊才上色。點一列看他用這種出裝玩過的英雄
      </div>
      <div>
        <div className={cn("grid items-end gap-x-2", cols)}>
          <span />
          <ForestAxis reach={reach} center="中位數 50" unit="分" worse="比同類型弱" better="比同類型強" />
          <span className="pb-0.5 text-right text-[10px] text-muted-foreground">貢獻</span>
          <span className="pb-0.5 text-right text-[10px] text-muted-foreground">場次</span>
          <span className="pb-0.5 text-[10px] text-muted-foreground">勝率（刻度＝他自己）</span>
          <span className="pb-0.5 text-[10px] text-muted-foreground">判定</span>
        </div>
        {profile.roles.map((j) => (
          <button
            key={j.key}
            type="button"
            data-testid="role-row"
            data-label={j.label}
            data-strength={j.strength}
            disabled={!j.games}
            onClick={() => onPick(j.label)}
            title={j.games ? tipOf(j, ownWr) : `${j.label}：沒有對局`}
            className={cn(
              "grid w-full items-center gap-x-2 border-b border-border/50 text-left transition last:border-b-0 enabled:hover:bg-accent/60",
              cols,
              selected === j.label && "rounded bg-primary/10 ring-1 ring-primary",
              !j.games && "opacity-50",
            )}
          >
            <span className="truncate pl-1 text-[13px] font-medium">{j.label}</span>
            <ForestTrack
              diff={j.g?.interval ? j.g.diff : null}
              interval={j.g?.interval ?? null}
              clear={!!j.g?.clear}
              reach={reach}
              empty={j.games ? `不到 ${MIN_N} 場` : undefined}
            />
            <span className={cn("text-right font-mono text-[13px] font-semibold tabular-nums", j.g?.interval ? NUM_CLASS[j.strength] : "text-muted-foreground")}>
              {j.score === null ? "—" : Math.round(j.score)}
            </span>
            <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {j.games}
              {total > 0 && j.games > 0 && <span className="block text-[10px]">{Math.round((100 * j.games) / total)}%</span>}
            </span>
            {j.games ? (
              <RecordCell winrate={j.winrate} wins={j.wins} losses={j.games - j.wins} baseline={ownWr} baselineLabel="他自己的整體勝率" />
            ) : (
              <span />
            )}
            {j.games ? <StrengthChip j={j} /> : <span className="text-[11px] text-muted-foreground">沒打過</span>}
          </button>
        ))}
      </div>
    </div>
  )
}

/** 抽屜：某個人的完整分析，分成總覽、出裝定位、英雄、貢獻分解四個分頁 */
function PlayerDrawerBody({
  player,
  profile,
  role,
  onRole,
  tab,
  onTab,
  crewFilter,
}: {
  player: Player
  profile: Profile
  role: string | null
  onRole: (role: string | null) => void
  tab: DrawerTab
  onTab: (tab: DrawerTab) => void
  crewFilter: (puuids: string[]) => CubeFilter
}) {
  const { apply, setAccount } = useFilters()
  const go = useNavigate()
  const settled = useDrawerSettled()
  const [radarMode, setRadarMode] = useState<"games" | "winrate">("games")
  const [sortBy, setSortBy] = useState<"score" | "games">("score")
  const [onlyClear, setOnlyClear] = useState(false)
  // 點英雄列展開那隻英雄的每一場（同時只開一隻，免得被好幾份列表撐得很長）
  const [openChamp, setOpenChamp] = useState<string | null>(null)
  useCrumb(20, openChamp ? `${openChamp}的每一場` : null, () => setOpenChamp(null))
  const ownWr = profile.overall.winrate
  const own: Own = { score: profile.overall.score, winrate: ownWr }
  const roleFilter = role ? [{ member: "builds.build_role", operator: "equals" as const, values: [role] }] : []
  const contrib = useCube(
    apply({ measures: CONTRIB_MEASURES, filters: [crewFilter([player.puuid]), ...roleFilter], limit: 1 }, "all"),
  )
  const champs = useCube(
    apply(
      {
        measures: STAT_MEASURES,
        dimensions: ["champions.name", "champions.icon_path"],
        filters: [crewFilter([player.puuid]), ...roleFilter],
        order: { "participants.games": "desc" },
        limit: NO_LIMIT,
      },
      "all",
    ),
  )
  // 英雄分頁的判斷：沒選出裝時和一覽表用同一份（profile.champs），選了出裝才用這裡查的那一組重新判斷
  const champJudged = useMemo(() => {
    if (!role) return { k: profile.champK, items: profile.champs }
    return judgeAll(
      champs.rows.map((r) => statOf(r, String(r["champions.name"]), String(r["champions.name"]), r["champions.icon_path"] as string)),
      own,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, champs.rows, profile])
  const champRows = useMemo(() => {
    const list = champJudged.items.filter((j) => j.games > 0 && (!onlyClear || isClear(j.strength) || extraOf(j)))
    return [...list].sort((a, b) =>
      sortBy === "games"
        ? b.games - a.games || (b.est ?? 0) - (a.est ?? 0)
        : (b.est ?? -1) - (a.est ?? -1) || b.games - a.games || a.label.localeCompare(b.label, "zh-Hant"),
    )
  }, [champJudged, sortBy, onlyClear])

  const pickRole = (r: string | null) => {
    onRole(r)
    onTab("champs")
  }
  const ov = profile.overall
  const wrAll = profile.overallWr
  const radar = profile.roles.map(({ label, games, wins, winrate }) => ({ label, games, wins, winrate }))
  const champCols = "grid-cols-[1.5rem_minmax(0,1fr)_3.25rem_minmax(8rem,12rem)_4.5rem_7.5rem]"

  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as DrawerTab)} className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="overview">總覽</TabsTrigger>
          <TabsTrigger value="roles">出裝定位</TabsTrigger>
          <TabsTrigger value="champs">英雄</TabsTrigger>
          <TabsTrigger value="contrib">貢獻分解</TabsTrigger>
        </TabsList>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setAccount(player)
            go("dashboard")
          }}
        >
          切換成看他的完整數據
          <ArrowRight className="size-3.5" />
        </Button>
      </div>

      {/* ── 總覽：整體的兩個數字、一句解讀、出裝雷達、看得出的強弱 ── */}
      <TabsContent value="overview" className="reveal space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SummaryCard
            title="隊內貢獻"
            main={ov.score === null ? "—" : String(Math.round(ov.score))}
            sub={
              ov.g?.interval
                ? `95% 區間 ${Math.round(50 + ov.g.interval[0])}～${Math.round(50 + ov.g.interval[1])}・${ov.scored} 場`
                : `${ov.scored} 場`
            }
            strength={ov.strength}
            note="和同類型（出裝定位 × 英雄官方主定位）的人比，50＝中位數。不用擊殺、金錢、勝負計算，不受輸贏影響"
          />
          <SummaryCard
            title="勝率"
            main={ov.winrate === null ? "—" : `${ov.winrate.toFixed(1)}%`}
            sub={
              wrAll?.interval
                ? `95% 區間 ${Math.round(50 + wrAll.interval[0])}～${Math.round(50 + wrAll.interval[1])}%・${ov.wins} 勝 ${ov.games - ov.wins} 敗`
                : `${ov.wins} 勝 ${ov.games - ov.wins} 敗`
            }
            strength={wrAll ? strengthOf(wrAll) : "看不出"}
            note="和 50% 比。好友多半一起打、勝率會互相牽動，用來比人不太準"
          />
        </div>
        <p className="text-sm" data-testid="crew-reading">
          {readingOf(profile)}
        </p>
        <div className="grid gap-4 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">各出裝的場次</div>
              <ToggleGroup type="single" size="sm" variant="outline" value={radarMode} onValueChange={(v) => v && setRadarMode(v as "games" | "winrate")}>
                <ToggleGroupItem value="games" className="h-7 px-2 text-xs">形狀：場次</ToggleGroupItem>
                <ToggleGroupItem value="winrate" className="h-7 px-2 text-xs">形狀：勝率</ToggleGroupItem>
              </ToggleGroup>
            </div>
            <div className="text-[11px] text-muted-foreground">點某一類的方向，看他用那種出裝玩過的英雄</div>
            {settled ? (
              <RadarChart data={radar} mode={radarMode} baseline={ownWr} total={ov.games} height={260} selected={role} onPick={(r) => pickRole(r)} />
            ) : (
              <div className="h-[260px]" />
            )}
          </div>
          <Highlights profile={profile} onRole={(r) => pickRole(r)} onChamps={() => onTab("champs")} />
        </div>
      </TabsContent>

      {/* ── 出裝定位：八種出裝的區間 ── */}
      <TabsContent value="roles" className="reveal">
        <RoleForest profile={profile} selected={role} onPick={(r) => pickRole(role === r ? null : r)} />
      </TabsContent>

      {/* ── 英雄：完整排名，可依出裝篩選，點一列看每一場 ── */}
      <TabsContent value="champs" className="reveal space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {[null, ...profile.roles.filter((j) => j.games > 0).map((j) => j.label)].map((r) => (
            <button
              key={r ?? "all"}
              type="button"
              onClick={() => onRole(r)}
              className={cn(
                "rounded-full border px-2.5 py-0.5 text-xs transition",
                role === r ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:border-primary/40",
              )}
            >
              {r ?? "全部出裝"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            依{sortBy === "score" ? "隊內貢獻（往他自己的平均收縮過，一兩場的不會排到最前面）" : "場次"}排；
            判定的區間依同時比了 {champJudged.k} 隻（{MIN_N} 場以上）放寬，所以單隻英雄很難看得出差別
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" size="sm" variant="outline" value={sortBy} onValueChange={(v) => v && setSortBy(v as "score" | "games")}>
              <ToggleGroupItem value="score" className="h-7 px-2 text-xs">依貢獻</ToggleGroupItem>
              <ToggleGroupItem value="games" className="h-7 px-2 text-xs">依場次</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup type="single" size="sm" variant="outline" value={onlyClear ? "clear" : "all"} onValueChange={(v) => v && setOnlyClear(v === "clear")}>
              <ToggleGroupItem value="all" className="h-7 px-2 text-xs">全部</ToggleGroupItem>
              <ToggleGroupItem value="clear" className="h-7 px-2 text-xs">只看看得出的</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        {role && (!settled || champs.loading) ? (
          <Skeleton className="h-[320px] w-full" />
        ) : role && champs.error ? (
          <div className="text-sm text-destructive">{champs.error}</div>
        ) : !champRows.length ? (
          <EmptyState>{onlyClear ? "沒有看得出差別的英雄：場次不夠，或差距都在誤差內。" : "這個條件下沒有對局。"}</EmptyState>
        ) : (
          <div className="space-y-1">
            <div className={cn("grid gap-3 px-2 text-[11px] text-muted-foreground", champCols)}>
              <span>#</span>
              <span>英雄（點一列看每一場）</span>
              <span>場次</span>
              <span>勝率（刻度＝他自己）</span>
              <span className="text-right">貢獻</span>
              <span>判定</span>
            </div>
            {champRows.map((j, i) => {
              const open = openChamp === j.label
              const half = j.g?.interval ? (j.g.interval[1] - j.g.interval[0]) / 2 : null
              return (
                <Fragment key={j.key}>
                  <ExpandRow
                    open={open}
                    onToggle={() => setOpenChamp(open ? null : j.label)}
                    label={j.label}
                    style={{ "--stagger": `${Math.min(i * 30, 400)}ms` } as CSSProperties}
                    className={cn("slide-in grid items-center gap-3 rounded-md px-2 py-1.5", champCols)}
                  >
                    <span className="text-right font-mono text-[11px] font-bold tabular-nums text-muted-foreground" data-testid="pick-rank">
                      {i + 1}
                    </span>
                    <span className="flex min-w-0 items-center gap-2.5" title={tipOf(j, ownWr)}>
                      <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                      <img src={iconUrl(j.icon)} alt="" className="size-8 shrink-0 rounded-md bg-icon-tile" />
                      <span className="truncate text-[13px] font-medium">{j.label}</span>
                    </span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">{j.games} 場</span>
                    <RecordCell winrate={j.winrate} wins={j.wins} losses={j.games - j.wins} baseline={ownWr} baselineLabel="他自己的整體勝率" />
                    <span className="text-right font-mono text-[12px] tabular-nums">
                      <span className={j.g?.interval ? NUM_CLASS[j.strength] : "text-muted-foreground"}>{j.score === null ? "—" : Math.round(j.score)}</span>
                      {half !== null && <span className="block text-[10px] text-muted-foreground">±{Math.round(half)}</span>}
                    </span>
                    <StrengthChip j={j} />
                  </ExpandRow>
                  {open && (
                    <div className="reveal mb-2 ml-3 border-l-2 border-primary/40 pl-3">
                      <PlayerMatches
                        puuid={player.puuid}
                        filters={[{ member: "champions.name", operator: "equals", values: [j.label] }, ...roleFilter]}
                      />
                    </div>
                  )}
                </Fragment>
              )
            })}
          </div>
        )}
      </TabsContent>

      {/* ── 貢獻分解：六項各自和同類型比 ── */}
      <TabsContent value="contrib" className="reveal">
        <div className="rounded-lg border p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-sm font-semibold">
              貢獻分解{role ? `・出裝是${role}時` : "・所有出裝"}
            </div>
            <div className="text-[12px]">
              隊內貢獻 <ContribScore dev={dev(contrib.rows[0])} className="text-base font-semibold" />
            </div>
          </div>
          <div className="mb-2 text-[11px] text-muted-foreground">
            每一項都和「同類型」（出裝定位 × 英雄官方主定位）的人比，換成名次百分位：50＝同類型的中位數，雷達裡的虛線圈與橫條中間的刻度就是 50。
            依出裝定位加權：坦克重承傷、參團與控場，輸出位重輸出與存活，輔助重參團與控場；有治療或護盾隊友的場次再加「治療護盾」。
            治療與護盾隊友的量只有開始擷取賽後統計之後的場次才有
          </div>
          {!settled || contrib.loading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : contrib.error ? (
            <div className="text-sm text-destructive">{contrib.error}</div>
          ) : (
            // 雷達看形狀（哪幾項突出、哪幾項是洞），橫條看每一項的確切數字與說明，兩個都留
            <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <ContribRadarChart
                data={CONTRIB_PARTS.map((c) => ({ label: c.label, hint: c.hint, value: opt(contrib.rows[0], c.key) }))}
                height={300}
              />
              <ContribBars row={contrib.rows[0]} />
            </div>
          )}
        </div>
      </TabsContent>
    </Tabs>
  )
}

type LookupOption = { name: string; icon: string; games: number; players: number }

/** 英雄／增幅選擇器：可搜尋，依「幾個人用過、合計幾場」排序 */
function LookupPicker({
  options,
  value,
  onChange,
  kind,
}: {
  options: LookupOption[]
  value: string | null
  onChange: (name: string) => void
  kind: LookupKind
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.name === value)
  const pick = (name: string) => {
    onChange(name)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-10 w-[280px] justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            {current ? (
              <img src={iconUrl(current.icon)} alt="" className="size-6 shrink-0 rounded bg-icon-tile" />
            ) : (
              <Search className="size-4 text-muted-foreground" />
            )}
            <span className="truncate">{current?.name ?? `選一${kind.counter}${kind.noun}`}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder={`搜尋${kind.noun}名稱…`} />
          <CommandList>
            <CommandEmpty>這群人都沒{kind.verb}過這{kind.counter}。</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.name}
                value={o.name}
                onSelect={() => pick(o.name)}
                // 同 AccountSwitcher：這版 cmdk 的 onSelect 在某些包法下不觸發，點擊路徑另外接上
                onClick={() => pick(o.name)}
                className="gap-2"
              >
                <img src={iconUrl(o.icon)} alt="" className="size-6 shrink-0 rounded bg-icon-tile" />
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {o.players} 人・{o.games} 場
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** 「查英雄」「查增幅裝置」的差別：查哪個維度、用什麼量詞與動詞。其餘完全一樣。 */
type LookupKind = {
  title: string
  caption: string
  noun: string
  counter: string
  verb: string
  nameKey: string
  iconKey: string
}

/** 選一個東西（一隻英雄、一個增幅），看這群人各自用它的戰績；點一個人展開他用它的每一場。 */
function LookupPanel({
  kind,
  rows,
  loading,
  people,
  puuids,
  wrOf,
}: {
  kind: LookupKind
  rows: CubeRow[]
  loading: boolean
  people: Player[]
  puuids: string[]
  wrOf: (puuid: string) => number | null
}) {
  const [picked, setPicked] = useState<string | null>(null)
  // 點某個人展開他的每一場；換選項時收起
  const [openPlayer, setOpenPlayer] = useState<string | null>(null)
  const pick = (next: string) => {
    setPicked(next)
    setOpenPlayer(null)
  }

  // 選項是這群人用過的東西，依「幾個人用過、合計幾場」排
  const options = useMemo(() => {
    const m = new Map<string, LookupOption>()
    for (const r of rows) {
      if (!puuids.includes(String(r["participants.puuid"]))) continue
      const name = String(r[kind.nameKey])
      const cur = m.get(name) ?? { name, icon: r[kind.iconKey] as string, games: 0, players: 0 }
      cur.games += n0(r, "participants.games")
      cur.players += 1
      m.set(name, cur)
    }
    return [...m.values()].sort((a, b) => b.players - a.players || b.games - a.games)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, puuids.join(), kind])
  const value = picked && options.some((o) => o.name === picked) ? picked : (options[0]?.name ?? null)

  const byPlayer = people
    .map((p) => {
      const r = rows.find((x) => x["participants.puuid"] === p.puuid && x[kind.nameKey] === value)
      const base = wrOf(p.puuid)
      const games = n0(r, "participants.games")
      const wins = n0(r, "participants.wins")
      const wr = games ? (100 * wins) / games : null
      return {
        player: p,
        games,
        wins,
        losses: n0(r, "participants.losses"),
        winrate: wr,
        base,
        delta: games && base !== null ? shrunk(games, wr, base) - base : null,
        perf: games ? dev(r) : null,
      }
    })
    .sort((a, b) => b.games - a.games || (b.winrate ?? 0) - (a.winrate ?? 0))
  const played = byPlayer.filter((r) => r.games)
  const total = played.reduce((a, r) => a + r.games, 0)
  const wins = played.reduce((a, r) => a + r.wins, 0)

  return (
    <Panel title={kind.title} caption={kind.caption}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <LookupPicker options={options} value={value} onChange={pick} kind={kind} />
        {value && (
          <span className="text-xs text-muted-foreground">
            {played.length} 人{kind.verb}過・合計 {total} 場・{wins} 勝 {total - wins} 敗
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-[320px] w-full" />
      ) : !value ? (
        <EmptyState>這群人還沒有對局。</EmptyState>
      ) : (
        <div className="space-y-1">
          <div className="grid grid-cols-[minmax(0,1fr)_3.5rem_minmax(8rem,14rem)_4.5rem_4.5rem] gap-3 px-2 text-[11px] text-muted-foreground">
            <span>玩家</span>
            <span>場次</span>
            <span>戰績</span>
            <span className="text-right">勝率</span>
            <span className="text-right">貢獻</span>
          </div>
          {byPlayer.map((r, i) => {
            const open = !!r.games && openPlayer === r.player.puuid
            const cells = (
              <>
                <span className="flex min-w-0 items-center gap-1.5">
                  <ChevronDown
                    className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90", !r.games && "invisible")}
                  />
                  <PlayerName player={r.player} className="text-[13px]" />
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{r.games ? `${r.games} 場` : ""}</span>
                {r.games ? (
                  <RecordCell winrate={r.winrate} wins={r.wins} losses={r.losses} baseline={r.base} baselineLabel="他自己的整體勝率" />
                ) : (
                  <span className="text-xs text-muted-foreground">沒{kind.verb}過</span>
                )}
                <span
                  className={cn(
                    "text-right font-mono text-[11px] tabular-nums",
                    r.delta === null || Math.abs(r.delta) < 2 ? "text-muted-foreground" : r.delta > 0 ? "text-win" : "text-loss",
                  )}
                >
                  {r.delta === null ? "" : `${signed(r.delta)}pp`}
                </span>
                <span className="text-right text-[12px]">{r.perf === null ? "" : <ContribScore dev={r.perf} />}</span>
              </>
            )
            const rowClass = "slide-in grid grid-cols-[minmax(0,1fr)_3.5rem_minmax(8rem,14rem)_4.5rem_4.5rem] items-center gap-3 rounded-md px-2 py-1.5"
            const style = { "--stagger": `${i * 35}ms` } as CSSProperties
            // 沒用過的人沒有東西可展開，維持一般的列
            if (!r.games) {
              return (
                <div key={r.player.puuid} style={style} className={cn(rowClass, "opacity-60")}>
                  {cells}
                </div>
              )
            }
            return (
              <Fragment key={r.player.puuid}>
                <ExpandRow
                  open={open}
                  onToggle={() => setOpenPlayer(open ? null : r.player.puuid)}
                  label={`${splitId(r.player.riot_id, r.player.puuid).name}${kind.verb}${value}`}
                  style={style}
                  className={rowClass}
                >
                  {cells}
                </ExpandRow>
                {open && (
                  <div className="reveal mb-2 ml-3 border-l-2 border-primary/40 pl-3">
                    <PlayerMatches
                      puuid={r.player.puuid}
                      filters={[{ member: kind.nameKey, operator: "equals", values: [value] }]}
                    />
                  </div>
                )}
              </Fragment>
            )
          })}
        </div>
      )}
    </Panel>
  )
}

const CHAMPION_LOOKUP: LookupKind = {
  title: "查英雄",
  caption:
    "選一隻英雄，看每個人玩它的戰績，點一個人展開他玩這隻英雄的每一場。「勝率」是和他自己整體勝率的差距（依場次收縮後），戰績條的刻度也是他自己的整體勝率；「貢獻」是這幾場的隊內貢獻（50＝同類型的中位數，不受輸贏影響）",
  noun: "英雄",
  counter: "隻",
  verb: "玩",
  nameKey: "champions.name",
  iconKey: "champions.icon_path",
}

const AUGMENT_LOOKUP: LookupKind = {
  title: "查增幅裝置",
  caption:
    "選一個增幅裝置，看每個人拿它的戰績，點一個人展開他拿到它的每一場。欄位的意思和「查英雄」一樣。一場會拿好幾個增幅，同一場會同時出現在它拿到的每個增幅底下，所以各增幅的場次不能加總",
  noun: "增幅",
  counter: "個",
  verb: "拿",
  nameKey: "augments.name",
  iconKey: "augments.icon_path",
}

export function Crew() {
  const { players, apply } = useFilters()
  const crew = useMemo(() => players.filter((p) => p.crew), [players])
  // 預設全部人都比；點名字可以拿掉（至少留一個）
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const chosen = crew.filter((p) => !excluded.has(p.puuid))
  const puuids = chosen.map((p) => p.puuid)
  const [focus, setFocus] = useState<{ puuid: string; role: string | null; tab: DrawerTab } | null>(null)

  const byId = useMemo(() => new Map(crew.map((p) => [p.puuid, p])), [crew])
  const focusPlayer = focus ? byId.get(focus.puuid) : undefined
  useCrumb(
    10,
    focusPlayer ? `${splitId(focusPlayer.riot_id, focusPlayer.puuid).name}${focus?.role ? `・${focus.role}` : ""}` : null,
    () => setFocus(null),
  )

  // 全域條件（模式、期間、下鑽）照套，但不鎖定帳號（scope "all"），改成鎖定這群人。equals 給多個值就是 IN。
  const crewFilter = (ids: string[]): CubeFilter => ({ member: "participants.puuid", operator: "equals", values: ids })
  const q = (query: CubeQuery): CubeQuery | null =>
    puuids.length ? apply({ ...query, filters: [crewFilter(puuids), ...(query.filters ?? [])] }, "all") : null

  const summary = useCube(
    q({ measures: [...STAT_MEASURES, "participants.kda"], dimensions: ["participants.puuid"], limit: NO_LIMIT }),
  )
  const roles = useCube(q({ measures: STAT_MEASURES, dimensions: ["participants.puuid", "builds.build_role"], limit: NO_LIMIT }))
  const champs = useCube(
    q({ measures: STAT_MEASURES, dimensions: ["participants.puuid", "champions.name", "champions.icon_path"], limit: NO_LIMIT }),
  )
  // 增幅是一場多列的維度：查 winrate 會讓 Cube 走「撈主鍵再 join 回來」的慢路徑（實測 2.0 秒，不查 0.5 秒），
  // 所以只查 games 與 wins，勝率由 LookupPanel 自己除（定義就是 100 × wins / games）
  const augments = useCube(
    q({
      measures: ["participants.games", "participants.wins", "participants.losses", "contribution.score"],
      dimensions: ["participants.puuid", "augments.name", "augments.icon_path"],
      limit: NO_LIMIT,
    }),
  )
  // 參照列：所有參賽者的出裝比例（不鎖玩家，也不受上方「拿掉誰」影響）
  const everyone = useCube(apply({ measures: ["participants.games", "participants.winrate", "participants.kda"] }, "all"))
  const everyoneRoles = useCube(apply({ measures: ["participants.games"], dimensions: ["builds.build_role"], limit: NO_LIMIT }, "all"))
  const error = summary.error ?? roles.error ?? champs.error ?? augments.error ?? everyone.error ?? everyoneRoles.error
  const loading = summary.loading || roles.loading || champs.loading || augments.loading || everyone.loading || everyoneRoles.loading

  const sumOf = (puuid: string) => summary.rows.find((r) => r["participants.puuid"] === puuid)
  const gamesOf = (puuid: string) => n0(sumOf(puuid), "participants.games")
  const wrOf = (puuid: string) => opt(sumOf(puuid), "participants.winrate")

  // 每個人的判斷一次算好：一覽表、抽屜都用同一份
  const profiles = useMemo(() => {
    const out = new Map<string, Profile>()
    for (const p of crew) {
      const s = summary.rows.find((r) => r["participants.puuid"] === p.puuid)
      const overallStat = statOf(s, "overall", "整體")
      const own: Own = { score: overallStat.score, winrate: overallStat.winrate }
      // 整體和 50 比只有一組，不用放寬；勝率和 50% 比
      const overall = judge(overallStat, { score: own.score, winrate: null }, 1.96)
      const overallWr = overallStat.games ? gapOf({ key: "overall", label: "整體", games: overallStat.games, wins: overallStat.wins }, 50) : null
      const roleStats = BUILD_ROLES.map((label) =>
        statOf(roles.rows.find((x) => x["participants.puuid"] === p.puuid && x["builds.build_role"] === label), label, label),
      )
      const champStats = champs.rows
        .filter((r) => r["participants.puuid"] === p.puuid)
        .map((r) => statOf(r, String(r["champions.name"]), String(r["champions.name"]), r["champions.icon_path"] as string))
      const roleJ = judgeAll(roleStats, own)
      const champJ = judgeAll(champStats, own)
      out.set(p.puuid, { overall, overallWr, roles: roleJ.items, roleK: roleJ.k, champs: champJ.items, champK: champJ.k })
    }
    return out
  }, [crew, summary.rows, roles.rows, champs.rows])

  // 依場次排：場次多的人判斷比較可信，放前面
  const ordered = [...chosen].sort((a, b) => gamesOf(b.puuid) - gamesOf(a.puuid))
  const everyoneTotal = n0(everyone.rows[0], "participants.games")

  // 矩陣上方那句話：同時看得出的有幾格
  const counts = useMemo(() => {
    const cells = ordered.flatMap((p) => profiles.get(p.puuid)?.roles ?? []).filter((j) => j.g?.interval)
    return {
      judged: cells.length,
      strong: cells.filter((j) => j.strength === "強勢").length,
      weak: cells.filter((j) => j.strength === "不強勢").length,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, puuids.join()])

  if (!players.length) return <Skeleton className="h-[420px] w-full" />
  if (crew.length < 2) {
    return (
      <EmptyState>
        還沒有可以比較的好友。到「追蹤對象」加入一起打的朋友，他們的戰績被採集進來之後就會出現在這裡。
      </EmptyState>
    )
  }

  const open = (puuid: string, role: string | null, tab: DrawerTab) => setFocus({ puuid, role, tab })

  return (
    <div className="space-y-4">
      {error && <QueryError error={error} />}

      <Panel
        title="比較對象"
        caption="你和追蹤中的好友。點名字可以拿掉或加回來；模式、期間與上方的篩選照常套用。大部分場次是一起打的，勝率會互相牽動，差距要搭配場次看"
      >
        <div className="flex flex-wrap gap-2">
          {crew.map((p) => {
            const on = !excluded.has(p.puuid)
            return (
              <button
                key={p.puuid}
                onClick={() =>
                  setExcluded((cur) => {
                    const next = new Set(cur)
                    if (on) {
                      if (crew.length - next.size <= 1) return cur // 至少留一個
                      next.add(p.puuid)
                    } else next.delete(p.puuid)
                    return next
                  })
                }
                className={cn(
                  "flex max-w-[16rem] items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition",
                  on ? "border-primary/50 bg-primary/10" : "text-muted-foreground opacity-60 hover:opacity-100",
                )}
              >
                <Check className={cn("size-3.5 shrink-0", on ? "text-primary" : "opacity-0")} />
                <PlayerName player={p} />
              </button>
            )
          })}
        </div>
      </Panel>

      {/* ── 全員一覽：每人一列，迷你雷達 + 出裝與英雄的判定 ── */}
      <Panel
        title="全員一覽"
        caption="判定看隊內貢獻（50＝同類型的中位數，不受輸贏影響）的誤差範圍：整段高於 50 是強勢、整段低於 50 是不強勢，還在誤差內的寫偏強／偏弱（虛線框）。雷達是各出裝佔他場次的比例。前面的數字是名次，看得出的排前面；滑過看數字，點一列看完整分析"
      >
        {loading ? (
          <Skeleton className="h-[640px] w-full" />
        ) : (
          <div className="space-y-3">
            <p className="text-sm" data-testid="crew-matrix-summary">
              各出裝裡 {counts.judged} 格有 {MIN_N} 場以上，看得出強弱的有 {counts.strong + counts.weak} 格（強勢 {counts.strong}、不強勢 {counts.weak}），其餘差距都還在誤差內。
            </p>
            <RowLegend />
            <div className="overflow-x-auto">
              <div className="min-w-[1040px]">
                <div className={cn("grid items-end gap-4 border-b px-2 pb-1.5 text-[11px] text-muted-foreground", ROW_COLS)}>
                  <span>玩家</span>
                  <span className="text-center">出裝定位</span>
                  <span className="grid grid-cols-2 gap-3">
                    <span className="text-win">出裝：比同類型強</span>
                    <span className="text-loss">出裝：比同類型弱</span>
                  </span>
                  <span className="grid grid-cols-2 gap-3">
                    <span className="text-win">英雄：比同類型強</span>
                    <span className="text-loss">英雄：比同類型弱</span>
                  </span>
                </div>
                <div
                  data-testid="crew-reference-row"
                  className={cn("grid w-full items-center gap-4 border-b border-dashed bg-muted/20 px-2 py-1", ROW_COLS)}
                >
                  <span className="min-w-0">
                    <span className="flex items-baseline gap-1.5 text-sm font-medium">
                      全體參賽者
                      <span className="rounded border border-dashed px-1 text-[10px] font-normal text-muted-foreground">參照</span>
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
                      {everyoneTotal} 場・{opt(everyone.rows[0], "participants.winrate")?.toFixed(1) ?? "—"}%・KDA{" "}
                      {opt(everyone.rows[0], "participants.kda")?.toFixed(2) ?? "—"}
                    </span>
                  </span>
                  <MiniHex
                    data={BUILD_ROLES.map((label) => ({
                      label,
                      games: n0(everyoneRoles.rows.find((x) => x["builds.build_role"] === label), "participants.games"),
                      strength: null,
                    }))}
                    total={everyoneTotal}
                  />
                  <span className="col-span-2 text-[11px] text-muted-foreground">
                    把資料庫裡每場十位參賽者都算進來：雷達是一般玩家各出裝佔多少，拿來和下面每個人的形狀對照他偏好什麼；
                    隊內貢獻依定義是 50（同類型的中位數），勝率每場兩隊都算，必然是 50%。
                  </span>
                </div>
                {ordered.map((p, i) => {
                  const prof = profiles.get(p.puuid)
                  if (!prof) return null
                  const ownWr = prof.overall.winrate
                  const ov = prof.overall
                  return (
                    <button
                      key={p.puuid}
                      type="button"
                      data-testid="crew-row"
                      onClick={() => open(p.puuid, null, "overview")}
                      style={{ "--stagger": `${i * 35}ms` } as CSSProperties}
                      className={cn(
                        "slide-in grid w-full items-center gap-4 rounded-md border-b px-2 py-1 text-left transition hover:bg-accent",
                        ROW_COLS,
                        focus?.puuid === p.puuid && "bg-primary/10",
                      )}
                    >
                      <span className="min-w-0">
                        <PlayerName player={p} className="text-sm" />
                        <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
                          {ov.games} 場・{ownWr?.toFixed(1) ?? "—"}%・KDA {opt(sumOf(p.puuid), "participants.kda")?.toFixed(2) ?? "—"}
                        </span>
                        <span className="block text-[11px] text-muted-foreground" title={tipOf(ov, null)} data-testid="crew-overall" data-strength={ov.strength}>
                          隊內貢獻{" "}
                          <span className={cn("font-mono font-semibold", ov.g?.interval ? NUM_CLASS[ov.strength] : "text-muted-foreground")}>
                            {ov.score === null ? "—" : Math.round(ov.score)}
                          </span>
                          {ov.strength !== "看不出" && (
                            <span className={cn("ml-1 rounded border px-1 text-[10px]", STRENGTH_CLASS[ov.strength])}>{ov.strength}</span>
                          )}
                        </span>
                      </span>
                      <MiniHex data={prof.roles.map((j) => ({ label: j.label, games: j.games, strength: j.strength }))} total={ov.games} />
                      <span className="grid grid-cols-2 items-center gap-3">
                        <RoleChips items={sideOf(prof.roles, "pos")} ownWr={ownWr} />
                        <RoleChips items={sideOf(prof.roles, "neg")} ownWr={ownWr} />
                      </span>
                      <span className="grid grid-cols-2 items-center gap-3">
                        <ChampSide items={sideOf(prof.champs, "pos")} ownWr={ownWr} />
                        <ChampSide items={sideOf(prof.champs, "neg")} ownWr={ownWr} />
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <HowWeJudge>
              <p>
                隊內貢獻是同類型（出裝定位 × 英雄官方主定位）裡的名次百分位：輸出、承傷、存活、參團、控場（有治療或護盾隊友時再加治療護盾）依出裝定位加權。
                不用擊殺、金錢、勝負計算，所以不受輸贏影響；50 是同類型的中位數。
              </p>
              <p>
                每一項都算誤差範圍（95%；單場的分數起伏大，標準差約 27，場次越多範圍越窄）。範圍整段高於 50 才寫「強勢」、整段低於 50 才寫「不強勢」；
                差 {CONTRIB_GAP} 分以上但範圍還跨過 50 寫「偏強／偏弱」；不到 {MIN_N} 場不下判斷。同一個人同時比好幾種出裝或好幾隻英雄，範圍會再放寬——
                一次比二十隻，總有一兩隻看起來特別好或特別差只是運氣。
              </p>
              <p>
                勝率只當補充：和他自己的整體勝率比，範圍也整段在一邊才標 ▲▼；貢獻強勢但勝率明顯低是「非戰之罪」，貢獻不強勢但勝率明顯高是「靠隊友」。
                好友多半一起打、勝率互相牽動，每個人的整體勝率目前都和 50% 分不出差別，所以不拿勝率判斷。
              </p>
              <p>
                舊版的「適合／不適合」用固定門檻、不管場次，幾乎每一項都會被貼上標籤，而且跟著這個人的整體水準走（整體強的人每個出裝都「適合」）。
                同一個人不同出裝、不同英雄之間的差距，目前的資料都還分不出來；看得出的，主要是人和人之間的差別。
              </p>
            </HowWeJudge>
          </div>
        )}
      </Panel>

      {/* ── 查英雄、查增幅裝置：選一個，看每個人用它的勝率與貢獻 ── */}
      {/* 兩個面板一樣的結構，寬螢幕（1900px 以上，展開的對局卡片才放得進半版）左右並排，其餘上下疊 */}
      <div className="grid items-start gap-4 min-[1900px]:grid-cols-2 [&>*]:min-w-0">
        <LookupPanel kind={CHAMPION_LOOKUP} rows={champs.rows} loading={loading} people={ordered} puuids={puuids} wrOf={wrOf} />
        <LookupPanel kind={AUGMENT_LOOKUP} rows={augments.rows} loading={loading} people={ordered} puuids={puuids} wrOf={wrOf} />
      </div>

      <DetailDrawer
        open={!!focusPlayer}
        onClose={() => setFocus(null)}
        title={focusPlayer ? <PlayerName player={focusPlayer} /> : ""}
        subtitle={
          focusPlayer
            ? `整體 ${wrOf(focusPlayer.puuid)?.toFixed(1) ?? "—"}%・${round0(gamesOf(focusPlayer.puuid))} 場・KDA ${opt(sumOf(focusPlayer.puuid), "participants.kda")?.toFixed(2) ?? "—"}`
            : undefined
        }
      >
        {focusPlayer && focus && profiles.get(focusPlayer.puuid) && (
          <PlayerDrawerBody
            key={focusPlayer.puuid}
            player={focusPlayer}
            profile={profiles.get(focusPlayer.puuid)!}
            role={focus.role}
            onRole={(role) => setFocus((f) => (f ? { ...f, role } : f))}
            tab={focus.tab}
            onTab={(tab) => setFocus((f) => (f ? { ...f, tab } : f))}
            crewFilter={crewFilter}
          />
        )}
      </DetailDrawer>
    </div>
  )
}
