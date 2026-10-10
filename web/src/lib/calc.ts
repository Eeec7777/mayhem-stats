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
  mana: number // 最大魔力（終極魔劍、熾天使看它）
  ranged: boolean // 遠程：很多被動對遠程打折（殞落王者之劍 9% → 6%、不朽盾弓護盾 ×0.8…）
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

/** 一波戰鬥的情況，給「額外傷害」規則用。 */
export type FightCtx = {
  s: MyStats
  t: Target
  autos: number // 這波普攻幾下
  casts: number // 這波技能放幾輪
  seconds: number
  ap: number // 戰鬥中的魔攻（含戰鬥中才有的加成）
  baseAd: number // 英雄基礎物攻（估）：耀光類被動看它
  bonusAd: number
  bonusHp: number // 自己的額外生命
}
export type Hit = { phys?: number; magic?: number; trueDmg?: number }
/** 額外傷害：命中附加、主動、燃燒…依這波戰鬥的情況算出原始傷害（還沒扣雙防）。 */
export type Extra = (c: FightCtx) => Hit
/** 耀光類（施放技能後下一次普攻加傷）：同類只會觸發一個，取最強的。回傳每次觸發的原始傷害。 */
export type Spellblade = (c: FightCtx) => Hit

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
  extras: Extra[]
  spellblades: Spellblade[]
  asBonusPct: number // 戰鬥中額外攻速 %（雲陶狂箭、鬼索疊層）
  critBonus: number // 戰鬥中額外暴擊率 %（殞落之祭）
  apCombatMult: number // 戰鬥中魔攻倍率（黑焰火炬）
  autoAmp: number // 普攻傷害 +%（海克斯光學C44）
  rangedAutoAmp: number // 只有遠程才有的普攻增傷（C44 依距離，遠程打得到滿）
  rangedDmgAmp: number // 只有遠程才有的增傷（視界專注：600 距離外）
  // 坦度
  bonusResistMult: number // 額外雙防 +%（賈克修）
  autoTaken: number // 普攻傷害降低（鍍板鋼蓋、冰霜之心），多個來源相乘
  physTakenMult: number // 物理傷害承受倍率（蘭頓之兆擋暴擊）
  combatMr: number // 戰鬥中額外魔防（自然之力）
  shields: ((s: MyStats) => number)[] // 每波一次的護盾（命脈類、凱尼克）
  shieldMult: number // 受到的護盾 +%（振奮盔甲）
  hpMult: number // 道具生命倍率（好戰者鎧甲），會放大之後加上去的生命
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
  extras: [],
  spellblades: [],
  asBonusPct: 0,
  critBonus: 0,
  apCombatMult: 1,
  autoAmp: 0,
  rangedAutoAmp: 0,
  rangedDmgAmp: 0,
  bonusResistMult: 0,
  autoTaken: 0,
  physTakenMult: 1,
  combatMr: 0,
  shields: [],
  shieldMult: 1,
  hpMult: 1,
}

// ── 等級成長：英雄基礎數值沒有存，用一般英雄的中位數估（只用在「額外生命」「額外雙防」和估對手的雙防）
const growth = (level: number) => (level - 1) * (0.7025 + 0.0175 * (level - 1))
export const baseHp = (level: number) => 640 + 105 * growth(level)
export const baseArmor = (level: number) => 32 + 4.7 * growth(level)
export const baseMr = (level: number) => 31 + 1.8 * growth(level)
export const baseAd = (level: number) => 60 + 3.4 * growth(level)
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
  const attackSpeed = Math.min(AS_CAP, s.attackSpeed + (AS_RATIO * e.asBonusPct) / 100)
  const autos = attackSpeed * p.seconds * (p.autoShare / 100)
  const crit = Math.min(100, Math.max(0, s.critChance + e.critBonus)) / 100
  const critF = 1 + crit * (s.critDamage - 1)
  const ap = s.ap * e.apCombatMult
  const autoAmp = e.autoAmp + (s.ranged ? e.rangedAutoAmp : 0)
  const autoPhys = autos * (s.ad * critF * (1 + autoAmp) + e.autoHpPct * s.hp) * e.autoMult
  const autoMagic = autos * e.onHitMagic * e.autoMult
  const hasAbility = p.basePhys + p.baseMagic + p.adRatio + p.apRatio > 0
  const casts = hasAbility ? 1 + (p.seconds * (1 + s.haste / 100)) / Math.max(0.5, p.cd) : 0
  const abilityCritF = e.abilityCritMult > 0 ? 1 + crit * (e.abilityCritMult - 1) : 1
  const abilityF = abilityCritF * (1 + e.abilityAmp)
  const abPhys = casts * (p.basePhys + p.adRatio * s.ad) * abilityF
  const abMagic = casts * (p.baseMagic + p.apRatio * ap) * abilityF

  const ctx: FightCtx = {
    s,
    t,
    autos,
    casts,
    seconds: p.seconds,
    ap,
    baseAd: Math.min(s.ad, baseAd(s.level)),
    bonusAd: Math.max(0, s.ad - baseAd(s.level)),
    bonusHp: Math.max(0, s.hp - baseHp(s.level)),
  }
  const extra = { phys: 0, magic: 0, trueDmg: 0 }
  const addHit = (h: Hit, times = 1) => {
    extra.phys += (h.phys ?? 0) * times
    extra.magic += (h.magic ?? 0) * times
    extra.trueDmg += (h.trueDmg ?? 0) * times
  }
  for (const x of e.extras) addHit(x(ctx))
  if (e.spellblades.length && casts > 0) {
    // 每放一次技能，下一次普攻觸發；冷卻 1.5 秒，也不會比普攻次數多
    const procs = Math.min(casts, autos, 1 + p.seconds / 1.5)
    const best = e.spellblades.map((f) => f(ctx)).sort((a, b) => sumHit(b) - sumHit(a))[0]
    addHit(best, procs)
  }
  const burn = e.burnHpPctPerSec > 0 && casts > 0 ? Math.min(p.seconds, casts * 3) * e.burnHpPctPerSec * t.hp : 0
  const fightPhys = e.flatPhysPerFight + e.hpPhysPerFight * s.hp
  const missiles = e.missileHpPct > 0 && casts > 0 ? (1 + Math.floor(p.seconds / 6)) * e.missileHpPct * t.hp : 0

  const armorEff = effectiveResist(t.armor, e.armorShred, combinePct(s.armorPenPct, e.extraArmorPenPct), s.lethality)
  const mrEff = effectiveResist(t.mr, e.mrShred, combinePct(s.magicPenPct, e.extraMagicPenPct), s.magicPen)
  const physTaken = mitigation(armorEff)
  const magicTaken = mitigation(mrEff)
  const bonusHpTarget = Math.max(0, t.hp - baseHp(t.level))
  const amp = 1 + e.dmgAmp + (s.ranged ? e.rangedDmgAmp : 0) + (e.dominik ? 0.15 * Math.min(1, bonusHpTarget / 1500) : 0)
  const keep = amp * (1 - e.selfPenalty)

  const phys = (autoPhys + abPhys + fightPhys + extra.phys) * physTaken * keep
  const magic = (autoMagic + abMagic + burn + extra.magic) * magicTaken * (1 + e.magicAmp) * keep
  const trueDmg = (missiles + extra.trueDmg) * keep
  return { total: phys + magic + trueDmg, phys, magic, trueDmg, autos, casts, physTaken, magicTaken, armorEff, mrEff }
}

const sumHit = (h: Hit) => (h.phys ?? 0) + (h.magic ?? 0) + (h.trueDmg ?? 0)

/** 有效生命：要打掉你多少「原始傷害」才會死（依對方的傷害類型比例加權）。
 *  護盾算進去：每波一次，擋的是扣完雙防之後的傷害，所以和生命一樣除以承受比例。 */
export function effectiveHp(s: MyStats, e: Effects, th: Threat) {
  const bonus = (resist: number, base: number) => resist + e.bonusResistMult * Math.max(0, resist - base)
  const armor = effectiveResist(bonus(s.armor, baseArmor(s.level)), 0, th.armorPenPct, th.lethality)
  const mr = effectiveResist(bonus(s.mr + e.combatMr, baseMr(s.level)), 0, th.magicPenPct, th.magicPen)
  const sum = th.physPct + th.magicPct + th.truePct || 1
  // 鍍板鋼蓋、冰霜之心只擋普攻；不知道對方物理傷害裡普攻占多少，以一半估
  const taken =
    (th.physPct / sum) * mitigation(armor) * (1 - e.autoTaken * 0.5) * e.physTakenMult +
    (th.magicPct / sum) * mitigation(mr) +
    th.truePct / sum
  const shield = e.shields.reduce((a, f) => a + f(s), 0) * e.shieldMult
  return (s.hp + shield) / taken
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

// 規則用的小工具
const withExtra = (e: Effects, f: Extra): Effects => ({ ...e, extras: [...e.extras, f] })
const withSpellblade = (e: Effects, f: Spellblade): Effects => ({ ...e, spellblades: [...e.spellblades, f] })
const withShield = (e: Effects, f: (s: MyStats) => number): Effects => ({ ...e, shields: [...e.shields, f] })
/** 有冷卻的效果在一波裡能觸發幾次：開打先觸發一次，之後每過一次冷卻再一次。 */
const procs = (seconds: number, cooldown: number) => 1 + Math.floor(seconds / cooldown)
const rangedMod = (s: MyStats, mod: number) => (s.ranged ? mod : 1)
/** 9 級起每級加多少（不朽盾弓、海妖殺手這種有等級斷點的數值）。 */
const fromLevel9 = (level: number, base: number, perLevel: number) => base + perLevel * Math.max(0, level - 8)
const bonusAdOf = (s: MyStats) => Math.max(0, s.ad - baseAd(s.level))
const bonusHpOf = (s: MyStats) => Math.max(0, s.hp - baseHp(s.level))

/** 會影響傷害或坦度、但不在數值欄裡的裝備被動。
 *  數字取自遊戲本身的裝備資料（CommunityDragon items.cdtb.bin.json 的 mDataValues／mItemCalculations，2026-10），
 *  不是說明文字——說明裡很多數字顯示成 0。
 *  需要條件的（疊層、戰鬥幾秒後、低血量）一律照 note 寫的假設算；有冷卻的以「每波觸發幾次」算。沒列的裝備只算數值。 */
export const ITEM_RULES: Record<number, ItemRule> = {
  // ── 放大屬性、穿透與削減
  3089: { note: "總魔攻 +30%", apply: (e) => ({ ...e, apMult: e.apMult * 1.3 }) },
  3071: { note: "物防削減 30%（疊滿 5 層）", apply: (e) => ({ ...e, armorShred: 1 - (1 - e.armorShred) * 0.7 }) },
  8010: { note: "魔防削減 30%（疊滿 4 層）", apply: (e) => ({ ...e, mrShred: 1 - (1 - e.mrShred) * 0.7 }) },
  3302: {
    note: "黑暗模式 +10% 雙穿透，以一半時間計",
    apply: (e) => ({ ...e, extraArmorPenPct: combinePct(e.extraArmorPenPct, 5), extraMagicPenPct: combinePct(e.extraMagicPenPct, 5) }),
  },
  2501: { note: "額外生命 2.5% 轉物攻", apply: (e) => ({ ...e, bonusHpToAd: e.bonusHpToAd + 0.025 }) },

  // ── 增傷
  3036: { note: "對額外生命多的對手最多 +15% 傷害", apply: (e) => ({ ...e, dominik: true }) },
  6653: {
    note: "燃燒每秒 2% 最大生命、增傷最多 6%",
    apply: (e) => ({ ...e, burnHpPctPerSec: e.burnHpPctPerSec + 0.02, dmgAmp: e.dmgAmp + 0.06 }),
  },
  4633: {
    note: "增傷最多 8%、額外生命 2% 轉魔攻",
    apply: (e) => ({ ...e, dmgAmp: e.dmgAmp + 0.08, bonusHpToAp: e.bonusHpToAp + 0.02 }),
  },
  3161: { note: "技能傷害 +12%（疊滿 4 層）", apply: (e) => ({ ...e, abilityAmp: e.abilityAmp + 0.12 }) },
  8020: { note: "對手受到的魔法傷害 +12%", apply: (e) => ({ ...e, magicAmp: e.magicAmp + 0.12 }) },
  4645: { note: "對 40% 生命以下暴擊 +20%，約當魔法傷害 +8%", apply: (e) => ({ ...e, magicAmp: e.magicAmp + 0.08 }) },
  6676: { note: "5% 生命處決，約當傷害 +5%", apply: (e) => ({ ...e, dmgAmp: e.dmgAmp + 0.05 }) },
  4628: {
    note: "600 距離外命中 +10% 傷害（遠程以全程計，近戰不計）",
    apply: (e) => ({ ...e, rangedDmgAmp: e.rangedDmgAmp + 0.1 }),
  },
  2523: {
    note: "普攻依距離最多 +10%（遠程以滿計，近戰 3%）",
    apply: (e) => ({ ...e, autoAmp: e.autoAmp + 0.03, rangedAutoAmp: e.rangedAutoAmp + 0.07 }),
  },

  // ── 普攻命中附加
  3124: {
    note: "普攻附加 30 魔法傷害；疊層攻速以平均 +24% 計",
    apply: (e) => ({ ...e, onHitMagic: e.onHitMagic + 30, asBonusPct: e.asBonusPct + 24 }),
  },
  3115: { note: "普攻附加 15 + 15% 魔攻 魔法傷害", apply: (e) => withExtra(e, (c) => ({ magic: c.autos * (15 + 0.15 * c.ap) })) },
  3091: { note: "普攻附加 45 魔法傷害", apply: (e) => withExtra(e, (c) => ({ magic: c.autos * 45 })) },
  3153: {
    note: "普攻附加目標當前生命 9%（遠程 6%），以平均剩 70% 計",
    apply: (e) => withExtra(e, (c) => ({ phys: c.autos * (c.s.ranged ? 0.06 : 0.09) * 0.7 * c.t.hp })),
  },
  6672: {
    note: "每 3 下普攻 150（9 級起每級 +5）物理，依目標損血最多 ×1.75，以 ×1.35 計；遠程 ×0.8",
    apply: (e) => withExtra(e, (c) => ({ phys: (c.autos / 3) * fromLevel9(c.s.level, 150, 5) * 1.35 * rangedMod(c.s, 0.8) })),
  },
  3094: { note: "充能普攻 40 魔法傷害，約每 4 下一次", apply: (e) => withExtra(e, (c) => ({ magic: (c.autos / 4) * 40 })) },
  3087: { note: "充能普攻連鎖閃電 60 魔法傷害，約每 4 下一次", apply: (e) => withExtra(e, (c) => ({ magic: (c.autos / 4) * 60 })) },
  3748: {
    note: "普攻附加自身最大生命 1% 物理、主動 4%（冷卻 10 秒）；遠程減半",
    apply: (e) =>
      withExtra(e, (c) => ({
        phys: (c.autos * 0.01 + procs(c.seconds, 10) * 0.04) * c.s.hp * rangedMod(c.s, 0.5),
      })),
  },
  3042: {
    note: "普攻附加最大魔力 1.2%、技能附加 4%（遠程 3%）物理",
    apply: (e) => withExtra(e, (c) => ({ phys: (c.autos * 0.012 + c.casts * (c.s.ranged ? 0.03 : 0.04)) * c.s.mana })),
  },
  3032: {
    note: "普攻英雄時攻速 +30%，持續 6 秒",
    apply: (e) => ({ ...e, asBonusPct: e.asBonusPct + 30 }),
  },
  6610: {
    note: "每 10 秒第一下普攻必定暴擊",
    apply: (e) =>
      withExtra(e, (c) => {
        const crit = Math.min(1, Math.max(0, c.s.critChance / 100))
        const expected = 1 + crit * (c.s.critDamage - 1)
        return { phys: procs(c.seconds, 10) * c.s.ad * Math.max(0, c.s.critDamage - expected) }
      }),
  },
  6699: {
    note: "充能普攻附加目標當前生命 9%（遠程 7%）物理，每波一次（以目標剩 85% 計）",
    apply: (e) => withExtra(e, (c) => ({ phys: (c.s.ranged ? 0.07 : 0.09) * 0.85 * c.t.hp })),
  },
  6692: {
    note: "2 秒內兩次命中：目標最大生命 8% 物理（冷卻 6 秒，遠程 ×0.625）與 150 + 40% 額外物攻的護盾",
    apply: (e) =>
      withShield(
        withExtra(e, (c) => ({ phys: procs(c.seconds, 6) * 0.08 * c.t.hp * rangedMod(c.s, 0.625) })),
        (s) => (150 + 0.4 * bonusAdOf(s)) * rangedMod(s, 0.5),
      ),
  },
  123430: { note: "施放技能疊暴擊率，最多 +20%，以平均 +15% 計", apply: (e) => ({ ...e, critBonus: e.critBonus + 15 }) },

  // ── 耀光類（施放技能後下一次普攻），同時有多件只算最強的
  3057: { note: "耀光：技能後下一次普攻 +100% 基礎物攻", apply: (e) => withSpellblade(e, (c) => ({ phys: c.baseAd })) },
  3100: {
    note: "耀光：技能後下一次普攻 75% 基礎物攻 + 45% 魔攻 魔法傷害",
    apply: (e) => withSpellblade(e, (c) => ({ magic: 0.75 * c.baseAd + 0.45 * c.ap })),
  },
  3078: { note: "耀光：技能後下一次普攻 +200% 基礎物攻", apply: (e) => withSpellblade(e, (c) => ({ phys: 2 * c.baseAd })) },
  3508: { note: "耀光：技能後下一次普攻 +125% 基礎物攻", apply: (e) => withSpellblade(e, (c) => ({ phys: 1.25 * c.baseAd })) },
  6662: { note: "耀光：技能後下一次普攻 +150% 基礎物攻", apply: (e) => withSpellblade(e, (c) => ({ phys: 1.5 * c.baseAd })) },

  // ── 技能附加、燃燒、主動
  6655: {
    note: "回音 75 + 5% 魔攻，單一目標約 2 倍（冷卻 12 秒）",
    apply: (e) => withExtra(e, (c) => (c.casts > 0 ? { magic: procs(c.seconds, 12) * 2 * (75 + 0.05 * c.ap) } : {})),
  },
  2503: {
    note: "技能燃燒每秒 20 + 2% 魔攻（3 秒）；燃燒中魔攻 +4%",
    apply: (e) => ({
      ...withExtra(e, (c) => ({ magic: (20 + 0.02 * c.ap) * Math.min(c.seconds, c.casts * 3) })),
      apCombatMult: e.apCombatMult * 1.04,
    }),
  },
  3118: {
    note: "大絕燃燒地面 3 秒，每秒 60 + 5% 魔攻，每波一次",
    apply: (e) => withExtra(e, (c) => (c.casts > 0 ? { magic: 3 * (60 + 0.05 * c.ap) } : {})),
  },
  4646: {
    note: "2.5 秒內打掉 25% 生命時引爆 125 + 10% 魔攻，每波一次",
    apply: (e) => withExtra(e, (c) => ({ magic: 125 + 0.1 * c.ap })),
  },
  3074: { note: "主動：80% 物攻物理（冷卻 10 秒）", apply: (e) => withExtra(e, (c) => ({ phys: procs(c.seconds, 10) * 0.8 * c.s.ad })) },
  6631: { note: "主動：80% 物攻物理（冷卻 15 秒）", apply: (e) => withExtra(e, (c) => ({ phys: procs(c.seconds, 15) * 0.8 * c.s.ad })) },
  3146: {
    note: "主動：175～253（依等級）+ 30% 魔攻 魔法傷害，每波一次",
    apply: (e) => withExtra(e, (c) => ({ magic: 175 + (78 * (c.s.level - 1)) / 17 + 0.3 * c.ap })),
  },
  3152: { note: "主動：135 + 15% 魔攻 魔法傷害，每波一次", apply: (e) => withExtra(e, (c) => ({ magic: 135 + 0.15 * c.ap })) },
  3084: {
    note: "每波一次 70 + 6% 最大生命的物理傷害",
    apply: (e) => ({ ...e, flatPhysPerFight: e.flatPhysPerFight + 70, hpPhysPerFight: e.hpPhysPerFight + 0.06 }),
  },
  2502: {
    note: "戰鬥中每 4 秒 3% 額外生命魔法傷害",
    apply: (e) => withExtra(e, (c) => ({ magic: Math.floor(c.seconds / 4) * 0.03 * c.bonusHp })),
  },
  3068: { note: "每秒 20 + 1.5% 額外生命魔法傷害", apply: (e) => withExtra(e, (c) => ({ magic: c.seconds * (20 + 0.015 * c.bonusHp) })) },

  // ── 坦度
  6665: { note: "戰鬥 5 秒後額外雙防 +30%", apply: (e) => ({ ...e, bonusResistMult: e.bonusResistMult + 0.3 }) },
  3047: { note: "普攻傷害 −10%", apply: (e) => ({ ...e, autoTaken: 1 - (1 - e.autoTaken) * 0.9 }) },
  3110: { note: "附近敵人攻速 −20%（以普攻傷害 −20% 計）", apply: (e) => ({ ...e, autoTaken: 1 - (1 - e.autoTaken) * 0.8 }) },
  3143: {
    note: "受到的暴擊傷害 −30%（假設對方物理傷害 20% 來自暴擊）",
    apply: (e) => ({ ...e, physTakenMult: e.physTakenMult * (1 - 0.3 * 0.2) }),
  },
  4401: { note: "被魔法打 8 次後魔防 +70（以整波都有計）", apply: (e) => ({ ...e, combatMr: e.combatMr + 70 }) },
  3083: { note: "道具生命 +12%", apply: (e) => ({ ...e, hpMult: e.hpMult * 1.12 }) },
  3065: { note: "受到的護盾 +25%", apply: (e) => ({ ...e, shieldMult: e.shieldMult * 1.25 }) },
  2504: { note: "魔法護盾：15% 最大生命（只擋魔法）", apply: (e) => withShield(e, (s) => 0.15 * s.hp) },
  3156: {
    note: "命脈：200 + 150% 額外物攻 魔法護盾（遠程 ×0.75）",
    apply: (e) => withShield(e, (s) => (200 + 1.5 * bonusAdOf(s)) * rangedMod(s, 0.75)),
  },
  3053: {
    note: "命脈：60% 額外生命的護盾（4.5 秒內衰減，遠程 ×0.6）",
    apply: (e) => withShield(e, (s) => 0.6 * bonusHpOf(s) * rangedMod(s, 0.6)),
  },
  6673: {
    note: "命脈：400（9 級起每級 +30）護盾（遠程 ×0.8）",
    apply: (e) => withShield(e, (s) => fromLevel9(s.level, 400, 30) * rangedMod(s, 0.8)),
  },
  3040: { note: "命脈：18% 最大魔力的護盾", apply: (e) => withShield(e, (s) => 0.18 * s.mana) },
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
  // 好戰者：道具生命 ×1.12。面板的額外生命已含現有倍率，先拆掉再乘新的
  const bonusHp0 = Math.max(0, s.hp - baseHp(s.level))
  const bonusHp1 = (bonusHp0 / e0.hpMult + add.hp) * e1.hpMult
  const hp = s.hp - bonusHp0 + bonusHp1
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
