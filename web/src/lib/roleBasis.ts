import type { CubeFilter } from "@/lib/cube"
import { BUILD_ROLES } from "@/pages/shared"

/** 各頁的定位（雷達圖、篩選、長條）一律用這一份：依終場出裝判斷，AP 刺客再看英雄的官方定位
 *  （定義在 cube/model/cubes/builds.yml）。原本還能切「官方主定位／含次定位」，
 *  但官方定位看不出這場實際怎麼出（官方「鬥士」有一半出純輸出裝），各頁用不同依據時雷達也對不起來，所以拿掉。 */
export type RoleSpec = {
  /** 分組用的 Cube 維度 */
  dimension: string
  /** 雷達的頂點（固定順序，形狀才能跨篩選、跨頁比較） */
  labels: string[]
  /** 篩某一類時的條件 */
  filterFor: (role: string) => CubeFilter[]
  /** 說明文字 */
  caption: string
}

export const ROLE_SPEC: RoleSpec = {
  dimension: "builds.build_role",
  labels: BUILD_ROLES,
  filterFor: (role) => [{ member: "builds.build_role", operator: "equals", values: [role] }],
  caption:
    "依每場終場出裝判斷（坦克、AD 鬥士、AD 近戰、AD 刺客、射手、AP 輸出、AP 刺客、AP 鬥士、輔助；射手與 AP 刺客另看英雄的官方定位），同一隻英雄不同場可能不一樣；太早結束沒成裝的場次不列入",
}
