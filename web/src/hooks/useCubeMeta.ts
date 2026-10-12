import { useEffect, useState } from "react"

/** Cube 模型的成員描述。UI 完全依這份資料產生，
 *  所以在 YAML 加一個 measure，畫面上就會自動多一個選項——
 *  前端不再抄一份模型清單，兩邊也就不會走鐘。 */
export type Member = {
  name: string
  title: string
  shortTitle?: string
  description?: string
  type: string
  public?: boolean
  meta?: {
    group?: string
    unit?: string
    decimals?: number
    higherIsBetter?: boolean
  }
}

export type Segment = { name: string; title: string; shortTitle?: string }

/** 模型裡定義好的下鑽路徑（cube 的 hierarchies），levels 是由粗到細的維度。 */
export type Hierarchy = { name: string; title: string; levels: string[] }

export type CubeMeta = {
  measures: Member[]
  dimensions: Member[]
  segments: Segment[]
  hierarchies: Hierarchy[]
  timeDimensions: Member[]
  byName: Map<string, Member>
}

const EMPTY: CubeMeta = {
  measures: [],
  dimensions: [],
  segments: [],
  hierarchies: [],
  timeDimensions: [],
  byName: new Map(),
}

/** 這些成員是給程式內部用的（主鍵、原始 id、篩選旗標），不該出現在選單。 */
const HIDDEN =
  /\.(id|game_key|puuid|subject_puuid|champion_id|team_id|win|is_me|icon_path|alias|slot|augment_id|item_id|game_id|duration_minutes|ended_surrender|queue_id|participant_key)$/

/** 整個 cube 都不進選單：game_players 是「某人有沒有在這場」的篩選用 cube，
 *  一場十列，拿來分組會讓每一場展開成十列（平均類指標會被重複計算）。
 *  要看「和誰同場」的統計請用隊友／對手那一家（teammates）。 */
const HIDDEN_CUBE = /^game_players\./

/** 模型裡沒給中文標題的成員不進選單——多半是內部欄位，
 *  暴露出來只會讓人選到看不懂的東西。 */
function isPresentable(m: { shortTitle?: string; title?: string }) {
  const text = m.shortTitle || m.title || ""
  return /[一-鿿]/.test(text)
}

export function useCubeMeta(): { meta: CubeMeta; loading: boolean; error: string | null } {
  const [meta, setMeta] = useState<CubeMeta>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/cube/meta")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        if (data.error) {
          setError(typeof data.error === "string" ? data.error : "模型讀取失敗")
          setLoading(false)
          return
        }
        const measures: Member[] = []
        const dimensions: Member[] = []
        const timeDimensions: Member[] = []
        const segments: Segment[] = []
        const hierarchies: Hierarchy[] = []

        for (const cube of data.cubes ?? []) {
          // view 是給 AI Agent 與外部工具的查詢入口（cube/model/views），成員和 cube 重複，
          // 列進選單會出現兩份，混選時還會撞到 join 路徑錯誤。前端一律直接查 cube。
          if (cube.type === "view") continue
          for (const m of cube.measures ?? []) {
            if (m.public === false || HIDDEN.test(m.name) || HIDDEN_CUBE.test(m.name) || !isPresentable(m)) continue
            measures.push(m)
          }
          for (const d of cube.dimensions ?? []) {
            if (d.public === false || HIDDEN.test(d.name) || HIDDEN_CUBE.test(d.name) || !isPresentable(d)) continue
            if (d.type === "time") timeDimensions.push(d)
            else dimensions.push(d)
          }
          // 只列對局表現的片段：其他 cube 的片段（例如 teammates.mine）和這頁的查詢接不起來。
          // mine 也不列，這頁用「分析對象」切換帳號。
          for (const s of cube.segments ?? []) {
            if (cube.name === "participants" && !s.name.endsWith(".mine")) segments.push(s)
          }
          for (const h of cube.hierarchies ?? []) {
            if (h.public !== false) hierarchies.push({ name: h.name, title: h.title ?? h.name, levels: h.levels })
          }
        }

        const byName = new Map<string, Member>()
        for (const m of [...measures, ...dimensions, ...timeDimensions]) byName.set(m.name, m)

        setMeta({ measures, dimensions, timeDimensions, segments, hierarchies, byName })
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { meta, loading, error }
}

/** 沒有 meta.group 的成員歸到「其他」，避免選單漏掉東西。 */
export function groupBy(members: Member[]): Map<string, Member[]> {
  const groups = new Map<string, Member[]>()
  for (const m of members) {
    const key = m.meta?.group ?? "其他"
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(m)
  }
  return groups
}

/** 用模型上的 meta 決定顯示格式，而不是在前端另外維護一張對照表。 */
export function formatValue(member: Member | undefined, raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "—"
  const n = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(n)) return String(raw)
  const decimals = member?.meta?.decimals ?? 1
  const unit = member?.meta?.unit ?? ""
  const text =
    decimals === 0 ? Math.round(n).toLocaleString() : n.toFixed(decimals)
  return `${text}${unit}`
}

export function label(member: Member | undefined, fallback: string): string {
  if (!member) return fallback
  // Cube 的 title 會把 cube 名稱前綴上去（「Champions 英雄」），
  // shortTitle 才是模型裡寫的那個標題，顯示用它。
  return member.shortTitle || member.title || fallback
}
