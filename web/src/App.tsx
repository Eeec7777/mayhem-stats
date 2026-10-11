import { lazy, Suspense, useEffect, useState, type ComponentType } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppShell, type PageId } from "@/components/AppShell"
import { Skeleton } from "@/components/ui/skeleton"
import { FilterProvider, useFilters } from "@/lib/filters"
import { NavContext } from "@/lib/nav"
import { BreadcrumbProvider } from "@/lib/breadcrumb"
import { WhoProvider } from "@/lib/whoState"
import { ThemeProvider } from "@/lib/theme"
import { markNavigation } from "@/lib/motion"
import { Dashboard } from "@/pages/Dashboard"

// 每頁各自成為一個 chunk。表格頁才會載入 AG Grid、圖表頁才會載入 ECharts，
// 全部打包在一起的話首屏要先扛下兩套函式庫（壓縮後將近 900KB）。
const LOADERS = {
  // 儀表板是預設首頁，直接打包進主程式，不走延遲載入。
  dashboard: () => Promise.resolve(Dashboard),
  matches: () => import("@/pages/Matches").then((m) => m.Matches),
  tilt: () => import("@/pages/Tilt").then((m) => m.Tilt),
  losses: () => import("@/pages/Losses").then((m) => m.Losses),
  champions: () => import("@/pages/Champions").then((m) => m.Champions),
  augments: () => import("@/pages/Augments").then((m) => m.Augments),
  lineups: () => import("@/pages/Lineups").then((m) => m.Lineups),
  players: () => import("@/pages/Players").then((m) => m.Players),
  crew: () => import("@/pages/Crew").then((m) => m.Crew),
  time: () => import("@/pages/TimeAnalysis").then((m) => m.TimeAnalysis),
  explore: () => import("@/pages/Explore").then((m) => m.Explore),
  recap: () => import("@/pages/Recap").then((m) => m.Recap),
  tracked: () => import("@/pages/Tracked").then((m) => m.Tracked),
  calc: () => import("@/pages/Calculator").then((m) => m.Calculator),
} satisfies Record<PageId, () => Promise<ComponentType>>

// 已經載入完成的頁面元件。有的話直接渲染，不經過 lazy()。
// React 19 的 Suspense 只要畫過一次 fallback，就會至少等 300ms 才換成內容（避免閃爍）；
// 就算 chunk 早就預載好了，經過 lazy() 的第一次渲染仍會暫停一下而吃到這 300ms。
const RESOLVED: Partial<Record<PageId, ComponentType>> = { dashboard: Dashboard }

const PAGES = {} as Record<PageId, ComponentType>
for (const [id, load] of Object.entries(LOADERS) as [PageId, () => Promise<ComponentType>][]) {
  PAGES[id] = lazy(() => load().then((c) => ({ default: (RESOLVED[id] = c) })))
}

const PAGE_IDS = new Set<PageId>(Object.keys(LOADERS) as PageId[])

function pageFromPath(): PageId {
  const segment = window.location.pathname.replace(/^\/+|\/+$/g, "")
  return PAGE_IDS.has(segment as PageId) ? segment as PageId : "dashboard"
}

/** 當前頁顯示完、瀏覽器閒下來之後，把其他頁的 chunk 先抓好。
 *  否則第一次點進表格頁，要先等 1.1MB 的 AG Grid 下載並解析完才開始查詢。 */
function usePrefetchPages() {
  useEffect(() => {
    const run = () =>
      (Object.entries(LOADERS) as [PageId, () => Promise<ComponentType>][]).forEach(([id, load]) =>
        load().then((c) => (RESOLVED[id] = c), () => {}),
      )
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 4000 })
      return () => window.cancelIdleCallback(id)
    }
    const id = setTimeout(run, 1500)
    return () => clearTimeout(id)
  }, [])
}

export default function App() {
  const [page, setPageState] = useState<PageId>(pageFromPath)
  const [dataRevision, setDataRevision] = useState(0)
  const setPage = (next: PageId) => {
    if (next === page) return
    markNavigation()
    window.history.pushState(null, "", `/${next}`)
    setPageState(next)
  }
  useEffect(() => {
    const onPopState = () => {
      markNavigation()
      setPageState(pageFromPath())
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])
  useEffect(() => {
    // 已經開著的分頁不會自己換成新版程式：資料（語意層、mat_* 表）跟著服務更新了，畫面上卻還是舊版的程式，
    // 兩邊的定義對不上（例：出裝定位從九類收斂成六類後，舊程式找不到「AD 鬥士」，雷達上全變成「沒打過」）。
    // 所以資料一變、重新連線或切回這個分頁時，比一下伺服器上 index.html 引用的主程式檔名，換了就重新載入。
    const checkBuild = () => {
      const current = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute("src")
      if (!current) return // 開發模式（vite）沒有建置檔名
      fetch("/", { cache: "no-store" })
        .then((r) => (r.ok ? r.text() : ""))
        .then((html) => {
          const latest = html.match(/\/assets\/index-[\w-]+\.js/)?.[0]
          if (latest && !current.endsWith(latest)) window.location.reload()
        })
        .catch(() => {})
    }
    const onVisible = () => document.visibilityState === "visible" && checkBuild()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("mayhem:data-changed", checkBuild)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("mayhem:data-changed", checkBuild)
    }
  }, [])
  useEffect(() => {
    const stream = new EventSource("/api/events")
    let opened = false
    stream.onopen = () => {
      // 斷線期間可能已經寫入資料；重連後也要重查。
      if (opened) {
        setDataRevision((n) => n + 1)
        window.dispatchEvent(new Event("mayhem:data-changed"))
      }
      opened = true
    }
    stream.addEventListener("data-changed", () => {
      setDataRevision((n) => n + 1)
      window.dispatchEvent(new Event("mayhem:data-changed"))
    })
    return () => stream.close()
  }, [])
  const Page = RESOLVED[page] ?? PAGES[page]
  usePrefetchPages()

  // 側邊欄收合時的標籤靠 Tooltip 顯示，需要這層 Provider（這版 shadcn 不再內建）
  return (
    <ThemeProvider>
    <TooltipProvider delayDuration={200}>
      <FilterProvider>
        <NavContext.Provider value={setPage}>
        <BreadcrumbProvider>
        <WhoProvider>
        <AppShell page={page} onNavigate={setPage}>
          {/* 換頁只做淡入，不做離場動畫。
              原本用 AnimatePresence mode="wait"：新頁要等舊頁的離場動畫跑完才會掛載，
              查詢也就晚了這麼久才送出。實測回訪一頁總共約 280ms，其中 214ms 是在等動畫。
              淡入用 CSS（page-enter），不用 motion：JS 驅動的動畫會被同時掛載的表格卡住。 */}
          <div key={page} className="page-enter">
            <Suspense fallback={<Skeleton className="h-[420px] w-full" />}>
              <AfterAccountReady>
                <Page key={dataRevision} />
              </AfterAccountReady>
            </Suspense>
          </div>
        </AppShell>
        </WhoProvider>
        </BreadcrumbProvider>
        </NavContext.Provider>
      </FilterProvider>
    </TooltipProvider>
    </ThemeProvider>
  )
}

/** 帳號確定之前不掛載頁面，理由見 FilterState.ready。 */
function AfterAccountReady({ children }: { children: React.ReactNode }) {
  const { ready } = useFilters()
  return ready ? children : <Skeleton className="h-[420px] w-full" />
}
