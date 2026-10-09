/** 一組：這個條件下的場次與勝場 */
export type GapRow = { key: string; label: string; games: number; wins: number }

/** 樣本不到這個數就不畫區間、不上色，只列場次 */
export const MIN_N = 5

/** 一次比較 k 組時，把 95% 區間拉寬到「全部組一起算還是 95%」（Šidák 校正）的 z 值。
 *  不調整的話，一頁二十幾列平均會有一兩列區間不含基準，只是運氣。k = 1 就是一般的 1.96。 */
export function zFor(k: number) {
  if (k <= 1) return 1.96
  // 雙尾 α = 1 − 0.95^(1/k)，反查標準常態：用 Acklam 的近似（誤差 < 1e-9）就夠了
  const alpha = 1 - Math.pow(0.95, 1 / k)
  return normInv(1 - alpha / 2)
}

function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) return -normInv(1 - p)
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** 勝率的區間（Wilson），預設 95%。常態近似在勝率接近 0% 或 100%、樣本又小時會給出超出範圍的區間，Wilson 不會。 */
export function wilson(wins: number, games: number, z = 1.96): [number, number] {
  if (!games) return [0, 100]
  const p = wins / games
  const denom = 1 + (z * z) / games
  const center = (p + (z * z) / (2 * games)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / games + (z * z) / (4 * games * games))) / denom
  return [(center - half) * 100, (center + half) * 100]
}

export type Gap = { winrate: number; diff: number; interval: [number, number] | null; clear: boolean }

/** 這一組比基準高或低幾個百分點、區間，以及區間是否整段都在基準的同一邊（「看得出差別」） */
export function gapOf(row: GapRow, baseline: number, z = 1.96): Gap {
  const winrate = row.games ? (100 * row.wins) / row.games : 0
  if (row.games < MIN_N) return { winrate, diff: winrate - baseline, interval: null, clear: false }
  const [lo, hi] = wilson(row.wins, row.games, z)
  const interval: [number, number] = [lo - baseline, hi - baseline]
  return { winrate, diff: winrate - baseline, interval, clear: interval[0] > 0 || interval[1] < 0 }
}

/** 幾張森林圖並排時共用同一個刻度，才比得起來：取所有區間最遠的一端，進位到 10，介於 20～50 */
export function reachOf(rows: GapRow[], baseline: number, z = 1.96) {
  const far = rows.map((r) => gapOf(r, baseline, z).interval).flatMap((i) => (i ? [Math.abs(i[0]), Math.abs(i[1])] : []))
  return Math.min(50, Math.max(20, Math.ceil(Math.max(0, ...far) / 10) * 10))
}

/** 強弱判定的五級。「強勢／不強勢」只在區間（已依一次比較幾組校正）整段在基準同一邊才給；
 *  其餘只說「偏強／偏弱」（差 3 個百分點以上但還分不出是不是運氣）或「看不出」。 */
export type Strength = "強勢" | "偏強" | "看不出" | "偏弱" | "不強勢"

export function strengthOf(gap: Gap): Strength {
  if (gap.interval === null) return "看不出"
  if (gap.clear) return gap.diff > 0 ? "強勢" : "不強勢"
  if (gap.diff >= 3) return "偏強"
  if (gap.diff <= -3) return "偏弱"
  return "看不出"
}

/** 精確二項檢定（雙尾），虛無假設 p = 0.5：n 場裡贏 x 場，有多罕見。 */
export function binomialP(x: number, n: number) {
  if (!n) return 1
  const logFact = (k: number) => {
    let s = 0
    for (let i = 2; i <= k; i++) s += Math.log(i)
    return s
  }
  const lf = logFact(n)
  const pmf = (k: number) => Math.exp(lf - logFact(k) - logFact(n - k) - n * Math.log(2))
  const px = pmf(x)
  let p = 0
  for (let k = 0; k <= n; k++) {
    const pk = pmf(k)
    if (pk <= px * (1 + 1e-9)) p += pk
  }
  return Math.min(1, p)
}

/** 實證貝氏（矩估計）：從一大群組（例如所有增幅）的勝率離散程度，估出「組與組之間真正的差距」有多大。
 *
 *  觀察到的離散 = 真正的差距 τ² + 純運氣（p(1−p)/n）。τ² 很小時，表上看到的差距大多是運氣。
 *  回傳 m = p(1−p)/τ²：收縮時相當於每組先加上 m 場「整體勝率」的虛擬場次；τ² 估成 0 時 m 是 Infinity（全部收到平均）。
 *  只用場次 ≥ minGames 的組來估，免得一兩場的組把離散灌大。 */
export function empiricalBayes(rows: { games: number; wins: number }[], minGames = MIN_N) {
  const used = rows.filter((r) => r.games >= minGames)
  const n = used.reduce((a, r) => a + r.games, 0)
  if (!n || used.length < 3) return { mu: null as number | null, tau2: 0, m: Infinity, groups: used.length, picks: n }
  const mu = used.reduce((a, r) => a + r.wins, 0) / n
  const ss = used.reduce((a, r) => a + r.games * (r.wins / r.games - mu) ** 2, 0)
  const tau2 = Math.max(0, (ss - used.length * mu * (1 - mu)) / n)
  return { mu, tau2, m: tau2 > 0 ? (mu * (1 - mu)) / tau2 : Infinity, groups: used.length, picks: n }
}

/** 收縮後的勝率（%）：往 base（%）拉，拉多少看 m（見 empiricalBayes）。m 是 Infinity 時就是 base。 */
export function shrinkRate(games: number, wins: number, base: number, m: number) {
  if (!Number.isFinite(m)) return base
  return (100 * wins + m * base) / (games + m)
}
