import { useMemo, useState } from "react"
import { BarCell, LiftCell, RecordCell, StatCell, num0, numOf, solidMax } from "@/components/cells"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Panel, EmptyState, QueryError } from "@/components/primitives"
import { AgTable, type GridColumn } from "@/components/AgTable"
import { DrillPanel } from "@/components/MatchList"
import { BarChart, type BarDatum } from "@/components/charts"
import { useCube } from "@/hooks/useCube"
import { MAX_GAME_IDS, num, type CubeFilter, type CubeRow } from "@/lib/cube"
import { useFilters } from "@/lib/filters"
import { useCrumb } from "@/lib/breadcrumb"
import { WhoSwitch } from "@/components/WhoSwitch"
import { usePageWho } from "@/lib/whoState"
import { useWhoScope, type Who } from "@/lib/who"
import { MIN_GAMES, NO_LIMIT, round0, round1 } from "./shared"

const ALL = "__all__"

const G = "participants.games"

/** 以增幅分組時排除「沒有增幅」的參賽者：participants 對 augments 是 left join，
 *  沒選到增幅的人（掛網、非 Mayhem 模式）會變成一列名稱空白的增幅。
 *  自己的場次幾乎不會有，切到「所有人」就會冒出來（Mayhem 裡有 3 位）。 */
const HAS_AUGMENT: CubeFilter = { member: "augments.name", operator: "set", values: [] }

/** 複合格子的欄位（規則見 ui-conventions skill）。選了英雄時多一欄「契合度」子彈圖。 */
function buildColumns(
  rows: CubeRow[],
  withSynergy: boolean,
  baselineWr: number | null,
  baselineDpm: number | null,
  baselineLabel: string,
): GridColumn[] {
  const maxDpm = solidMax(rows, "participants.dpm", G, MIN_GAMES)

  return [
    { key: "augments.name", title: "增幅裝置", kind: "dimension", iconKey: "augments.icon_path", rarityKey: "augments.rarity", flex: 1.8, minWidth: 190 },
    { key: G, title: "場次", kind: "metric", format: round0, flex: 0.5, minWidth: 70 },
    {
      key: "participants.winrate",
      title: "戰績",
      kind: "metric",
      flex: 1.4,
      minWidth: 165,
      cell: (r) => (
        <RecordCell
          winrate={numOf(r, "participants.winrate")}
          wins={num0(r, "participants.wins")}
          losses={num0(r, G) - num0(r, "participants.wins")}
          baseline={baselineWr}
          baselineLabel={withSynergy ? "這隻英雄的整體勝率" : baselineLabel}
        />
      ),
    },
    ...(withSynergy
      ? ([
          {
            key: "lift",
            title: "契合度（加成）",
            kind: "metric",
            flex: 1.6,
            minWidth: 190,
            cell: (r) => (
              <LiftCell
                winrate={numOf(r, "participants.winrate")}
                base={numOf(r, "baseWr")}
                sub={
                  numOf(r, "baseWr") === null
                    ? "沒有其他英雄的紀錄"
                    : `所有英雄 ${round1(num0(r, "baseWr"))}% · ${round0(num0(r, "baseGames"))} 場`
                }
              />
            ),
          },
        ] satisfies GridColumn[])
      : []),
    {
      key: "participants.kda",
      title: "KDA",
      kind: "metric",
      flex: 1,
      minWidth: 140,
      cell: (r) => (
        <StatCell
          main={numOf(r, "participants.kda")?.toFixed(2) ?? "—"}
          sub={`${round1(num0(r, "participants.avg_kills"))}/${round1(num0(r, "participants.avg_deaths"))}/${round1(num0(r, "participants.avg_assists"))}`}
        />
      ),
    },
    {
      key: "participants.dpm",
      title: "輸出（每分鐘傷害）",
      kind: "metric",
      flex: 1.6,
      minWidth: 200,
      cell: (r) => (
        <BarCell value={numOf(r, "participants.dpm")} max={maxDpm} reference={baselineDpm} label={round0(num0(r, "participants.dpm"))} />
      ),
    },
    { key: "participants.wins", title: "勝場", kind: "metric", hide: true },
    { key: "participants.avg_kills", title: "平均擊殺", kind: "metric", hide: true },
    { key: "participants.avg_deaths", title: "平均死亡", kind: "metric", hide: true },
    { key: "participants.avg_assists", title: "平均助攻", kind: "metric", hide: true },
    ...(withSynergy
      ? ([
          { key: "baseWr", title: "所有英雄勝率", kind: "metric", hide: true },
          { key: "baseGames", title: "所有英雄場次", kind: "metric", hide: true },
        ] satisfies GridColumn[])
      : []),
  ]
}

export function Augments() {
  const { addDrill, drills } = useFilters()
  // 看誰的數據（和英雄頁同一個切換列）。之後所有查詢都走 scope.q，不直接用 apply
  const [who, setWhoState] = usePageWho()
  const scope = useWhoScope(who)
  const apply = scope.q
  const [picked, setPicked] = useState<string>(ALL)
  // 交叉篩選：點長條 → 表格選取並捲到那一列；點表格一列 → 長條亮起那一根。再點一次取消
  const [focus, setFocus] = useState<string | null>(null)
  const toggleFocus = (name: string) => setFocus((cur) => (cur === name ? null : name))
  // 從別頁下鑽來的英雄已經是全域篩選（麵包屑裡的標籤），這裡只登記本頁選單選的
  useCrumb(10, picked === ALL || drills.some((d) => d.member === "champions.name") ? null : `${picked} 上的增幅`, () => setPicked(ALL))
  useCrumb(20, focus, () => setFocus(null))

  // 已經從別頁下鑽到某隻英雄的話，就以那隻為準，選單鎖住，免得兩個條件打架
  const drilled = drills.find((d) => d.member === "champions.name")?.values[0] ?? null
  const champion = drilled ?? (picked === ALL ? null : picked)
  // 換人看時，選單裡的英雄與聚焦的增幅可能已經不在了
  const setWho = (next: Who) => {
    setWhoState(next)
    setPicked(ALL)
    setFocus(null)
  }
  const noTracked = who === "tracked" && !scope.trackedCount

  const champions = useCube(
    apply({
      measures: ["participants.games"],
      dimensions: ["champions.name"],
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )

  const { rows, loading, error } = useCube(
    apply({
      measures: [
        "participants.games",
        "participants.wins",
        "participants.winrate",
        "participants.kda",
        "participants.avg_kills",
        "participants.avg_deaths",
        "participants.avg_assists",
        "participants.dpm",
      ],
      dimensions: ["augments.name", "augments.rarity", "augments.icon_path"],
      filters: [
        HAS_AUGMENT,
        ...(champion && !drilled ? [{ member: "champions.name", operator: "equals" as const, values: [champion] }] : []),
      ],
      order: { "participants.games": "desc" },
      limit: NO_LIMIT,
    }),
  )

  // 基準線：同一個增幅在「所有英雄」上的勝率。套用其他全域條件，但拿掉英雄這一個。
  const baselineQuery = apply({
    measures: ["participants.games", "participants.winrate"],
    dimensions: ["augments.name"],
    filters: [HAS_AUGMENT],
    limit: NO_LIMIT,
  })
  const baseline = useCube(
    champion
      ? { ...baselineQuery, filters: (baselineQuery.filters ?? []).filter((f) => f.member !== "champions.name") }
      : null,
  )

  // 整體刻度線必須獨立查詢，不能把每場的多個增幅分組再加總；增幅數不同時會重複加權。
  // 這筆查詢與表格使用同一個玩家、模式、日期及英雄條件，但不按增幅分組。
  const overallQuery = apply({
    measures: ["participants.games", "participants.wins", "participants.dpm"],
    filters: champion && !drilled ? [{ member: "champions.name", operator: "equals", values: [champion] }] : [],
    limit: 1,
  })
  const overall = useCube(overallQuery)
  const overallRow = overall.rows[0]
  const overallGames = overallRow ? num0(overallRow, "participants.games") : 0
  const overallWr = overallGames ? (100 * num0(overallRow, "participants.wins")) / overallGames : null
  const overallDpm = overallRow ? num(overallRow["participants.dpm"]) : null

  // 資料沒變就回傳同一個陣列：欄位定義跟著它重建，每次都換新的話 AG Grid 會把使用者點的排序重設
  const tableRows = useMemo(() => {
    const baseMap = new Map(
      baseline.rows.map((r) => [
        String(r["augments.name"]),
        { wr: num(r["participants.winrate"]), games: num(r["participants.games"]) ?? 0 },
      ]),
    )
  
    // 單一英雄的樣本通常只有個位數，所以選了英雄時什麼都不藏，全部列出來。
    // 排序用場次而不是加成：依加成排的話，最上面會整排是「1 場 1 勝 → +50pp」這種雜訊。
    // 想看加成排行點欄位標題就能換。
    return champion
      ? rows
          .map((r): CubeRow => {
            const base = baseMap.get(String(r["augments.name"]))
            const wr = num(r["participants.winrate"])
            return {
              ...r,
              baseWr: base?.wr ?? null,
              baseGames: base?.games ?? null,
              lift: wr !== null && base?.wr != null ? wr - base.wr : null,
            }
          })
          .sort(
            (a, b) =>
              (num(b["participants.games"]) ?? 0) - (num(a["participants.games"]) ?? 0) ||
              (num(b.lift) ?? -999) - (num(a.lift) ?? -999),
          )
      : rows
  }, [rows, baseline.rows, champion])
  const columns = useMemo(
    () => buildColumns(tableRows, !!champion, overallWr, overallDpm, scope.baselineLabel),
    [tableRows, champion, overallWr, overallDpm, scope.baselineLabel],
  )

  // 全部英雄時圖表只放樣本夠的，否則整張圖都是 1 場 100% 的雜訊。
  // 單一英雄時幾乎沒有增幅到得了門檻，圖會永遠是空的——改成全部都畫，
  // 長條顏色本來就會依場次往平均收斂，1 場全勝不會被畫成深綠。
  const chartMin = champion ? 1 : MIN_GAMES
  const top: BarDatum[] = rows
    .filter((r) => (num(r["participants.games"]) ?? 0) >= chartMin)
    .map((r) => ({
      label: String(r["augments.name"] ?? "—"),
      value: num(r["participants.winrate"]) ?? 0,
      games: num(r["participants.games"]) ?? 0,
    }))
    .sort((a, b) => b.value - a.value)

  return (
    <div className="space-y-4">
      <WhoSwitch who={who} onChange={setWho} trackedCount={scope.trackedCount} />
      {noTracked ? (
        <EmptyState>還沒有追蹤任何玩家。到「追蹤對象」頁加人之後，這裡就能看他們的增幅數據。</EmptyState>
      ) : (
      <>
      <Panel
        title="看某隻英雄上的表現"
        caption="選一隻英雄，表格會多出「契合度」：條是這個增幅在這隻英雄上的勝率，刻度線是它在所有英雄上的勝率，差距就是加成"
      >
        {champions.loading ? (
          <Skeleton className="h-9 w-72" />
        ) : champions.error ? (
          <QueryError error={champions.error} />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Select value={drilled ?? picked} onValueChange={setPicked} disabled={!!drilled}>
              <SelectTrigger className="w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>全部英雄</SelectItem>
                {champions.rows.map((r) => (
                  <SelectItem key={String(r["champions.name"])} value={String(r["champions.name"])}>
                    {String(r["champions.name"])}（{num(r["participants.games"])} 場）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {drilled && (
              <span className="text-xs text-muted-foreground">
                已從其他頁下鑽到「{drilled}」，要換英雄請先移除上方的篩選標籤。
              </span>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title={champion ? `${champion} 最常選的增幅` : "勝率排行"}
        caption={
          champion
            ? "這隻英雄選過的每個增幅，依勝率排列，超過 14 個時在圖上捲動。樣本多半只有一兩場，長條顏色已依場次往平均收斂——滑過長條看場次"
            : `僅計入 ${MIN_GAMES} 場以上的增幅，超過 14 個時在圖上捲動。點一根長條（或表格的一列）會列出選了它的每一場，表格與長條也會互相亮起`
        }
      >
        {loading ? (
          <Skeleton className="h-[320px] w-full" />
        ) : top.length ? (
          // 平均線要傳整體勝率：預設的「長條自己的加權平均」會把一場的多個增幅重複計入
          // （實測 50.3%，同一頁表格的刻度是真正的整體 48.0%）
          <BarChart data={top} suffix="%" selected={focus} onPick={toggleFocus} baseline={overallWr ?? undefined} />
        ) : (
          <EmptyState>
            {champion ? "這個條件下這隻英雄還沒有增幅紀錄。" : `還沒有任何增幅累積到 ${MIN_GAMES} 場，再多打幾場就會出現。`}
          </EmptyState>
        )}
      </Panel>

      {focus && (
        <DrillPanel
          title={champion ? `${champion} 選了「${focus}」` : `選了「${focus}」`}
          gameIdKey="matches.game_id"
          // 目前帳號以外：每一列是「那場選了這個增幅的人」（有選英雄時再鎖那隻），卡片標出是誰
          matchParams={scope.matchParams({ augment: focus, ...(champion ? { champion } : {}) })}
          showPlayer={who !== "account"}
          query={apply({
            measures: ["participants.games"],
            dimensions: ["matches.game_id"],
            filters: [
              { member: "augments.name", operator: "equals", values: [focus] },
              ...(champion && !drilled ? [{ member: "champions.name", operator: "equals", values: [champion] }] : []),
            ],
            limit: MAX_GAME_IDS,
          })}
          onClose={() => setFocus(null)}
        />
      )}

      <Panel
        title={champion ? `${champion} 的增幅契合度` : "全部增幅"}
        caption={
          champion
            ? `這隻英雄選過的全部增幅，依場次排序（點「加成」標題可改依加成排）。加成 = 在這隻英雄上的勝率 − 在所有英雄上的勝率：有些增幅本來就強、在誰身上都好，加成才看得出「特別適合這隻英雄」。場次少的列看場次欄判斷，那是線索不是結論。`
            : `這份資料只有這個資料庫拿得到——Riot 對 Mayhem 封鎖了公開 API，任何第三方網站都算不出增幅勝率。`
        }
      >
        {loading || overall.loading || (champion && baseline.loading) ? (
          <Skeleton className="h-[480px] w-full" />
        ) : error ? (
          <div className="text-sm text-destructive">{error}</div>
        ) : (
          <AgTable
            columns={columns}
            rowHeight={54}
            highlight={focus ? { key: "augments.name", value: focus } : null}
            onRowClick={(row) => toggleFocus(String(row["augments.name"]))}
            rows={tableRows}
            emptyHint={champion ? "這個條件下這隻英雄還沒有增幅紀錄。" : undefined}
            height={520}
            fileName={champion ? `augments-${champion}` : "augments"}
            onDrill={(_col, value) =>
              addDrill({
                member: "augments.name",
                operator: "equals",
                values: [value],
                label: `增幅：${value}`,
              })
            }
          />
        )}
      </Panel>
      </>
      )}
    </div>
  )
}
