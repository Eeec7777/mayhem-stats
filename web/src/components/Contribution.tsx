import { ChevronDown } from "lucide-react"
import { CONTRIB_GAP, CONTRIB_PARTS, PERF_GAP, PERF_PARTS, WORK_GAP, WORK_PARTS, type ContribTag } from "@/hooks/useContribution"
import { num, type CubeRow } from "@/lib/cube"
import { cn } from "@/lib/utils"

// 貢獻分數的呈現。分數的定義只有一份，在語意層（規格見 docs/contribution-scoring.md）：
//   本場貢獻（work，contribution_v2.yml；計分板大數字、對局卡片、MVP／ACE、好友比較頁）：這場可觀測的工作量，只和同一場另外九個人比，
//     權重依終場裝備的連續比例；50＝v2.0 定版時所有人的平均。沒有賽後統計的場次是暫估。
//   表現（perf，contribution.yml）：舊的當局表現分，和同類型、同時長帶的歷史人次比；英雄頁與好友比較頁的「打法」還在用。
//   隊內（rank，計分板上的小字）：在隊裡扛的份量，占全隊的比例再在同類型內排名；各隊平均都在 50 附近。
// 這裡只負責畫（常數與查詢在 hooks/useContribution.ts）：好友比較頁、單場計分板、對局卡片共用同一套數字與橫條。

/** 貢獻的數字：0～100，50＝中位數；差距不到門檻的用淡色。gap 預設是隊內排名的門檻，表現分傳 PERF_GAP */
export function ContribScore({ dev: d, className, gap = CONTRIB_GAP }: { dev: number | null; className?: string; gap?: number }) {
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        d === null || Math.abs(d) < gap ? "text-muted-foreground" : d > 0 ? "text-win" : "text-loss",
        className,
      )}
    >
      {d === null ? "—" : Math.round(50 + d)}
    </span>
  )
}

/** 以 50 為中線的橫條：往右是比中位數高，往左是比中位數低 */
function DivergingBar({ v, className }: { v: number | null; className?: string }) {
  const d = v === null ? null : v - 50
  return (
    <span className={cn("relative block rounded-full bg-muted/50", className)}>
      {v !== null && d !== null && (
        <span
          className={cn("absolute inset-y-0 rounded-full", d >= 0 ? "bg-win/70" : "bg-loss/70")}
          style={d >= 0 ? { left: "50%", width: `${d}%` } : { left: `${v}%`, width: `${50 - v}%` }}
        />
      )}
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-muted-foreground/60" />
    </span>
  )
}

/** 各項的橫條：中間的刻度是 50，往右是比較多；沒有值的項目顯示「—」。
 *  kind＝work：本場貢獻的四項，和本場參考量比（等於參考量是 50）；perf：每分鐘的實際數值，和同類型、同時長帶的人比；
 *  rank（預設）：占全隊的比例，和同類型的人比 */
export function ContribBars({ row, className, kind = "rank" }: { row: CubeRow | undefined; className?: string; kind?: "work" | "perf" | "rank" }) {
  const parts = kind === "work" ? WORK_PARTS : kind === "perf" ? PERF_PARTS : CONTRIB_PARTS
  const gap = kind === "work" ? WORK_GAP : kind === "perf" ? PERF_GAP : CONTRIB_GAP
  const basis =
    kind === "work" ? "和本場參考量比，50＝剛好等於參考量" : kind === "perf" ? "在同類型、同時長帶的人裡的百分位，50＝中位數" : "在同類型的人裡的百分位，50＝中位數"
  return (
    <div className={className ?? "space-y-1.5"}>
      {parts.map((c) => {
        const v = row ? num(row[c.key]) : null
        return (
          <div key={c.key} className="grid grid-cols-[3.5rem_minmax(0,1fr)_2rem] items-center gap-2" title={`${c.label}：${c.hint}\n${basis}`}>
            <span className="text-[12px]">{c.label}</span>
            <DivergingBar v={v} className="h-2" />
            <ContribScore dev={v === null ? null : v - 50} gap={gap} className="text-right text-[12px]" />
          </div>
        )
      })}
    </div>
  )
}

const WORK_TITLE =
  "本場貢獻（0～100）：這場的輸出、承傷、控場、治療護盾，和同一場另外九個人比，權重依你的終場裝備；清兵、推塔另有小幅加分。50＝所有人的平均，死亡不扣分"
const ESTIMATE_NOTE = "*暫估：這場沒有賽後統計，治療護盾隊友的量改用含自補的治療量"

/** 對局卡片裡的一個小數字：「貢獻 62」；暫估的場次數字後面加「*」 */
export function ContribInline({ score, rank, estimate }: { score: number | null; rank?: number | null; estimate?: boolean }) {
  if (score === null) return null
  return (
    <span
      className="whitespace-nowrap"
      title={`${WORK_TITLE}${estimate ? `\n${ESTIMATE_NOTE}` : ""}${rank != null ? `\n隊內排名 ${Math.round(rank)}（在隊裡扛的份量，50＝同類型的中位數）` : ""}`}
    >
      貢獻 <ContribScore dev={score - 50} gap={WORK_GAP} className="font-semibold" />
      {estimate && <span className="text-muted-foreground">*</span>}
    </span>
  )
}

/** MVP／ACE 標籤：MVP＝贏的那隊本場貢獻最高、ACE＝輸的那隊本場貢獻最高（兩隊各自取最高） */
export function ContribTagBadge({ tag, className }: { tag: ContribTag; className?: string }) {
  return (
    <span
      title={tag === "MVP" ? "MVP：贏的一隊本場貢獻最高" : "ACE：輸的一隊本場貢獻最高"}
      className={cn(
        "rounded px-1 py-px text-[10px] font-bold leading-none",
        tag === "MVP" ? "bg-gold/20 text-gold" : "bg-primary/15 text-primary",
        className,
      )}
    >
      {tag}
    </span>
  )
}

/** 計分板每列：大數字（本場貢獻，暫估加「*」）＋ 小字「隊內 78」＋ 以 50 為中線的橫條；點了展開各項。
 */
export function ContribMeter({
  score,
  rank,
  tag,
  estimate,
  expanded,
  onToggle,
}: {
  score: number | null
  rank: number | null
  tag?: ContribTag
  estimate?: boolean
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={`${WORK_TITLE}${estimate ? `\n${ESTIMATE_NOTE}` : ""}${rank === null ? "" : `\n隊內 ${Math.round(rank)}：在隊裡扛的份量（占全隊的比例，和同類型的人排名）。`}\n點一下看各項明細${tag === "MVP" ? "\nMVP：贏的一隊本場貢獻最高" : tag === "ACE" ? "\nACE：輸的一隊本場貢獻最高" : ""}`}
      className="flex w-[150px] shrink-0 flex-col gap-1 rounded-md px-1.5 py-1 text-left transition hover:bg-secondary/60"
    >
      <span className="flex items-center gap-1.5">
        <ContribScore dev={score === null ? null : score - 50} gap={WORK_GAP} className="text-base font-bold leading-none" />
        {estimate && score !== null && <span className="-ml-1 text-[11px] leading-none text-muted-foreground">*</span>}
        {tag && <ContribTagBadge tag={tag} />}
        {rank !== null && <span className="whitespace-nowrap text-[10px] leading-none text-muted-foreground">隊內 {Math.round(rank)}</span>}
        <ChevronDown className={cn("ml-auto size-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </span>
      <DivergingBar v={score} className="h-1.5" />
    </button>
  )
}
