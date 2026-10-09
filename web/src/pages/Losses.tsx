import { useMemo, useState } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { DrillPanel, MAX_GAME_IDS } from "@/components/MatchList"
import { Kpi, Panel, EmptyState, QueryError } from "@/components/primitives"
import { AgTable, type GridColumn } from "@/components/AgTable"
import { BarChart, type BarDatum } from "@/components/charts"
import { useCube } from "@/hooks/useCube"
import { num } from "@/lib/cube"
import { ContrastCell, numOf } from "@/components/cells"
import { useFilters } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { WhoSwitch } from "@/components/WhoSwitch"
import { useWhoScope, type Who } from "@/lib/who"

/** 拿來做勝負對照的指標。higherIsBetter 只影響顏色，不影響數字。 */
type Metric = {
  key: string
  label: string
  group: string
  decimals?: number
  suffix?: string
  higherIsBetter: boolean
}

const TEAM_METRICS: Metric[] = [
  { key: "participants.team_dpm", label: "我方每分鐘傷害", group: "團隊", higherIsBetter: true },
  { key: "participants.enemy_dpm", label: "敵方每分鐘傷害", group: "團隊", higherIsBetter: false },
  { key: "participants.team_gpm", label: "我方每分鐘經濟", group: "團隊", higherIsBetter: true },
  { key: "participants.enemy_gpm", label: "敵方每分鐘經濟", group: "團隊", higherIsBetter: false },
  { key: "participants.avg_team_kills", label: "我方總擊殺", group: "團隊", decimals: 1, higherIsBetter: true },
  { key: "participants.avg_enemy_kills", label: "敵方總擊殺", group: "團隊", decimals: 1, higherIsBetter: false },
]

const MINE_METRICS: Metric[] = [
  { key: "participants.avg_kills", label: "我的擊殺", group: "我自己", decimals: 1, higherIsBetter: true },
  { key: "participants.avg_deaths", label: "我的死亡", group: "我自己", decimals: 1, higherIsBetter: false },
  { key: "participants.avg_assists", label: "我的助攻", group: "我自己", decimals: 1, higherIsBetter: true },
  { key: "participants.kda", label: "我的 KDA", group: "我自己", decimals: 2, higherIsBetter: true },
  { key: "participants.dpm", label: "我的每分鐘傷害", group: "我自己", higherIsBetter: true },
  { key: "participants.gpm", label: "我的每分鐘經濟", group: "我自己", higherIsBetter: true },
  { key: "participants.avg_taken", label: "我承受的傷害", group: "我自己", higherIsBetter: false },
  { key: "participants.avg_survival", label: "最長存活(秒)", group: "我自己", higherIsBetter: true },
]

const SHARE_METRICS: Metric[] = [
  { key: "participants.damage_share", label: "我的傷害佔比", group: "隊內佔比", decimals: 1, suffix: "%", higherIsBetter: true },
  { key: "participants.tank_share", label: "我的承傷佔比", group: "隊內佔比", decimals: 1, suffix: "%", higherIsBetter: true },
  { key: "participants.kill_participation", label: "我的參團率", group: "隊內佔比", decimals: 1, suffix: "%", higherIsBetter: true },
]

const ALL_METRICS = [...TEAM_METRICS, ...MINE_METRICS, ...SHARE_METRICS]

// 好壞方向每個指標都不一樣：敵方傷害變高是壞事，我的 KDA 變高是好事。差不到 3% 就不上色，免得看起來像有事
const toneOf = (diff: number | null, higherIsBetter: boolean) =>
  diff === null || Math.abs(diff) < 3 ? null : diff > 0 === higherIsBetter ? "good" : "bad"

const fmtMetric = (n: number, decimals = 0, suffix = "") =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`

/** 「所有人」是每場兩隊十個人都算：
 *  - 隊內佔比（傷害、承傷、參團率）在全體平均上必然是固定值（5 人分 100%），勝局敗局不會有差，整組不列。
 *  - 敵方的數字就是對面那隊的我方數字（勝局的「敵方」= 敗局的「我方」），整組不列，免得同一件事列兩次。 */
const metricsFor = (who: Who) =>
  who === "all" ? [...TEAM_METRICS.filter((m) => m.key.includes("team_")), ...MINE_METRICS] : ALL_METRICS

/** 切到追蹤對象或所有人之後，「我的」不再是「我」：用中性的字 */
const labelFor = (m: Metric, who: Who) =>
  who === "account" ? m.label : m.label.replace(/^我承受的/, "承受的").replace(/^我的/, "").replace(/^我方/, "本隊").replace(/^敵方/, "對手")

// 表格高 680px + 工具列：載入骨架要一樣高（722px），資料到的時候版面才不會往下推
const columnsFor = (showRef: boolean): GridColumn[] => [
  { key: "group", title: "分類", kind: "dimension", flex: 0.8, minWidth: 90 },
  { key: "label", title: "指標", kind: "dimension", flex: 1.3, minWidth: 140 },
  {
    // 排序依「敗局相差」；兩條細條同刻度，一眼看出勝局和敗局差多少
    key: "diffPct",
    title: "勝局 vs 敗局（敗局相差）",
    kind: "metric",
    flex: 2.6,
    minWidth: 300,
    cell: (r) => (
      <ContrastCell
        win={numOf(r, "win")}
        loss={numOf(r, "loss")}
        format={(n) => fmtMetric(n, Number(r.decimals ?? 0), String(r.suffix ?? ""))}
        diffPct={numOf(r, "diffPct")}
        tone={toneOf(numOf(r, "diffPct"), r.higherIsBetter === true)}
      />
    ),
  },
  ...(showRef
    ? [
        {
          // 同一個「敗局相差」，但是用所有人算：自己的落差比一般人大還是小，一眼可比
          key: "refDiff",
          title: "所有人（敗局相差）",
          kind: "metric" as const,
          flex: 0.9,
          minWidth: 130,
          cell: (r: Record<string, unknown>) => {
            const d = numOf(r, "refDiff")
            const tone = toneOf(d, r.higherIsBetter === true)
            return (
              <span
                title="把資料庫裡每場的十位參賽者都算進來，勝局和敗局各自平均後的相差"
                className={`font-mono text-sm font-semibold tabular-nums ${tone === "good" ? "text-win" : tone === "bad" ? "text-loss" : "text-muted-foreground"}`}
              >
                {d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(1)}%`}
              </span>
            )
          },
        },
      ]
    : []),
  { key: "win", title: "勝局", kind: "metric", hide: true },
  { key: "loss", title: "敗局", kind: "metric", hide: true },
]

export function Losses() {
  const { apply: applyAccount } = useFilters()
  const [who, setWhoState] = useState<Who>("account")
  const scope = useWhoScope(who)
  const apply = scope.q
  const [bucket, setBucket] = useState<string | null>(null)
  useCrumb(10, bucket ? `對局長度 ${bucket}` : null, () => setBucket(null))
  const setWho = (next: Who) => {
    setWhoState(next)
    setBucket(null)
  }
  const noTracked = who === "tracked" && !scope.trackedCount
  const metrics = metricsFor(who)

  const resultQuery = {
    measures: ["participants.games", ...metrics.map((m) => m.key), "matches.avg_duration"],
    dimensions: ["participants.result"],
    limit: 5,
  }
  const byResult = useCube(apply(resultQuery))
  // 對照用：所有人的勝局與敗局。已經在看所有人就不用另外查；「所有人」本身不列的指標（佔比）不查
  const ref = useCube(
    who === "all"
      ? null
      : applyAccount(
          { ...resultQuery, measures: ["participants.games", ...metrics.map((m) => m.key), "matches.avg_duration"] },
          "all",
        ),
  )

  // 對局長度的勝率在「所有人」下每一格都剛好是 50%（一場 5 勝 5 敗），不畫
  const byDuration = useCube(
    who === "all"
      ? null
      : apply({
          measures: ["participants.games", "participants.winrate"],
          dimensions: ["matches.duration_bucket"],
          limit: 10,
        }),
  )

  const win = byResult.rows.find((r) => r["participants.result"] === "勝")
  const loss = byResult.rows.find((r) => r["participants.result"] === "敗")
  const refWin = ref.rows.find((r) => r["participants.result"] === "勝")
  const refLoss = ref.rows.find((r) => r["participants.result"] === "敗")
  const winGames = num(win?.["participants.games"]) ?? 0
  const lossGames = num(loss?.["participants.games"]) ?? 0
  const total = winGames + lossGames

  // 用相對差而不是絕對差,不同量級的指標才排得在一起比
  const diffOf = (w: number | null, l: number | null) => (w !== null && l !== null && w !== 0 ? ((l - w) / Math.abs(w)) * 100 : null)
  const rows = metrics.map((m) => {
    const w = num(win?.[m.key])
    const l = num(loss?.[m.key])
    return {
      group: who === "account" || m.group !== "我自己" ? m.group : "個人",
      label: labelFor(m, who),
      win: w,
      loss: l,
      diffPct: diffOf(w, l),
      refDiff: diffOf(num(refWin?.[m.key]), num(refLoss?.[m.key])),
      higherIsBetter: m.higherIsBetter,
      decimals: m.decimals,
      suffix: m.suffix,
    }
  })
  const columns = useMemo(() => columnsFor(who !== "all"), [who])

  // 依分組的下界由短到長排。Cube 回傳的順序不固定（實測「15-20、< 15、20-25」）
  const bucketStart = (label: string) => (label.startsWith("<") ? 0 : Number(label.match(/\d+/)?.[0] ?? 999))
  const durationBars: BarDatum[] = byDuration.rows
    .map((r) => ({
      label: String(r["matches.duration_bucket"] ?? "—"),
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r["participants.games"]) ?? 0,
    }))
    .sort((a, b) => bucketStart(a.label) - bucketStart(b.label))

  const teamDpmWin = num(win?.["participants.team_dpm"])
  const teamDpmLoss = num(loss?.["participants.team_dpm"])
  const enemyDpmWin = num(win?.["participants.enemy_dpm"])
  const enemyDpmLoss = num(loss?.["participants.enemy_dpm"])
  const oursDrop =
    teamDpmWin && teamDpmLoss ? ((teamDpmLoss - teamDpmWin) / teamDpmWin) * 100 : null
  const theirsRise =
    enemyDpmWin && enemyDpmLoss ? ((enemyDpmLoss - enemyDpmWin) / enemyDpmWin) * 100 : null

  const durWin = num(win?.["matches.avg_duration"])
  const durLoss = num(loss?.["matches.avg_duration"])

  const switcher = <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} />
  if (noTracked) {
    return (
      <div className="space-y-4">
        {switcher}
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的敗因數據。</EmptyState>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {switcher}
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="勝率"
          value={total ? `${((winGames / total) * 100).toFixed(1)}%` : "—"}
          hint={total ? `${winGames} 勝 ${lossGames} 敗${who === "all" ? "・每場兩隊都算，所以是 50%" : ""}` : undefined}
          loading={byResult.loading}
        />
        <Kpi
          label="打不動還是被打爆"
          value={oursDrop !== null && theirsRise !== null ? (Math.abs(theirsRise) > Math.abs(oursDrop) ? "被打爆" : "打不動") : "—"}
          hint={
            oursDrop !== null && theirsRise !== null
              ? `輸時${who === "account" ? "我方" : "本隊"}輸出 ${oursDrop.toFixed(0)}%、${who === "account" ? "敵方" : "對手"} ${theirsRise > 0 ? "+" : ""}${theirsRise.toFixed(0)}%`
              : who === "all"
                ? "兩隊都算，我方和敵方互為鏡像，分不出誰打不動"
                : undefined
          }
          loading={byResult.loading}
        />
        <Kpi
          label="平均局長"
          // matches.avg_duration 在模型裡已經除過 60，單位就是分鐘
          value={durWin !== null && durLoss !== null ? `${durLoss.toFixed(1)} / ${durWin.toFixed(1)} 分` : "—"}
          hint="敗局 / 勝局。輸的局通常比較長，所以傷害與經濟用每分鐘比；擊殺、死亡等是每場平均"
          loading={byResult.loading}
        />
      </div>

      <Panel
        title="勝局與敗局，數字差在哪"
        caption={`「敗局相差」= 敗局比勝局高或低幾 %。勝方色代表往好的方向、敗方色代表往壞的方向，差不到 3% 不上色；可以點欄位標題排序。${
          who === "all"
            ? "「所有人」是每場兩隊十位都算：隊內佔比（5 人分 100%）與敵方數字（就是對面那隊的本隊數字）不列。"
            : "最右邊「所有人」是同一個相差用資料庫裡所有參賽者算的，拿來看自己的落差比一般人大還是小。"
        }`}
      >
        {byResult.loading ? (
          <Skeleton className="h-[722px] w-full" />
        ) : byResult.error ? (
          <QueryError error={byResult.error} />
        ) : !win || !loss ? (
          <EmptyState>這個條件下缺少勝局或敗局，沒得比較。</EmptyState>
        ) : (
          <>
            <AgTable columns={columns} rowHeight={54} rows={rows as unknown as Record<string, unknown>[]} height={680} fileName="win-vs-loss" />
            <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
              <p>
                這張表是<strong>描述</strong>，不是原因。遊戲中的數字大多是輸贏的結果而不是起因——
                落後了才會經濟少、才會被推塔，不是反過來。真正在結果之前就決定的，是英雄、增幅、
                時段、隊友這些，那些在其他頁面。
              </p>
              {who !== "all" && (
                <p>
                  「隊內佔比」那一組比較接近可以自省的部分：如果輸的時候你的佔比反而變高，
                  代表拖住的不是你；反過來就是你自己在輸的局裡也縮了。
                </p>
              )}
              {who === "all" && (
                <p>「對局長度與勝率」在所有人下不畫：一場 5 勝 5 敗，每個長度分組的勝率必然是 50%。</p>
              )}
              <p>和朋友一起打會不會贏，在「隊友 / 對手」頁最上方。</p>
            </div>
          </>
        )}
      </Panel>

      {who !== "all" && (
      <Panel
        title="對局長度與勝率"
        caption="和上面的「平均局長」是同一件事的分組版。注意因果方向：贏的時候通常推得快，所以短局勝率高多半是結果、不是原因。點一根看那些場次"
      >
        {byDuration.loading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : byDuration.error ? (
          <QueryError error={byDuration.error} />
        ) : durationBars.length ? (
          <BarChart
            data={durationBars}
            suffix="%"
            selected={bucket}
            onPick={(label) => setBucket((cur) => (cur === label ? null : label))}
          />
        ) : (
          <EmptyState>還沒有資料。</EmptyState>
        )}
      </Panel>
      )}

      {bucket && (
        // 分組界線只留在語意層（matches.duration_bucket），後端不再各存一份
        <DrillPanel
          title={`對局長度 ${bucket}`}
          gameIdKey="matches.game_id"
          query={apply({
            measures: ["participants.games"],
            dimensions: ["matches.game_id"],
            filters: [{ member: "matches.duration_bucket", operator: "equals", values: [bucket] }],
            limit: MAX_GAME_IDS,
          })}
          matchParams={scope.matchParams({})}
          showPlayer={who !== "account"}
          onClose={() => setBucket(null)}
        />
      )}
    </div>
  )
}
