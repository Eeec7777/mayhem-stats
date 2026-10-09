import { useMemo } from "react"
import { MAX_GAME_IDS, type CubeFilter, type CubeQuery, type CubeRow } from "@/lib/cube"
import { useFilters } from "@/lib/filters"

/** 看誰的數據：目前帳號（其他頁一樣的預設）、自己加上追蹤對象、或資料庫裡出現過的所有參賽者 */
export type Who = "account" | "tracked" | "all"

export const WHO_LABEL: Record<Who, string> = {
  account: "目前帳號",
  tracked: "追蹤對象",
  all: "所有人",
}

export type WhoScope = {
  who: Who
  /** 「追蹤對象」模式包含的人數（含自己） */
  trackedCount: number
  /** 把全域條件（模式、期間、下鑽）和「看誰」一起套進查詢 */
  q: (query: CubeQuery) => CubeQuery
  /** 戰績刻度與說明文字裡的「誰的整體勝率」 */
  baselineLabel: string
  /** 逐場列表要蓋過的 /api/matches 參數（再加上鎖定「那一列是誰」的 champion 或 augment）；
   *  目前帳號時不蓋，沿用全域的帳號 */
  matchParams: (extra: Record<string, string>) => Record<string, string> | undefined
}

/** 「追蹤對象」是自己加上追蹤對象頁裡的人，也就是 /api/players 的 crew，和好友比較頁同一群：
 *  本機帳號、追蹤中的玩家，以及公開鏡像上登入者自己綁定的帳號。
 *  「所有人」不鎖玩家：一場十個人都算，所以整體勝率會接近 50%。
 *  兩者都照樣套模式、期間與全域下鑽，只是拿掉「目前帳號」這個條件。 */
export function useWhoScope(who: Who): WhoScope {
  const { apply, players } = useFilters()
  const tracked = useMemo(() => players.filter((p) => p.crew).map((p) => p.puuid), [players])
  return useMemo(() => {
    const byPlayers: CubeFilter = { member: "participants.puuid", operator: "equals", values: tracked }
    return {
      who,
      trackedCount: tracked.length,
      q:
        who === "account"
          ? (query) => apply(query)
          : who === "tracked"
            ? (query) => apply({ ...query, filters: [byPlayers, ...(query.filters ?? [])] }, "all")
            : (query) => apply(query, "all"),
      baselineLabel: who === "account" ? "你的整體勝率" : `${WHO_LABEL[who]}的整體勝率`,
      matchParams: (extra) =>
        who === "account" ? undefined : { puuid: who === "all" ? "*" : tracked.join(","), ...extra },
    }
  }, [apply, who, tracked])
}

/** 追蹤對象的逐場下鑽：一列是「某位玩家的某一場」，不是一場。
 *  查詢要帶 participants.participant_key（平台:場次:參賽者編號），交給 CubeMatchList 的 rowsToParams，
 *  列出的就是圖上算進去的那幾列；只給 game_ids 的話，同場另一位追蹤對象不符合條件的那一列也會被列出來。 */
export function participantRows(rows: CubeRow[]) {
  const picks = rows.slice(0, MAX_GAME_IDS).map((r) => {
    const [, game, pid] = String(r["participants.participant_key"]).split(":")
    return `${game}:${pid}`
  })
  return picks.length ? { params: { puuid: "*", participants: picks.join(",") }, count: picks.length } : null
}
