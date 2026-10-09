/** 一組：這個條件下的場次與勝場 */
export type GapRow = { key: string; label: string; games: number; wins: number }

/** 樣本不到這個數就不畫區間、不上色，只列場次 */
export const MIN_N = 5

/** 勝率的 95% 區間（Wilson）。常態近似在勝率接近 0% 或 100%、樣本又小時會給出超出範圍的區間，Wilson 不會。 */
export function wilson(wins: number, games: number): [number, number] {
  if (!games) return [0, 100]
  const z = 1.96
  const p = wins / games
  const denom = 1 + (z * z) / games
  const center = (p + (z * z) / (2 * games)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / games + (z * z) / (4 * games * games))) / denom
  return [(center - half) * 100, (center + half) * 100]
}

export type Gap = { winrate: number; diff: number; interval: [number, number] | null; clear: boolean }

/** 這一組比基準高或低幾個百分點、區間，以及區間是否整段都在基準的同一邊（「看得出差別」） */
export function gapOf(row: GapRow, baseline: number): Gap {
  const winrate = row.games ? (100 * row.wins) / row.games : 0
  if (row.games < MIN_N) return { winrate, diff: winrate - baseline, interval: null, clear: false }
  const [lo, hi] = wilson(row.wins, row.games)
  const interval: [number, number] = [lo - baseline, hi - baseline]
  return { winrate, diff: winrate - baseline, interval, clear: interval[0] > 0 || interval[1] < 0 }
}

/** 幾張森林圖並排時共用同一個刻度，才比得起來：取所有區間最遠的一端，進位到 10，介於 20～50 */
export function reachOf(rows: GapRow[], baseline: number) {
  const far = rows.map((r) => gapOf(r, baseline).interval).flatMap((i) => (i ? [Math.abs(i[0]), Math.abs(i[1])] : []))
  return Math.min(50, Math.max(20, Math.ceil(Math.max(0, ...far) / 10) * 10))
}
