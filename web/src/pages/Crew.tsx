import { Fragment, useMemo, useState, type CSSProperties } from "react"
import { ArrowRight, Check, ChevronDown, ChevronsUpDown, Search } from "lucide-react"
import { RecordCell } from "@/components/cells"
import { ContribBars, ContribScore } from "@/components/Contribution"
import { CONTRIB_GAP, CONTRIB_MEASURES, CONTRIB_PARTS } from "@/hooks/useContribution"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, Panel, QueryError } from "@/components/primitives"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ContribRadarChart, RadarChart, SHRINK_K, shrunk, type RadarDatum } from "@/components/charts"
import { DetailDrawer, useDrawerSettled } from "@/components/DetailDrawer"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, iconUrl, num, type CubeFilter, type CubeQuery, type CubeRow } from "@/lib/cube"
import { MatchList } from "@/components/MatchList"
import { useFilters, type Player } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { useNavigate } from "@/lib/nav"
import { cn } from "@/lib/utils"
import { BUILD_ROLES, BUILD_SHORT, MIN_GAMES, NO_LIMIT, round0, splitRiotId } from "./shared"

// ── 「適合／不適合」的判斷：貢獻為主、勝率為輔 ─────────────────────────
// 貢獻：語意層的 contribution.score（隊內貢獻排名，占全隊的比例，不含當局表現分——表現分和勝負相關，不能拿來判斷「運氣」）——輸出、承傷、存活、參團、控場（有治療或護盾隊友時再加治療護盾），各自和「同類型」
//       （出裝定位 × 英雄官方主定位）的人比成名次百分位，再依出裝定位加權、同類型內再排一次名。50＝同類型的中位數。
//       分數不用擊殺、金錢、勝負當輸入，所以不受輸贏影響：只看勝率不公平，大亂鬥的勝負很大一部分是隊友與陣容
//       （前三場團戰的贏家只有 54% 會贏）。這裡用「分數 − 50」，依場次往 0 收縮；單場標準差約 29，門檻見 CONTRIB_GAP。
// 勝率：和這個人「自己的」整體勝率比（每個人本來水準不同），依場次往他的平均收縮後的差距。
// 強判斷（適合／不適合）一定要貢獻達標，勝率只能讓它降級或補充說明：
//   貢獻好 → 適合（勝率明顯差時改成「非戰之罪」）；貢獻差 → 不適合（勝率明顯好時改成「靠隊友」）；
//   貢獻普通 → 只看勝率給次級標籤。
// 門檻跟著目前的篩選即時算，所以留在前端；分數的定義在語意層（cube/model/cubes/contribution.yml）。
const ROLE_MIN = MIN_GAMES
const CHAMP_MIN = 3
const WR_GAP_ROLE = 3
const WR_GAP_CHAMP = 5
const PICKS_SHOWN = 3

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

type Verdict = "good" | "unlucky" | "winning" | "bad" | "lucky" | "losing"

const VERDICT: Record<Verdict, { label: string; side: "pos" | "neg"; strong: boolean; hint: string }> = {
  good: { label: "適合", side: "pos", strong: true, hint: "貢獻比同類型的中位數高，勝率也沒有比平常差" },
  unlucky: { label: "非戰之罪", side: "pos", strong: false, hint: "貢獻比同類型的中位數高，但勝率比平常低——輸多半不是他的問題" },
  winning: { label: "勝率好", side: "pos", strong: false, hint: "勝率比平常高，貢獻和同類型差不多" },
  bad: { label: "不適合", side: "neg", strong: true, hint: "貢獻比同類型的中位數低，勝率也沒有比平常好" },
  lucky: { label: "靠隊友", side: "neg", strong: false, hint: "勝率比平常高，但貢獻比同類型的中位數低——贏多半是隊友或陣容" },
  losing: { label: "勝率差", side: "neg", strong: false, hint: "勝率比平常低，貢獻和同類型差不多" },
}
const ORDER: Verdict[] = ["good", "unlucky", "winning", "bad", "lucky", "losing"]

function judge(wr: number, contrib: number, wrGap: number): Verdict | null {
  const wrUp = wr >= wrGap
  const wrDown = wr <= -wrGap
  if (contrib >= CONTRIB_GAP) return wrDown ? "unlucky" : "good"
  if (contrib <= -CONTRIB_GAP) return wrUp ? "lucky" : "bad"
  if (wrUp) return "winning"
  if (wrDown) return "losing"
  return null
}

type Item = { label: string; icon?: string; games: number; wins: number; winrate: number | null; perf: number | null }
type Pick = Item & { wr: number; perfAdj: number; verdict: Verdict }
type Call = { pos: Pick[]; neg: Pick[]; all: Pick[] }

/** 依勝率差與貢獻分數把一組（出裝定位或英雄）分成正面／負面兩邊 */
function classify(items: Item[], base: number | null, minGames: number, wrGap: number, limit = PICKS_SHOWN): Call {
  if (base === null) return { pos: [], neg: [], all: [] }
  const all = items
    .filter((i) => i.games >= minGames)
    .map((i) => {
      const wr = shrunk(i.games, i.winrate, base) - base
      const perfAdj = i.perf === null ? 0 : (i.games * i.perf) / (i.games + SHRINK_K)
      return { ...i, wr, perfAdj, verdict: judge(wr, perfAdj, wrGap) }
    })
    .filter((i): i is Pick => i.verdict !== null)
  // 強的判斷在前，同一級依「勝率差＋貢獻」的絕對值排，並列依名稱
  const rank = (a: Pick, b: Pick) =>
    ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) ||
    Math.abs(b.wr + b.perfAdj) - Math.abs(a.wr + a.perfAdj) ||
    b.games - a.games ||
    a.label.localeCompare(b.label, "zh-Hant")
  const sorted = [...all].sort(rank)
  return {
    pos: sorted.filter((i) => VERDICT[i.verdict].side === "pos").slice(0, limit),
    neg: sorted.filter((i) => VERDICT[i.verdict].side === "neg").slice(0, limit),
    all,
  }
}

const tip = (i: Pick) =>
  `${i.label}・${VERDICT[i.verdict].label}（${VERDICT[i.verdict].hint}）\n` +
  `${i.games} 場・${i.wins} 勝 ${i.games - i.wins} 敗・勝率 ${i.winrate?.toFixed(1)}%\n` +
  `勝率比他自己平均 ${signed(i.wr)}pp・貢獻比同類型的中位數 ${signed(i.perfAdj, 0)}（隊內貢獻 ${i.perf === null ? "—" : Math.round(50 + i.perf)}，50＝中位數，依場次收縮前）`

function verdictClass(v: Verdict) {
  const { side, strong } = VERDICT[v]
  if (side === "pos") return strong ? "border-win/50 bg-win/15 text-win font-semibold" : "border-dashed border-win/40 text-win"
  return strong ? "border-loss/50 bg-loss/15 text-loss font-semibold" : "border-dashed border-loss/40 text-loss"
}

/** 迷你雷達（出裝定位八個頂點）：形狀是各出裝定位佔他自己場次的比例（偏好怎麼玩），頂點是判斷結果。
 *
 *  一覽表裡每人一個，七個人上下排成一欄就能一眼比形狀。用 SVG 而不是 ECharts：
 *  七個 canvas 實例的成本不值得，這裡也不需要互動。外框是「他自己最常用的那種出裝」，
 *  形狀才撐得開（全員同一把尺時，某人 AD 輸出佔一半，其他人全縮成一團點）。 */
function MiniHex({ data, total, call, size = 96 }: { data: RadarDatum[]; total: number; call: Call; size?: number }) {
  const c = size / 2
  const r = size / 2 - 14 // 留位置給標籤
  const n = data.length
  const at = (i: number, frac: number) => {
    const a = ((90 + (i * 360) / n) * Math.PI) / 180 // 和 ECharts 雷達同方向：正上方開始、逆時針
    return [c + Math.cos(a) * r * frac, c - Math.sin(a) * r * frac] as const
  }
  const ring = (frac: number) => data.map((_, i) => at(i, frac).join(",")).join(" ")
  const verdictOf = new Map(call.all.map((p) => [p.label, p.verdict]))
  const share = data.map((d) => (total ? d.games / total : 0))
  const scaleMax = Math.max(0.01, ...share)
  const tone = (label: string) => {
    const v = verdictOf.get(label)
    if (!v) return "fill-muted-foreground"
    return VERDICT[v].side === "pos" ? "fill-win" : "fill-loss"
  }
  const text = data
    .map((d, i) => `${d.label} ${Math.round(share[i] * 100)}%（${d.games} 場${verdictOf.get(d.label) ? `，${VERDICT[verdictOf.get(d.label)!].label}` : ""}）`)
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
        points={share.map((s, i) => at(i, Math.min(1, s / scaleMax)).join(",")).join(" ")}
        className="fill-data/30 stroke-data"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {data.map((d, i) => {
        const [x, y] = at(i, Math.min(1, share[i] / scaleMax))
        const [lx, ly] = at(i, 1.3)
        const v = verdictOf.get(d.label)
        return (
          <g key={d.label}>
            <circle cx={x} cy={y} r={v && VERDICT[v].strong ? 3.2 : v ? 2.6 : 1.8} className={tone(d.label)} />
            <text
              x={lx}
              y={ly}
              textAnchor="middle"
              dominantBaseline="central"
              className={cn("text-[9px] font-semibold", tone(d.label))}
            >
              {BUILD_SHORT[d.label] ?? d.label.slice(0, 1)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 出裝定位的判斷標籤：「適合 AP 輸出」，實心是強判斷、虛線框是次級 */
function RoleChips({ items }: { items: Pick[] }) {
  if (!items.length) return <span className="text-[11px] text-muted-foreground">—</span>
  return (
    <span className="flex flex-wrap content-start items-start gap-1">
      {items.map((i) => (
        <span key={i.label} title={tip(i)} className={cn("rounded border px-1.5 py-0.5 text-[11px]", verdictClass(i.verdict))}>
          <span className="opacity-80">{VERDICT[i.verdict].label}</span> {i.label}
        </span>
      ))}
    </span>
  )
}

/** 英雄頭像列：外框實線是強判斷、虛線是次級；滑過看戰績、勝率差與貢獻 */
function ChampIcons({ items }: { items: Pick[] }) {
  if (!items.length) return <span className="text-[11px] text-muted-foreground">—</span>
  return (
    <span className="flex gap-1.5">
      {items.map((i) => {
        const pos = VERDICT[i.verdict].side === "pos"
        return (
          <span key={i.label} title={tip(i)} className="relative shrink-0">
            <img
              src={iconUrl(i.icon)}
              alt={i.label}
              className={cn(
                "size-8 rounded-md bg-icon-tile",
                VERDICT[i.verdict].strong ? "ring-2" : "ring-1 opacity-80",
                pos ? "ring-win/80" : "ring-loss/80",
              )}
            />
            <span
              className={cn(
                "absolute -bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-background px-0.5 text-[9px] leading-tight",
                pos ? "text-win" : "text-loss",
              )}
            >
              {VERDICT[i.verdict].label}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/** 抽屜裡的判斷清單：每項一列，判斷＋勝率差＋貢獻 */
function PickList({ title, items, empty }: { title: string; items: Pick[]; empty: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold text-muted-foreground">{title}</div>
      {items.length ? (
        <div className="space-y-1">
          {items.map((i) => (
            <div key={i.label} className="flex items-center gap-2" title={tip(i)}>
              {i.icon && <img src={iconUrl(i.icon)} alt="" className="size-6 shrink-0 rounded bg-icon-tile" />}
              <span className="min-w-0 flex-1 truncate text-[13px]">{i.label}</span>
              <span className={cn("shrink-0 rounded border px-1.5 text-[11px]", verdictClass(i.verdict))}>{VERDICT[i.verdict].label}</span>
              <span className="w-[112px] shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                勝 {signed(i.wr)}・貢 {signed(i.perfAdj, 0)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-muted-foreground">{empty}</div>
      )}
    </div>
  )
}

type Analysis = { radar: RadarDatum[]; roleCall: Call; champCall: Call }

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

/** 抽屜：某個人的完整分析（大雷達圖 + 判斷），以及他（在某種出裝下）玩過的每隻英雄。 */
function PlayerDrawerBody({
  player,
  role,
  overallWr,
  total,
  analysis,
  crewFilter,
  onRole,
}: {
  player: Player
  role: string | null
  overallWr: number | null
  total: number
  analysis: Analysis
  crewFilter: (puuids: string[]) => CubeFilter
  onRole: (role: string | null) => void
}) {
  const { apply, setAccount } = useFilters()
  const go = useNavigate()
  const settled = useDrawerSettled()
  const [radarMode, setRadarMode] = useState<"games" | "winrate">("games")
  // 點英雄列展開那隻英雄的每一場（同時只開一隻，免得抽屜被好幾份列表撐得很長）
  const [openChamp, setOpenChamp] = useState<string | null>(null)
  useCrumb(20, openChamp ? `${openChamp}的每一場` : null, () => setOpenChamp(null))
  const roleFilter = role ? [{ member: "builds.build_role", operator: "equals" as const, values: [role] }] : []
  const contrib = useCube(
    apply({ measures: CONTRIB_MEASURES, filters: [crewFilter([player.puuid]), ...roleFilter], limit: 1 }, "all"),
  )
  const champs = useCube(
    apply(
      {
        measures: ["participants.games", "participants.wins", "participants.losses", "participants.winrate", "contribution.score"],
        dimensions: ["champions.name", "champions.icon_path"],
        filters: [crewFilter([player.puuid]), ...roleFilter],
        order: { "participants.games": "desc" },
        limit: NO_LIMIT,
      },
      "all",
    ),
  )

  return (
    <>
      <div className="flex justify-end">
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
      <div className="grid gap-4 rounded-lg border p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-semibold">出裝定位</div>
            {/* 和英雄頁、儀表板同一種雷達：預設形狀是場次，可切成勝率 */}
            <ToggleGroup type="single" size="sm" variant="outline" value={radarMode} onValueChange={(v) => v && setRadarMode(v as "games" | "winrate")}>
              <ToggleGroupItem value="games" className="h-7 px-2 text-xs">形狀：場次</ToggleGroupItem>
              <ToggleGroupItem value="winrate" className="h-7 px-2 text-xs">形狀：勝率</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {radarMode === "games"
              ? "形狀是場次；頂點下是勝率與場次，比他自己的整體勝率明顯高／低才上色"
              : `形狀是勝率（外框 100%）；虛線圈是他自己的整體勝率 ${overallWr?.toFixed(1) ?? "—"}%`}
            。點某一類的方向，下面只列那種出裝的英雄
          </div>
          {settled ? (
            <RadarChart
              data={analysis.radar}
              mode={radarMode}
              baseline={overallWr}
              total={total}
              height={280}
              selected={role}
              onPick={(r) => onRole(role === r ? null : r)}
            />
          ) : (
            <div className="h-[280px]" />
          )}
        </div>
        <div className="grid content-start gap-4">
          <PickList title="出裝定位：好的一面" items={analysis.roleCall.pos} empty="沒有明顯比平常好的定位" />
          <PickList title="出裝定位：要注意的" items={analysis.roleCall.neg} empty="沒有明顯比平常差的定位" />
          <PickList title="英雄：好的一面" items={analysis.champCall.pos} empty={`還沒有英雄在 ${CHAMP_MIN} 場以上明顯比平常好`} />
          <PickList title="英雄：要注意的" items={analysis.champCall.neg} empty={`還沒有英雄在 ${CHAMP_MIN} 場以上明顯比平常差`} />
          <p className="text-[11px] text-muted-foreground">
            「勝」是勝率比他自己平均高幾個百分點；「貢」是隊內貢獻比同類型的中位數（50）高多少。都已依場次收縮。
            適合／不適合看的是貢獻，勝率只用來補充：貢獻好但勝率差是「非戰之罪」，貢獻差但勝率好是「靠隊友」
          </p>
        </div>
      </div>

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
          每一項都和「同類型」（出裝定位 × 英雄官方主定位）的人比，換成名次百分位：50＝同類型的中位數，
          雷達裡的虛線圈與橫條中間的刻度就是 50。分數不用擊殺、金錢、勝負當輸入，所以不受輸贏影響，看的是他自己做得比同類型多還是少。
          隊內貢獻依出裝定位加權：坦克重承傷、參團與控場，輸出位重輸出與存活，輔助重參團與控場；有治療或護盾隊友的場次再加「治療護盾」（沒有就不算、也不扣分）。
          治療與護盾隊友的量只有開始擷取賽後統計之後的場次才有，舊場次只看得到含自補的治療量，護盾型英雄在舊場次只做到不扣分
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

      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">{role ? `出裝是${role}時玩過的英雄` : "玩過的每隻英雄"}</div>
        {role && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onRole(null)}>
            看全部出裝
          </Button>
        )}
      </div>
      {!settled || champs.loading ? (
        <Skeleton className="h-[320px] w-full" />
      ) : champs.error ? (
        <div className="text-sm text-destructive">{champs.error}</div>
      ) : !champs.rows.length ? (
        <EmptyState>這個條件下沒有對局。</EmptyState>
      ) : (
        <div className="space-y-1">
          <div className="grid grid-cols-[minmax(0,1fr)_4rem_minmax(9rem,13rem)_4.5rem] gap-3 px-2 text-[11px] text-muted-foreground">
            <span>英雄（點一列看每一場）</span>
            <span>場次</span>
            <span>戰績（刻度＝他自己的整體勝率）</span>
            <span className="text-right">貢獻</span>
          </div>
          {champs.rows.map((r, i) => {
            const perf = opt(r, "participants.games") ? dev(r) : null
            const name = String(r["champions.name"])
            const open = openChamp === name
            return (
              <Fragment key={name}>
              <ExpandRow
                open={open}
                onToggle={() => setOpenChamp(open ? null : name)}
                label={name}
                style={{ "--stagger": `${Math.min(i * 30, 400)}ms` } as CSSProperties}
                className="slide-in grid grid-cols-[minmax(0,1fr)_4rem_minmax(9rem,13rem)_4.5rem] items-center gap-3 rounded-md px-2 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <ChevronDown className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                  <img src={iconUrl(r["champions.icon_path"] as string)} alt="" className="size-8 shrink-0 rounded-md bg-icon-tile" />
                  <span className="truncate text-[13px] font-medium">{name}</span>
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">{n0(r, "participants.games")} 場</span>
                <RecordCell
                  winrate={opt(r, "participants.winrate")}
                  wins={n0(r, "participants.wins")}
                  losses={n0(r, "participants.losses")}
                  baseline={overallWr}
                  baselineLabel="他自己的整體勝率"
                />
                <span title="這幾場的隊內貢獻（50＝同類型的中位數，未收縮）" className="text-right text-[12px]">
                  <ContribScore dev={perf} />
                </span>
              </ExpandRow>
              {open && (
                <div className="reveal mb-2 ml-3 border-l-2 border-primary/40 pl-3">
                  <PlayerMatches
                    puuid={player.puuid}
                    filters={[{ member: "champions.name", operator: "equals", values: [name] }, ...roleFilter]}
                  />
                </div>
              )}
              </Fragment>
            )
          })}
        </div>
      )}
    </>
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
  const [focus, setFocus] = useState<{ puuid: string; role: string | null } | null>(null)

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
    q({
      measures: ["participants.games", "participants.wins", "participants.losses", "participants.winrate", "participants.kda", "contribution.score"],
      dimensions: ["participants.puuid"],
      limit: NO_LIMIT,
    }),
  )
  const roles = useCube(
    q({
      measures: ["participants.games", "participants.wins", "participants.winrate", "contribution.score"],
      dimensions: ["participants.puuid", "builds.build_role"],
      limit: NO_LIMIT,
    }),
  )
  const champs = useCube(
    q({
      measures: ["participants.games", "participants.wins", "participants.losses", "participants.winrate", "contribution.score"],
      dimensions: ["participants.puuid", "champions.name", "champions.icon_path"],
      limit: NO_LIMIT,
    }),
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
  // 參照列：所有參賽者的整體與出裝定位比例（不鎖玩家，也不受上方「拿掉誰」影響）
  const everyone = useCube(apply({ measures: ["participants.games", "participants.winrate", "participants.kda"] }, "all"))
  const everyoneRoles = useCube(
    apply({ measures: ["participants.games", "participants.wins", "participants.winrate"], dimensions: ["builds.build_role"], limit: NO_LIMIT }, "all"),
  )
  const error = summary.error ?? roles.error ?? champs.error ?? augments.error ?? everyone.error ?? everyoneRoles.error
  const loading = summary.loading || roles.loading || champs.loading || augments.loading || everyone.loading || everyoneRoles.loading

  const sumOf = (puuid: string) => summary.rows.find((r) => r["participants.puuid"] === puuid)
  const gamesOf = (puuid: string) => n0(sumOf(puuid), "participants.games")
  const wrOf = (puuid: string) => opt(sumOf(puuid), "participants.winrate")

  // 每個人的分析一次算好：一覽表、抽屜都用同一份
  const analysis = useMemo(() => {
    const out = new Map<string, Analysis>()
    for (const p of crew) {
      const s = summary.rows.find((r) => r["participants.puuid"] === p.puuid)
      const base = opt(s, "participants.winrate")
      const roleRows = BUILD_ROLES.map((label) => {
        const r = roles.rows.find((x) => x["participants.puuid"] === p.puuid && x["builds.build_role"] === label)
        return {
          label,
          games: n0(r, "participants.games"),
          wins: n0(r, "participants.wins"),
          winrate: opt(r, "participants.winrate"),
          perf: dev(r),
        }
      })
      const mine = champs.rows
        .filter((r) => r["participants.puuid"] === p.puuid)
        .map((r) => ({
          label: String(r["champions.name"]),
          icon: r["champions.icon_path"] as string,
          games: n0(r, "participants.games"),
          wins: n0(r, "participants.wins"),
          winrate: opt(r, "participants.winrate"),
          perf: dev(r),
        }))
      out.set(p.puuid, {
        radar: roleRows.map(({ label, games, wins, winrate }) => ({ label, games, wins, winrate })),
        roleCall: classify(roleRows, base, ROLE_MIN, WR_GAP_ROLE),
        champCall: classify(mine, base, CHAMP_MIN, WR_GAP_CHAMP),
      })
    }
    return out
  }, [crew, summary.rows, roles.rows, champs.rows])

  // 依場次排：場次多的人判斷比較可信，放前面
  const ordered = [...chosen].sort((a, b) => gamesOf(b.puuid) - gamesOf(a.puuid))

  if (!players.length) return <Skeleton className="h-[420px] w-full" />
  if (crew.length < 2) {
    return (
      <EmptyState>
        還沒有可以比較的好友。到「追蹤對象」加入一起打的朋友，他們的戰績被採集進來之後就會出現在這裡。
      </EmptyState>
    )
  }

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

      {/* ── 全員一覽：每人一列，迷你雷達 + 判斷 ── */}
      <Panel
        title="全員一覽"
        caption={`定位依「終場出裝」判斷（AD 輸出、AD 刺客、AP 輸出、AP 刺客、坦克、AD 鬥士、AP 鬥士、輔助）：AD 刺客是穿甲裝為主，AP 刺客是 AP 輸出裝配上官方定位為刺客的英雄，其餘不看官方定位。雷達是各出裝佔他場次的比例（最常用的頂到外框）。判斷以「貢獻」為主：輸出、承傷、存活、參團、控場（有治療或護盾隊友時再加治療護盾）各自和同類型（出裝定位 × 英雄官方主定位）的人比（不受輸贏影響），依出裝定位加權成隊內貢獻（同類型的中位數＝50）；收縮後高或低 ${CONTRIB_GAP} 分以上才算數。貢獻好是「適合」、差是「不適合」；勝率（和他自己平均比，出裝 ${WR_GAP_ROLE}pp、英雄 ${WR_GAP_CHAMP}pp）只做補充——貢獻好但勝率差是「非戰之罪」、貢獻差但勝率好是「靠隊友」、貢獻普通時才單看勝率（虛線框）。滑過看數字；點一列看完整分析`}
      >
        {loading ? (
          <Skeleton className="h-[640px] w-full" />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[1040px]">
              <div className="grid grid-cols-[13rem_6rem_minmax(0,1fr)_minmax(0,1fr)] items-end gap-4 border-b px-2 pb-1.5 text-[11px] text-muted-foreground">
                <span>玩家</span>
                <span className="text-center">出裝定位</span>
                <span className="grid grid-cols-2 gap-3">
                  <span className="text-win">出裝：好的一面</span>
                  <span className="text-loss">出裝：要注意的</span>
                </span>
                <span className="grid grid-cols-2 gap-3">
                  <span className="text-win">英雄：好的一面</span>
                  <span className="text-loss">英雄：要注意的</span>
                </span>
              </div>
              <div
                data-testid="crew-reference-row"
                className="grid w-full grid-cols-[13rem_6rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 border-b border-dashed bg-muted/20 px-2 py-1"
              >
                <span className="min-w-0">
                  <span className="flex items-baseline gap-1.5 text-sm font-medium">
                    全體參賽者
                    <span className="rounded border border-dashed px-1 text-[10px] font-normal text-muted-foreground">參照</span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
                    {n0(everyone.rows[0], "participants.games")} 場・{opt(everyone.rows[0], "participants.winrate")?.toFixed(1) ?? "—"}%・KDA{" "}
                    {opt(everyone.rows[0], "participants.kda")?.toFixed(2) ?? "—"}
                  </span>
                </span>
                <MiniHex
                  data={BUILD_ROLES.map((label) => {
                    const r = everyoneRoles.rows.find((x) => x["builds.build_role"] === label)
                    return { label, games: n0(r, "participants.games"), wins: n0(r, "participants.wins"), winrate: opt(r, "participants.winrate") }
                  })}
                  total={n0(everyone.rows[0], "participants.games")}
                  call={{ pos: [], neg: [], all: [] }}
                />
                <span className="col-span-2 text-[11px] text-muted-foreground">
                  把資料庫裡每場十位參賽者都算進來的平均：雷達是一般玩家各出裝佔多少，拿來和下面每個人的形狀對照他偏好什麼；勝率每場兩隊都算，必然是 50%。
                </span>
              </div>
              {ordered.map((p, i) => {
                const a = analysis.get(p.puuid)
                const base = wrOf(p.puuid)
                const perf = dev(sumOf(p.puuid))
                if (!a) return null
                return (
                  <button
                    key={p.puuid}
                    onClick={() => setFocus({ puuid: p.puuid, role: null })}
                    style={{ "--stagger": `${i * 35}ms` } as CSSProperties}
                    className={cn(
                      "slide-in grid w-full grid-cols-[13rem_6rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-4 rounded-md border-b px-2 py-1 text-left transition hover:bg-accent",
                      focus?.puuid === p.puuid && "bg-primary/10",
                    )}
                  >
                    <span className="min-w-0">
                      <PlayerName player={p} className="text-sm" />
                      <span className="mt-0.5 block font-mono text-[11px] tabular-nums text-muted-foreground">
                        {gamesOf(p.puuid)} 場・
                        <span className={cn(base !== null && base >= 50 ? "text-win" : "text-loss")}>{base?.toFixed(1) ?? "—"}%</span>
                        ・KDA {opt(sumOf(p.puuid), "participants.kda")?.toFixed(2) ?? "—"}
                      </span>
                      <span
                        className="block text-[11px] text-muted-foreground"
                        title="隊內貢獻：輸出、承傷、存活、參團、控場（有治療或護盾隊友時再加治療護盾）各自和同類型的人比，依出裝定位加權。50＝同類型的中位數，不受輸贏影響"
                      >
                        隊內貢獻 <ContribScore dev={perf} className="font-semibold" />
                      </span>
                    </span>
                    <MiniHex data={a.radar} total={gamesOf(p.puuid)} call={a.roleCall} />
                    <span className="grid grid-cols-2 items-center gap-3">
                      <RoleChips items={a.roleCall.pos} />
                      <RoleChips items={a.roleCall.neg} />
                    </span>
                    <span className="grid grid-cols-2 items-center gap-3">
                      <ChampIcons items={a.champCall.pos} />
                      <ChampIcons items={a.champCall.neg} />
                    </span>
                  </button>
                )
              })}
            </div>
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
        {focusPlayer && analysis.get(focusPlayer.puuid) && (
          <PlayerDrawerBody
            key={focusPlayer.puuid}
            player={focusPlayer}
            role={focus?.role ?? null}
            overallWr={wrOf(focusPlayer.puuid)}
            total={gamesOf(focusPlayer.puuid)}
            analysis={analysis.get(focusPlayer.puuid)!}
            crewFilter={crewFilter}
            onRole={(role) => setFocus({ puuid: focusPlayer.puuid, role })}
          />
        )}
      </DetailDrawer>
    </div>
  )
}
