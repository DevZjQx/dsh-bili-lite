// ============================================================================
// dsh-bili-lite · 计划（它自己排的作息 / 定时任务）—— 两侧共用的唯一真相
//
// 谁决定：永远它自己 —— agent 用 `bun bili.ts schedule add/drop/clear` 写这里，
// 宿主（bili-pulse）只照着读：到点投「计划拍」、拍里带上它自己写的标签。
// 宿主不排、不改、不掷骰子 —— 计划文件和旧的「替它掷骰子排时刻表」是两回事：
// 那个被否掉是因为决定在宿主手里，这里决定在模型手里 ✓
//
// 文件：~/.dsh/bili-lite-work/schedule.json ——
//   { seq, entries: [entry], fired: [最近投递记录（展示用，最多 50 条）] }
//   entry: { id, kind: 'once'|'daily'|'every', label, createdAt, nextDue(ISO),
//            at: "HH:MM"（daily 才有）, everyMin（every 才有）, plan（人话时间，展示用） }
//
// 防滥用上限（写死，与写额度同 philosophy）：在排 ≤30 条；--every 最短 5 分钟。
// ============================================================================
import { SCHEDULE_FILE } from '../config/paths.ts'
import { readJson, writeJson } from './json-file.ts'

export const MAX_PENDING = 30
export const MIN_EVERY_MIN = 5
export const MAX_EVERY_MIN = 1440
/** 保质期：daily / every 默认活 14 天，到期不续就自己消亡（回落兜底节拍） */
export const DEFAULT_FOR_DAYS = 14
export const MAX_FOR_DAYS = 365
const DAY_MS = 86_400_000

export type EntryKind = 'once' | 'daily' | 'every'

export interface ScheduleEntry {
  id: string
  kind: EntryKind
  label: string
  createdAt: string
  /** 下一次该投的时间（ISO）；坏数据可能缺失，读的时候按防御式处理 */
  nextDue: string
  /** daily 才有 */
  at?: string
  /** every 才有 */
  everyMin?: number
  /** once 的人话时间（展示用） */
  plan?: string
  /** add 时的一次性提示（如「今天这个点已过 → 排到明天」） */
  note?: string | null
  /** 保质期的天数（daily / every 才有；默认 DEFAULT_FOR_DAYS） */
  forDays?: number
  /** 到期时间（ISO）；once 没有 —— 发完即撤，不需要保质期。到期投一拍「到期拍」后从计划里撤掉 */
  expiresAt?: string
  /** 已投递次数（「第 N 次」和「一直在重复」都靠它；老数据没有 = 0） */
  fires?: number
}

export interface FiredEntry { at: string; id: string; kind: EntryKind; label: string }
export interface PlanFile { seq: number; entries: ScheduleEntry[]; fired: FiredEntry[] }

const pad = (n: number): string => String(n).padStart(2, '0')
/** 仓库统一的时间展示：sv-SE → "YYYY-MM-DD HH:mm" */
const fmtDate = (d: Date): string => d.toLocaleDateString('sv-SE') + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())

/** 老数据（没有 expiresAt / fires）在读的时候补齐 —— 只算不写，下一次落盘自然带上 */
function normalize(e: ScheduleEntry): ScheduleEntry {
  const out: ScheduleEntry = { ...e, fires: Math.max(0, Number(e.fires) || 0) }
  if (!out.expiresAt && (out.kind === 'daily' || out.kind === 'every')) {
    const c = Date.parse(out.createdAt)
    if (Number.isFinite(c)) out.expiresAt = new Date(c + (Number(out.forDays) || DEFAULT_FOR_DAYS) * DAY_MS).toISOString()
  }
  return out
}

export function readPlan(): PlanFile {
  const p = readJson<Partial<PlanFile>>(SCHEDULE_FILE, {})
  return {
    seq: Number(p.seq) || 0,
    entries: Array.isArray(p.entries) ? p.entries.map(normalize) : [],
    fired: Array.isArray(p.fired) ? p.fired : [],
  }
}

function writePlan(p: PlanFile): void { writeJson(SCHEDULE_FILE, p) }

/** "HH:MM" → {h,m}；不合规矩给 null（让调用方报用法，不静默猜） */
export function parseHHMM(s: string | undefined | null): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim())
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2])
  return h <= 23 && mi <= 59 ? { h, m: mi } : null
}

/** 下一个「今天（或明天）的 h:m」—— 已过就排到明天（本地时区） */
export function nextDailyAt(h: number, m: number, from: Date = new Date()): Date {
  const d = new Date(from)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1)
  return d
}

/** --at："21:30"（今天，过了就明天）或 "2026-02-06 21:30" / "2026-02-06T21:30"（本地时区）→ Date；不对就 throw */
export function parseAt(s: string | undefined | null, now: Date = new Date()): Date {
  const str = String(s ?? '').trim()
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})$/.exec(str)
  if (m) {
    const [, y, mo, d, h, mi] = m.map(Number)
    const t = new Date(y, mo - 1, d, h, mi, 0, 0)
    if (t.getFullYear() !== y || t.getMonth() !== mo - 1 || t.getDate() !== d) throw new Error(`没有这个日子：${str}（示例：2026-02-06 21:30）`)
    return t
  }
  const hm = parseHHMM(str)
  if (hm) return nextDailyAt(hm.h, hm.m, now)
  throw new Error(`看不懂 --at "${str}" —— 要 "21:30" 或 "2026-02-06 21:30"`)
}

/** --every："90" | "90m" | "2h" | "1d" → 分钟数（5–1440）；不对就 throw */
export function parseEvery(s: string | undefined | null): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(String(s ?? '').trim())
  if (!m) throw new Error(`看不懂 --every "${s}" —— 示例：90m、2h、45`)
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  const min = Math.round(unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n)
  if (!Number.isFinite(min) || min < MIN_EVERY_MIN || min > MAX_EVERY_MIN) {
    throw new Error(`--every 要在 ${MIN_EVERY_MIN} 分钟 – ${MAX_EVERY_MIN} 分钟（1 天）之间，现在是 ${min}`)
  }
  return min
}

/** --for：保质期天数 —— "7d" / "7" → 7；1–365 天；不对就 throw */
export function parseFor(s: string | undefined | null): number {
  const m = /^(\d+)\s*[d天]?$/i.exec(String(s ?? '').trim())
  const n = m ? Number(m[1]) : NaN
  if (!Number.isFinite(n) || n < 1 || n > MAX_FOR_DAYS) throw new Error(`--for 要在 1–${MAX_FOR_DAYS} 天之间（示例：7d、14、30）`)
  return n
}

/** 人话时间（展示用）：once → "2026-02-06 21:30"，daily → "每天 21:30"，every → "每 90 分钟" */
export function fmtWhen(e: ScheduleEntry): string {
  if (e.kind === 'daily') return `每天 ${e.at}`
  if (e.kind === 'every') return `每 ${e.everyMin} 分钟`
  return e.plan || (e.nextDue ? fmtDate(new Date(e.nextDue)) : '?')
}

const defaultLabel: Record<EntryKind, string> = { once: '到点了，看一眼？', daily: '按计划的日常一拍', every: '按计划的一拍' }
const cleanLabel = (s: string | undefined, kind: EntryKind): string =>
  String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || defaultLabel[kind]

export interface AddEntryInput { at?: string; daily?: string; every?: string; label?: string; forDays?: string }

/**
 * 加一条（三种拍子给一个）：{ at?, daily?, every?, label? }
 * 返回 { entry, note }；排满了 / 参数不对 throw（CLI 把话带给模型）。
 */
export function addEntry({ at, daily, every, label, forDays }: AddEntryInput = {}): { entry: ScheduleEntry; note: string | null } {
  const given = [at !== undefined, daily !== undefined, every !== undefined].filter(Boolean).length
  if (given !== 1) throw new Error('--at / --daily / --every 三选一，正好给一个')
  if (at !== undefined && forDays !== undefined) throw new Error('--at 是一次性的（发完即撤），不用 --for —— 保质期只给 --daily / --every')
  const p = readPlan()
  if (p.entries.length >= MAX_PENDING) throw new Error(`计划排满了（最多 ${MAX_PENDING} 条在排）—— 先 schedule drop 几条，或 clear 重排`)

  let draft: Omit<ScheduleEntry, 'id' | 'label' | 'createdAt'>
  if (at !== undefined) {
    const bare = parseHHMM(at)          // 只给了 HH:MM：今天这个点已过会排到明天，说一声
    const rolled = bare && new Date().setHours(bare.h, bare.m, 0, 0) <= Date.now()
    const t = parseAt(at)
    draft = { kind: 'once', nextDue: t.toISOString(), plan: fmtDate(t), note: rolled ? '今天这个点已过 → 排到明天' : null }
  } else if (daily !== undefined) {
    const hm = parseHHMM(daily)
    if (!hm) throw new Error(`看不懂 --daily "${daily}" —— 要 "HH:MM"，示例：21:00`)
    const t = nextDailyAt(hm.h, hm.m)
    draft = { kind: 'daily', at: `${pad(hm.h)}:${pad(hm.m)}`, nextDue: t.toISOString() }
  } else {
    const min = parseEvery(every)
    draft = { kind: 'every', everyMin: min, nextDue: new Date(Date.now() + min * 60_000).toISOString() }
  }
  // 保质期只给 daily / every：到点不是为了执行到底，是留一个「还续不续」的复查点
  const createdAt = new Date()
  const days = draft.kind === 'once' ? null : parseFor(forDays ?? String(DEFAULT_FOR_DAYS))
  const entry: ScheduleEntry = {
    ...draft,
    id: 's' + (p.seq + 1),
    label: cleanLabel(label, draft.kind),
    createdAt: createdAt.toISOString(),
    fires: 0,
    ...(days ? { forDays: days, expiresAt: new Date(createdAt.getTime() + days * DAY_MS).toISOString() } : {}),
  }
  p.seq += 1
  p.entries.push(entry)
  writePlan(p)
  return { entry, note: entry.note ?? null }
}

export function dropEntry(id: string | undefined): boolean {
  const p = readPlan()
  const before = p.entries.length
  p.entries = p.entries.filter((e) => e.id !== String(id ?? '').trim())
  writePlan(p)
  return p.entries.length < before
}

export function clearPlan(): number {
  const p = readPlan()
  const n = p.entries.length
  p.entries = []
  writePlan(p)
  return n
}

const expiryOf = (e: ScheduleEntry): number => {
  const t = Date.parse(e.expiresAt ?? '')
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY
}

/** 到点的（含错过补投：宿主刚起来也照发）；过期的不再投普通拍 —— 它该走「到期拍」。只读不写 */
export function dueEntries(now = Date.now()): ScheduleEntry[] {
  return readPlan().entries
    .filter((e) => Number.isFinite(Date.parse(e.nextDue)) && Date.parse(e.nextDue) <= now && expiryOf(e) > now)
    .sort((a, b) => Date.parse(a.nextDue) - Date.parse(b.nextDue))
}

/** 到期的（保质期过了）—— 投一拍「还续不续」，投完由 markExpired 撤掉；只读不写 */
export function dueExpired(now = Date.now()): ScheduleEntry[] {
  return readPlan().entries
    .filter((e) => expiryOf(e) <= now)
    .sort((a, b) => expiryOf(a) - expiryOf(b))
}

/** 投完记账：once 删掉；daily/every 推到下一次；追一笔 fired（最多留 50 条） */
export function markFired(ids: string[], now: Date = new Date()): ScheduleEntry[] {
  const p = readPlan()
  const hit = new Set(ids)
  const done: ScheduleEntry[] = []
  p.entries = p.entries.filter((e) => {
    if (!hit.has(e.id)) return true
    done.push(e)
    e.fires = (Number(e.fires) || 0) + 1      // 「第 N 次」靠它 —— 重复只有被数出来才看得见
    const hm = parseHHMM(e.at)
    if (e.kind === 'daily' && hm) {
      e.nextDue = nextDailyAt(hm.h, hm.m, now).toISOString()
      return true
    }
    if (e.kind === 'every' && Number.isFinite(Number(e.everyMin))) {
      let next = Date.parse(e.nextDue) + Number(e.everyMin) * 60_000
      if (next <= now.getTime()) next = now.getTime() + Number(e.everyMin) * 60_000   // 迟到的投递不连环补
      e.nextDue = new Date(next).toISOString()
      return true
    }
    return false   // once（以及认不出的坏数据）→ 发完即撤
  })
  for (const e of done) p.fired.push({ at: now.toISOString(), id: e.id, kind: e.kind, label: e.label })
  if (p.fired.length > 50) p.fired = p.fired.slice(-50)
  writePlan(p)
  return done
}

/** 到期拍投完记账：这几条从计划里撤掉（不自动续）—— 计划空下来，兜底节拍接手 */
export function markExpired(ids: string[], now: Date = new Date()): ScheduleEntry[] {
  const p = readPlan()
  const hit = new Set(ids)
  const done = p.entries.filter((e) => hit.has(e.id))
  p.entries = p.entries.filter((e) => !hit.has(e.id))
  for (const e of done) p.fired.push({ at: now.toISOString(), id: e.id, kind: e.kind, label: e.label })
  if (p.fired.length > 50) p.fired = p.fired.slice(-50)
  writePlan(p)
  return done
}

/**
 * 「第 N 次 · 排于 X 天前」—— 把「一直在重复」这件事数出来。
 * 重复对人是无感的，对模型也是：不数出来，它就不会觉得这条便条已经老了。
 */
export function historyText(e: ScheduleEntry, now: Date = new Date(), upcoming = false): string {
  const fires = Math.max(0, Number(e.fires) || 0)
  const c = Date.parse(e.createdAt)
  const days = Number.isFinite(c) ? Math.floor((now.getTime() - c) / DAY_MS) : null
  const when = days === null ? '' : days <= 0 ? '今天排的' : `排于 ${days} 天前`
  const count = upcoming ? `第 ${fires + 1} 次` : `投过 ${fires} 次`
  return `${count}${when ? ' · ' + when : ''}`
}

/** 保质期还剩几天（once 没有）—— 列表 / add 的回执用 */
export function expiryText(e: ScheduleEntry, now: Date = new Date()): string | null {
  if (!Number.isFinite(expiryOf(e))) return null
  const left = Math.ceil((expiryOf(e) - now.getTime()) / DAY_MS)
  return left <= 0 ? '今天到期' : `还剩 ${left} 天`
}

export interface PlanSummary { pending: number; nextDueText: string | null; nextWhenText: string | null }

/** 设置页 / 状态用：在排几条、下一次什么时候 */
export function planSummary(now: Date = new Date()): PlanSummary {
  const p = readPlan()
  const next = p.entries.filter((e) => Number.isFinite(Date.parse(e.nextDue))).sort((a, b) => Date.parse(a.nextDue) - Date.parse(b.nextDue))[0]
  return {
    pending: p.entries.length,
    nextDueText: next ? fmtDate(new Date(next.nextDue)) : null,
    nextWhenText: next ? fmtWhen(next) : null,
  }
}
