import { useCallback, useEffect, useState } from "react"
import { Plus, X, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel, EmptyState, Kpi } from "@/components/primitives"
import { useCollectorStatus } from "@/hooks/useCube"

type Account = { puuid: string; riot_id: string | null; games: number; shared?: number }
type AccountsPayload = {
  me: { puuid: string; riot_id: string }[]
  tracked: Account[]
  candidates: Account[]
}

export function Tracked() {
  const [data, setData] = useState<AccountsPayload | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [ingesting, setIngesting] = useState(false)
  const status = useCollectorStatus()

  const load = useCallback(async () => {
    const res = await fetch("/api/accounts")
    setData(await res.json())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const toggle = async (puuid: string, tracked: boolean) => {
    setBusy(puuid)
    setError(null)
    try {
      const res = await fetch("/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ puuid, tracked }),
      })
      const body = await res.json()
      if (body.error) setError(body.error)
      await load()
    } finally {
      setBusy(null)
    }
  }

  const collectNow = async () => {
    setIngesting(true)
    try {
      await fetch("/api/ingest", { method: "POST" })
      await load()
    } finally {
      setIngesting(false)
    }
  }

  // 對外開放的唯讀模式：寫入端點會回 403，這頁的入口就不要留著讓人白按
  const readOnly = !!status?.public
  const trackedIds = new Set(data?.tracked.map((a) => a.puuid) ?? [])
  const candidates = (data?.candidates ?? []).filter(
    (c) => !trackedIds.has(c.puuid) && (c.riot_id ?? "").toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi
          label="我的 Mayhem 場次"
          value={status ? String(status.myMayhemMatches ?? "—") : "—"}
          hint="分析頁面看的是這個數字"
          loading={!status}
        />
        <Kpi
          label="資料庫全部對局"
          value={status ? String(status.totalMatches) : "—"}
          hint="含好友帶進來、你沒參與的場次"
          loading={!status}
        />
        <Kpi
          label="追蹤中的對象"
          value={String(data?.tracked.length ?? 0)}
          hint="每輪採集會一併掃描"
          loading={!data}
        />
      </div>

      {readOnly && (
        <div className="rounded-lg border border-primary/40 bg-primary/10 p-3 text-sm">
          這個站台是<b>對外開放的唯讀模式</b>：採集與追蹤名單只能在這台電腦上操作
          （開 127.0.0.1:5057）。其他玩家的名稱也已經換成代號。
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <Panel
        title="追蹤中"
        caption="每次採集會順便掃這些人的紀錄。他們打了你沒參與的對局也會被收進來。"
        action={
          readOnly ? undefined : (
            <Button size="sm" variant="outline" onClick={collectNow} disabled={ingesting}>
              <RefreshCw className={ingesting ? "animate-spin" : ""} />
              {ingesting ? "採集中…" : "立即採集"}
            </Button>
          )
        }
      >
        {!data ? (
          <Skeleton className="h-24 w-full" />
        ) : !data.tracked.length ? (
          <EmptyState>還沒有追蹤任何人。從下面的清單加入。</EmptyState>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.tracked.map((a) => (
              <Badge key={a.puuid} variant="secondary" className="gap-2 py-1.5 pl-3 pr-1.5">
                <span className="font-medium">{a.riot_id ?? a.puuid.slice(0, 8)}</span>
                <span className="text-muted-foreground">
                  同場 {a.shared ?? a.games}
                  {a.shared !== undefined && a.games > a.shared && (
                    <span className="ml-1 text-[10px]">＋{a.games - a.shared} 場你沒參與</span>
                  )}
                </span>
                <button
                  onClick={() => toggle(a.puuid, false)}
                  disabled={busy === a.puuid || readOnly}
                  className="rounded-sm opacity-60 transition hover:opacity-100"
                  aria-label="取消追蹤"
                >
                  <X className="size-3.5" />
                </button>
              </Badge>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        title="可加入的對象"
        caption="只列得出曾經和你同場過的人——客戶端沒有提供公開的名稱查詢，完全沒同場過的帳號查不到。"
      >
        <Input
          placeholder="搜尋名稱…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-3 max-w-xs"
        />
        {!data ? (
          <Skeleton className="h-40 w-full" />
        ) : !candidates.length ? (
          <EmptyState>沒有符合的對象。</EmptyState>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {candidates.map((c) => (
              <button
                key={c.puuid}
                onClick={() => toggle(c.puuid, true)}
                disabled={busy === c.puuid || readOnly}
                className="flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition hover:bg-accent disabled:opacity-50"
              >
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{c.riot_id ?? c.puuid.slice(0, 8)}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{c.games} 場</span>
              </button>
            ))}
          </div>
        )}
      </Panel>

      <div className="space-y-2 text-xs leading-relaxed text-muted-foreground">
        <p>
          <b className="text-foreground">別人的紀錄只給最新 20 場</b>（你自己是 100 場），
          而且一樣不能翻頁。所以追蹤對象的歷史深度比你自己淺很多，也更容易被時間擠掉——
          想累積就得讓採集持續跑。
        </p>
        <p>
          <b className="text-foreground">對常一起玩的人，這通常收不到什麼新東西。</b>
          因為你們的對局你早就有了（而且是完整 10 人版本）。真正會有新資料的，
          是那些偶爾才跟你同隊、大部分時間自己玩的朋友。
        </p>
        <p>
          重複採集不會產生重複資料：對局以 (platform_id, game_id) 為主鍵，
          寫入用 INSERT OR IGNORE，而且抓明細之前會先問資料庫有沒有了。
          同一場不論從誰的清單掃到，都只會存一份。
        </p>
      </div>
    </div>
  )
}
