export const round1 = (value: number) => value.toFixed(1)
export const round0 = (value: number) => Math.round(value).toLocaleString()
export const round2 = (value: number) => value.toFixed(2)

/** 單一項目（一隻英雄、一個增幅、一個場次序號）的勝率，場次低於這個數就不單獨解讀：
 *  排行圖不畫。原本各頁各訂 2、3、4、5，同一個「樣本太小」在不同頁標準不同。
 *  表格一律全部列出、不淡化——要不要信那幾列交給使用者看場次欄判斷。 */
export const MIN_GAMES = 5

/** 「全部列出」的查詢用這個 limit。Cube 不給 limit 時預設只回 10000 列，上限是 50000。
 *  列表類查詢（英雄、增幅、隊友、每日）不要再寫 200、500 這種數字——資料一多就默默少掉後面的列。
 *  AG Grid 只渲染看得到的列，上萬列捲動也不卡。 */
export const NO_LIMIT = 50000

/** Riot ID 拆成名稱與 #tag，版面上 tag 用淡色。沒有名稱時用 puuid 前 8 碼 */
export const splitRiotId = (riotId: string | null, puuid: string) => {
  const [name, tag] = (riotId ?? puuid.slice(0, 8)).split("#")
  return { name, tag: tag ? `#${tag}` : "" }
}

export const WEEKDAYS =["週日", "週一", "週二", "週三", "週四", "週五", "週六"]

/** 熱力圖的粗分組。
 *
 *  168 格攤 100 多場，單格最多只有個位數，顏色再怎麼校正也只是在看雜訊。
 *  切成 7×4 = 28 格之後，每格的樣本才有機會累積到看得出差異的量。 */
export const BLOCKS = [
  { label: "深夜 0-5", from: 0, to: 5 },
  { label: "早上 6-11", from: 6, to: 11 },
  { label: "下午 12-17", from: 12, to: 17 },
  { label: "晚上 18-23", from: 18, to: 23 },
]

export type HourCell = { weekday: number; hour: number; games: number; winrate: number | null }
export type BlockCell = { weekday: number; block: number; games: number; winrate: number | null }

/** 逐小時併成四時段。要用勝場數相加，不能把勝率平均起來——那樣一場的格子會和二十場的一樣重。 */
export function toBlocks(hours: HourCell[]): BlockCell[] {
  const acc = new Map<string, { weekday: number; block: number; games: number; wins: number }>()
  for (const h of hours) {
    const block = BLOCKS.findIndex((b) => h.hour >= b.from && h.hour <= b.to)
    if (block < 0) continue
    const key = `${h.weekday}:${block}`
    const prev = acc.get(key) ?? { weekday: h.weekday, block, games: 0, wins: 0 }
    prev.games += h.games
    prev.wins += (h.games * (h.winrate ?? 0)) / 100
    acc.set(key, prev)
  }
  return [...acc.values()].map((c) => ({
    weekday: c.weekday,
    block: c.block,
    games: c.games,
    winrate: c.games ? (c.wins / c.games) * 100 : null,
  }))
}

/** 出裝定位（builds.build_role）六類，也是雷達上的順序：
 *  坦克 → 鬥士 → 刺客 → 射手 → 法師 → 輔助 → 回到坦克。相鄰的是性質相近的：由肉到脆、輔助接回坦克（開團／保人）。
 *  AD／AP 不放進名稱，另外看 builds.damage_type。「未成形」不畫。 */
export const BUILD_ROLES = ["坦克", "鬥士", "刺客", "射手", "法師", "輔助"]

/** 迷你雷達與標籤用的短名（也是陣容頁五人組成的字） */
export const BUILD_SHORT: Record<string, string> = {
  坦克: "坦",
  鬥士: "鬥",
  刺客: "刺",
  射手: "射",
  法師: "法",
  輔助: "輔",
}
