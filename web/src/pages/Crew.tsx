import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { ArrowRight, Check, ChevronDown, ChevronsUpDown, Search } from "lucide-react"
import { RecordCell } from "@/components/cells"
import { ContribBars, ContribScore } from "@/components/Contribution"
import { PERF_GAP, PERF_MEASURES, PERF_PARTS } from "@/hooks/useContribution"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, Panel, QueryError } from "@/components/primitives"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ContribRadarChart, SHRINK_K, shrunk } from "@/components/charts"
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
  PERF_SD,
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
// 判斷用當局表現分（contribution.perf）：每分鐘的實際數值和同類型（出裝定位 × 英雄官方主定位）、同時長帶的人比，50＝中位數；
// 坦克、輔助和輸出位拉成同一把尺（各比較對象內標準差都是 20，見 contribution.yml），不用擊殺、金錢、勝負當輸入。
// 2026-10-10 從隊內排名（contribution.score）換過來：隊內排名是零和的，而好友幾乎都五排，
//   它量到的是「這群朋友之間誰分到比較多工作」——和強的朋友同隊的人一定被壓低（同隊時 64.7 對 31.1）。
//   原本不用表現分是因為它和勝負有關（個人相關 0.19），但五排的朋友共享輸贏，這個顧慮在這頁不成立。
//   和 50 比，95% 區間（標準誤＝單場標準差 PERF_SD 19 ÷ √有分數的場數）整段高於 50 是「強勢」、整段低於 50 是「不強勢」；
//   差 PERF_GAP（4）分以上但區間還跨過 50 是「偏強／偏弱」；其餘畫面上寫「普通」；不到 MIN_N 場寫「場次不夠」。
//   同一個人同時比好幾種出裝（或好幾隻英雄）時用 zFor(k) 放寬區間——一次比二十隻，總會有一兩隻只是運氣。
// 勝率只當補充：和他自己的整體勝率比，區間（同樣放寬）整段在一邊才標 ▲▼，以及「非戰之罪」（表現好但勝率比他平常低 WR_LUCK 以上）、
//   「靠隊友」（貢獻不強勢但勝率明顯高）。好友多半一起打、勝率互相牽動，2026-10 實測每個人的整體勝率都和 50% 分不出差別。
// 舊版用固定門檻（貢獻差 6 分、勝率差 3／5pp），不管場次：89% 的出裝、82% 的英雄都被貼上「適合／不適合」，
//   而且幾乎全部跟著這個人的整體水準走（整體強的人每個出裝都「適合」）。改成區間之後，看得出的只剩真的看得出的。
//   依據見 analysis/crew_verdicts.py。

/** 一覽表「英雄」分頁每邊最多放幾隻頭像；其餘寫「還有 N 隻」，完整排名在點開的抽屜裡 */
const CHAMPS_SHOWN = 5
/** 場次、勝負、表現分，以及算區間要用的「有表現分的場次」（重開局沒有分數） */
const STAT_MEASURES = [
  "participants.games",
  "participants.wins",
  "participants.losses",
  "participants.winrate",
  "contribution.perf",
  "contribution.scored_games",
]

const n0 = (r: CubeRow | undefined, k: string) => (r ? (num(r[k]) ?? 0) : 0)
const opt = (r: CubeRow | undefined, k: string) => (r ? num(r[k]) : null)
const signed = (v: number, digits = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`
/** 表現分換成「和同類型中位數（50）的差距」 */
const dev = (r: CubeRow | undefined) => {
  const v = opt(r, "contribution.perf")
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
  /** 表現分和 50 比（區間已依同時比幾組放寬）；沒有分數是 null */
  g: ScoreGap | null
  strength: Strength
  /** 勝率和他自己的整體勝率比（區間同樣放寬）；只用來標 ▲▼ 與「非戰之罪／靠隊友」 */
  wr: Gap | null
  /** 排序用：表現分往他自己的平均收縮（SHRINK_K 場虛擬場次），一兩場的不會排到最前面 */
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
  style: PlayStyle
}

const statOf = (r: CubeRow | undefined, key: string, label: string, icon?: string): Stat => ({
  key,
  label,
  icon,
  games: n0(r, "participants.games"),
  wins: n0(r, "participants.wins"),
  winrate: opt(r, "participants.winrate"),
  score: opt(r, "contribution.perf"),
  scored: n0(r, "contribution.scored_games"),
})

function judge(s: Stat, own: Own, z: number): Judged {
  const g = s.score === null ? null : scoreGapOf(s.score, s.scored, z, PERF_SD)
  const wr = own.winrate === null || !s.games ? null : gapOf({ key: s.key, label: s.label, games: s.games, wins: s.wins }, own.winrate, z)
  const est = s.score === null || own.score === null ? null : (s.scored * s.score + SHRINK_K * own.score) / (s.scored + SHRINK_K)
  return { ...s, g, strength: g ? scoreStrengthOf(g, PERF_GAP) : "看不出", wr, est }
}

/** 一個人的一組（他的幾種出裝，或他玩過的英雄）一起判斷：樣本夠的有 k 組，區間就放寬到「這 k 組一起看還是 95%」 */
function judgeAll(stats: Stat[], own: Own) {
  const k = stats.filter((s) => s.score !== null && s.scored >= MIN_N).length
  const z = zFor(k)
  return { k, items: stats.map((s) => judge(s, own, z)) }
}

const wrFlag = (j: Judged) => (j.wr?.clear ? (j.wr.diff > 0 ? "up" : "down") : null)

/** 勝率和他自己的平均差這麼多（百分點）以上、但還在誤差內時，補一句「勝率偏高／偏低」 */
const WR_LEAN = 15
/** 表現和勝率走反方向（打得好卻常輸、打得差卻常贏）要差這麼多百分點、至少 LUCK_MIN 場，才標「非戰之罪／靠隊友」 */
const WR_LUCK = 10
const LUCK_MIN = 10

/** 勝率的補充說明：
 *  - 表現比同類型好（強勢／偏強），勝率卻比他自己的平均低 WR_LUCK 以上 →「非戰之罪」：輸多半不是他的問題
 *  - 表現比同類型差（不強勢／偏弱），勝率卻高 WR_LUCK 以上 →「靠隊友」
 *    這兩個不要求勝率的區間整段在一邊：勝率每項只有幾十場，區間幾乎都寬到 ±20pp，那樣幾乎永遠不會出現；
 *    表現分本身已經是看得出（或偏）的才標，誤差另外寫在滑過的說明裡
 *  - 其餘：勝率區間整段在一邊是「明顯高／低」，差 WR_LEAN 以上但還在誤差內是「偏高／偏低」 */
function extraOf(j: Judged) {
  const d = j.wr?.interval ? j.wr.diff : null
  if (d !== null && j.games >= LUCK_MIN) {
    if (isPos(j.strength) && d <= -WR_LUCK) return "非戰之罪"
    if (isNeg(j.strength) && d >= WR_LUCK) return "靠隊友"
  }
  const f = wrFlag(j)
  if (f) return f === "up" ? "勝率明顯高" : "勝率明顯低"
  if (d !== null && Math.abs(d) >= WR_LEAN) return d > 0 ? "勝率偏高" : "勝率偏低"
  return null
}

/** 畫面上的字：場次夠、但表現分和 50 差不多的是「普通」（不是「看不出」——那會被讀成場次不夠） */
const shownOf = (s: Strength) => (s === "看不出" ? "普通" : s)

const isPos = (s: Strength) => s === "強勢" || s === "偏強"
const isNeg = (s: Strength) => s === "不強勢" || s === "偏弱"
const isClear = (s: Strength) => s === "強勢" || s === "不強勢"

function tipOf(j: Judged, ownWr: number | null) {
  const lines = [`${j.label}・${j.games} 場${j.scored !== j.games ? `（有表現分的 ${j.scored} 場）` : ""}`]
  if (j.g) {
    lines.push(
      `表現分 ${Math.round(j.g.mean)}（50＝同類型的中位數）` +
        (j.g.interval
          ? `，區間 ${Math.round(50 + j.g.interval[0])}～${Math.round(50 + j.g.interval[1])} → ${shownOf(j.strength)}`
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
  if (x === "非戰之罪")
    lines.push(`非戰之罪：表現比同類型好，勝率卻比他平常低 ${WR_LUCK} 個百分點以上，輸多半不是他的問題${j.wr?.clear ? "" : "（勝率差距還在誤差內）"}`)
  if (x === "靠隊友")
    lines.push(`靠隊友：表現比同類型差，勝率卻比他平常高 ${WR_LUCK} 個百分點以上，贏多半是隊友或陣容${j.wr?.clear ? "" : "（勝率差距還在誤差內）"}`)
  return lines.join("\n")
}

/** 判定標籤：五級（實心＝看得出、虛線＝還在誤差內），勝率也看得出時在後面補一句 */
function StrengthChip({ j }: { j: Judged }) {
  const x = extraOf(j)
  const up = (j.wr?.diff ?? 0) > 0
  // 不到 MIN_N 場沒有區間：和「場次夠、和 50 差不多」的普通分開講
  if (!j.g?.interval && !x) return <span className="text-[11px] text-muted-foreground/80">場次不夠</span>
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span data-testid="strength-chip" className={cn("rounded border px-1.5 text-[11px]", STRENGTH_CLASS[j.strength])}>
        {j.g?.interval ? shownOf(j.strength) : "場次不夠"}
      </span>
      {x && (
        <span className={cn("text-[11px]", wrFlag(j) ? "text-foreground" : "text-muted-foreground")}>
          <span className={up ? "text-win" : "text-loss"}>{up ? "▲" : "▼"}</span>
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

/** 迷你雷達（出裝定位九個頂點）：形狀是各出裝定位佔他自己場次的比例（偏好怎麼玩），頂點顏色是判定。
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
    // 頂點多時左右兩端的標籤會貼到邊，overflow 放出去（欄與欄之間有 gap，不會壓到別人）
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

/** 抽屜總覽的雷達：和一覽表的迷你雷達同一套——形狀是各出裝佔他場次的比例、顏色是表現分的判定。
 *  原本用共用的 RadarChart，它的標籤顏色是「勝率和他自己的平均比」，和一覽表的判定（表現分）不是同一件事，
 *  同一個坦克一邊寫偏強、一邊是紅字，看起來像數字對不上。 */
function RoleHex({ roles, total, selected, onPick }: { roles: Judged[]; total: number; selected: string | null; onPick: (label: string) => void }) {
  const W = 420
  const H = 320 // 標籤三行（名稱、表現分・場次、勝率），底下那個頂點要多留空間
  const cx = W / 2
  const cy = H / 2 + 2
  const r = 92
  const n = roles.length
  const at = (i: number, frac: number) => {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180 // 和一覽表同方向：正上方開始、逆時針
    return [cx + Math.cos(a) * r * frac, cy - Math.sin(a) * r * frac] as const
  }
  const ring = (frac: number) => roles.map((_, i) => at(i, frac).join(",")).join(" ")
  const share = roles.map((j) => (total ? j.games / total : 0))
  const scaleMax = Math.max(0.01, ...share)
  const tone = (j: Judged) => (j.g?.interval ? DOT_CLASS[j.strength] : "fill-muted-foreground")
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[420px] overflow-visible" data-testid="role-hex">
      <polygon points={ring(1)} className="fill-muted/30 stroke-muted-foreground/40" strokeWidth={1} />
      <polygon points={ring(0.5)} className="fill-none stroke-muted-foreground/25" strokeWidth={0.75} />
      {roles.map((_, i) => {
        const [x, y] = at(i, 1)
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="stroke-muted-foreground/25" strokeWidth={0.75} />
      })}
      <polygon
        points={share.map((v, i) => at(i, Math.min(1, v / scaleMax)).join(",")).join(" ")}
        className="fill-data/30 stroke-data"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      {roles.map((j, i) => {
        const [x, y] = at(i, Math.min(1, share[i] / scaleMax))
        const [lx, ly] = at(i, 1.42)
        const on = selected === j.label
        return (
          <g
            key={j.key}
            role="button"
            tabIndex={j.games ? 0 : -1}
            aria-label={`看他用${j.label}玩過的英雄`}
            data-label={j.label}
            data-strength={j.strength}
            className={cn("outline-none", j.games ? "cursor-pointer" : "cursor-default opacity-60", "[&:hover_text]:underline")}
            onClick={() => j.games && onPick(j.label)}
            onKeyDown={(e) => {
              if (j.games && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault()
                onPick(j.label)
              }
            }}
          >
            <title>{j.games ? tipOf(j, null) : `${j.label}：沒有對局`}</title>
            <circle cx={x} cy={y} r={isClear(j.strength) ? 5 : j.g?.interval && j.strength !== "看不出" ? 4 : 3} className={tone(j)} />
            <text x={lx} y={ly - 7} textAnchor="middle" dominantBaseline="central" className={cn("text-[13px] font-semibold", tone(j), on && "underline")}>
              {j.label}
            </text>
            <text x={lx} y={ly + 9} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground font-mono text-[11px]">
              {j.games ? `${j.score === null ? "—" : Math.round(j.score)}・${j.games} 場` : "沒打過"}
            </text>
            {j.games > 0 && j.winrate !== null && (
              <text x={lx} y={ly + 23} textAnchor="middle" dominantBaseline="central" className="fill-muted-foreground font-mono text-[11px]">
                勝率 {Math.round(j.winrate)}%
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** 出裝定位的判定標籤：「1 強勢 射手」，實心是看得出的、虛線框是還在誤差內 */
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
          {j.winrate !== null && (
            <span className={cn("ml-1 font-mono", wrFlag(j) === "up" ? "text-win" : wrFlag(j) === "down" ? "text-loss" : "opacity-70")}>
              {Math.round(j.winrate)}%{wrFlag(j) === "up" ? "▲" : wrFlag(j) === "down" ? "▼" : ""}
            </span>
          )}
          <LuckTag j={j} />
        </span>
      ))}
    </span>
  )
}

/** 表現和勝率走反方向時的小標：「非戰之罪」「靠隊友」 */
function LuckTag({ j }: { j: Judged }) {
  const x = extraOf(j)
  if (x !== "非戰之罪" && x !== "靠隊友") return null
  return (
    <span
      data-testid="crew-luck"
      className={cn("ml-1 rounded-sm px-1 text-[10px]", x === "非戰之罪" ? "bg-win/15 text-win" : "bg-loss/15 text-loss")}
    >
      {x}
    </span>
  )
}

function RowLegend() {
  const chip = (s: Strength, text: string) => (
    <span className="flex items-center gap-1.5">
      <span className={cn("rounded border px-1 text-[10px]", STRENGTH_CLASS[s])}>{shownOf(s)}</span>
      {text}
    </span>
  )
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      {chip("強勢", "比同類型強（看得出）")}
      {chip("偏強", `高 ${PERF_GAP} 分以上，還在誤差內`)}
      {chip("看不出", "和同類型差不多")}
      {chip("偏弱", `低 ${PERF_GAP} 分以上，還在誤差內`)}
      {chip("不強勢", "比同類型弱（看得出）")}
      <span>
        <span className="text-win">▲</span>
        <span className="text-loss">▼</span> 後面的 % 是勝率，▲▼＝比他自己的平均明顯高／低
      </span>
      <span>
        <span className="rounded-sm bg-win/15 px-1 text-[10px] text-win">非戰之罪</span> 表現好但常輸（勝率低 {WR_LUCK}pp 以上）
      </span>
      <span>
        <span className="rounded-sm bg-loss/15 px-1 text-[10px] text-loss">靠隊友</span> 表現差但常贏
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

/** 英雄頭像：名次、判定外框、表現分。給 onClick 時整顆可以點（在整列按鈕裡面也可以，點擊不會傳到外層）；
 *  放在別的按鈕裡時，外層按鈕加上 group，滑過一樣會有上浮與變亮 */
function ChampBadge({ j, rank, ownWr, onClick }: { j: Judged; rank: number; ownWr: number | null; onClick?: () => void }) {
  const p = isPos(j.strength)
  const clear = isClear(j.strength)
  const body = (
    <span className="relative block transition duration-150 group-hover:-translate-y-0.5 group-hover:brightness-125">
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
          "size-8 rounded-md bg-icon-tile transition-shadow duration-150 group-hover:shadow-md group-hover:shadow-primary/40",
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
      {(extraOf(j) === "非戰之罪" || extraOf(j) === "靠隊友") && (
        <span
          data-testid="crew-champ-luck"
          className={cn(
            "absolute -right-1 -top-1 z-10 rounded-sm px-0.5 text-[8px] leading-tight ring-1 ring-background",
            extraOf(j) === "非戰之罪" ? "bg-win text-background" : "bg-loss text-background",
          )}
        >
          {extraOf(j) === "非戰之罪" ? "非戰" : "隊友"}
        </span>
      )}
    </span>
  )
  const tip = `第 ${rank} 名・${tipOf(j, ownWr)}${onClick ? "\n點一下看他玩這隻的每一場" : ""}`
  if (!onClick) {
    return (
      <span title={tip} className="relative shrink-0" data-testid="crew-champ" data-strength={j.strength}>
        {body}
      </span>
    )
  }
  return (
    // 在一覽表的整列按鈕裡面，不能再放 <button>，所以用 role="button"；點擊與鍵盤都不往外傳
    <span
      role="button"
      tabIndex={0}
      title={tip}
      aria-label={`看${j.label}的每一場`}
      data-testid="crew-champ"
      data-strength={j.strength}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return
        e.preventDefault()
        e.stopPropagation()
        onClick()
      }}
      className="group relative shrink-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {body}
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

function ChampSide({
  items,
  ownWr,
  onMore,
  onPick,
}: {
  items: Judged[]
  ownWr: number | null
  onMore?: () => void
  onPick?: (label: string) => void
}) {
  if (!items.length) return <span className="text-[11px] text-muted-foreground">—</span>
  const rest = items.length - CHAMPS_SHOWN
  return (
    <span className="flex flex-wrap items-center gap-1.5 gap-y-3">
      {items.slice(0, CHAMPS_SHOWN).map((j, i) => (
        <ChampBadge key={j.key} j={j} rank={i + 1} ownWr={ownWr} onClick={onPick ? () => onPick(j.label) : undefined} />
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

/** 抽屜裡的橫向長條：比同類型強（或弱）的英雄全部列出，一行排開，太多時左右捲動 */
function ChampStrip({
  title,
  tone,
  items,
  ownWr,
  onPick,
}: {
  title: string
  tone: "pos" | "neg"
  items: Judged[]
  ownWr: number | null
  /** 點一隻：捲到下面清單的那一列並展開他玩這隻的每一場 */
  onPick: (label: string) => void
}) {
  const clear = items.filter((j) => isClear(j.strength)).length
  return (
    <div className="rounded-lg border px-3 py-2" data-testid={tone === "pos" ? "strip-strong" : "strip-weak"}>
      <div className="mb-1.5 flex items-baseline gap-2 text-xs">
        <span className={cn("font-semibold", tone === "pos" ? "text-win" : "text-loss")}>{title}</span>
        <span className="text-[11px] text-muted-foreground">
          {items.length} 隻{items.length ? `・看得出 ${clear}（實線框）` : ""}
        </span>
      </div>
      {items.length ? (
        <div className="flex gap-2.5 overflow-x-auto px-1 pb-2.5 pt-1.5">
          {items.map((j, i) => (
            <button
              key={j.key}
              type="button"
              onClick={() => onPick(j.label)}
              aria-label={`看${j.label}的每一場`}
              className="group flex shrink-0 cursor-pointer flex-col items-center gap-1.5 rounded-md px-0.5 transition hover:bg-accent/60"
            >
              <ChampBadge j={j} rank={i + 1} ownWr={ownWr} />
              <span className="mt-1 max-w-[3.5rem] truncate text-[10px] text-muted-foreground group-hover:text-foreground">{j.label}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="pb-1 text-[11px] text-muted-foreground">沒有（{MIN_N} 場以上、差距 6 分以上的才列）</div>
      )}
    </div>
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
  rowKey,
}: {
  open: boolean
  onToggle: () => void
  className: string
  style?: CSSProperties
  children: React.ReactNode
  label: string
  /** 讓外面找得到這一列（捲過去用） */
  rowKey?: string
}) {
  return (
    <button
      type="button"
      data-row-key={rowKey}
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

/** 兩個分頁：總覽（整體的數字、雷達、看得出的強弱、貢獻分解）、出裝與英雄（出裝的區間圖，點一種出裝下面只列那種出裝的英雄） */
type DrawerTab = "overview" | "picks"

/** 總覽分頁上的一張數字卡：主數字、區間、判定與一句說明 */
function SummaryCard({ title, main, sub, strength, label, note }: { title: string; main: string; sub: string; strength: Strength; label: string; note: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span className={cn("rounded border px-1.5 text-[11px]", STRENGTH_CLASS[strength])}>{label}</span>
      </div>
      <div className="mt-1 font-mono text-2xl font-bold tabular-nums">{main}</div>
      <div className="font-mono text-[11px] tabular-nums text-muted-foreground">{sub}</div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
    </div>
  )
}

// ── 玩家類型：常玩什麼（出裝分布、AD／AP、英雄池）與打法（表現分六項哪裡突出） ─────────────
// 位置看出裝定位的場次比例，打法看表現分六項的平均（各項都和同類型比，50＝中位數，所以是「同樣的位置裡他哪裡做得多」）。
// 門檻是判斷：六項的平均在 300 場時誤差約 ±2，差 AXIS_LEAN 分以上才算突出；場次不到 STYLE_MIN 只講位置不講打法。

const STYLE_MIN = 20
/** 打法用的六項（表現分），順序同 PERF_PARTS */
const AXES = [
  { key: "contribution.perf_dmg", label: "輸出", up: "輸出高", down: "輸出偏低" },
  { key: "contribution.perf_soak", label: "承傷", up: "很耐打", down: "扛不住" },
  { key: "contribution.perf_minion", label: "清兵", up: "清兵多", down: "清兵少" },
  { key: "contribution.perf_obj", label: "推塔", up: "常拆塔", down: "很少拆塔" },
  { key: "contribution.perf_cc", label: "控場", up: "控場多", down: "控場少" },
  { key: "contribution.perf_heal", label: "治療護盾", up: "常補血護盾", down: "補給少" },
] as const
const AXIS_LEAN = 4

type PlayStyle = {
  /** 「AD 後排輸出」這種位置描述 */
  position: string
  /** 「衝鋒型」這種打法；場次不夠或沒有明顯特徵是 null */
  archetype: string | null
  archetypeNote: string | null
  /** 出裝比例，由多到少（只列有玩的）；base 是一般玩家的比例 */
  mix: { label: string; share: number; base: number }[]
  /** 比一般玩家明顯多玩的出裝 */
  favors: { label: string; share: number; base: number }[]
  adShare: number | null
  champCount: number
  top5Share: number
  topChamps: string[]
  /** 有表現分的場次夠 STYLE_MIN，才講打法 */
  enough: boolean
  /** 五項的平均（和同類型比，50＝中位數；治療護盾不算） */
  axes: { label: string; value: number | null; up: string; down: string }[]
}

function playStyleOf(
  roles: Judged[],
  champs: Judged[],
  sum: CubeRow | undefined,
  base: Map<string, number>,
  scored: number,
  dmgGames: { ad: number; ap: number },
): PlayStyle {
  const total = roles.reduce((a, j) => a + j.games, 0)
  const share = (labels: string[]) => (total ? roles.filter((j) => labels.includes(j.label)).reduce((a, j) => a + j.games, 0) / total : 0)
  // 四大類：後排（射手、法師）、前排（坦克、鬥士）、刺客、輔助。最大的一類占 45% 以上才說他是那一類，
  // 後排再看射手、法師哪個占後排的三分之二以上；都不到就是「什麼位置都玩」，附上最常的出裝
  const adc = share(["射手"])
  const mage = share(["法師"])
  const groups = [
    { name: "back", v: adc + mage },
    { name: "front", v: share(["坦克", "鬥士"]) },
    { name: "dive", v: share(["刺客"]) },
    { name: "support", v: share(["輔助"]) },
  ].sort((x, y) => y.v - x.v)
  const adShare = dmgGames.ad + dmgGames.ap > 0 ? dmgGames.ad / (dmgGames.ad + dmgGames.ap) : null
  const dmg = adShare === null ? "" : adShare >= 0.62 ? "AD " : adShare <= 0.38 ? "AP " : ""
  const topRole = [...roles].sort((x, y) => y.games - x.games)[0]
  const main = groups[0]
  const position =
    main.v < 0.45
      ? `什麼位置都玩${topRole?.games ? `（最常玩 ${topRole.label}）` : ""}`
      : main.name === "back"
        ? adc >= main.v * (2 / 3)
          ? "射手"
          : mage >= main.v * (2 / 3)
            ? "法師"
            : "後排（射手＋法師）"
        : main.name === "front"
          ? `${dmg}前排（坦克／鬥士）`
          : main.name === "dive"
            ? `${dmg}刺客`
            : "輔助"
  const mix = roles
    .filter((j) => j.games > 0)
    .map((j) => ({ label: j.label, share: total ? j.games / total : 0, base: base.get(j.label) ?? 0 }))
    .sort((a, b) => b.share - a.share)
  const favors = mix.filter((m) => m.share >= 0.08 && m.base > 0 && m.share / m.base >= 1.5)

  const played = champs.filter((j) => j.games > 0).sort((a, b) => b.games - a.games)
  const champGames = played.reduce((a, j) => a + j.games, 0)
  const top5Share = champGames ? played.slice(0, 5).reduce((a, j) => a + j.games, 0) / champGames : 0

  // 治療護盾只在有治療或護盾隊友的場次才有值，平均只代表那幾場（可能只占一成），不拿來判斷打法
  const axes = AXES.filter((a) => a.label !== "治療護盾").map((a) => ({ label: a.label, value: opt(sum, a.key), up: a.up, down: a.down }))
  const v = (label: string) => axes.find((a) => a.label === label)?.value ?? 50
  let archetype: string | null = null
  let archetypeNote: string | null = null
  if (scored >= STYLE_MIN) {
    const ups = axes.filter((a) => a.value !== null && a.value >= 50 + AXIS_LEAN)
    const downs = axes.filter((a) => a.value !== null && a.value <= 50 - AXIS_LEAN)
    // 輸出、承傷都是「每條命」的量，死得多會直接拉低這兩項，所以不再另外看存活
    if (ups.length >= 3) {
      archetype = "全面型"
      archetypeNote = "好幾項都比同類型多，沒有明顯的洞"
    } else if (v("推塔") >= 57) {
      archetype = "推進型"
      archetypeNote = "拆塔比同類型多：團戰贏了會把優勢換成塔"
    } else if (v("輸出") >= 57) {
      archetype = "輸出型"
      archetypeNote = "每條命打出的傷害比同類型多"
    } else if (v("承傷") >= 57) {
      archetype = "前排型"
      archetypeNote = "每條命扛下的傷害比同類型多"
    } else if (v("控場") >= 57) {
      archetype = "控場型"
      archetypeNote = "控制敵人的時間比同類型多"
    } else if (v("清兵") >= 57) {
      archetype = "清線型"
      archetypeNote = "清兵比同類型多"
    } else if (!ups.length && !downs.length) {
      archetype = "均衡型"
      archetypeNote = "輸出、承傷、清兵、推塔、控場都和同類型的中位數差不多"
    }
  }
  return {
    position,
    archetype,
    archetypeNote,
    mix,
    favors,
    adShare,
    champCount: played.length,
    top5Share,
    topChamps: played.slice(0, 5).map((j) => j.label),
    enough: scored >= STYLE_MIN,
    axes,
  }
}

const pct0 = (v: number) => `${Math.round(v * 100)}%`
/** 一行版：位置・打法；沒有對上任何一型時，改寫最突出的一兩項（「很少死」） */
const styleLine = (s: PlayStyle) => {
  if (s.archetype) return `${s.position}・${s.archetype}`
  if (!s.enough) return s.position
  const top = s.axes
    .filter((a) => a.value !== null && Math.abs(a.value - 50) >= AXIS_LEAN)
    .sort((a, b) => Math.abs((b.value ?? 50) - 50) - Math.abs((a.value ?? 50) - 50))
    .slice(0, 2)
    .map((a) => ((a.value ?? 50) > 50 ? a.up : a.down))
  return top.length ? `${s.position}・${top.join('、')}` : s.position
}

/** 總覽分頁的「玩家類型」卡片 */
function StyleCard({ style, scored }: { style: PlayStyle; scored: number }) {
  const notable = style.axes
    .filter((a) => a.value !== null && Math.abs(a.value - 50) >= AXIS_LEAN)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  return (
    <div className="rounded-lg border p-3" data-testid="crew-style">
      <div className="text-[11px] text-muted-foreground">玩家類型</div>
      <div className="mt-0.5 text-lg font-semibold">{styleLine(style)}</div>
      {style.archetypeNote && <div className="text-[12px] text-muted-foreground">{style.archetypeNote}</div>}
      <dl className="mt-2 grid gap-x-3 gap-y-1.5 text-[12px] sm:grid-cols-[5.5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">常玩的出裝</dt>
        <dd>
          {style.mix.slice(0, 4).map((m, i) => (
            <span key={m.label}>
              {i > 0 && "、"}
              {m.label} <span className="font-mono tabular-nums">{pct0(m.share)}</span>
            </span>
          ))}
          {style.favors.length > 0 && (
            <span className="block text-muted-foreground">
              比一般玩家多玩 {style.favors.map((m) => `${m.label}（他 ${pct0(m.share)}，一般 ${pct0(m.base)}）`).join("、")}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">AD／AP</dt>
        <dd>{style.adShare === null ? "—" : `AD 裝 ${pct0(style.adShare)}、AP 裝 ${pct0(1 - style.adShare)}（兩種傷害裝都沒買的純坦、純輔助不算）`}</dd>
        <dt className="text-muted-foreground">英雄池</dt>
        <dd>
          玩過 {style.champCount} 隻，最常玩的 5 隻占 <span className="font-mono tabular-nums">{pct0(style.top5Share)}</span>
          {style.topChamps.length > 0 && <span className="block text-muted-foreground">{style.topChamps.join("、")}</span>}
        </dd>
        <dt className="text-muted-foreground">打法</dt>
        <dd>
          {scored < STYLE_MIN
            ? `有表現分的場次不到 ${STYLE_MIN} 場，先不判斷`
            : notable.length
              ? notable.map((a, i) => (
                  <span key={a.label}>
                    {i > 0 && "、"}
                    <span className={(a.value ?? 50) > 50 ? "text-win" : "text-loss"}>{(a.value ?? 50) > 50 ? a.up : a.down}</span>
                    <span className="font-mono text-muted-foreground tabular-nums">（{a.label} {Math.round(a.value ?? 50)}）</span>
                  </span>
                ))
              : "五項都和同類型的中位數差不多"}
          <span className="block text-muted-foreground">各項都和同類型、同時長帶的人比，50＝中位數，所以是「同樣的位置裡他哪裡做得多」；治療護盾只有部分場次有量，不算進來</span>
        </dd>
      </dl>
    </div>
  )
}

/** 一句話講這個人整體的情形：只根據看得出的差別 */
function readingOf(p: Profile) {
  const s = p.overall.strength
  const w = p.overallWr ? strengthOf(p.overallWr) : "看不出"
  if (s === "強勢")
    return w === "強勢"
      ? "打得比同類型的人好，勝率也明顯高於 50%。"
      : "打得比同類型的人好，但勝率和 50% 分不出差別：輸贏很大一部分取決於隊友與隨機拿到的陣容。"
  if (s === "不強勢")
    return w === "不強勢" ? "打得比同類型的人差，勝率也明顯低於 50%。" : "打得比同類型的人差，但勝率沒有跟著變低：隊友補上了不少。"
  return "表現分和同類型的人差不多（差距還在誤差內）。"
}

/** 總覽分頁的「看得出的強項／弱項」：只列區間整段在一邊的，其餘只講有幾項 */
function Highlights({
  profile,
  onRole,
  onChamps,
  onChamp,
}: {
  profile: Profile
  onRole: (r: string) => void
  onChamps: () => void
  onChamp: (label: string) => void
}) {
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
              <ChampBadge key={j.key} j={j} rank={i + 1} ownWr={ownWr} onClick={() => onChamp(j.label)} />
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
        另有 {leanUp} 項偏強、{leanDown} 項偏弱，差距還在誤差內；「出裝與英雄」分頁看得到全部。
      </p>
    </div>
  )
}

/** 出裝定位分頁：一種出裝一列，表現分畫成區間（中線＝同類型的中位數 50），右邊是勝率與判定 */
function RoleForest({ profile, selected, onPick }: { profile: Profile; selected: string | null; onPick: (role: string) => void }) {
  const ownWr = profile.overall.winrate
  const far = profile.roles.flatMap((j) => (j.g?.interval ? [Math.abs(j.g.interval[0]), Math.abs(j.g.interval[1])] : []))
  const reach = Math.min(50, Math.max(20, Math.ceil(Math.max(0, ...far) / 10) * 10))
  const total = profile.overall.games
  const cols = "grid-cols-[5.5rem_minmax(8rem,1fr)_2.5rem_3.25rem_minmax(6.5rem,9rem)_7.5rem]"
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        點是他這種出裝的表現分、線是區間（同時比 {profile.roleK} 種出裝，已放寬）；區間整段在中線同一邊才上色。點一列，下面只列他用這種出裝玩過的英雄
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

/** 抽屜：某個人的完整分析，分成「總覽」與「出裝與英雄」兩個分頁 */
function PlayerDrawerBody({
  player,
  profile,
  role,
  onRole,
  tab,
  onTab,
  crewFilter,
  jumpChamp,
}: {
  player: Player
  profile: Profile
  role: string | null
  onRole: (role: string | null) => void
  tab: DrawerTab
  onTab: (tab: DrawerTab) => void
  crewFilter: (puuids: string[]) => CubeFilter
  /** 從一覽表點英雄頭像打開時：直接展開那隻英雄的每一場 */
  jumpChamp?: string
}) {
  const { apply, setAccount } = useFilters()
  const go = useNavigate()
  const settled = useDrawerSettled()
  const [sortBy, setSortBy] = useState<"score" | "games">("score")
  const [onlyClear, setOnlyClear] = useState(false)
  // 進場的滑入動畫只在第一次列出時播：切換排序或篩選時列會重新排列，React 搬動 DOM 節點會讓 CSS 動畫重播，
  // 整張清單看起來在跳來跳去
  const [reordered, setReordered] = useState(false)
  // 切到「只看看得出的」時清單一下變短，捲動位置會被擠回頂端；那時先把清單區撐在原本的高度
  const listRef = useRef<HTMLDivElement>(null)
  const [listMinH, setListMinH] = useState<number | undefined>(undefined)
  // 點英雄列展開那隻英雄的每一場（同時只開一隻，免得被好幾份列表撐得很長）
  const [openChamp, setOpenChamp] = useState<string | null>(null)
  useCrumb(20, openChamp ? `${openChamp}的每一場` : null, () => setOpenChamp(null))
  const ownWr = profile.overall.winrate
  const own: Own = { score: profile.overall.score, winrate: ownWr }
  const roleFilter = role ? [{ member: "builds.build_role", operator: "equals" as const, values: [role] }] : []
  const contrib = useCube(
    apply({ measures: PERF_MEASURES, filters: [crewFilter([player.puuid]), ...roleFilter], limit: 1 }, "all"),
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
    const list = champJudged.items.filter((j) => j.games > 0 && (!onlyClear || isClear(j.strength) || wrFlag(j)))
    return [...list].sort((a, b) =>
      sortBy === "games"
        ? b.games - a.games || (b.est ?? 0) - (a.est ?? 0)
        : (b.est ?? -1) - (a.est ?? -1) || b.games - a.games || a.label.localeCompare(b.label, "zh-Hant"),
    )
  }, [champJudged, sortBy, onlyClear])

  // 橫向長條點一隻英雄：清單裡展開那一列（被「只看看得出的」藏起來就先放回全部），再捲過去
  const jumpToChamp = (label: string, delay = 60) => {
    onTab("picks")
    setOnlyClear(false)
    setListMinH(undefined)
    setOpenChamp(label)
    setTimeout(() => {
      document.querySelector(`[data-row-key="${CSS.escape(label)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" })
    }, delay)
  }
  // 抽屜剛打開時要等它滑進來（約 300ms）、清單畫出來，再捲過去
  useEffect(() => {
    if (jumpChamp) jumpToChamp(jumpChamp, 450)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpChamp])
  const pickRole = (r: string | null) => {
    onRole(r)
    onTab("picks")
  }
  const ov = profile.overall
  const wrAll = profile.overallWr
  const champCols = "grid-cols-[1.5rem_minmax(8rem,1fr)_3rem_minmax(8rem,11rem)_minmax(7rem,10rem)_2.25rem_6.5rem]"
  // 英雄清單裡的貢獻區間共用一把尺：取所有區間最遠的一端，進位到 10，介於 20～50
  const champReach = Math.min(
    50,
    Math.max(20, Math.ceil(Math.max(0, ...champJudged.items.flatMap((j) => (j.g?.interval ? [Math.abs(j.g.interval[0]), Math.abs(j.g.interval[1])] : []))) / 10) * 10),
  )

  return (
    <Tabs value={tab} onValueChange={(v) => onTab(v as DrawerTab)} className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="overview">總覽</TabsTrigger>
          <TabsTrigger value="picks">出裝與英雄</TabsTrigger>
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
            title="表現分"
            main={ov.score === null ? "—" : String(Math.round(ov.score))}
            sub={
              ov.g?.interval
                ? `95% 區間 ${Math.round(50 + ov.g.interval[0])}～${Math.round(50 + ov.g.interval[1])}・${ov.scored} 場`
                : `${ov.scored} 場`
            }
            strength={ov.strength}
            label={ov.g?.interval ? shownOf(ov.strength) : "場次不夠"}
            note="每分鐘的實際表現和同類型（出裝定位 × 英雄官方主定位）、同時長帶的人比，50＝中位數；坦克、輔助和輸出位是同一把尺。不看隊友分走多少"
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
            label={shownOf(wrAll ? strengthOf(wrAll) : "看不出")}
            note="和 50% 比。好友多半一起打、勝率會互相牽動，用來比人不太準"
          />
        </div>
        <p className="text-sm" data-testid="crew-reading">
          {readingOf(profile)}
        </p>
        <StyleCard style={profile.style} scored={ov.scored} />
        <div className="grid gap-4 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">各出裝</div>
            </div>
            <div className="text-[11px] text-muted-foreground">
              形狀是各出裝佔他場次的比例；顏色和一覽表一樣是表現分的判定，標籤下是表現分・場次與勝率。點一種出裝看他用它玩過的英雄
            </div>
            <RoleHex roles={profile.roles} total={ov.games} selected={role} onPick={(r) => pickRole(r)} />
          </div>
          <Highlights profile={profile} onRole={(r) => pickRole(r)} onChamps={() => onTab("picks")} onChamp={(label) => jumpToChamp(label, 150)} />
        </div>
        {/* 貢獻分解：六項各自和同類型比（選了出裝就只看那種出裝） */}
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-semibold">
            貢獻分解{role ? `・出裝是${role}時` : "・所有出裝"}
          </div>
          <div className="text-[12px]">
            表現分 <ContribScore dev={dev(contrib.rows[0])} gap={PERF_GAP} className="text-base font-semibold" />
          </div>
        </div>
        <div className="mb-2 text-[11px] text-muted-foreground">
          每一項都是每分鐘的實際數值，和「同類型」（出裝定位 × 英雄官方主定位）、同時長帶的人比，換成名次百分位：50＝同類型的中位數，雷達裡的虛線圈與橫條中間的刻度就是 50。
          輸出、承傷都是「每條命」的量（除以死亡＋1），送頭換來的數字不加分。依出裝定位加權：輸出位重輸出與推塔；坦克的本職是承傷、控場、推塔、清兵，輔助是控場、治療護盾、推塔、清兵，輸出（輔助另加承傷）超過同類型中位數的部分再額外加分、低於不扣。
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
              data={PERF_PARTS.map((c) => ({ label: c.label, hint: c.hint, value: opt(contrib.rows[0], c.key) }))}
              height={300}
            />
            <ContribBars row={contrib.rows[0]} kind="perf" />
          </div>
        )}
      </div>
      </TabsContent>

      {/* ── 出裝與英雄：上面各種出裝的區間，點一種出裝下面只列那種出裝的英雄；英雄點一列看每一場 ── */}
      <TabsContent value="picks" className="reveal space-y-5">
        <RoleForest profile={profile} selected={role} onPick={(r) => onRole(role === r ? null : r)} />
        <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-3">
          <div className="text-sm font-semibold">{role ? `出裝是${role}時玩過的英雄` : "玩過的每隻英雄"}</div>
          {role && (
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onRole(null)}>
              看全部出裝
            </Button>
          )}
        </div>
        {!(role && (!settled || champs.loading)) && (
          <div className="grid gap-2">
            <ChampStrip title="比同類型強的英雄" tone="pos" items={sideOf(champJudged.items, "pos")} ownWr={ownWr} onPick={jumpToChamp} />
            <ChampStrip title="比同類型弱的英雄" tone="neg" items={sideOf(champJudged.items, "neg")} ownWr={ownWr} onPick={jumpToChamp} />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            依{sortBy === "score" ? "表現分（往他自己的平均收縮過，一兩場的不會排到最前面）" : "場次"}排；
            判定的區間依同時比了 {champJudged.k} 隻（{MIN_N} 場以上）放寬，所以單隻英雄很難看得出差別
          </div>
          <div className="flex items-center gap-2">
            <ToggleGroup type="single" size="sm" variant="outline" value={sortBy} onValueChange={(v) => {
                if (!v) return
                setReordered(true)
                setSortBy(v as "score" | "games")
              }}>
              <ToggleGroupItem value="score" className="h-7 px-2 text-xs">依貢獻</ToggleGroupItem>
              <ToggleGroupItem value="games" className="h-7 px-2 text-xs">依場次</ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup type="single" size="sm" variant="outline" value={onlyClear ? "clear" : "all"} onValueChange={(v) => {
                if (!v) return
                setReordered(true)
                setListMinH(v === "clear" ? listRef.current?.offsetHeight : undefined)
                setOnlyClear(v === "clear")
              }}>
              <ToggleGroupItem value="all" className="h-7 px-2 text-xs">全部</ToggleGroupItem>
              <ToggleGroupItem value="clear" className="h-7 px-2 text-xs">只看看得出的</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <div ref={listRef} style={{ minHeight: onlyClear ? listMinH : undefined }}>
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
              <span className="text-center">表現分（中線＝50）</span>
              <span />
              <span>判定</span>
            </div>
            {champRows.map((j, i) => {
              const open = openChamp === j.label
              return (
                <Fragment key={j.key}>
                  <ExpandRow
                    open={open}
                    onToggle={() => setOpenChamp(open ? null : j.label)}
                    label={j.label}
                    rowKey={j.label}
                    style={{ "--stagger": `${Math.min(i * 30, 400)}ms` } as CSSProperties}
                    className={cn(!reordered && "slide-in", "grid items-center gap-3 rounded-md px-2 py-1.5", champCols)}
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
                    <ForestTrack
                      diff={j.g?.interval ? j.g.diff : null}
                      interval={j.g?.interval ?? null}
                      clear={!!j.g?.clear}
                      reach={champReach}
                      empty={`不到 ${MIN_N} 場`}
                    />
                    <span className={cn("text-right font-mono text-[13px] font-semibold tabular-nums", j.g?.interval ? NUM_CLASS[j.strength] : "text-muted-foreground")}>
                      {j.score === null ? "—" : Math.round(j.score)}
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
        </div>
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
                <span className="text-right text-[12px]">{r.perf === null ? "" : <ContribScore dev={r.perf} gap={PERF_GAP} />}</span>
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
    "選一隻英雄，看每個人玩它的戰績，點一個人展開他玩這隻英雄的每一場。「勝率」是和他自己整體勝率的差距（依場次收縮後），戰績條的刻度也是他自己的整體勝率；「貢獻」是這幾場的表現分（50＝同類型的中位數）",
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

// ── 數據總表：每個人的各項平均，分成幾組切換 ─────────────────────────────────
// 都是「每場先算再平均」的語意層度量；比人時要記得出裝比例不同（射手天生打塔快、坦克天生承傷多），所以最後一組是出裝比例。
// 對小兵傷害對局資料沒有，用「總輸出 − 對英雄 − 對建築」估計；死亡時間只有賽後統計有（2026-10-03 起）。
type StatCol = { key: string; label: string; fmt: (v: number) => string; hint: string; lower?: boolean }
const int = (v: number) => Math.round(v).toLocaleString()
const pctFmt = (v: number) => `${v.toFixed(1)}%`
const mmssFmt = (v: number) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`
const STAT_SETS: { id: string; label: string; caption: string; cols: StatCol[] }[] = [
  {
    id: "dmg",
    label: "輸出",
    caption: "對英雄的傷害。傷害占全隊是零和的（五個人加起來 100%），和強的朋友同隊會被分走",
    cols: [
      { key: "participants.avg_damage", label: "平均對英雄傷害", fmt: int, hint: "每場平均對英雄造成的傷害" },
      { key: "participants.dpm", label: "每分鐘對英雄傷害", fmt: int, hint: "每場對英雄傷害除以對局分鐘數再平均" },
      { key: "participants.damage_share", label: "傷害占全隊", fmt: pctFmt, hint: "對英雄傷害占我方全隊的比例" },
      { key: "participants.damage_per_gold", label: "每塊錢傷害", fmt: (v) => v.toFixed(2), hint: "對英雄傷害除以獲得金錢：錢有沒有換成輸出" },
      { key: "participants.champion_damage_focus", label: "打在英雄上的比例", fmt: pctFmt, hint: "總輸出裡有多少打在英雄身上，偏低代表花很多時間在清兵、打塔" },
    ],
  },
  {
    id: "tank",
    label: "承傷與存活",
    caption: "承受傷害高不一定是壞事：前排本來就要吃傷害，要和死亡一起看",
    cols: [
      { key: "participants.avg_taken", label: "平均承受傷害", fmt: int, hint: "每場平均承受的總傷害" },
      { key: "participants.taken_per_min", label: "每分鐘承受傷害", fmt: int, hint: "每場承受傷害除以對局分鐘數再平均" },
      { key: "participants.tank_share", label: "承傷占全隊", fmt: pctFmt, hint: "承受傷害占我方全隊的比例" },
      { key: "participants.mitigated_per_min", label: "每分鐘減免傷害", fmt: int, hint: "護甲、魔抗、護盾等擋掉的傷害，每分鐘" },
      { key: "participants.avg_deaths", label: "平均死亡", fmt: (v) => v.toFixed(1), hint: "每場平均死亡次數（越少越好）", lower: true },
      { key: "participants.avg_time_dead", label: "平均死亡時間", fmt: mmssFmt, hint: "每場在死亡倒數裡的總時間（越少越好）。對局資料沒有，只算有賽後統計的場次（2026-10-03 起、採集器有抓到賽後畫面的）", lower: true },
      { key: "participants.time_dead_share", label: "死亡時間占全場", fmt: pctFmt, hint: "死亡總時間占全場時間的比例（越少越好），同樣只算有賽後統計的場次", lower: true },
    ],
  },
  {
    id: "fight",
    label: "團戰",
    caption: "參與擊殺、控場與治療：輔助、坦克的貢獻多半在這裡",
    cols: [
      { key: "participants.kda", label: "KDA", fmt: (v) => v.toFixed(2), hint: "(擊殺＋助攻) ÷ 死亡" },
      { key: "participants.avg_kills", label: "平均擊殺", fmt: (v) => v.toFixed(1), hint: "每場平均擊殺" },
      { key: "participants.avg_assists", label: "平均助攻", fmt: (v) => v.toFixed(1), hint: "每場平均助攻" },
      { key: "participants.kill_participation", label: "參團率", fmt: pctFmt, hint: "(擊殺＋助攻) ÷ 隊伍擊殺" },
      { key: "participants.cc_time_per_min", label: "每分鐘控場", fmt: (v) => `${v.toFixed(1)} 秒`, hint: "每分鐘控制敵人的時間" },
      { key: "participants.heal_per_min", label: "每分鐘治療", fmt: int, hint: "每分鐘治療量（含自補）" },
      { key: "participants.multikill_rate", label: "多殺場次率", fmt: pctFmt, hint: "有雙殺以上的場次比例" },
    ],
  },
  {
    id: "push",
    label: "推進與資源",
    caption: "大亂鬥是團戰贏了之後推塔決勝，拆塔是把優勢換成勝利的那一步。射手天生打塔快，比人時看「出裝比例」那組",
    cols: [
      { key: "participants.objective_damage_share", label: "建築傷害占全隊", fmt: pctFmt, hint: "對建築的傷害佔我方全隊的比例，每場先算再平均。最能看出「隊上誰在拆塔」" },
      { key: "participants.avg_objective_damage", label: "平均對塔傷害", fmt: int, hint: "每場平均對防禦塔、兵營、主堡的傷害" },
      { key: "participants.avg_turret_kills", label: "每場推塔", fmt: (v) => v.toFixed(2), hint: "每場親手摧毀（最後一擊）的防禦塔數" },
      { key: "participants.total_turret_kills", label: "推塔總數", fmt: int, hint: "範圍內親手摧毀的防禦塔總數（場次多的人自然多）" },
      { key: "participants.avg_inhibitor_kills", label: "每場兵營", fmt: (v) => v.toFixed(2), hint: "每場親手摧毀的兵營數" },
      { key: "participants.avg_minion_damage", label: "平均小兵傷害", fmt: int, hint: "估計值：總輸出 − 對英雄傷害 − 對建築傷害（大亂鬥沒有野怪，剩下的幾乎都是小兵）" },
      { key: "participants.cs_per_min", label: "每分鐘補兵", fmt: (v) => v.toFixed(1), hint: "每分鐘擊殺的小兵數" },
      { key: "participants.gpm", label: "每分鐘經濟", fmt: int, hint: "每分鐘獲得的金錢" },
      { key: "participants.gold_share", label: "經濟占全隊", fmt: pctFmt, hint: "獲得金錢占我方全隊的比例" },
    ],
  },
]
const STAT_MEASURES_ALL = ["participants.games", "participants.time_dead_games", ...STAT_SETS.flatMap((g) => g.cols.map((c) => c.key))]

function StatsPanel({
  people,
  rows,
  loading,
  profiles,
}: {
  people: Player[]
  rows: CubeRow[]
  loading: boolean
  profiles: Map<string, Profile>
}) {
  const [setId, setSetId] = useState<string>("dmg")
  // 點一格：下面列出算進這格的每一場（出裝比例那組只列那種出裝／那種傷害類型的場次）
  const [drill, setDrill] = useState<{ puuid: string; key: string; label: string } | null>(null)
  const [sortKey, setSortKey] = useState<string>("participants.avg_damage")
  const isMix = setId === "mix"
  const set = STAT_SETS.find((g) => g.id === setId)
  // 出裝比例那組：六種出裝各占幾成（AD／AP 寫在玩家類型裡，這裡不另列）
  const mixCols: StatCol[] = BUILD_ROLES.map((r) => ({ key: `mix:${r}`, label: r, fmt: (v: number) => `${Math.round(v * 100)}%`, hint: `出裝是${r}的場次比例` }))
  const cols = isMix ? mixCols : (set?.cols ?? [])
  const rowOf = (puuid: string) => rows.find((r) => r["participants.puuid"] === puuid)
  const valueOf = (puuid: string, key: string): number | null => {
    if (key.startsWith("mix:")) return profiles.get(puuid)?.style.mix.find((m) => m.label === key.slice(4))?.share ?? 0
    return opt(rowOf(puuid), key)
  }
  const activeSort = cols.some((c) => c.key === sortKey) ? sortKey : cols[0]?.key
  const lowerSort = cols.find((c) => c.key === activeSort)?.lower
  const sorted = [...people].sort((a, b) => {
    const va = valueOf(a.puuid, activeSort)
    const vb = valueOf(b.puuid, activeSort)
    if (va === null || vb === null) return va === null ? (vb === null ? 0 : 1) : -1
    return lowerSort ? va - vb : vb - va
  })
  // 每欄最好的人標綠；死亡類越少越好。出裝比例不是好壞，不標
  const best = new Map(
    cols.map((c) => {
      const vals = people.map((p) => valueOf(p.puuid, c.key)).filter((v): v is number => v !== null)
      return [c.key, isMix || !vals.length ? null : c.lower ? Math.min(...vals) : Math.max(...vals)]
    }),
  )
  return (
    <Panel
      title="數據總表"
      caption="每個人的各項平均（每場先算再平均）。切換上方的分組看不同面向；點欄位標題換排序，點數字看算進去的每一場；每欄最好的人標綠（死亡類是越少越好）。比人時記得出裝不同：射手天生打塔快、坦克天生承傷多，可以對照「出裝比例」"
    >
      {loading ? (
        <Skeleton className="h-[300px] w-full" />
      ) : (
        <div className="reveal space-y-2">
          <ToggleGroup type="single" size="sm" variant="outline" value={setId} onValueChange={(v) => v && setSetId(v)} className="flex-wrap">
            {STAT_SETS.map((g) => (
              <ToggleGroupItem key={g.id} value={g.id}>
                {g.label}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="mix">出裝比例</ToggleGroupItem>
          </ToggleGroup>
          <p className="text-[11px] text-muted-foreground">
            {isMix ? "六種出裝各占他場次的幾成。不是好壞，是拿來對照其他數字的；點數字看那種出裝的每一場" : set?.caption}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm" data-testid="crew-stats">
              <thead>
                <tr className="border-b text-[11px] text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">玩家</th>
                  <th className="px-2 py-1.5 text-right font-medium">場次</th>
                  {cols.map((c) => (
                    <th key={c.key} className="px-2 py-1.5 text-right font-medium" title={c.hint}>
                      <button
                        type="button"
                        onClick={() => setSortKey(c.key)}
                        className={cn("cursor-pointer underline-offset-2 hover:text-foreground hover:underline", activeSort === c.key && "text-foreground underline")}
                      >
                        {c.label}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((p) => {
                  const r = rowOf(p.puuid)
                  return (
                    <tr key={p.puuid} className="border-b border-border/50 last:border-b-0" data-testid="crew-stats-row">
                      <td className="px-2 py-1.5">
                        <PlayerName player={p} className="text-sm" />
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums text-muted-foreground">{n0(r, "participants.games")}</td>
                      {cols.map((c) => {
                        const v = valueOf(p.puuid, c.key)
                        return (
                          <td
                            key={c.key}
                            data-key={c.key}
                            className={cn(
                              "px-2 py-1.5 text-right font-mono tabular-nums",
                              v !== null && v === best.get(c.key) && "font-semibold text-win",
                              drill?.puuid === p.puuid && drill.key === c.key && "bg-primary/10",
                            )}
                          >
                            {v === null ? (
                              "—"
                            ) : (
                              <button
                                type="button"
                                title={`看${splitId(p.riot_id, p.puuid).name}算進「${c.label}」的每一場`}
                                onClick={() =>
                                  setDrill((cur) => (cur?.puuid === p.puuid && cur.key === c.key ? null : { puuid: p.puuid, key: c.key, label: c.label }))
                                }
                                className="cursor-pointer rounded px-0.5 underline-offset-2 transition hover:bg-accent hover:underline"
                              >
                                {c.fmt(v)}
                              </button>
                            )}
                            {(c.key === "participants.avg_time_dead" || c.key === "participants.time_dead_share") && v !== null && (
                              <span className="ml-1 text-[10px] font-normal text-muted-foreground">{n0(r, "participants.time_dead_games")} 場</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {drill && (
            <div className="space-y-2 border-t pt-3" data-testid="crew-stats-drill">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="text-sm font-semibold">
                  {splitId(people.find((x) => x.puuid === drill.puuid)?.riot_id ?? "", drill.puuid).name}・{drill.label}的每一場
                </div>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDrill(null)}>
                  收起
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {drill.key.startsWith("mix:")
                  ? `出裝是${drill.key.slice(4)}的場次`
                  : drill.key.includes("time_dead")
                    ? "這一欄只算有賽後統計的場次；下面列出範圍內全部的場次，舊場次沒有死亡時間"
                    : "這一欄是下面這些場次的平均"}
              </p>
              <PlayerMatches
                key={`${drill.puuid}|${drill.key}`}
                puuid={drill.puuid}
                filters={drill.key.startsWith("mix:") ? [{ member: "builds.build_role", operator: "equals", values: [drill.key.slice(4)] }] : []}
              />
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

export function Crew() {
  const { players, apply } = useFilters()
  const crew = useMemo(() => players.filter((p) => p.crew), [players])
  // 預設全部人都比；點名字可以拿掉（至少留一個）
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const chosen = crew.filter((p) => !excluded.has(p.puuid))
  const puuids = chosen.map((p) => p.puuid)
  const [focus, setFocus] = useState<{ puuid: string; role: string | null; tab: DrawerTab; champ?: string } | null>(null)

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
    q({ measures: [...STAT_MEASURES, "participants.kda", ...PERF_PARTS.map((c) => c.key)], dimensions: ["participants.puuid"], limit: NO_LIMIT }),
  )
  const roles = useCube(q({ measures: STAT_MEASURES, dimensions: ["participants.puuid", "builds.build_role"], limit: NO_LIMIT }))
  const champs = useCube(
    q({ measures: STAT_MEASURES, dimensions: ["participants.puuid", "champions.name", "champions.icon_path"], limit: NO_LIMIT }),
  )
  // 增幅是一場多列的維度：查 winrate 會讓 Cube 走「撈主鍵再 join 回來」的慢路徑（實測 2.0 秒，不查 0.5 秒），
  // 所以只查 games 與 wins，勝率由 LookupPanel 自己除（定義就是 100 × wins / games）
  const augments = useCube(
    q({
      measures: ["participants.games", "participants.wins", "participants.losses", "contribution.perf"],
      dimensions: ["participants.puuid", "augments.name", "augments.icon_path"],
      limit: NO_LIMIT,
    }),
  )
  const stats = useCube(q({ measures: STAT_MEASURES_ALL, dimensions: ["participants.puuid"], limit: NO_LIMIT }))
  // 出裝的傷害類型（AD／AP）：玩家類型與數據總表的出裝比例用
  const dmgTypes = useCube(q({ measures: ["participants.games"], dimensions: ["participants.puuid", "builds.damage_type"], limit: NO_LIMIT }))
  // 參照列：所有參賽者的出裝比例（不鎖玩家，也不受上方「拿掉誰」影響）
  const everyone = useCube(apply({ measures: ["participants.games", "participants.winrate", "participants.kda"] }, "all"))
  const everyoneRoles = useCube(apply({ measures: ["participants.games"], dimensions: ["builds.build_role"], limit: NO_LIMIT }, "all"))
  const error = summary.error ?? roles.error ?? champs.error ?? augments.error ?? everyone.error ?? everyoneRoles.error ?? stats.error ?? dmgTypes.error
  const loading = summary.loading || roles.loading || champs.loading || augments.loading || everyone.loading || everyoneRoles.loading

  const sumOf = (puuid: string) => summary.rows.find((r) => r["participants.puuid"] === puuid)
  const gamesOf = (puuid: string) => n0(sumOf(puuid), "participants.games")
  const wrOf = (puuid: string) => opt(sumOf(puuid), "participants.winrate")

  // 每個人的判斷一次算好：一覽表、抽屜都用同一份
  const profiles = useMemo(() => {
    const out = new Map<string, Profile>()
    // 一般玩家（資料庫裡所有參賽者）的出裝比例，拿來對照「他比一般人多玩什麼」
    const baseTotal = everyoneRoles.rows.reduce((a, r) => a + n0(r, "participants.games"), 0)
    const base = new Map(everyoneRoles.rows.map((r) => [String(r["builds.build_role"]), baseTotal ? n0(r, "participants.games") / baseTotal : 0]))
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
      const dmgOf = (t: string) => n0(dmgTypes.rows.find((r) => r["participants.puuid"] === p.puuid && r["builds.damage_type"] === t), "participants.games")
      const style = playStyleOf(roleJ.items, champJ.items, s, base, overallStat.scored, { ad: dmgOf("AD"), ap: dmgOf("AP") })
      out.set(p.puuid, { overall, overallWr, roles: roleJ.items, roleK: roleJ.k, champs: champJ.items, champK: champJ.k, style })
    }
    return out
  }, [crew, summary.rows, roles.rows, champs.rows, everyoneRoles.rows, dmgTypes.rows])

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

  const open = (puuid: string, role: string | null, tab: DrawerTab, champ?: string) => setFocus({ puuid, role, tab, champ })

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
        caption="判定看當局表現分（50＝同類型的中位數，坦克、輔助和輸出位同一把尺）的誤差範圍：整段高於 50 是強勢、整段低於 50 是不強勢，還在誤差內的寫偏強／偏弱（虛線框）。雷達是各出裝佔他場次的比例。前面的數字是名次，看得出的排前面；滑過看數字，點一列看完整分析"
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
                    表現分依定義是 50（同類型的中位數），勝率每場兩隊都算，必然是 50%。
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
                          表現分{" "}
                          <span className={cn("font-mono font-semibold", ov.g?.interval ? NUM_CLASS[ov.strength] : "text-muted-foreground")}>
                            {ov.score === null ? "—" : Math.round(ov.score)}
                          </span>
                          {ov.g?.interval && (
                            <span className={cn("ml-1 rounded border px-1 text-[10px]", STRENGTH_CLASS[ov.strength])}>{shownOf(ov.strength)}</span>
                          )}
                        </span>
                        <span className="block truncate text-[11px]" title={prof.style.archetypeNote ?? undefined} data-testid="crew-style-line">
                          {styleLine(prof.style)}
                        </span>
                      </span>
                      <MiniHex data={prof.roles.map((j) => ({ label: j.label, games: j.games, strength: j.strength }))} total={ov.games} />
                      <span className="grid grid-cols-2 items-center gap-3">
                        <RoleChips items={sideOf(prof.roles, "pos")} ownWr={ownWr} />
                        <RoleChips items={sideOf(prof.roles, "neg")} ownWr={ownWr} />
                      </span>
                      <span className="grid grid-cols-2 items-center gap-3">
                        <ChampSide items={sideOf(prof.champs, "pos")} ownWr={ownWr} onPick={(label) => open(p.puuid, null, "picks", label)} />
                        <ChampSide items={sideOf(prof.champs, "neg")} ownWr={ownWr} onPick={(label) => open(p.puuid, null, "picks", label)} />
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <HowWeJudge>
              <p>
                當局表現分：輸出（每條命的對英雄傷害）、承傷（每條命扛下的傷害）、清兵、推塔、控場（有治療或護盾隊友時再加治療護盾），各自和同類型（出裝定位 × 英雄官方主定位）、同時長帶的人比成百分位；輸出、承傷除以死亡＋1，送頭換來的數字不加分，
                再依出裝定位加權；50 是同類型的中位數。輸出位重輸出與推塔；坦克、輔助先算本職（坦克：承傷、控場、推塔、清兵；輔助：控場、治療護盾、推塔、清兵），拉成同一把尺後，輸出（輔助另加承傷）超過同類型中位數的部分再額外加分、低於不扣——坦克、輔助打出好輸出會往上跳。
                不用擊殺、金錢、勝負計算；也不看隊友分走多少（以前用的「隊內排名」是零和的，和強的朋友同隊就會被壓低）。
              </p>
              <p>
                每一項都算誤差範圍（95%；單場的分數起伏大，標準差約 19，場次越多範圍越窄）。範圍整段高於 50 才寫「強勢」、整段低於 50 才寫「不強勢」；
                差 {PERF_GAP} 分以上但範圍還跨過 50 寫「偏強／偏弱」；其餘是「普通」（和同類型差不多）；不到 {MIN_N} 場寫「場次不夠」。同一個人同時比好幾種出裝或好幾隻英雄，範圍會再放寬——
                一次比二十隻，總有一兩隻看起來特別好或特別差只是運氣。
              </p>
              <p>
                勝率只當補充：和他自己的整體勝率比，範圍也整段在一邊寫「勝率明顯高／低」，差 15 個百分點以上但還在誤差內寫「勝率偏高／偏低」；表現比同類型好（強勢或偏強）、勝率卻比他平常低 {WR_LUCK} 個百分點以上（至少 {LUCK_MIN} 場）是「非戰之罪」：輸多半不是他的問題；反過來表現差、勝率卻高是「靠隊友」。
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

      <StatsPanel people={ordered} rows={stats.rows} loading={loading || stats.loading} profiles={profiles} />

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
            jumpChamp={focus.champ}
            crewFilter={crewFilter}
          />
        )}
      </DetailDrawer>
    </div>
  )
}
