// 出裝計算機的計算核心：純函式，畫面只負責收輸入、排版。
//
// 做法（面板層級，不分英雄技能）：
//   - 「我的面板」是遊戲裡看到的最終數字（已經含身上的裝備與增幅）。
//   - 身上的裝備與增幅只用來算「面板看不到的效果」：增傷、破甲、燃燒，以及會放大之後屬性的被動（死亡之帽的 +30% 魔攻）。
//   - 一波戰鬥的傷害 = 普攻（攻速 × 秒數 × 普攻時間比例）＋ 技能（施放次數 × (基礎 + 係數 × 物攻／魔攻)），
//     再依對手的雙防、你的穿透換算成實際打進去的量。
//   - 一件裝備的效益 = 加上它之後，傷害（或你的有效生命）提升幾 %，再除以價格換成「每千金」。
//
// 公式都是英雄聯盟公開的規則：減傷 = 100 / (100 + 防禦)；防禦先扣 % 削減、再扣 % 穿透、最後扣固定穿透（不會扣到負的）。

export type MyStats = {
  level: number
  ad: number
  ap: number
  attackSpeed: number // 每秒普攻次數（面板上的攻速）
  critChance: number // %
  critDamage: number // 倍率，預設 1.75
  lethality: number
  armorPenPct: number // %
  magicPen: number
  magicPenPct: number // %
  haste: number
  hp: number
  armor: number
  mr: number
}

export type Target = { level: number; hp: number; armor: number; mr: number }

/** 我的傷害組成：一波戰鬥裡普攻和技能各占多少。沒有英雄技能資料，用幾種典型打法當預設，讓使用者自己調。 */
export type Profile = {
  seconds: number // 一波戰鬥幾秒
  autoShare: number // 這段時間裡有幾 % 在普攻
  cd: number // 一輪技能的平均冷卻（秒，未計技能加速）
  basePhys: number // 一輪技能的基礎物理傷害合計
  baseMagic: number // 一輪技能的基礎魔法傷害合計
  adRatio: number // 一輪技能的物攻係數合計
  apRatio: number // 一輪技能的魔攻係數合計
}

/** 對方打我：傷害類型比例與對方的穿透，用來算有效生命。 */
export type Threat = {
  physPct: number
  magicPct: number
  truePct: number
  lethality: number
  armorPenPct: number
  magicPen: number
  magicPenPct: number
}

/** 面板看不到、要另外算的效果。由身上的裝備被動、增幅與手動補充累加而成。 */
export type Effects = {
  // 會放大「之後加上去的」屬性（面板已經含現有的部分）
  adMult: number
  apMult: number
  bonusHpToAd: number // 狂霸血甲：額外生命的 % 轉物攻
  bonusHpToAp: number // 峽谷製造者
  apToHaste: number // 靈光一閃：魔攻的 % 轉技能加速
  // 戰鬥中才有的效果
  dmgAmp: number // 所有傷害 +%（小數）
  magicAmp: number
  abilityAmp: number
  armorShred: number // 物防削減（小數，多個來源相乘）
  mrShred: number
  extraArmorPenPct: number // 戰鬥中額外的 % 穿透（%）
  extraMagicPenPct: number
  abilityCritMult: number // 技能可以暴擊時的暴擊倍率（0 = 技能不會暴擊）
  autoMult: number // 普攻多打幾成（雙刀流）
  autoHpPct: number // 普攻附加自身最大生命 %（重型打手）
  onHitMagic: number // 每次普攻附加的魔法傷害
  burnHpPctPerSec: number // 技能命中後燃燒：每秒目標最大生命 %（黎安卓）
  missileHpPct: number // 魔法導彈：每次觸發的真實傷害（目標最大生命 %，已乘飛彈數）
  flatPhysPerFight: number // 每波一次的物理傷害（雄心之鋼，依自身生命，已換算成數字前先存比例）
  hpPhysPerFight: number
  dominik: boolean
  selfPenalty: number // 造成傷害降低（天界之身）
  // 坦度
  bonusResistMult: number // 額外雙防 +%（賈克修）
  autoTaken: number // 普攻傷害降低（鍍板鋼蓋）
}

export const NO_EFFECTS: Effects = {
  adMult: 1,
  apMult: 1,
  bonusHpToAd: 0,
  bonusHpToAp: 0,
  apToHaste: 0,
  dmgAmp: 0,
  magicAmp: 0,
  abilityAmp: 0,
  armorShred: 0,
  mrShred: 0,
  extraArmorPenPct: 0,
  extraMagicPenPct: 0,
  abilityCritMult: 0,
  autoMult: 1,
  autoHpPct: 0,
  onHitMagic: 0,
  burnHpPctPerSec: 0,
  missileHpPct: 0,
  flatPhysPerFight: 0,
  hpPhysPerFight: 0,
  dominik: false,
  selfPenalty: 0,
  bonusResistMult: 0,
  autoTaken: 0,
}

// ── 等級成長：英雄基礎數值沒有存，用一般英雄的中位數估（只用在「額外生命」「額外雙防」和估對手的雙防）
const growth = (level: number) => (level - 1) * (0.7025 + 0.0175 * (level - 1))
export const baseHp = (level: number) => 640 + 105 * growth(level)
export const baseArmor = (level: number) => 32 + 4.7 * growth(level)
export const baseMr = (level: number) => 31 + 1.8 * growth(level)
/** 攻速成長比例：裝備的 +% 攻速乘這個才是面板增加的量。多數英雄 0.625～0.7。 */
export const AS_RATIO = 0.65
export const AS_CAP = 2.5

/** 防禦換成「打進去幾成」：100 / (100 + 防禦)；負防禦則是 2 − 100 / (100 − 防禦)。 */
export const mitigation = (resist: number) => (resist >= 0 ? 100 / (100 + resist) : 2 - 100 / (100 - resist))

/** 有效防禦：先 % 削減、再 % 穿透、最後固定穿透（固定穿透不會扣到 0 以下）。 */
export function effectiveResist(resist: number, shred: number, penPct: number, flatPen: number) {
  if (resist <= 0) return resist
  const afterPct = resist * (1 - shred) * (1 - penPct / 100)
  return Math.max(0, afterPct - flatPen)
}

const combinePct = (a: number, b: number) => 100 * (1 - (1 - a / 100) * (1 - b / 100))

export type DamageBreakdown = {
  total: number
  phys: number
  magic: number
  trueDmg: number
  autos: number
  casts: number
  physTaken: number // 物理打進去幾成（0～1）
  magicTaken: number
  armorEff: number
  mrEff: number
}

export function damage(s: MyStats, e: Effects, t: Target, p: Profile): DamageBreakdown {
  const autos = Math.min(s.attackSpeed, AS_CAP) * p.seconds * (p.autoShare / 100)
  const crit = Math.min(100, Math.max(0, s.critChance)) / 100
  const critF = 1 + crit * (s.critDamage - 1)
  const autoPhys = autos * (s.ad * critF + e.autoHpPct * s.hp) * e.autoMult
  const autoMagic = autos * e.onHitMagic * e.autoMult
  const hasAbility = p.basePhys + p.baseMagic + p.adRatio + p.apRatio > 0
  const casts = hasAbility ? 1 + (p.seconds * (1 + s.haste / 100)) / Math.max(0.5, p.cd) : 0
  const abilityCritF = e.abilityCritMult > 0 ? 1 + crit * (e.abilityCritMult - 1) : 1
  const abilityF = abilityCritF * (1 + e.abilityAmp)
  const abPhys = casts * (p.basePhys + p.adRatio * s.ad) * abilityF
  const abMagic = casts * (p.baseMagic + p.apRatio * s.ap) * abilityF
  const burn = e.burnHpPctPerSec > 0 && casts > 0 ? Math.min(p.seconds, casts * 3) * e.burnHpPctPerSec * t.hp : 0
  const fightPhys = e.flatPhysPerFight + e.hpPhysPerFight * s.hp
  const missiles = e.missileHpPct > 0 && casts > 0 ? (1 + Math.floor(p.seconds / 6)) * e.missileHpPct * t.hp : 0

  const armorEff = effectiveResist(t.armor, e.armorShred, combinePct(s.armorPenPct, e.extraArmorPenPct), s.lethality)
  const mrEff = effectiveResist(t.mr, e.mrShred, combinePct(s.magicPenPct, e.extraMagicPenPct), s.magicPen)
  const physTaken = mitigation(armorEff)
  const magicTaken = mitigation(mrEff)
  const bonusHpTarget = Math.max(0, t.hp - baseHp(t.level))
  const amp = 1 + e.dmgAmp + (e.dominik ? 0.15 * Math.min(1, bonusHpTarget / 1500) : 0)
  const keep = amp * (1 - e.selfPenalty)

  const phys = (autoPhys + abPhys + fightPhys) * physTaken * keep
  const magic = (autoMagic + abMagic + burn) * magicTaken * (1 + e.magicAmp) * keep
  const trueDmg = missiles * keep
  return { total: phys + magic + trueDmg, phys, magic, trueDmg, autos, casts, physTaken, magicTaken, armorEff, mrEff }
}

/** 有效生命：要打掉你多少「原始傷害」才會死（依對方的傷害類型比例加權）。 */
export function effectiveHp(s: MyStats, e: Effects, th: Threat) {
  const bonus = (resist: number, base: number) => resist + e.bonusResistMult * Math.max(0, resist - base)
  const armor = effectiveResist(bonus(s.armor, baseArmor(s.level)), 0, th.armorPenPct, th.lethality)
  const mr = effectiveResist(bonus(s.mr, baseMr(s.level)), 0, th.magicPenPct, th.magicPen)
  const sum = th.physPct + th.magicPct + th.truePct || 1
  // 鍍板鋼蓋只擋普攻；不知道對方物理傷害裡普攻占多少，以一半估
  const taken =
    (th.physPct / sum) * mitigation(armor) * (1 - e.autoTaken * 0.5) +
    (th.magicPct / sum) * mitigation(mr) +
    th.truePct / sum
  return s.hp / taken
}

// ── 裝備

export type CalcItem = {
  id: number
  name: string
  icon: string | null
  price: number
  buys: number
  boots: boolean
  stats: Record<string, number>
}

/** 修正前的解析器把「40% 魔法穿透」存成 40 點；維度表下次更新（客戶端連上時）就會變成 MagicPenetrationPercent。 */
const LEGACY_PCT_MAGIC_PEN = new Set([3135, 3137, 4630])

export function itemStats(item: CalcItem) {
  const st = item.stats
  const legacyPct = LEGACY_PCT_MAGIC_PEN.has(item.id) && st.MagicPenetrationPercent == null
  return {
    ad: st.AttackDamage ?? 0,
    ap: st.AbilityPower ?? 0,
    asPct: st.AttackSpeed ?? 0,
    crit: st.CritChance ?? 0,
    critDmg: (st.CritDamage ?? 0) / 100,
    lethality: st.Lethality ?? 0,
    armorPenPct: st.ArmorPenetration ?? 0,
    magicPen: legacyPct ? 0 : (st.MagicPenetration ?? 0),
    magicPenPct: st.MagicPenetrationPercent ?? (legacyPct ? (st.MagicPenetration ?? 0) : 0),
    haste: st.AbilityHaste ?? 0,
    hp: st.Health ?? 0,
    armor: st.Armor ?? 0,
    mr: st.MagicResist ?? 0,
  }
}

export type ItemRule = { note: string; apply: (e: Effects) => Effects }

/** 會影響傷害或坦度、但不在數值欄裡的裝備被動。數字取自裝備說明（2026-10）；
 *  需要條件的（疊層、戰鬥幾秒後）一律以「戰鬥中已經疊滿」計，note 會寫清楚。沒列的裝備只算數值。 */
export const ITEM_RULES: Record<number, ItemRule> = {
  3089: { note: "總魔攻 +30%", apply: (e) => ({ ...e, apMult: e.apMult * 1.3 }) },
  3071: { note: "物防削減 30%（疊滿 5 層）", apply: (e) => ({ ...e, armorShred: 1 - (1 - e.armorShred) * 0.7 }) },
  8010: { note: "魔防削減 30%（疊滿 4 層）", apply: (e) => ({ ...e, mrShred: 1 - (1 - e.mrShred) * 0.7 }) },
  3036: { note: "對額外生命多的對手最多 +15% 傷害", apply: (e) => ({ ...e, dominik: true }) },
  6653: {
    note: "燃燒每秒 2% 最大生命、增傷最多 6%",
    apply: (e) => ({ ...e, burnHpPctPerSec: e.burnHpPctPerSec + 0.02, dmgAmp: e.dmgAmp + 0.06 }),
  },
  4633: {
    note: "增傷最多 8%、額外生命 2% 轉魔攻",
    apply: (e) => ({ ...e, dmgAmp: e.dmgAmp + 0.08, bonusHpToAp: e.bonusHpToAp + 0.02 }),
  },
  2501: { note: "額外生命 2.5% 轉物攻", apply: (e) => ({ ...e, bonusHpToAd: e.bonusHpToAd + 0.025 }) },
  3161: { note: "技能傷害 +12%（疊滿 4 層）", apply: (e) => ({ ...e, abilityAmp: e.abilityAmp + 0.12 }) },
  8020: { note: "對手受到的魔法傷害 +12%", apply: (e) => ({ ...e, magicAmp: e.magicAmp + 0.12 }) },
  4645: { note: "對 40% 生命以下暴擊 +20%，約當魔法傷害 +8%", apply: (e) => ({ ...e, magicAmp: e.magicAmp + 0.08 }) },
  6676: { note: "5% 生命處決，約當傷害 +5%", apply: (e) => ({ ...e, dmgAmp: e.dmgAmp + 0.05 }) },
  3302: {
    note: "黑暗模式 +10% 雙穿透，以一半時間計",
    apply: (e) => ({ ...e, extraArmorPenPct: combinePct(e.extraArmorPenPct, 5), extraMagicPenPct: combinePct(e.extraMagicPenPct, 5) }),
  },
  3124: { note: "普攻附加 30 魔法傷害", apply: (e) => ({ ...e, onHitMagic: e.onHitMagic + 30 }) },
  3084: {
    note: "每波一次 70 + 6% 最大生命的物理傷害",
    apply: (e) => ({ ...e, flatPhysPerFight: e.flatPhysPerFight + 70, hpPhysPerFight: e.hpPhysPerFight + 0.06 }),
  },
  6665: { note: "戰鬥 5 秒後額外雙防 +30%", apply: (e) => ({ ...e, bonusResistMult: e.bonusResistMult + 0.3 }) },
  3047: { note: "普攻傷害 −10%", apply: (e) => ({ ...e, autoTaken: Math.max(e.autoTaken, 0.1) }) },
}

// ── 增幅：數值預設取自競技場同名增幅的資料（CommunityDragon），大亂鬥版本可能不同，所以每個都能改

export type AugmentRule = {
  id: number
  name: string
  unit: string // 數值的意思，例如「% 物攻」
  value: number
  apply: (e: Effects, v: number) => Effects
}

export const AUGMENT_RULES: AugmentRule[] = [
  { id: 1007, name: "蠻力重擊", unit: "% 物攻", value: 10, apply: (e, v) => ({ ...e, adMult: e.adMult * (1 + v / 100) }) },
  {
    id: 1041,
    name: "巨人",
    unit: "% 物攻與魔攻",
    value: 10,
    apply: (e, v) => ({ ...e, adMult: e.adMult * (1 + v / 100), apMult: e.apMult * (1 + v / 100) }),
  },
  { id: 1048, name: "寶石手套", unit: "% 技能暴擊傷害", value: 140, apply: (e, v) => ({ ...e, abilityCritMult: v / 100 }) },
  { id: 1004, name: "基本功夫", unit: "% 技能傷害", value: 25, apply: (e, v) => ({ ...e, abilityAmp: e.abilityAmp + v / 100 }) },
  { id: 1030, name: "靈光一閃", unit: "% 魔攻轉技能加速", value: 20, apply: (e, v) => ({ ...e, apToHaste: e.apToHaste + v / 100 }) },
  {
    id: 1028,
    name: "侵蝕裝甲",
    unit: "% 雙防削減（疊滿）",
    value: 20,
    apply: (e, v) => ({ ...e, armorShred: 1 - (1 - e.armorShred) * (1 - v / 100), mrShred: 1 - (1 - e.mrShred) * (1 - v / 100) }),
  },
  { id: 1225, name: "雙刀流", unit: "% 普攻額外箭矢", value: 40, apply: (e, v) => ({ ...e, autoMult: e.autoMult * (1 + v / 100) }) },
  { id: 1181, name: "重型打手", unit: "% 自身生命附加於普攻", value: 3.5, apply: (e, v) => ({ ...e, autoHpPct: e.autoHpPct + v / 100 }) },
  { id: 1195, name: "巨人殺手", unit: "% 傷害（依體型差）", value: 10, apply: (e, v) => ({ ...e, dmgAmp: e.dmgAmp + v / 100 }) },
  {
    id: 1133,
    name: "魔法導彈",
    unit: "% 目標生命（每 6 秒，3 發合計）",
    value: 1,
    apply: (e, v) => ({ ...e, missileHpPct: e.missileHpPct + v / 100 }),
  },
  { id: 1013, name: "天界之身", unit: "% 造成傷害降低", value: 10, apply: (e, v) => ({ ...e, selfPenalty: e.selfPenalty + v / 100 }) },
]

/** 手動補充：沒有寫成規則的增幅或被動，自己填進來。 */
export type Manual = { dmgAmp: number; armorShred: number; mrShred: number }

export function buildEffects(ownedIds: number[], augments: Record<number, number>, manual: Manual) {
  let e = NO_EFFECTS
  for (const id of new Set(ownedIds)) {
    const rule = ITEM_RULES[id]
    if (rule) e = rule.apply(e)
  }
  for (const rule of AUGMENT_RULES) {
    if (augments[rule.id] != null) e = rule.apply(e, augments[rule.id])
  }
  return {
    ...e,
    dmgAmp: e.dmgAmp + manual.dmgAmp / 100,
    armorShred: 1 - (1 - e.armorShred) * (1 - manual.armorShred / 100),
    mrShred: 1 - (1 - e.mrShred) * (1 - manual.mrShred / 100),
  }
}

/** 加上一件裝備（或一包屬性）之後的面板。e0 是現在的效果、e1 是加上之後的效果；
 *  會放大屬性的被動（死亡之帽）用「先拆掉現有倍率、加上去、再乘新倍率」處理，轉換類（狂霸）只加差額。 */
export function addStats(s: MyStats, add: ReturnType<typeof itemStats>, e0: Effects, e1: Effects): MyStats {
  const hp = s.hp + add.hp
  const bonusHp0 = Math.max(0, s.hp - baseHp(s.level))
  const bonusHp1 = Math.max(0, hp - baseHp(s.level))
  const ad = ((s.ad - e0.bonusHpToAd * bonusHp0) / e0.adMult + add.ad) * e1.adMult + e1.bonusHpToAd * bonusHp1
  const ap = ((s.ap - e0.bonusHpToAp * bonusHp0) / e0.apMult + add.ap) * e1.apMult + e1.bonusHpToAp * bonusHp1
  return {
    ...s,
    hp,
    ad,
    ap,
    attackSpeed: Math.min(AS_CAP, s.attackSpeed + (AS_RATIO * add.asPct) / 100),
    critChance: Math.min(100, s.critChance + add.crit),
    critDamage: s.critDamage + add.critDmg,
    lethality: s.lethality + add.lethality,
    armorPenPct: combinePct(s.armorPenPct, add.armorPenPct),
    magicPen: s.magicPen + add.magicPen,
    magicPenPct: combinePct(s.magicPenPct, add.magicPenPct),
    haste: s.haste + add.haste + e1.apToHaste * ap - e0.apToHaste * s.ap,
    armor: s.armor + add.armor,
    mr: s.mr + add.mr,
  }
}

export const ZERO_ADD: ReturnType<typeof itemStats> = {
  ad: 0, ap: 0, asPct: 0, crit: 0, critDmg: 0, lethality: 0, armorPenPct: 0,
  magicPen: 0, magicPenPct: 0, haste: 0, hp: 0, armor: 0, mr: 0,
}

export type ItemValue = {
  item: CalcItem
  dmgGain: number // 傷害提升 %
  ehpGain: number // 有效生命提升 %
  dmgPerK: number // 每千金
  ehpPerK: number
  note: string | null
}

export function evaluateItem(
  item: CalcItem,
  s: MyStats,
  e0: Effects,
  t: Target,
  p: Profile,
  th: Threat,
  base: { dmg: number; ehp: number },
): ItemValue {
  const rule = ITEM_RULES[item.id]
  const e1 = rule ? rule.apply(e0) : e0
  const s1 = addStats(s, itemStats(item), e0, e1)
  const dmgGain = base.dmg > 0 ? (damage(s1, e1, t, p).total / base.dmg - 1) * 100 : 0
  const ehpGain = base.ehp > 0 ? (effectiveHp(s1, e1, th) / base.ehp - 1) * 100 : 0
  const k = item.price / 1000 || 1
  return { item, dmgGain, ehpGain, dmgPerK: dmgGain / k, ehpPerK: ehpGain / k, note: rule?.note ?? null }
}

/** 單一屬性的邊際：各加一份「一個基本小裝的量」，看傷害／有效生命提升多少，以及那份屬性大約值多少錢。 */
export const STAT_STEPS: { key: keyof ReturnType<typeof itemStats>; label: string; amount: number; gold: number }[] = [
  { key: "ad", label: "+10 物攻", amount: 10, gold: 350 },
  { key: "ap", label: "+20 魔攻", amount: 20, gold: 400 },
  { key: "lethality", label: "+10 物理致命", amount: 10, gold: 300 },
  { key: "armorPenPct", label: "+18% 物理穿透", amount: 18, gold: 625 },
  { key: "magicPen", label: "+12 魔法穿透", amount: 12, gold: 800 },
  { key: "magicPenPct", label: "+13% 魔法穿透", amount: 13, gold: 775 },
  { key: "crit", label: "+15% 暴擊率", amount: 15, gold: 600 },
  { key: "asPct", label: "+15% 攻速", amount: 15, gold: 400 },
  { key: "haste", label: "+10 技能加速", amount: 10, gold: 450 },
  { key: "hp", label: "+150 生命", amount: 150, gold: 400 },
  { key: "armor", label: "+20 物防", amount: 20, gold: 400 },
  { key: "mr", label: "+20 魔防", amount: 20, gold: 400 },
]

export type Preset = { id: string; label: string; hint: string; profile: Profile }

/** 典型打法的預設。數字是一般英雄 6～11 級的量級，只是起點，套用後照自己的英雄改。 */
export const PRESETS: Preset[] = [
  {
    id: "marksman",
    label: "普攻射手",
    hint: "傷害主要來自普攻，技能是輔助",
    profile: { seconds: 6, autoShare: 90, cd: 8, basePhys: 200, baseMagic: 0, adRatio: 1, apRatio: 0 },
  },
  {
    id: "assassin",
    label: "AD 刺客／技能型",
    hint: "一套技能打完就走，戰鬥很短",
    profile: { seconds: 4, autoShare: 30, cd: 7, basePhys: 600, baseMagic: 0, adRatio: 2.4, apRatio: 0 },
  },
  {
    id: "bruiser",
    label: "鬥士",
    hint: "技能和普攻穿插，打比較久",
    profile: { seconds: 7, autoShare: 60, cd: 6, basePhys: 400, baseMagic: 0, adRatio: 1.6, apRatio: 0 },
  },
  {
    id: "burst-mage",
    label: "爆發法師",
    hint: "一輪技能就是主要傷害",
    profile: { seconds: 5, autoShare: 10, cd: 7, basePhys: 0, baseMagic: 750, adRatio: 0, apRatio: 2.2 },
  },
  {
    id: "dps-mage",
    label: "持續法師",
    hint: "冷卻短、一直丟技能",
    profile: { seconds: 7, autoShare: 15, cd: 4, basePhys: 0, baseMagic: 350, adRatio: 0, apRatio: 1.1 },
  },
]

/** 從對方的裝備估他的雙防與生命（英雄基礎值用一般英雄的中位數）。 */
export function estimateTarget(level: number, items: CalcItem[]): Target {
  const sum = (k: "hp" | "armor" | "mr") => items.reduce((a, it) => a + itemStats(it)[k], 0)
  return {
    level,
    hp: Math.round(baseHp(level) + sum("hp")),
    armor: Math.round(baseArmor(level) + sum("armor")),
    mr: Math.round(baseMr(level) + sum("mr")),
  }
}

/** 從整隊敵人的裝備估「對方打我」：物理／魔法比例看兩類輸出裝的花費，穿透取平均。 */
export function estimateThreat(enemies: CalcItem[][]): Threat | null {
  let physGold = 0
  let magicGold = 0
  const pen = { lethality: 0, armorPenPct: 0, magicPen: 0, magicPenPct: 0 }
  for (const items of enemies) {
    for (const it of items) {
      const st = itemStats(it)
      const physW = st.ad + st.crit + st.asPct + st.lethality + st.armorPenPct
      const magicW = st.ap + st.magicPen + st.magicPenPct
      if (physW + magicW > 0) {
        physGold += (it.price * physW) / (physW + magicW)
        magicGold += (it.price * magicW) / (physW + magicW)
      }
      pen.lethality += st.lethality
      pen.armorPenPct += st.armorPenPct
      pen.magicPen += st.magicPen
      pen.magicPenPct += st.magicPenPct
    }
  }
  if (!enemies.length || physGold + magicGold === 0) return null
  const n = enemies.length
  const truePct = 5
  const physPct = Math.round(((physGold / (physGold + magicGold)) * (100 - truePct)))
  return {
    physPct,
    magicPct: 100 - truePct - physPct,
    truePct,
    lethality: Math.round(pen.lethality / n),
    armorPenPct: Math.round(pen.armorPenPct / n),
    magicPen: Math.round(pen.magicPen / n),
    magicPenPct: Math.round(pen.magicPenPct / n),
  }
}
