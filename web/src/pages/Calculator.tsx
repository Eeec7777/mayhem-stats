import { useEffect, useMemo, useState, type ReactNode } from "react"
import { ChevronsUpDown, Plus, Radio, RotateCcw, X } from "lucide-react"
import { AgTable, type GridColumn } from "@/components/AgTable"
import { StatCell } from "@/components/cells"
import { Kpi, Panel, QueryError } from "@/components/primitives"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useCollectorStatus } from "@/hooks/useCube"
import { iconUrl } from "@/lib/cube"
import { cn } from "@/lib/utils"
import {
  AUGMENT_RULES,
  ITEM_RULES,
  PRESETS,
  STAT_STEPS,
  ZERO_ADD,
  addStats,
  buildEffects,
  damage,
  effectiveHp,
  estimateTarget,
  estimateThreat,
  evaluateItem,
  type CalcItem,
  type Manual,
  type MyStats,
  type Profile,
  type Target,
  type Threat,
} from "@/lib/calc"

type Catalog = { items: CalcItem[]; augments: { id: number; name: string; icon: string | null }[] }

type LivePlayer = {
  champion: string | null
  championName: string | null
  icon: string | null
  level: number
  isMe: boolean
  ally: boolean
  items: number[]
}
type Live = { inGame: boolean; level?: number; gold?: number; stats?: Partial<MyStats>; players?: LivePlayer[] }

type State = {
  me: MyStats
  target: Target
  profile: Profile
  preset: string
  threat: Threat
  owned: number[]
  augments: Record<number, number>
  manual: Manual
}

// 預設值：11 級左右、身上兩件裝的量級，打開就有一組能看的結果
const DEFAULT_STATE: State = {
  me: {
    level: 11, ad: 160, ap: 0, attackSpeed: 1.1, critChance: 25, critDamage: 2, lethality: 0, armorPenPct: 0,
    magicPen: 0, magicPenPct: 0, haste: 10, hp: 1900, armor: 70, mr: 45, mana: 600, ranged: false,
  },
  target: { level: 11, hp: 2300, armor: 85, mr: 55 },
  profile: PRESETS[0].profile,
  preset: PRESETS[0].id,
  threat: { physPct: 50, magicPct: 45, truePct: 5, lethality: 0, armorPenPct: 0, magicPen: 0, magicPenPct: 0 },
  owned: [],
  augments: {},
  manual: { dmgAmp: 0, armorShred: 0, mrShred: 0 },
}

const STORAGE_KEY = "mayhem-calc"

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STATE
    const saved = JSON.parse(raw) as Partial<State>
    // 一層一層合併：之後加了新欄位，舊的存檔也不會缺值
    return {
      ...DEFAULT_STATE,
      ...saved,
      // 舊版預設把基礎暴擊傷害寫成 1.75（舊版本的數字）；遊戲資料與即時資料都是 2.0，舊存檔沒改過的直接更正
      me: { ...DEFAULT_STATE.me, ...saved.me, ...(saved.me?.critDamage === 1.75 ? { critDamage: 2 } : {}) },
      target: { ...DEFAULT_STATE.target, ...saved.target },
      profile: { ...DEFAULT_STATE.profile, ...saved.profile },
      threat: { ...DEFAULT_STATE.threat, ...saved.threat },
      manual: { ...DEFAULT_STATE.manual, ...saved.manual },
    }
  } catch {
    return DEFAULT_STATE
  }
}

const pct1 = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(1)}%`

type Mode = "dmg" | "ehp" | "mix"

export function Calculator() {
  const [state, setState] = useState<State>(loadState)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>("dmg")
  const [scope, setScope] = useState<"full" | "all">("full")

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* 無痕視窗之類存不了：只是下次要重填 */
    }
  }, [state])

  useEffect(() => {
    let cancelled = false
    fetch("/api/calc/catalog")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((c: Catalog) => !cancelled && setCatalog(c))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [])

  const byId = useMemo(() => new Map((catalog?.items ?? []).map((i) => [i.id, i])), [catalog])
  const set = <K extends keyof State>(key: K, value: State[K]) => setState((s) => ({ ...s, [key]: value }))
  const patch = <K extends "me" | "target" | "profile" | "threat" | "manual">(key: K, field: keyof State[K], v: number | boolean) =>
    setState((s) => ({ ...s, [key]: { ...s[key], [field]: v }, ...(key === "profile" ? { preset: "custom" } : {}) }))

  const effects = useMemo(() => buildEffects(state.owned, state.augments, state.manual), [state.owned, state.augments, state.manual])
  const result = useMemo(() => damage(state.me, effects, state.target, state.profile), [state.me, effects, state.target, state.profile])
  const ehp = useMemo(() => effectiveHp(state.me, effects, state.threat), [state.me, effects, state.threat])

  const ownsBoots = state.owned.some((id) => byId.get(id)?.boots)
  const values = useMemo(() => {
    if (!catalog) return []
    const owned = new Set(state.owned)
    return catalog.items
      .filter((it) => !owned.has(it.id) && !(it.boots && ownsBoots))
      .filter((it) => scope === "all" || it.price >= 2200 || (it.boots && it.price > 300))
      .map((it) => evaluateItem(it, state.me, effects, state.target, state.profile, state.threat, { dmg: result.total, ehp }))
      .filter((v) => Math.abs(v.dmgGain) > 0.05 || Math.abs(v.ehpGain) > 0.05)
  }, [catalog, state, effects, result.total, ehp, ownsBoots, scope])

  const rows = useMemo(
    () =>
      values
        .map((v) => ({
          name: v.item.name,
          icon: v.item.icon,
          price: v.item.price,
          buys: v.item.buys,
          dmgGain: v.dmgGain,
          ehpGain: v.ehpGain,
          dmgPerK: v.dmgPerK,
          ehpPerK: v.ehpPerK,
          mixPerK: (v.dmgPerK + v.ehpPerK) / 2,
          note: v.note ?? "",
        }))
        .sort((a, b) => (mode === "dmg" ? b.dmgPerK - a.dmgPerK : mode === "ehp" ? b.ehpPerK - a.ehpPerK : b.mixPerK - a.mixPerK)),
    [values, mode],
  )

  const columns = useMemo<GridColumn[]>(
    () => [
      { key: "name", title: "裝備", kind: "dimension", iconKey: "icon", flex: 1.4, minWidth: 170, pinned: "left" },
      { key: "price", title: "價格", kind: "metric", format: (n) => n.toLocaleString(), flex: 0.5, minWidth: 80 },
      {
        key: "dmgPerK",
        title: "輸出 每千金",
        kind: "metric",
        flex: 0.8,
        minWidth: 120,
        tone: (v) => (v > 0.05 ? "good" : null),
        cell: (r) => <StatCell main={pct1(Number(r.dmgPerK))} sub={`整件 ${pct1(Number(r.dmgGain))}`} />,
      },
      {
        key: "ehpPerK",
        title: "坦度 每千金",
        kind: "metric",
        flex: 0.8,
        minWidth: 120,
        cell: (r) => <StatCell main={pct1(Number(r.ehpPerK))} sub={`整件 ${pct1(Number(r.ehpGain))}`} />,
      },
      { key: "mixPerK", title: "綜合 每千金", kind: "metric", format: pct1, flex: 0.6, minWidth: 100 },
      { key: "buys", title: "大亂鬥購買", kind: "metric", format: (n) => n.toLocaleString(), flex: 0.5, minWidth: 90 },
      { key: "note", title: "另外計入的被動", kind: "dimension", flex: 1.4, minWidth: 180 },
      { key: "dmgGain", title: "輸出 整件", kind: "metric", hide: true },
      { key: "ehpGain", title: "坦度 整件", kind: "metric", hide: true },
    ],
    [],
  )

  const statSteps = useMemo(
    () =>
      STAT_STEPS.map((step) => {
        const s1 = addStats(state.me, { ...ZERO_ADD, [step.key]: step.amount }, effects, effects)
        const dmg = result.total > 0 ? (damage(s1, effects, state.target, state.profile).total / result.total - 1) * 100 : 0
        const tank = ehp > 0 ? (effectiveHp(s1, effects, state.threat) / ehp - 1) * 100 : 0
        return { ...step, dmg, tank, perK: (Math.max(dmg, tank) / step.gold) * 1000, isTank: tank > dmg }
      }),
    [state.me, state.target, state.profile, state.threat, effects, result.total, ehp],
  )
  const stepMax = Math.max(0.01, ...statSteps.map((s) => Math.max(s.dmg, s.tank)))

  const hitsToKill = result.total > 0 ? state.target.hp / result.total : Infinity

  return (
    <div className="space-y-4">
      <LiveBar
        byId={byId}
        onApply={(live, enemy) =>
          setState((s) => {
            const enemies = (live.players ?? []).filter((p) => !p.ally && !p.isMe)
            const me = (live.players ?? []).find((p) => p.isMe)
            const items = (ids: number[]) => ids.map((id) => byId.get(id)).filter((x): x is CalcItem => !!x)
            const threat = estimateThreat(enemies.map((p) => items(p.items)))
            return {
              ...s,
              me: { ...s.me, ...live.stats, level: live.level ?? s.me.level },
              owned: me ? me.items.filter((id) => byId.has(id)) : s.owned,
              target: enemy ? estimateTarget(enemy.level, items(enemy.items)) : s.target,
              threat: threat ?? s.threat,
            }
          })
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="我的面板" caption="遊戲裡按 C 看到的最終數字（已經含身上的裝備與增幅）" index={0}>
          <FieldGrid>
            <NumField label="等級" value={state.me.level} onChange={(v) => patch("me", "level", v)} min={1} max={18} />
            <NumField label="物攻" value={state.me.ad} onChange={(v) => patch("me", "ad", v)} />
            <NumField label="魔攻" value={state.me.ap} onChange={(v) => patch("me", "ap", v)} />
            <NumField label="攻速" value={state.me.attackSpeed} onChange={(v) => patch("me", "attackSpeed", v)} step={0.01} />
            <NumField label="暴擊率" suffix="%" value={state.me.critChance} onChange={(v) => patch("me", "critChance", v)} />
            <NumField label="暴擊傷害" suffix="倍" value={state.me.critDamage} onChange={(v) => patch("me", "critDamage", v)} step={0.05} />
            <NumField label="物理致命" value={state.me.lethality} onChange={(v) => patch("me", "lethality", v)} />
            <NumField label="物理穿透" suffix="%" value={state.me.armorPenPct} onChange={(v) => patch("me", "armorPenPct", v)} />
            <NumField label="魔法穿透" value={state.me.magicPen} onChange={(v) => patch("me", "magicPen", v)} />
            <NumField label="魔法穿透" suffix="%" value={state.me.magicPenPct} onChange={(v) => patch("me", "magicPenPct", v)} />
            <NumField label="技能加速" value={state.me.haste} onChange={(v) => patch("me", "haste", v)} />
            <NumField label="生命" value={state.me.hp} onChange={(v) => patch("me", "hp", v)} step={50} />
            <NumField label="物防" value={state.me.armor} onChange={(v) => patch("me", "armor", v)} />
            <NumField label="魔防" value={state.me.mr} onChange={(v) => patch("me", "mr", v)} />
            <NumField label="魔力" value={state.me.mana} onChange={(v) => patch("me", "mana", v)} step={50} />
          </FieldGrid>
          <div className="mt-3 flex items-center gap-2 text-xs">
            <span className="w-[4.5rem] shrink-0 text-muted-foreground">攻擊距離</span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={state.me.ranged ? "ranged" : "melee"}
              onValueChange={(v) => v && setState((s) => ({ ...s, me: { ...s.me, ranged: v === "ranged" } }))}
            >
              <ToggleGroupItem value="melee">近戰</ToggleGroupItem>
              <ToggleGroupItem value="ranged">遠程</ToggleGroupItem>
            </ToggleGroup>
            <span className="text-[11px] text-muted-foreground">很多被動對遠程打折</span>
          </div>
        </Panel>

        <Panel title="對手" caption="你要打的那個人；從遊戲帶入時是依他的等級與裝備估的，可以再改" index={1}>
          <FieldGrid>
            <NumField label="等級" value={state.target.level} onChange={(v) => patch("target", "level", v)} min={1} max={18} />
            <NumField label="生命" value={state.target.hp} onChange={(v) => patch("target", "hp", v)} step={50} />
            <NumField label="物防" value={state.target.armor} onChange={(v) => patch("target", "armor", v)} />
            <NumField label="魔防" value={state.target.mr} onChange={(v) => patch("target", "mr", v)} />
          </FieldGrid>
          <div className="mt-4 border-t pt-3">
            <div className="text-xs font-medium">對方打我</div>
            <p className="mb-2 text-[11px] text-muted-foreground">算坦裝效益用：對方整隊的傷害類型比例與穿透（帶入時依敵方裝備估）</p>
            <FieldGrid>
              <NumField label="物理" suffix="%" value={state.threat.physPct} onChange={(v) => patch("threat", "physPct", v)} />
              <NumField label="魔法" suffix="%" value={state.threat.magicPct} onChange={(v) => patch("threat", "magicPct", v)} />
              <NumField label="真實" suffix="%" value={state.threat.truePct} onChange={(v) => patch("threat", "truePct", v)} />
              <NumField label="物理致命" value={state.threat.lethality} onChange={(v) => patch("threat", "lethality", v)} />
              <NumField label="物理穿透" suffix="%" value={state.threat.armorPenPct} onChange={(v) => patch("threat", "armorPenPct", v)} />
              <NumField label="魔法穿透" value={state.threat.magicPen} onChange={(v) => patch("threat", "magicPen", v)} />
              <NumField label="魔法穿透" suffix="%" value={state.threat.magicPenPct} onChange={(v) => patch("threat", "magicPenPct", v)} />
            </FieldGrid>
          </div>
        </Panel>

        <Panel title="我的傷害組成" caption="一波戰鬥裡普攻和技能各打多少。先選最像的打法，再照自己的英雄調" index={2}>
          <div className="mb-3 flex flex-wrap gap-1.5" data-testid="calc-presets">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                onClick={() => setState((s) => ({ ...s, preset: p.id, profile: p.profile }))}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs transition-colors",
                  state.preset === p.id ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:border-primary/40",
                )}
              >
                {p.label}
              </button>
            ))}
            {state.preset === "custom" && (
              <span className="rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground">自訂</span>
            )}
          </div>
          <FieldGrid>
            <NumField label="戰鬥秒數" value={state.profile.seconds} onChange={(v) => patch("profile", "seconds", v)} />
            <NumField label="普攻時間" suffix="%" value={state.profile.autoShare} onChange={(v) => patch("profile", "autoShare", v)} />
            <NumField label="技能冷卻" suffix="秒" value={state.profile.cd} onChange={(v) => patch("profile", "cd", v)} step={0.5} />
            <NumField label="基礎物理" value={state.profile.basePhys} onChange={(v) => patch("profile", "basePhys", v)} step={25} />
            <NumField label="基礎魔法" value={state.profile.baseMagic} onChange={(v) => patch("profile", "baseMagic", v)} step={25} />
            <NumField label="物攻係數" value={state.profile.adRatio} onChange={(v) => patch("profile", "adRatio", v)} step={0.1} />
            <NumField label="魔攻係數" value={state.profile.apRatio} onChange={(v) => patch("profile", "apRatio", v)} step={0.1} />
          </FieldGrid>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            「基礎」「係數」都是一輪技能（各放一次）的加總，例如 Q 的 80 + 1.0 物攻加上 E 的 120 + 0.6 物攻，就填 200 和 1.6。
            「技能冷卻」是一輪技能的平均冷卻，技能加速會讓戰鬥中多放幾輪。
          </p>
        </Panel>
      </div>

      <Panel
        title="身上的裝備與增幅"
        caption="面板已經含它們的數值，這裡只用來算面板看不到的效果：增傷、破甲、燃燒，以及會放大之後屬性的被動（例如死亡之帽的 +30% 魔攻）"
        index={3}
      >
        <div className="grid gap-4 lg:grid-cols-[1fr_1fr_auto]">
          <div>
            <div className="mb-2 text-xs font-medium">裝備</div>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="calc-owned">
              {state.owned.map((id) => {
                const it = byId.get(id)
                return (
                  <Chip
                    key={id}
                    icon={it?.icon}
                    label={it?.name ?? `#${id}`}
                    sub={ITEM_RULES[id]?.note}
                    onRemove={() => set("owned", state.owned.filter((x) => x !== id))}
                  />
                )
              })}
              <Picker
                label="加裝備"
                options={(catalog?.items ?? [])
                  .filter((i) => !state.owned.includes(i.id))
                  .sort((a, b) => b.buys - a.buys)
                  .map((i) => ({ id: i.id, name: i.name, icon: i.icon, sub: ITEM_RULES[i.id] ? "有被動規則" : `${i.price} 金` }))}
                onPick={(id) => set("owned", [...state.owned, id])}
              />
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium">增幅</div>
            <div className="flex flex-wrap items-center gap-1.5" data-testid="calc-augments">
              {AUGMENT_RULES.filter((r) => state.augments[r.id] != null).map((r) => (
                <AugmentChip
                  key={r.id}
                  icon={catalog?.augments.find((a) => a.id === r.id)?.icon}
                  name={r.name}
                  unit={r.unit}
                  value={state.augments[r.id]}
                  onChange={(v) => set("augments", { ...state.augments, [r.id]: v })}
                  onRemove={() => {
                    const next = { ...state.augments }
                    delete next[r.id]
                    set("augments", next)
                  }}
                />
              ))}
              <Picker
                label="加增幅"
                options={AUGMENT_RULES.filter((r) => state.augments[r.id] == null).map((r) => ({
                  id: r.id,
                  name: r.name,
                  icon: catalog?.augments.find((a) => a.id === r.id)?.icon ?? null,
                  sub: r.unit,
                }))}
                onPick={(id) => set("augments", { ...state.augments, [id]: AUGMENT_RULES.find((r) => r.id === id)!.value })}
              />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              只列效果算得出來的增幅；預設數值取自競技場同名增幅，大亂鬥版本可能不同，可以直接改。純加屬性的增幅（例如女巫思維）已經在面板裡，不用加。
            </p>
          </div>
          <div className="lg:w-56">
            <div className="mb-2 text-xs font-medium">其他（手動補）</div>
            <FieldGrid cols={1}>
              <NumField label="額外增傷" suffix="%" value={state.manual.dmgAmp} onChange={(v) => patch("manual", "dmgAmp", v)} />
              <NumField label="物防削減" suffix="%" value={state.manual.armorShred} onChange={(v) => patch("manual", "armorShred", v)} />
              <NumField label="魔防削減" suffix="%" value={state.manual.mrShred} onChange={(v) => patch("manual", "mrShred", v)} />
            </FieldGrid>
          </div>
        </div>
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="calc-kpis">
        <Kpi
          label="一波傷害"
          value={Math.round(result.total).toLocaleString()}
          hint={`物理 ${Math.round(result.phys).toLocaleString()}・魔法 ${Math.round(result.magic).toLocaleString()}${result.trueDmg ? `・真實 ${Math.round(result.trueDmg).toLocaleString()}` : ""}`}
          index={0}
        />
        <Kpi
          label="打掉對手生命"
          value={`${((result.total / Math.max(1, state.target.hp)) * 100).toFixed(0)}%`}
          hint={Number.isFinite(hitsToKill) ? `約 ${hitsToKill.toFixed(1)} 波打死` : "打不動"}
          tone={hitsToKill <= 1 ? "win" : undefined}
          index={1}
        />
        <Kpi
          label="實際打進去"
          value={`${Math.round(result.physTaken * 100)}% / ${Math.round(result.magicTaken * 100)}%`}
          hint={`物理／魔法。對方有效物防 ${Math.round(result.armorEff)}・魔防 ${Math.round(result.mrEff)}`}
          index={2}
        />
        <Kpi
          label="你的有效生命"
          value={Math.round(ehp).toLocaleString()}
          hint={`面板生命 ${Math.round(state.me.hp).toLocaleString()}，對方要打這麼多原始傷害`}
          index={3}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)]">
        <Panel title="多一點屬性，差多少" caption="各加一份小裝的量，傷害或有效生命提升多少；右邊是換算成每千金" index={4}>
          <ul className="space-y-2" data-testid="calc-stat-steps">
            {[...statSteps]
              .sort((a, b) => b.perK - a.perK)
              .map((s) => {
                const v = Math.max(s.dmg, s.tank)
                return (
                  <li key={s.key} className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2 text-xs">
                    <span className="truncate">{s.label}</span>
                    <span className="relative h-2 overflow-hidden rounded-full bg-muted">
                      <span
                        className={cn("bar-grow absolute inset-y-0 left-0 rounded-full", s.isTank ? "bg-data/70" : "bg-primary/80")}
                        style={{ width: `${(v / stepMax) * 100}%` }}
                      />
                    </span>
                    <span className="text-right font-mono tabular-nums" title={`${s.isTank ? "有效生命" : "傷害"} ${pct1(v)}，約 ${s.gold} 金`}>
                      {pct1(s.perK)}
                    </span>
                  </li>
                )
              })}
          </ul>
          <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-primary/80" />
              傷害
            </span>
            <span className="flex items-center gap-1">
              <span className="size-2 rounded-full bg-data/70" />
              有效生命
            </span>
          </div>
        </Panel>

        <Panel
          title="現在出哪件效益最大"
          caption={`每件加上去之後的提升，除以價格換成每千金。已經有的裝備${ownsBoots ? "與其他鞋子" : ""}不列；被動以戰鬥中疊滿計，沒寫規則的被動只算數值`}
          index={5}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup type="single" size="sm" variant="outline" value={scope} onValueChange={(v) => v && setScope(v as "full" | "all")}>
                <ToggleGroupItem value="full">完整裝備</ToggleGroupItem>
                <ToggleGroupItem value="all">含小裝</ToggleGroupItem>
              </ToggleGroup>
              <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as Mode)}>
                <ToggleGroupItem value="dmg">看輸出</ToggleGroupItem>
                <ToggleGroupItem value="ehp">看坦度</ToggleGroupItem>
                <ToggleGroupItem value="mix">各半</ToggleGroupItem>
              </ToggleGroup>
            </div>
          }
        >
          {error ? (
            <QueryError error={error} />
          ) : !catalog ? (
            <Skeleton className="h-[560px] w-full" />
          ) : (
            <>
              {rows.length > 0 && <TopPick row={rows[0]} mode={mode} />}
              <AgTable columns={columns} rows={rows} rowHeight={54} height={500} fileName="item-value" />
            </>
          )}
        </Panel>
      </div>

      <details className="rounded-lg border bg-card px-4 py-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">這個計算機怎麼算、哪些沒算</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
          <li>減傷照遊戲規則：打進去的比例 = 100 ÷ (100 + 有效防禦)。有效防禦依序扣 % 削減、% 穿透、固定穿透（扣到 0 為止）。</li>
          <li>普攻次數 = 攻速 × 戰鬥秒數 × 普攻時間比例，暴擊依暴擊率取期望值；技能施放次數 = 1 + 秒數 × (1 + 技能加速 ÷ 100) ÷ 冷卻。</li>
          <li>裝備的 +% 攻速以攻速成長 0.65 換成面板攻速；英雄基礎數值沒有資料，「額外生命」「額外雙防」與估對手時用一般英雄的中位數。</li>
          <li>沒算：英雄自己的被動、大亂鬥對個別英雄的增減傷調整、治療與吸血、護盾、控制，以及沒寫規則的裝備被動（只算數值）。結果適合拿來比「哪件比較划算」，不是精確的傷害預測。</li>
        </ul>
      </details>
    </div>
  )
}

function TopPick({ row, mode }: { row: Record<string, string | number | null>; mode: Mode }) {
  const label = mode === "dmg" ? "輸出" : mode === "ehp" ? "坦度" : "輸出與坦度各半"
  const key = mode === "dmg" ? "dmgPerK" : mode === "ehp" ? "ehpPerK" : "mixPerK"
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2" data-testid="calc-top-pick">
      {row.icon && <img src={iconUrl(String(row.icon))} alt="" className="size-9 rounded bg-icon-tile" />}
      <div className="min-w-0 text-sm">
        <div>
          看{label}，現在最划算的是 <span className="font-semibold">{row.name}</span>
        </div>
        <div className="text-xs text-muted-foreground">
          每千金 {pct1(Number(row[key]))}・整件 輸出 {pct1(Number(row.dmgGain))}／坦度 {pct1(Number(row.ehpGain))}・{Number(row.price).toLocaleString()} 金
        </div>
      </div>
    </div>
  )
}

function FieldGrid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 }) {
  return <div className={cn("grid gap-x-3 gap-y-2", cols === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}>{children}</div>
}

function NumField({
  label,
  value,
  onChange,
  suffix,
  step = 1,
  min = 0,
  max,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix?: string
  step?: number
  min?: number
  max?: number
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-[4.5rem] shrink-0 text-muted-foreground">{label}</span>
      <span className="relative min-w-0 flex-1">
        <Input
          type="number"
          inputMode="decimal"
          aria-label={suffix ? `${label}（${suffix}）` : label}
          className={cn("h-7 font-mono tabular-nums", suffix && "pr-7")}
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          onChange={(e) => {
            const v = e.target.valueAsNumber
            onChange(Number.isFinite(v) ? v : 0)
          }}
        />
        {suffix && <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] text-muted-foreground">{suffix}</span>}
      </span>
    </label>
  )
}

function Chip({ icon, label, sub, onRemove }: { icon?: string | null; label: string; sub?: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border bg-muted/40 py-0.5 pl-0.5 pr-1 text-xs" title={sub}>
      {icon && <img src={iconUrl(icon)} alt="" className="size-6 rounded bg-icon-tile" />}
      <span className="max-w-[8rem] truncate">{label}</span>
      {sub && <span className="size-1.5 rounded-full bg-primary" aria-label="有被動規則" />}
      <button type="button" onClick={onRemove} className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100" aria-label={`移除 ${label}`}>
        <X className="size-3" />
      </button>
    </span>
  )
}

function AugmentChip({
  icon,
  name,
  unit,
  value,
  onChange,
  onRemove,
}: {
  icon?: string | null
  name: string
  unit: string
  value: number
  onChange: (v: number) => void
  onRemove: () => void
}) {
  return (
    <span className="flex items-center gap-1.5 rounded-md border bg-muted/40 py-0.5 pl-0.5 pr-1 text-xs">
      {icon && <img src={iconUrl(icon)} alt="" className="size-6 rounded bg-icon-tile" />}
      <span>{name}</span>
      <Input
        type="number"
        aria-label={`${name} ${unit}`}
        className="h-6 w-14 px-1.5 font-mono text-xs tabular-nums"
        value={value}
        step={0.5}
        onChange={(e) => onChange(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}
      />
      <span className="text-muted-foreground">{unit}</span>
      <button type="button" onClick={onRemove} className="rounded p-0.5 opacity-60 hover:bg-muted hover:opacity-100" aria-label={`移除 ${name}`}>
        <X className="size-3" />
      </button>
    </span>
  )
}

function Picker({
  label,
  options,
  onPick,
}: {
  label: string
  options: { id: number; name: string; icon: string | null; sub?: string }[]
  onPick: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const pick = (id: number) => {
    onPick(id)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
          <Plus className="size-3.5" />
          {label}
          <ChevronsUpDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="搜尋名稱…" />
          <CommandList>
            <CommandEmpty>找不到。</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.id}
                value={`${o.name} ${o.id}`}
                onSelect={() => pick(o.id)}
                // 同 AccountSwitcher：這版 cmdk 的 onSelect 在某些包法下不觸發，點擊路徑另外接上
                onClick={() => pick(o.id)}
                className="gap-2"
              >
                {o.icon && <img src={iconUrl(o.icon)} alt="" className="size-6 shrink-0 rounded bg-icon-tile" />}
                <span className="min-w-0 flex-1 truncate">{o.name}</span>
                {o.sub && <span className="shrink-0 text-[11px] text-muted-foreground">{o.sub}</span>}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** 對局中從遊戲的即時資料帶入：自己的面板與裝備、選一個敵人當對手、依整隊敵人的裝備估「對方打我」。 */
function LiveBar({ byId, onApply }: { byId: Map<number, CalcItem>; onApply: (live: Live, enemy: LivePlayer | null) => void }) {
  const status = useCollectorStatus() as { public?: boolean } | null
  const [live, setLive] = useState<Live | null>(null)
  const [loading, setLoading] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)

  if (status?.public) return null

  const enemies = (live?.players ?? []).filter((p) => !p.ally && !p.isMe)
  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/calc/live")
      const data: Live = await res.json()
      setLive(data)
      if (data.inGame) {
        const first = (data.players ?? []).filter((p) => !p.ally && !p.isMe)[0] ?? null
        setPicked(first ? 0 : null)
        onApply(data, first)
      }
    } catch {
      setLive({ inGame: false })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rise flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3" data-testid="calc-live">
      <Button size="sm" onClick={load} disabled={loading || !byId.size} className="gap-1.5">
        {live?.inGame ? <RotateCcw className="size-3.5" /> : <Radio className="size-3.5" />}
        {live?.inGame ? "重新帶入" : "從對局帶入"}
      </Button>
      {!live && <span className="text-xs text-muted-foreground">對局進行中按一下，帶入你現在的面板、裝備，並依敵人的裝備估對手的雙防</span>}
      {live && !live.inGame && <span className="text-xs text-muted-foreground">現在不在對局中（遊戲開著、對局進行中才讀得到）</span>}
      {live?.inGame && (
        <>
          <span className="text-xs text-muted-foreground">選要打的人：</span>
          <div className="flex flex-wrap gap-1.5">
            {enemies.map((p, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  setPicked(i)
                  onApply(live, p)
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs transition-colors",
                  picked === i ? "border-primary bg-primary/15" : "hover:border-primary/40",
                )}
              >
                {p.icon && <img src={iconUrl(p.icon)} alt="" className="size-6 rounded-full bg-icon-tile" />}
                {p.championName ?? p.champion}
                <span className="text-muted-foreground">Lv{p.level}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
