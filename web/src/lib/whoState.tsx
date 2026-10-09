import { createContext, useContext, useState, type ReactNode } from "react"
import type { Who } from "@/lib/who"

/** 「看誰」的選擇跨頁保留：在英雄頁選了追蹤對象，切到增幅頁還是追蹤對象，不必每頁重選。
 *  不是每頁都有三個選項（節奏頁沒有所有人），所以各頁用 usePageWho 讀，遇到那頁不能選的就退回目前帳號——
 *  只是這頁暫時退回，選擇本身還留著，回到能選的頁面又會是原本那個。 */
const WhoState = createContext<[Who, (who: Who) => void] | null>(null)

export function WhoProvider({ children }: { children: ReactNode }) {
  const state = useState<Who>("account")
  return <WhoState.Provider value={state}>{children}</WhoState.Provider>
}

export function usePageWho(disabled?: Partial<Record<Who, string>>): [Who, (who: Who) => void] {
  const ctx = useContext(WhoState)
  if (!ctx) throw new Error("usePageWho 必須在 WhoProvider 內使用")
  const [stored, set] = ctx
  return [disabled?.[stored] ? "account" : stored, set]
}
