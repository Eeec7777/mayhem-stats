import { useCube } from "@/hooks/useCube"
import { num, type CubeRow } from "@/lib/cube"

// 貢獻的分數，定義只有一份，在語意層（規格見 docs/contribution-scoring.md）；畫法在 components/Contribution.tsx：
//   本場貢獻（contribution_v2.work，cube/model/cubes/contribution_v2.yml）：這場可觀測的工作量，只和同一場另外九個人比，
//     權重依終場裝備的連續比例；50＝v2.0 定版時所有人的平均。2026-10-17 起計分板大數字、對局卡片、MVP／ACE、好友比較頁都用它。
//   表現（perf，contribution.yml）：舊的當局表現分，和同類型、同時長帶的歷史人次比。英雄頁、好友比較頁的「打法」還在用，也留作回放對照。
//   隊內（score）：在隊裡扛的份量，占全隊的比例，份額零和所以各隊平均都在 50 附近。計分板小字用它。

/** 貢獻（分數 − 50）要偏離多少才算好或差，低於這個值的數字用淡色。
 *  分數是同類型內的名次百分位，單場標準差約 29（舊版加權平均約 19，門檻 4，按同樣比例放大成 6）。
 *  好友比較頁拿收縮後的平均分數比，「人 × 出裝」的差距也跟著放大約 1.5 倍 */
export const CONTRIB_GAP = 6
/** 表現分是百分位的加權平均、不再重新排名，標準差約 20（隊內排名約 29），門檻按同樣比例縮小 */
export const PERF_GAP = 4

/** 貢獻的六項，順序固定：先「做了多少」（輸出、承傷）再「撐住」（存活）再「參與與幫忙」（參團、控場、治療護盾）。
 *  治療護盾只在有治療或護盾隊友的場次才有值，其他場次是空值（雷達圖會略過那個頂點）。 */
export const CONTRIB_PARTS = [
  { key: "contribution.dmg_pct", label: "輸出", hint: "對英雄傷害佔隊伍的比例（除以依陣容算的期望份額）" },
  { key: "contribution.soak_pct", label: "承傷", hint: "承受傷害＋自身減免佔隊伍的比例（除以依陣容算的期望份額）" },
  { key: "contribution.surv_pct", label: "存活", hint: "死亡佔隊伍死亡的比例，越低越好（分數越高代表死得越少）" },
  { key: "contribution.kp_pct", label: "參團", hint: "(擊殺＋助攻) / 隊伍擊殺" },
  { key: "contribution.cc_pct", label: "控場", hint: "每分鐘控制敵人的時間（Combo Breaker 讓控場邊際遞減，權重中等）" },
  { key: "contribution.heal_pct", label: "治療護盾", hint: "每分鐘有效治療＋護盾隊友，只在有治療或護盾隊友的場次計（不分定位排名；舊場次沒有護盾的量，改用含自補的治療量）" },
] as const
export const CONTRIB_MEASURES = ["contribution.score", ...CONTRIB_PARTS.map((c) => c.key)]

/** 表現分的六項，順序與 CONTRIB_PARTS 相同；比的是每分鐘的實際數值，不看隊友占了多少 */
export const PERF_PARTS = [
  { key: "contribution.perf_dmg", label: "輸出", hint: "考慮死亡的傷害：對英雄傷害 ÷ √（死亡＋1），死得多會打折" },
  { key: "contribution.perf_soak", label: "承傷", hint: "扛傷效率：（承受＋自身減免）÷ √（死亡＋1），死得多會打折" },
  { key: "contribution.perf_minion", label: "清兵", hint: "每分鐘對小兵的傷害（估計＝總輸出 − 對英雄 − 對建築）" },
  { key: "contribution.perf_obj", label: "推塔", hint: "每分鐘對建築的傷害（有一半是結果：贏的一隊才拆得到塔）" },
  { key: "contribution.perf_cc", label: "控場", hint: "每分鐘控制敵人的時間" },
  { key: "contribution.perf_heal", label: "治療護盾", hint: "每分鐘有效治療＋護盾隊友，只在有治療或護盾隊友的場次計（舊場次沒有護盾的量，改用含自補的治療量）" },
] as const
export const PERF_MEASURES = ["contribution.perf", ...PERF_PARTS.map((c) => c.key)]

/** 本場貢獻 v2 的單場標準差約 20（2026-10-17 全體 19.7），門檻和表現分一樣用 4 */
export const WORK_GAP = 4
export const WORK = "contribution_v2.work"
export const WORK_STATUS = "contribution_v2.score_status"
/** 有本場貢獻的場次（重開局、不完整的對局沒有分數）：算誤差範圍的樣本數 */
export const WORK_GAMES = "contribution_v2.scored_games"

/** 本場貢獻的四項：每項 0～100，等於本場參考量是 50（治療護盾是固定換算，每分鐘 1250 是 50） */
export const WORK_PARTS = [
  { key: "contribution_v2.part_dmg", label: "輸出", hint: "每分鐘對英雄傷害，和本場參考量比（其他九人的量依裝備職責分到你的份）" },
  { key: "contribution_v2.part_soak", label: "承傷", hint: "每分鐘承受＋自身減免，和本場參考量比；只是承傷量，分不出有效開戰或無效吃傷" },
  { key: "contribution_v2.part_cc", label: "控場", hint: "每分鐘控制敵人的時間，和本場參考量比" },
  { key: "contribution_v2.part_heal", label: "治療護盾", hint: "每分鐘治療＋護盾隊友（固定換算，每分鐘 1250 是 50）；沒有賽後統計的場次改用含自補的治療量，是暫估" },
] as const
export const WORK_MEASURES = [WORK, ...WORK_PARTS.map((c) => c.key), "contribution_v2.base", "contribution_v2.cross_role", "contribution_v2.progress"]

/** 本場貢獻 v2（0～100，50＝v2.0 定版時所有人的平均） */
export const workScore = (r: CubeRow | undefined) => (r ? num(r[WORK]) : null)
/** 這一列的本場貢獻是不是暫估（沒有賽後統計的治療護盾隊友量） */
export const isEstimate = (r: CubeRow | undefined) => r?.[WORK_STATUS] === "estimate"

/** 當局表現分（0～100，50＝同類型、同時長帶的中位數） */
export const perfScore = (r: CubeRow | undefined) => (r ? num(r["contribution.perf"]) : null)
/** 隊內貢獻排名（0～100，50＝同類型的中位數） */
export const contribScore = (r: CubeRow | undefined) => (r ? num(r["contribution.score"]) : null)

/** 一批參賽者（鍵：platform_id:game_id:participant_id）各自的本場貢獻、表現與隊內排名。
 *  parts＝true 時連各項一起查。一批不要超過 50 個鍵，查詢走 GET，網址才不會太長。 */
export function useContribution(keys: string[], parts = false): Map<string, CubeRow> {
  const res = useCube(
    keys.length
      ? {
          dimensions: ["participants.participant_key", WORK_STATUS],
          measures: parts ? [...WORK_MEASURES, ...PERF_MEASURES, ...CONTRIB_MEASURES] : [WORK, "contribution.perf", "contribution.score"],
          filters: [{ member: "participants.participant_key", operator: "equals", values: keys }],
          limit: keys.length,
        }
      : null,
  )
  return new Map(res.rows.map((r) => [String(r["participants.participant_key"]), r]))
}

export type ContribTag = "MVP" | "ACE"

/** 這一隊（五個人）裡的本場貢獻最高才有標籤：贏的一隊是 MVP、輸的一隊是 ACE。
 *  五個人的分數沒到齊就不標，免得資料還沒回來時誤標。 */
export function contribTagOf(score: number | null, teamScores: (number | null)[], won: boolean): ContribTag | undefined {
  if (score === null || teamScores.length === 0 || teamScores.some((v) => v === null)) return undefined
  return score === Math.max(...(teamScores as number[])) ? (won ? "MVP" : "ACE") : undefined
}

type CardRow = {
  platform_id: string
  game_id: number
  participant_id: number
  team_id: number
  win: number
  roster?: { participant_id: number; team_id: number }[]
}

/** 一批對局卡片（一批不要超過 50 張）上各自的本場貢獻、隊內排名與 MVP／ACE（看本場貢獻）。
 *  標籤要比同隊五個人，卡片只有自己那一列，所以用 matches.game_id 一次查整批的十個人，
 *  隊伍歸屬用卡片帶的 roster 對。team_id 在語意層是私有欄位，不能直接查。 */
export function useCardContribution(
  rows: CardRow[],
): Map<string, { score: number | null; rank: number | null; tag?: ContribTag; estimate: boolean }> {
  const gameIds = [...new Set(rows.map((r) => r.game_id))]
  const res = useCube(
    gameIds.length
      ? {
          dimensions: ["participants.participant_key", WORK_STATUS],
          measures: [WORK, "contribution.score"],
          filters: [{ member: "matches.game_id", operator: "equals", values: gameIds.map(String) }],
          limit: gameIds.length * 10,
        }
      : null,
  )
  const scores = new Map(res.rows.map((r) => [String(r["participants.participant_key"]), workScore(r)]))
  const estimates = new Map(res.rows.map((r) => [String(r["participants.participant_key"]), isEstimate(r)]))
  const ranks = new Map(res.rows.map((r) => [String(r["participants.participant_key"]), contribScore(r)]))
  const key = (m: { platform_id: string; game_id: number }, pid: number) => `${m.platform_id}:${m.game_id}:${pid}`
  return new Map(
    rows.map((m) => {
      const score = scores.get(key(m, m.participant_id)) ?? null
      const team = (m.roster ?? []).filter((p) => p.team_id === m.team_id).map((p) => scores.get(key(m, p.participant_id)) ?? null)
      return [
        key(m, m.participant_id),
        { score, rank: ranks.get(key(m, m.participant_id)) ?? null, tag: contribTagOf(score, team, m.win === 1), estimate: estimates.get(key(m, m.participant_id)) ?? false },
      ]
    }),
  )
}
