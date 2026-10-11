import { cn } from "@/lib/utils"

/** 出裝定位標籤。九種定位沒辦法各給一個分得開的顏色（見 index.css 的 --role-*），所以拆成兩個編碼：
 *  - 顏色＝傷害類型：AD 橘、AP 紫、坦克與輔助青（不靠輸出吃飯的）
 *  - 框線＝站位：實心＝前排（坦克、AD 鬥士、AP 鬥士）、虛線＝近身切入（刺客、AD 近戰）、空心＝後排（射手、AP 輸出、輔助）
 *  文字一律用前景色（顏色只放在點、框與底色），色盲或亮色主題也讀得到。 */
type Tone = "ad" | "ap" | "util"
type Shape = "front" | "assassin" | "back"

const ROLE_STYLE: Record<string, { tone: Tone; shape: Shape }> = {
  坦克: { tone: "util", shape: "front" },
  輔助: { tone: "util", shape: "back" },
  "AD 鬥士": { tone: "ad", shape: "front" },
  "AD 刺客": { tone: "ad", shape: "assassin" },
  "AD 近戰": { tone: "ad", shape: "assassin" },
  射手: { tone: "ad", shape: "back" },
  "AP 鬥士": { tone: "ap", shape: "front" },
  "AP 刺客": { tone: "ap", shape: "assassin" },
  "AP 輸出": { tone: "ap", shape: "back" },
}

// Tailwind 要看得到完整的 class 名稱才會產生，不能用字串拼接
const TONE: Record<Tone, { dot: string; front: string; assassin: string; back: string }> = {
  ad: {
    dot: "bg-role-ad",
    front: "border-role-ad bg-role-ad/25",
    assassin: "border-dashed border-role-ad bg-role-ad/10",
    back: "border-role-ad/70",
  },
  ap: {
    dot: "bg-role-ap",
    front: "border-role-ap bg-role-ap/25",
    assassin: "border-dashed border-role-ap bg-role-ap/10",
    back: "border-role-ap/70",
  },
  util: {
    dot: "bg-role-util",
    front: "border-role-util bg-role-util/25",
    assassin: "border-dashed border-role-util bg-role-util/10",
    back: "border-role-util/70",
  },
}

const SHAPE_TEXT: Record<Shape, string> = { front: "前排", assassin: "近身切入", back: "後排" }

export function RoleChip({ role, className }: { role: string; className?: string }) {
  const style = ROLE_STYLE[role]
  if (!style) {
    // 未成形（太早結束沒成裝）：不屬於任何一類，灰色空心
    return (
      <span
        title="出裝定位：未成形（太早結束，沒有成裝）"
        className={cn("inline-flex items-center whitespace-nowrap rounded border border-muted-foreground/40 px-1.5 text-[11px] leading-[18px] text-muted-foreground", className)}
      >
        {role}
      </span>
    )
  }
  const tone = TONE[style.tone]
  return (
    <span
      title={`出裝定位：${role}（依終場裝備判斷）`}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11px] leading-[18px] text-foreground",
        tone[style.shape],
        className,
      )}
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      {role}
    </span>
  )
}

/** 標籤的讀法。放在有定位標籤的列表旁邊 */
export function RoleLegend({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground", className)}>
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-role-ad" />
        AD
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-role-ap" />
        AP
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="size-1.5 rounded-full bg-role-util" />
        坦克／輔助
      </span>
      <span className="text-muted-foreground/70">｜</span>
      {(["front", "assassin", "back"] as Shape[]).map((s) => (
        <span key={s} className="inline-flex items-center gap-1">
          <span className={cn("inline-block h-2.5 w-4 rounded-sm border", s === "front" ? "border-muted-foreground bg-muted-foreground/30" : s === "assassin" ? "border-dashed border-muted-foreground" : "border-muted-foreground/70")} />
          {SHAPE_TEXT[s]}
        </span>
      ))}
    </span>
  )
}
