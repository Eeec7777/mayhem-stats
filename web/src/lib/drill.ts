/** 自由探索「下鑽路徑」與「交叉矩陣」共用的規則。
 *
 *  維度分成兩家：participants（以某人每場的表現為一列）與 teammates（某人某場 × 同場另一人）。
 *  兩家都接得到 matches，但彼此沒有 join 路徑，混在同一個查詢會得到 "Can't find join path"，
 *  所以一條路徑、一張矩陣只能用同一家的維度，選單也只列同一家的。 */
import type { CubeFilter, CubeQuery, CubeRow } from "@/lib/cube"
import { num } from "@/lib/cube"
import { label, type CubeMeta, type Member } from "@/hooks/useCubeMeta"
import { NO_LIMIT, WEEKDAYS } from "@/pages/shared"

export type Family = "participants" | "teammates"

/** 路徑最多幾層。麵包屑的登記是固定數量的 hook，這個數字不能在執行期改變。 */
export const MAX_LEVELS = 5

/** 已經點下去的一層。games / wins 是被點的那一列的數字，下一層拿來當比較基準；
 *  不知道時（例如從交叉矩陣點進來的列條件）給 null，下一層會自己查。 */
export type DrillPick = {
  member: string
  value: string | null
  games: number | null
  wins: number | null
}

export const familyOf = (member: string): Family =>
  member.startsWith("teammates.") ? "teammates" : "participants"

/** 某一家可以用的維度。my_games 的分區算法和另外兩家都不同，不放進路徑。 */
export function dimensionsOf(meta: CubeMeta, family: Family): Member[] {
  return meta.dimensions.filter((d) => {
    const cube = d.name.split(".")[0]
    if (cube === "my_games") return false
    if (family === "teammates") return cube === "teammates" || cube === "matches" || cube === "champion_roles" || cube === "builds"
    return cube !== "teammates"
  })
}

/** 帶圖示或稀有度的維度，查詢時要順便把對應欄位撈回來才顯示得出來。 */
export const COMPANION: Record<string, { icon?: string; rarity?: string }> = {
  "champions.name": { icon: "champions.icon_path" },
  "augments.name": { icon: "augments.icon_path", rarity: "augments.rarity" },
  "items.name": { icon: "items.icon_path" },
  "teammates.my_champion": { icon: "teammates.my_champion_icon" },
  "teammates.other_champion": { icon: "teammates.other_champion_icon" },
}

export const companionsOf = (dims: string[]) =>
  dims.flatMap((d) => [COMPANION[d]?.icon, COMPANION[d]?.rarity].filter(Boolean) as string[])

/** 資料庫裡存的是代碼或數字的維度，顯示時換成看得懂的字。篩選一律用原始值。 */
export function displayValue(member: string, raw: string | number | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "（無）"
  const v = String(raw)
  switch (member) {
    case "matches.weekday":
      return WEEKDAYS[Number(v)] ?? v
    case "matches.hour_of_day":
      return `${v}:00`
    case "teammates.relation":
      return v === "teammate" ? "隊友" : v === "opponent" ? "對手" : v
    case "participants.party_size":
      return v === "0" ? "沒有朋友同隊" : `${v} 位朋友同隊`
    default:
      return v
  }
}

/** 有自然順序的維度照值排，其餘照場次多寡（Cube 已經排好）。 */
const ORDERED = new Set([
  "matches.weekday",
  "matches.hour_of_day",
  "matches.duration_bucket",
  "matches.local_date",
  "matches.patch",
  "participants.party_size",
  "participants.champ_level",
  "participants.death_bucket",
])

/** 分組標籤的排序鍵：「< 12 分」排在「12-14 分」前面，「16 次以上」排在「11-15 次」後面。 */
function orderKey(v: string): number | null {
  const m = v.match(/\d+(\.\d+)?/)
  if (!m) return null
  return Number(m[0]) - (v.trimStart().startsWith("<") ? 0.5 : 0)
}

export function sortRows(member: string, rows: CubeRow[]): CubeRow[] {
  if (!ORDERED.has(member)) return rows
  return [...rows].sort((a, b) => {
    const va = String(a[member] ?? "")
    const vb = String(b[member] ?? "")
    // 版本號（15.18）與日期要逐段比，單一數字鍵分不出 15.2 和 15.18
    if (member === "matches.patch" || member === "matches.local_date") {
      return va.localeCompare(vb, undefined, { numeric: true })
    }
    const ka = orderKey(va)
    const kb = orderKey(vb)
    if (ka === null || kb === null) return va.localeCompare(vb, undefined, { numeric: true })
    return ka - kb
  })
}

/** 一層的條件。值是 null 的那一組（例如沒有增幅）用 notSet，equals null 查不到東西。 */
export function pickFilter(pick: Pick<DrillPick, "member" | "value">): CubeFilter {
  return pick.value === null
    ? { member: pick.member, operator: "notSet", values: [] }
    : { member: pick.member, operator: "equals", values: [pick.value] }
}

/** 「英雄：拉克絲」這種寫法，麵包屑與全站下鑽共用。 */
export const pickLabel = (meta: CubeMeta, pick: Pick<DrillPick, "member" | "value">) =>
  `${label(meta.byName.get(pick.member), pick.member)}：${displayValue(pick.member, pick.value)}`

export const recordMeasures = (family: Family) => [
  `${family}.games`,
  `${family}.wins`,
  `${family}.winrate`,
]

/** 同一家、除了場次勝負以外的指標，給「附加指標」選單用。teammates 只有場次勝負。 */
export function extraMeasuresOf(meta: CubeMeta, family: Family): Member[] {
  const base = new Set(recordMeasures(family))
  return meta.measures.filter(
    (m) => m.name.startsWith(`${family}.`) && !base.has(m.name) && !m.name.endsWith(".losses"),
  )
}

/** 一層的查詢：依這一層的維度分組，帶上已經點過的每一層當條件。 */
export function levelQuery(
  family: Family,
  dims: string[],
  picks: DrillPick[],
  extra: string[] = [],
): CubeQuery {
  return {
    measures: [...recordMeasures(family), ...extra],
    dimensions: [...dims, ...companionsOf(dims)],
    filters: picks.map(pickFilter),
    order: { [`${family}.games`]: "desc" },
    limit: NO_LIMIT,
  }
}

export const n0 = (row: CubeRow | undefined, key: string) => (row ? (num(row[key]) ?? 0) : 0)
