import { Globe, User, Users, type LucideIcon } from "lucide-react"
import { useFilters } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { WHO_LABEL, type Who } from "@/lib/who"
import { cn } from "@/lib/utils"

const OPTIONS: { value: Who; icon: LucideIcon }[] = [
  { value: "account", icon: User },
  { value: "tracked", icon: Users },
  { value: "all", icon: Globe },
]

/** 頁面最上方的「看誰的數據」列。
 *
 *  原本是英雄面板右上角的一組小按鈕，和面板內的「形狀：場次／勝率」長得一樣、選中只是淡灰底，
 *  很難發現、也看不出現在是哪一種。這個選擇會改變整頁每一個數字，所以放在頁首、左對齊，
 *  選中用主色實心，旁邊用一句話講清楚現在算的是誰；不是預設時也登記進麵包屑。 */
export function WhoSwitch({
  who,
  onChange,
  trackedCount,
  disabled,
}: {
  who: Who
  onChange: (who: Who) => void
  trackedCount: number
  /** 這一頁不適用的選項與原因。停用的選項照樣顯示（不是藏起來），原因寫在下面，免得使用者以為少了功能 */
  disabled?: Partial<Record<Who, string>>
}) {
  const { account } = useFilters()
  useCrumb(5, who === "account" ? null : WHO_LABEL[who], () => onChange("account"))

  const detail =
    who === "account"
      ? `只算 ${account?.riot_id ?? "目前帳號"} 自己的場次，和其他頁一樣`
      : who === "tracked"
        ? `你自己加上追蹤對象，共 ${trackedCount} 位玩家，各自的每一場`
        : "資料庫裡每一場的十位參賽者，隊友和對手都算——整體勝率因此接近 50%"

  return (
    <div className="rise flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3">
      <span className="text-sm font-semibold">看誰的數據</span>
      <div role="radiogroup" aria-label="看誰的數據" className="flex rounded-lg border bg-muted/40 p-0.5">
        {OPTIONS.map(({ value, icon: Icon }) => {
          const on = who === value
          const off = disabled?.[value]
          return (
            <button
              key={value}
              role="radio"
              aria-checked={on}
              aria-disabled={!!off}
              title={off}
              onClick={() => !off && onChange(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
                off
                  ? "cursor-not-allowed text-muted-foreground/50"
                  : on
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {WHO_LABEL[value]}
              {value === "tracked" && <span className={cn("text-xs tabular-nums", on ? "opacity-80" : "opacity-60")}>{trackedCount}</span>}
            </button>
          )
        })}
      </div>
      <span className="text-xs text-muted-foreground">{detail}</span>
      {disabled &&
        (Object.keys(disabled) as Who[]).map((k) => (
          <span key={k} className="basis-full text-[11px] text-muted-foreground">
            「{WHO_LABEL[k]}」不能選：{disabled[k]}
          </span>
        ))}
    </div>
  )
}
