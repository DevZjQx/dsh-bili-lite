// ============================================================================
// dsh-bili-lite · 账本 —— 额度 / 判重 / 「看过」的唯一真相（~/.dsh/bili-lite-work/ledger.json）
// comment 与 watch 都记进来；「看过」只看这份账本。
// ============================================================================
import { LEDGER_FILE } from '../../config/paths.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'

export type LedgerType = 'comment' | 'interact' | 'watch'

/** 一条记录：type 决定哪些字段有意义（comment 用 bvid/note，interact 用 action/target，watch 用 bvid/up/title） */
export interface LedgerEntry {
  at: string
  type: LedgerType
  bvid?: string
  /** interact 的判重键：BV 号或 uid:<mid> */
  target?: string
  /** interact 的动作：like / follow */
  action?: string
  /** comment 的回复目标：被回复的那条评论 rpid（顶层评论不填）—— 回复的判重按它算 */
  rpid?: number
  /** comment 的楼层根 rpid：回楼中楼时才有（顶层评论的回复两者相同） */
  root?: number
  /** 我们自己这条评论的 rpid（B 站回执里带的，公开可见性核对用） */
  newRpid?: number
  /** 取消类（取消赞 / 取关）：不占额度，也不参与判重 */
  undo?: true
  note?: string
  up?: string
  title?: string
}

export interface Ledger { log: LedgerEntry[] }

export const today = (): string => new Date().toLocaleDateString('sv-SE')

export function readLedger(): Ledger { return readJson<Ledger>(LEDGER_FILE, { log: [] }) }

export function ledgerAppend(entry: Omit<LedgerEntry, 'at'>): void {
  const led = readLedger()
  led.log.push({ at: new Date().toISOString(), ...entry })
  if (led.log.length > 2000) led.log = led.log.slice(-1500)
  writeJson(LEDGER_FILE, led)
}

export function writesToday(): LedgerEntry[] {
  return readLedger().log.filter((x) => x.type === 'comment' && new Date(x.at).toLocaleDateString('sv-SE') === today())
}

/** 今天做过的互动（赞 / 关注）—— 取消类不算额度 */
export function interactionsToday(): LedgerEntry[] {
  return readLedger().log.filter((x) => x.type === 'interact' && !x.undo
    && new Date(x.at).toLocaleDateString('sv-SE') === today())
}

/** 同一个目标、同一种互动，days 天内做过没有 —— 看最后一条记录：
 *  最后一次是取消（undo）→ 现在没这个互动，不算；否则按时间判 days 天。
 *  这样「赞 → 取消 → 再赞」不会被 7 天前的旧赞卡死，取消也仍然是纠正、不是在刷。 */
export function interactedWithin(target: string, action: string, days = 7): boolean {
  const log = readLedger().log
  let last: LedgerEntry | null = null
  for (const x of log) {
    if (x.type === 'interact' && x.action === action && x.target === target) last = x
  }
  if (!last || last.undo) return false
  return Date.now() - new Date(last.at).getTime() < days * 86_400_000
}

export function commentedWithin(bvid: string, days = 7): boolean {
  return readLedger().log.some((x) => x.type === 'comment' && x.bvid === bvid
    && Date.now() - new Date(x.at).getTime() < days * 86_400_000)
}

/** 同一条评论 7 天内回过没有 —— 回复的判重键是 rpid，不是 BV 号（同一视频下可以分别回不同的人） */
export function repliedWithin(rpid: string | number, days = 7): boolean {
  return readLedger().log.some((x) => x.type === 'comment' && String(x.rpid ?? '') === String(rpid)
    && Date.now() - new Date(x.at).getTime() < days * 86_400_000)
}

export function seenSet(): Set<string> {
  const seen = new Set<string>()
  for (const x of readLedger().log) if (x.bvid) seen.add(x.bvid)
  return seen
}
