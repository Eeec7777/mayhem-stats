import { useMemo, useState, type CSSProperties, type ReactNode } from "react"
import {
  Calculator,
  LayoutDashboard,
  Swords,
  Sparkles,
  Users,
  CalendarClock,
  Compass,
  Zap,
  RefreshCw,
  X,
  Circle,
  ScrollText,
  Activity,
  Radar,
  TrendingDown,
  ChevronRight,
  Filter,
  GitCompareArrows,
  Shield,
  Clapperboard,
  ChevronDown,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCollectorStatus, useCube } from "@/hooks/useCube"
import { DATE_RANGES, useFilters } from "@/lib/filters"
import { MAYHEM_QUEUE_ID } from "@/lib/cube"
import { AccountSwitcher, ViewingOtherBanner } from "@/components/AccountSwitcher"
import { ThemeSwitcher } from "@/components/ThemeSwitcher"
import { useCrumbs } from "@/lib/breadcrumb"

export type PageId =
  | "dashboard"
  | "matches"
  | "champions"
  | "augments"
  | "lineups"
  | "players"
  | "crew"
  | "time"
  | "tilt"
  | "losses"
  | "explore"
  | "tracked"
  | "recap"
  | "calc"

const NAV: { group: string; items: { id: PageId; label: string; icon: typeof Zap }[] }[] = [
  {
    group: "總覽",
    items: [
      { id: "dashboard", label: "儀表板", icon: LayoutDashboard },
      { id: "matches", label: "對局紀錄", icon: ScrollText },
    ],
  },
  {
    group: "分析",
    items: [
      { id: "champions", label: "英雄", icon: Swords },
      { id: "augments", label: "增幅裝置", icon: Sparkles },
      { id: "lineups", label: "陣容", icon: Shield },
      { id: "players", label: "隊友 / 對手", icon: Users },
      { id: "crew", label: "好友比較", icon: GitCompareArrows },
      { id: "time", label: "時段", icon: CalendarClock },
      { id: "tilt", label: "節奏與連敗", icon: Activity },
      { id: "losses", label: "敗因分析", icon: TrendingDown },
    ],
  },
  {
    group: "工具",
    items: [
      { id: "calc", label: "出裝計算機", icon: Calculator },
      { id: "recap", label: "賽季回顧", icon: Clapperboard },
      { id: "explore", label: "自由探索", icon: Compass },
      { id: "tracked", label: "追蹤對象", icon: Radar },
    ],
  },
]

const PAGE_TITLES: Record<PageId, { title: string; caption: string }> = {
  dashboard: { title: "儀表板", caption: "整體表現與趨勢的一頁式總覽" },
  matches: { title: "對局紀錄", caption: "逐場瀏覽，點進去看完整戰報" },
  tilt: { title: "節奏與連敗", caption: "上一場的結果、同一輪連打到第幾場，和勝率的關係" },
  losses: { title: "敗因分析", caption: "輸的時候，哪些數字和贏的時候不一樣" },
  champions: { title: "英雄", caption: "每個英雄的場次、勝率與輸出表現" },
  augments: { title: "增幅裝置", caption: "各增幅的勝率，以及在特定英雄上的契合度" },
  lineups: { title: "陣容", caption: "什麼陣容比較會贏，以及在各種陣容下出什麼裝" },
  players: { title: "隊友 / 對手", caption: "和朋友一起打會不會贏、和誰同隊會贏、遇到誰會輸" },
  crew: { title: "好友比較", caption: "你和追蹤中的好友並排比較：整體戰績、各類型勝率與擅長的英雄" },
  time: { title: "時段", caption: "每天、星期與時段的表現分佈" },
  explore: { title: "自由探索", caption: "自選維度與指標，做任意組合的分析" },
  recap: { title: "賽季回顧", caption: "把這段時間的戰績做成一支可以直接播放的短片" },
  calc: { title: "出裝計算機", caption: "依你現在的面板和對手的雙防，算每件裝備的傷害與坦度效益" },
  tracked: { title: "追蹤對象", caption: "除了自己以外，還要一併採集誰的戰績" },
}

function CollectorPill() {
  const status = useCollectorStatus()
  const [ingesting, setIngesting] = useState(false)

  if (!status) return null

  const ingestNow = async () => {
    setIngesting(true)
    try {
      await fetch("/api/ingest", { method: "POST" })
    } finally {
      setIngesting(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg bg-sidebar-accent/60 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium">
        <Circle
          className={
            status.clientConnected
              ? "size-2 shrink-0 fill-win text-win"
              : "size-2 shrink-0 fill-muted-foreground text-muted-foreground"
          }
        />
        {status.clientConnected ? "客戶端已連線" : "客戶端未執行"}
      </div>
      <div className="text-muted-foreground">
        我的 Mayhem <b className="text-foreground">{status.myMayhemMatches ?? status.mayhemMatches}</b> 場
        <br />
        資料庫共 {status.totalMatches} 場
        {status.trackedCount ? `（追蹤 ${status.trackedCount} 人）` : ""}
      </div>
      {status.lastRun && (
        <div className="text-muted-foreground">
          上次採集{" "}
          {new Date(status.lastRun.at * 1000).toLocaleTimeString("zh-TW", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      )}
      {status.public ? (
        <div className="text-[11px] text-muted-foreground">唯讀模式（對外開放中）</div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full text-xs"
          onClick={ingestNow}
          disabled={ingesting}
        >
          <RefreshCw className={ingesting ? "animate-spin" : ""} />
          {ingesting ? "採集中…" : "立即採集"}
        </Button>
      )}
    </div>
  )
}

/** 遊戲版本（主.次）的多選。選項來自資料裡實際有的版本，不受期間篩選影響（選了 7 天也要看得到舊版本）。 */
function VersionFilter() {
  const { versions, setVersions } = useFilters()
  const query = useMemo(
    () => ({
      measures: ["matches.count"],
      dimensions: ["matches.patch"],
      filters: [{ member: "matches.queue_id", operator: "equals" as const, values: [MAYHEM_QUEUE_ID] }],
      order: { "matches.patch": "asc" as const },
      limit: 100,
    }),
    [],
  )
  const { rows, loading } = useCube(query)
  const options = useMemo(
    () =>
      rows
        .map((r) => ({ patch: String(r["matches.patch"]), games: Number(r["matches.count"] ?? 0) }))
        // 版號要照數字排（16.9 在 16.10 前面），字串排序會錯
        .sort((a, b) => {
          const [am, an] = a.patch.split(".").map(Number)
          const [bm, bn] = b.patch.split(".").map(Number)
          return am - bm || an - bn
        }),
    [rows],
  )
  const toggle = (patch: string, on: boolean) => {
    const next = on ? [...versions, patch] : versions.filter((v) => v !== patch)
    setVersions(options.map((o) => o.patch).filter((p) => next.includes(p)))
  }
  const label = !versions.length ? "全部版本" : versions.length <= 2 ? versions.join("、") : `${versions[0]} 等 ${versions.length} 個`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-[150px] justify-between gap-2 font-normal" disabled={loading && !options.length}>
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>遊戲版本（可多選）</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => setVersions([])} disabled={!versions.length}>
          全部版本
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {options.map((o) => (
          <DropdownMenuCheckboxItem
            key={o.patch}
            checked={versions.includes(o.patch)}
            // 多選時選單不要每點一下就關掉
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(on) => toggle(o.patch, on)}
          >
            <span className="font-mono">{o.patch}</span>
            <span className="ml-auto pl-4 text-xs text-muted-foreground">{o.games} 場</span>
          </DropdownMenuCheckboxItem>
        ))}
        {!options.length && !loading && <div className="px-2 py-1.5 text-xs text-muted-foreground">資料裡還沒有版本資訊</div>}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GlobalFilters() {
  const { queueId, setQueueId, dateRange, setDateRange } = useFilters()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <AccountSwitcher />
      <Select value={queueId ?? "all"} onValueChange={(v) => setQueueId(v === "all" ? null : v)}>
        <SelectTrigger size="sm" className="w-[136px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={MAYHEM_QUEUE_ID}>只看 Mayhem</SelectItem>
          <SelectItem value="all">全部模式</SelectItem>
        </SelectContent>
      </Select>

      <Select value={dateRange} onValueChange={setDateRange}>
        <SelectTrigger size="sm" className="w-[128px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DATE_RANGES.map((range) => (
            <SelectItem key={range.value} value={range.value}>
              {range.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <VersionFilter />

    </div>
  )
}

/** 麵包屑：頁名 › 全域下鑽（跨頁生效，可個別移除）› 頁面內各層聚焦（登記自 useCrumb）。
 *  點某一層清掉比它深的所有層；點頁名清掉這頁的所有聚焦。取代原本散在各處的篩選標籤。 */
function Breadcrumb({ title, caption }: { title: string; caption: string }) {
  const { drills, removeDrill, clearDrills } = useFilters()
  const crumbs = useCrumbs()
  // 由深到淺清，避免淺層的 clear 觸發重新渲染時深層還在
  const clearFrom = (index: number) => [...crumbs.slice(index)].reverse().forEach((c) => c.clear())
  const empty = !drills.length && !crumbs.length

  return (
    <div className="mr-auto min-w-0">
      <h1 className="truncate text-base font-semibold leading-tight">
        {crumbs.length ? (
          <button onClick={() => clearFrom(0)} className="transition hover:text-primary" title="回到這頁的最上層">
            {title}
          </button>
        ) : (
          title
        )}
      </h1>
      {empty ? (
        <p className="truncate text-xs text-muted-foreground">{caption}</p>
      ) : (
        <nav aria-label="目前位置" className="mt-0.5">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs">
            {drills.map((drill, index) => (
              <li key={`d${index}`} className="slide-in flex items-center gap-1" style={{ "--stagger": `${index * 30}ms` } as CSSProperties}>
                <ChevronRight className="size-3 text-muted-foreground" />
                <span className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2 pr-1 text-primary">
                  <Filter className="size-3" />
                  <button onClick={() => clearFrom(0)} title="跨頁生效的篩選；點這裡清掉這頁更深的聚焦">
                    {drill.label}
                  </button>
                  <button onClick={() => removeDrill(index)} className="rounded-full p-0.5 opacity-70 transition hover:bg-primary/20 hover:opacity-100" aria-label={`移除篩選 ${drill.label}`}>
                    <X className="size-3" />
                  </button>
                </span>
              </li>
            ))}
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1
              return (
                <li key={crumb.id} className="slide-in flex items-center gap-1" style={{ "--stagger": `${(drills.length + index) * 30}ms` } as CSSProperties}>
                  <ChevronRight className="size-3 text-muted-foreground" />
                  {last ? (
                    <span className="font-medium text-foreground" aria-current="location">{crumb.label}</span>
                  ) : (
                    <button onClick={() => clearFrom(index + 1)} className="text-muted-foreground transition hover:text-primary">
                      {crumb.label}
                    </button>
                  )}
                </li>
              )
            })}
            {drills.length + crumbs.length > 1 && (
              <li>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-1 h-6 px-2 text-xs"
                  onClick={() => {
                    clearFrom(0)
                    clearDrills()
                  }}
                >
                  全部清除
                </Button>
              </li>
            )}
          </ol>
        </nav>
      )}
    </div>
  )
}

function NavSections({
  page,
  onNavigate,
}: {
  page: PageId
  onNavigate: (page: PageId) => void
}) {
  const { isMobile, setOpenMobile } = useSidebar()

  const go = (id: PageId) => {
    onNavigate(id)
    // 窄螢幕時側邊欄是覆蓋式抽屜，選完不關的話遮罩會擋住底下的操作
    if (isMobile) setOpenMobile(false)
  }

  return (
    <>
      {NAV.map((section) => (
        <SidebarGroup key={section.group}>
          <SidebarGroupLabel>{section.group}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={page === item.id}
                    tooltip={item.label}
                    onClick={() => go(item.id)}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  )
}

export function AppShell({
  page,
  onNavigate,
  children,
}: {
  page: PageId
  onNavigate: (page: PageId) => void
  children: ReactNode
}) {
  const meta = PAGE_TITLES[page]

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/15">
              <Zap className="size-4 text-primary" />
            </div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <div className="truncate text-sm font-semibold leading-tight">Mayhem 戰績</div>
              <div className="truncate text-[11px] text-muted-foreground">本機 BI</div>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <NavSections page={page} onNavigate={onNavigate} />
        </SidebarContent>

        <SidebarFooter className="group-data-[collapsible=icon]:hidden">
          <CollectorPill />
        </SidebarFooter>
      </Sidebar>

      {/* 透明底：讓 body 的主題光暈與格線透出來 */}
      {/* min-w-0：flex 子元素預設 min-width: auto，內容一寬就把整塊推出視窗（768px 寬時對局紀錄、好友比較橫向溢出） */}
      <SidebarInset className="min-w-0 bg-transparent">
        {/* id 給好友比較的分頁列量高度：標題列會換行，分頁列要貼在它正下方 */}
        <header id="app-header" className="sticky top-0 z-20 flex flex-col gap-3 border-b bg-background/85 px-5 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center gap-3">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="!h-5" />
            <Breadcrumb title={meta.title} caption={meta.caption} />
            <GlobalFilters />
            <ThemeSwitcher />
          </div>
        </header>

        <main className="min-w-0 flex-1 p-5">
          <ViewingOtherBanner />
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
