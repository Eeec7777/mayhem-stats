import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, "..", "..")
const venvPython = join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
const PYTHON = process.env.E2E_PYTHON ?? (existsSync(venvPython) ? venvPython : "python")

export type Row = Record<string, string | number | null>

/** 直接對 mayhem.db 下 SQL（唯讀），當作 Cube 數字的獨立對照。 */
export function sql(query: string, params: (string | number)[] = []): Row[] {
  const out = execFileSync(PYTHON, ["-I", join(here, "oracle.py")], {
    input: JSON.stringify({ sql: query, params }),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(out)
}

/** 站長自己的 puuid（accounts.is_me = 1 的第一個，和前端預設帳號一致）。 */
export function mePuuid(): string {
  return String(sql("SELECT puuid FROM accounts WHERE is_me = 1 ORDER BY added_at LIMIT 1")[0].puuid)
}

/** 自己的 Mayhem 場次彙總：場數、勝場。 */
export function myRecord(extraWhere = "", params: (string | number)[] = []) {
  const r = sql(
    `SELECT COUNT(*) AS games, COALESCE(SUM(p.win), 0) AS wins
       FROM match_participants p JOIN matches m USING (platform_id, game_id)
      WHERE p.puuid = ? AND m.queue_id = 2400 ${extraWhere}`,
    [mePuuid(), ...params],
  )[0]
  return { games: Number(r.games), wins: Number(r.wins) }
}
