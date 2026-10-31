/**
 * dsh-bili-lite · bili-agent —— ops 层（唯一的数据面）
 *
 * 为什么有这一层：同一件事现在有两个调用方 —— 终端里的 `bili.ts` 和 DSH 的工具
 * （`bili_feed` / `bili_video` / …）。tool 的契约要求 `execute` 返回一个规范化 JSON 值，
 * 由渲染层单独负责给人看的话（DSH `adding-a-tool.md`：不许让调用方去解析 prose）。
 * 所以「取数据」和「说人话」必须分开，否则两条路只有一条能拿到结构化结果。
 *
 * 这一层的三条铁律：
 *   1. 不打印、不退出、不读 argv —— 失败一律 `throw new BiliError(…)`，
 *      CLI 把它翻成退出码（2/3/4/5/6），tool 把它翻成 isError。
 *   2. 不格式化 —— 不出现「万」「MM:SS」「3 天前」。数字给秒和原值，
 *      口径（怎么显示）属于调用方。唯一的例外是 schedule.whenText（见下）。
 *   3. 副作用留在这一层 —— 账本记账、`看过` 标记、收件箱已读、计划落盘都在这里。
 *      谁上移到 tool，CLI 那条路就会漏记。
 *
 * 现状：全部 op 已迁完（feed / up / following / video / shots / inbox / history /
 * schedule / comment / interact）。CLI 只剩「解析 flags + 排版」，数据与副作用都在这里。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { apiGet, apiPost, explainCode, loadCred, whoami, wbi, getFollowingFeed, searchUsers, getSpaceVideos, getFollowings, getView, getPlayerInfo, pickSubtitle, getSubtitleLines, getDanmakuBrief, getMsgFeed, getThreadReplies, banUntil, banWhy, getPlayUrl, UA } from '../../lib/bilibili.ts'
import type { Cred, ApiEnvelope, VideoView, NavResp, MsgFeedRow } from '../../lib/bilibili.ts'
import { requireFfmpeg, runFfmpegAsync, ffmpegCaps, findFfmpegFont, isFfmpegAbort } from '../../lib/ffmpeg.ts'
import { formatClock, formatClockFine } from '../../lib/timecode.ts'
import { SHOTS_DIR } from '../../config/paths.ts'
import { seenSet, ledgerAppend, readLedger, writesToday, interactionsToday, interactedWithin, commentedWithin, repliedWithin, today } from './ledger.ts'
import { config, DEFAULTS } from '../../config/store.ts'
import { readPlan, addEntry, dropEntry, clearPlan, fmtWhen, expiryText, MAX_PENDING } from '../../lib/schedule.ts'
import type { ScheduleEntry } from '../../lib/schedule.ts'
import { readJson, writeJson } from '../../lib/json-file.ts'
import { INBOX_FILE } from '../../config/paths.ts'

// ── 失败 ────────────────────────────────────────────────────────────────
/**
 * 失败码与 CLI 退出码的对应（映射在 bili.ts，不放这里 —— 退出码是 CLI 的方言）：
 *   usage 2 · credential/guard 3 · auth/notfound 4 · upstream 5 · unsupported 6
 */
export type OpsErrorCode =
  /** 参数不对：缺 BV、格数非法、--every 太短…… */
  | 'usage'
  /** 没有凭据（没登录 / cookie 丢了） */
  | 'credential'
  /** 护栏拒绝：额度用完 / 7 天内判重 / 分享已关闭 —— 不是 bug，是克制 */
  | 'guard'
  /** 有凭据但登录态失效（-101 之类），要去重新扫码 */
  | 'auth'
  /**
   * 目标不存在：搜不到这个人 / 这条稿子不在了。
   * 与 auth 共用退出码 4 —— 这是历史沿革（原来「找不到 UP」就是 4），别把它当登录问题。
   */
  | 'notfound'
  /** B 站接口失败：网络、风控熔断、非零 code */
  | 'upstream'
  /** 环境缺能力：没 ffmpeg / 这条视频没字幕 / 宿主没装依赖 */
  | 'unsupported'

export class BiliError extends Error {
  readonly code: OpsErrorCode
  /** 下一步该干什么（CLI 打在 ✗ 后面；tool 拼进 message 里） */
  readonly hint?: string

  constructor(code: OpsErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'BiliError'
    this.code = code
    this.hint = hint
  }
}

// ── 共享小工具（只做数据整形，不碰显示口径）──────────────────────────────
const BV_RE = /^BV[0-9A-Za-z]{10}$/
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/**
 * "90" / "1:30" / "1:02:03" → 秒。
 * 给了但认不出就 undefined —— 不静默当 0（0 秒和「不知道多长」是两件事）。
 */
function toSeconds(d: number | string | null | undefined): number | undefined {
  if (d === null || d === undefined || d === '') return undefined
  const s = String(d).trim()
  const parts = s.split(':').map(Number)
  if (parts.length >= 2 && parts.every((x) => Number.isFinite(x))) return parts.reduce((a, b) => a * 60 + b, 0)
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/** 没凭据是常态，不是「意外」：统一翻成 credential 码，消息原样保留（里面已经写了去哪补） */
function cred(): Cred {
  try { return loadCred() } catch (e) { throw new BiliError('credential', msg(e)) }
}

/** 搜索结果的标题带 <em> 高亮标签，去掉 */
const plainTitle = (s: string | undefined): string => String(s ?? '').replace(/<[^>]+>/g, '')

/** 数字参数容错：NaN / 没给 → 默认值（再交给 clamp 收边界） */
const finiteOr = (n: number | undefined, fallback: number): number => (Number.isFinite(Number(n)) ? Number(n) : fallback)

/** 秒级时间戳 → YYYY-MM-DD（本地时区；日期是数据，不是口径） */
const dateOnly = (sec: number): string => new Date(sec * 1000).toLocaleDateString('sv-SE')

/** 逐句字幕拼成可读的流水：CJK 边界不加空格，英文边界加 */
const flowText = (texts: string[]): string => texts.reduce((acc, t) => {
  if (!acc) return t
  const cjk = /[\u4e00-\u9fff，。！？、；：…）》」』％]$/.test(acc.slice(-1)) || /^[\u4e00-\u9fff，。！？、；：…（《「『]/.test(t)
  return acc + (cjk ? '' : ' ') + t
}, '')

// ── feed ────────────────────────────────────────────────────────────────
/** limit 1–10（超出按 10）；keywords ≤3 个，不给就查热门 */
export interface FeedOptions {
  limit?: number
  keywords?: string[]
}

/** 候选从哪来：关注动态 → 搜索 → 热门，谁有谁上 */
export type FeedSource = 'search' | 'following' | 'popular'

export interface FeedCandidate {
  bvid: string
  title: string
  up?: string
  play?: number
  durationSec?: number
  source: FeedSource
  /** source=search 时命中的那个词 */
  keyword?: string
}

export interface FeedResult {
  candidates: FeedCandidate[]
  /**
   * 源级失败 / 跳过（关注动态缺 buvid3、某个词搜挂了……）。
   * 这类情况不抛错：一条支路抖一下不该让整次「今天看什么」失败。
   */
  notes: string[]
}

/** 搜索接口的字段形态（内部用，不对外暴露 —— 它只是上游的方言） */
interface SearchRow { bvid?: string; title?: string; author?: string; play?: number; duration?: number | string }
interface PopularRow { bvid?: string; title?: string; owner?: { name?: string }; stat?: { view?: number }; duration?: number | string }
interface ReplyRow { like?: number; member?: { uname?: string }; content?: { message?: string }; count?: number }

/**
 * 今天的候选：关键词搜索（它自己给）→ 关注动态 → 热门，谁有谁上，凑够 n 条为止。
 *
 * 三条支路互不牵连：一条挂了只记 note，其余照给。理由是抖动是常态 ——
 * 关注动态缺 buvid3 必被 -352 拦，热门偶尔超时，为这些让整次「今天看什么」失败
 * 等于让它每一拍都在跟网络吵架。
 */
export async function feed(opts: FeedOptions = {}): Promise<FeedResult> {
  // 非法数字（--n abc / 工具传了 NaN）退回默认值：静默返回空列表比报错更难查
  const wanted = Number(opts.limit ?? 5)
  const n = clamp(Math.trunc(Number.isFinite(wanted) ? wanted : 5), 1, 10)
  const keywords = (opts.keywords ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
  const credential = cred()
  const seen = seenSet()
  const notes: string[] = []
  const pool: FeedCandidate[] = []
  /** 只排除「看过」和重复；不预先排除任何题材 —— 要不要看它自己判断 */
  const push = (c: FeedCandidate): void => {
    if (!BV_RE.test(c.bvid)) return
    if (seen.has(c.bvid)) return
    if (pool.some((x) => x.bvid === c.bvid)) return
    pool.push(c)
  }

  // ① 它自己给的关键词（不给就跳过这一路）
  for (const kw of keywords) {
    try {
      const qs = await wbi({ search_type: 'video', keyword: kw.slice(0, 40), page: 1 }, credential)
      const j = await apiGet<ApiEnvelope<{ result?: SearchRow[] }>>(
        `https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`,
        { cred: credential, referer: 'https://search.bilibili.com/' },
      )
      for (const r of j.data?.result ?? []) {
        if (!r.bvid) continue
        push({
          bvid: r.bvid,
          title: plainTitle(r.title),
          up: r.author,
          play: r.play === undefined ? undefined : Number(r.play),
          durationSec: toSeconds(r.duration),
          source: 'search',
          keyword: kw,
        })
      }
    } catch (e) { notes.push(`搜「${kw}」失败：${msg(e)}`) }
    if (pool.length >= n * 3) break
  }

  // ② 关注动态：关注是它自己做的决定，这里只把结果端上来
  if (pool.length < n) {
    if (!credential.buvid3) {
      notes.push('关注动态跳过：cookie 里没有 buvid3 —— 去设置页重抄一次 cookie；这轮先靠搜索 / 热门')
    } else {
      const before = pool.length
      try {
        const items = await getFollowingFeed(credential)
        for (const it of items) {
          const a = it.modules?.module_dynamic?.major?.archive
          if (!a?.bvid) continue
          push({
            bvid: a.bvid,
            title: String(a.title ?? ''),
            up: it.modules?.module_author?.name,
            play: a.stat?.play === undefined ? undefined : Number(a.stat.play),
            durationSec: toSeconds(a.duration_text),
            source: 'following',
          })
        }
        if (pool.length === before) notes.push('关注动态里没有没看过的投稿 —— 关注的人还没更新，或这个号还没关注谁')
      } catch (e) { notes.push(`关注动态失败：${msg(e)}`) }
    }
  }

  // ③ 还是不够就用热门补
  if (pool.length < n) {
    try {
      const j = await apiGet<ApiEnvelope<{ list?: PopularRow[] }>>(
        'https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20',
        { cred: credential },
      )
      for (const r of j.data?.list ?? []) {
        if (!r.bvid) continue
        push({
          bvid: r.bvid,
          title: String(r.title ?? ''),
          up: r.owner?.name,
          play: r.stat?.view,
          durationSec: toSeconds(r.duration),
          source: 'popular',
        })
      }
    } catch (e) { notes.push(`热门列表失败：${msg(e)}`) }
  }

  return { candidates: pool.slice(0, n), notes }
}

// ── up ──────────────────────────────────────────────────────────────────
export type UpOrder = 'pubdate' | 'click' | 'stow'

/** target 可以写 mid / 空间链接 / 名字（写名字时先搜一次，歧义信息进 matched） */
export interface UpOptions {
  target: string
  limit?: number
  page?: number
  order?: UpOrder
}

export interface UpVideo {
  bvid: string
  title: string
  play: number
  danmaku: number
  /** 接口给的是 "MM:SS" 字符串，这里换算成秒；认不出就不填 */
  durationSec?: number
  /** ISO 日期；接口没给就不填 */
  publishedAt?: string
}

export interface UpResult {
  mid: string
  name?: string
  total: number
  page: number
  pages: number
  /** 本页条数（收过边界后的真实值）—— 编号 / 「下一页带 --n」都要用它，别让调用方再算一遍 */
  pageSize: number
  order: UpOrder
  videos: UpVideo[]
  /** target 是按名字找的时候才有：命中的那位 + 其余同名候选（让它自己判断有没有认错人） */
  matched?: {
    mid: string
    name: string
    fans?: number
    videos?: number
    alternates: Array<{ mid: string; name: string }>
  }
}

/**
 * 某位 UP 的投稿列表。target 三种写法：纯 mid / 空间链接 / 名字。
 * 写名字要多花一次搜人（只读，同一套节流）—— 搜到的第一位当命中，其余进 matched.alternates，
 * 让它自己判断有没有认错人（同名 UP 很常见）。
 */
export async function up(opts: UpOptions): Promise<UpResult> {
  const target = String(opts.target ?? '').trim()
  if (!target) throw new BiliError('usage', '缺少目标：mid / 空间链接 / 名字')
  const ps = clamp(Math.trunc(finiteOr(opts.limit, 20)), 1, 50)
  const pn = clamp(Math.trunc(finiteOr(opts.page, 1)), 1, 500)
  const order: UpOrder = opts.order ?? 'pubdate'
  if (order !== 'pubdate' && order !== 'click' && order !== 'stow') {
    throw new BiliError('usage', `--order 只认 pubdate / click / stow，收到「${String(order)}」`)
  }
  const credential = cred()

  let mid = ''
  let matched: UpResult['matched']
  const fromUrl = target.match(/space\.bilibili\.com\/(\d{1,12})/)
  if (fromUrl) mid = fromUrl[1]
  else if (/^\d{1,12}$/.test(target)) mid = target
  else {
    const hits = (await searchUsers(target, credential)).filter((u) => u.mid)
    if (!hits.length) {
      throw new BiliError('notfound', `没搜到叫「${target}」的 UP`, '换成完整的名字，或直接写 mid（following / video 的输出里有）')
    }
    const [top, ...rest] = hits
    mid = String(top.mid)
    matched = {
      mid,
      name: String(top.uname ?? ''),
      fans: top.fans === undefined ? undefined : Number(top.fans),
      videos: top.videos === undefined ? undefined : Number(top.videos),
      alternates: rest.slice(0, 4).map((u) => ({ mid: String(u.mid), name: String(u.uname ?? '') })),
    }
  }

  const res = await getSpaceVideos(mid, credential, { pn, ps, order })
  return {
    mid,
    name: res.name,
    total: res.total,
    page: pn,
    pages: Math.max(1, Math.ceil(res.total / ps)),
    pageSize: ps,
    order,
    videos: res.list.map((v) => ({
      bvid: String(v.bvid ?? ''),
      title: plainTitle(v.title),
      play: Number(v.play ?? 0) || 0,
      danmaku: Number(v.video_review ?? 0) || 0,
      durationSec: toSeconds(v.length),
      publishedAt: v.created ? dateOnly(Number(v.created)) : undefined,
    })),
    matched,
  }
}

// ── following ───────────────────────────────────────────────────────────
export interface FollowingOptions {
  limit?: number
  page?: number
}

export interface FollowingUser {
  mid: string
  name: string
  followedAt?: string
  badge?: string
  sign?: string
}

export interface FollowingResult {
  /** vmid 现查 nav —— 配置里的 self 是快照，换过号会指错人 */
  self: { mid: string; name: string }
  total: number
  page: number
  pages: number
  /** 本页条数（收过边界后的真实值）—— 编号 / 「下一页带 --n」都要用它 */
  pageSize: number
  users: FollowingUser[]
  /** 翻过头了：pages 是上限，它不该以为「关注了 0 个人」 */
  outOfRange: boolean
}

/**
 * 我关注了谁（名单本身，最近关注的在前）。
 * 和 feed 里的「关注动态」分工：动态只说谁最近发了什么，长期不更的看不见；
 * 这条才是完整名单，mid 可直接抄给 up 往下翻。
 *
 * vmid 只能是自己，所以现查一次 nav —— 配置里的 self 是登录那一刻的快照，换过号就指错人。
 */
export async function following(opts: FollowingOptions = {}): Promise<FollowingResult> {
  const ps = clamp(Math.trunc(finiteOr(opts.limit, 50)), 1, 50)
  const pn = clamp(Math.trunc(finiteOr(opts.page, 1)), 1, 500)
  const credential = cred()
  const self = await whoami(credential)
  const res = await getFollowings(self.mid, credential, { pn, ps })
  const pages = Math.max(1, Math.ceil(res.total / ps))
  return {
    self: { mid: String(self.mid), name: String(self.name ?? '') },
    total: res.total,
    page: pn,
    pages,
    pageSize: ps,
    // 页码越界单说：不然会渲染出「第 2/1 页」这种对不上的标题
    outOfRange: res.total > 0 && pn > pages,
    users: res.list.map((u) => {
      const official = String(u.official?.title ?? '').trim()
      return {
        mid: String(u.mid ?? ''),
        name: String(u.uname ?? ''),
        followedAt: u.mtime ? dateOnly(Number(u.mtime)) : undefined,
        badge: official || (Number(u.vip?.vipStatus) === 1 ? '大会员' : '') || undefined,
        // 签名常带换行：压成一行，截断留给渲染层（那里才有「多长算长」的口径）
        sign: String(u.sign ?? '').replace(/\s+/g, ' ').trim() || undefined,
      }
    }),
  }
}

// ── video ───────────────────────────────────────────────────────────────
/** 不给 read 就是概览；range 的 toSec 缺省 = 到结尾 */
export type VideoRead = { mode: 'all' } | { mode: 'range'; fromSec: number; toSec?: number }

export interface VideoOptions {
  bvid: string
  read?: VideoRead
}

export interface VideoOverview {
  kind: 'overview'
  bvid: string
  aid: number
  title: string
  up: { mid?: number; name?: string }
  publishedAt?: string
  durationSec: number
  stats: { view: number; danmaku: number; like: number; coin: number; favorite: number }
  description?: string
  chapters: Array<{ fromSec: number; title: string }>
  subtitle?: {
    kind: 'ai' | 'cc'
    /** 前 500 字试读；全文走 read —— 概览把整条字幕塞进上下文就不是概览了 */
    preview: string
    chars: number
    fromSec: number
    toSec: number
  }
  /** none=这条本来没字幕；need-login=登录态才给 */
  subtitleMissing?: 'none' | 'need-login'
  danmaku?: {
    count: number
    top: Array<{ word: string; n: number }>
    /** 最密的一分钟：起点（秒）与条数 */
    denseAtSec?: number
    denseInMinute?: number
  }
  /** 读失败与「真没评论」要分清：undefined = 没读到，[] = 读了，一条没有 */
  topReplies?: Array<{ like: number; author: string; text: string; replyCount?: number }>
  /**
   * 章节 / 字幕 / 弹幕 / 热评是四条独立支路，各自失败只进这里，不整条失败。
   * 带 stage 是为了让终端能在**原地**交代一句（「弹幕读取失败」就该出现在弹幕的位置，
   * 而不是堆在结尾）—— 这是 note 唯一多出来的字段。
   */
  notes: Array<{ stage: VideoNoteStage; message: string }>
}

export type VideoNoteStage = 'chapters' | 'danmaku' | 'replies'

export interface VideoTranscript {
  kind: 'transcript'
  bvid: string
  title: string
  /** 没字幕时不知道是哪种，就不填 */
  subtitleKind?: 'ai' | 'cc'
  fromSec: number
  /** 缺省 = 到结尾 */
  toSec?: number
  chars: number
  text: string
  /** 空结果要分清是「没字幕」还是「这一段没字幕」 */
  empty?: 'no-subtitle' | 'no-lines-in-range'
}

/**
 * 看懂一条：概览（简介 / 章节 / 字幕试读 / 弹幕热词 / 热评）或字幕正文。
 *
 * 两个入口合成一个函数，因为「先取 view」这步一样，分歧只在拿到 view 之后。
 * 概览和深读**都记 watch** 进账本（「看过」的唯一真相）—— 读了字幕也算看过，
 * 否则同一支视频会一直被 feed 当成没看过反复端上来。
 */
export async function video(opts: VideoOptions): Promise<VideoOverview | VideoTranscript> {
  const bvid = String(opts.bvid ?? '').trim()
  if (!BV_RE.test(bvid)) throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD（从 feed / up 的输出里抄）')
  const credential = cred()
  const v = await getView(bvid, credential)
  const title = String(v.title ?? '')
  if (opts.read) {
    const t = await transcript(bvid, title, v, credential, opts.read)
    recordWatch(bvid, title, v)
    return t
  }

  const notes: VideoOverview['notes'] = []
  const overview: VideoOverview = {
    kind: 'overview',
    bvid,
    aid: Number(v.aid ?? 0),
    title,
    up: { mid: v.owner?.mid === undefined ? undefined : Number(v.owner.mid), name: v.owner?.name },
    publishedAt: v.pubdate ? dateOnly(Number(v.pubdate)) : undefined,
    durationSec: Number(v.duration ?? 0) || 0,
    stats: {
      view: Number(v.stat?.view ?? 0) || 0,
      danmaku: Number(v.stat?.danmaku ?? 0) || 0,
      like: Number(v.stat?.like ?? 0) || 0,
      coin: Number(v.stat?.coin ?? 0) || 0,
      favorite: Number(v.stat?.favorite ?? 0) || 0,
    },
    description: String(v.desc ?? '').trim() || undefined,
    chapters: [],
    notes,
  }

  // ── 章节 + 字幕（同一个接口，同一次失败）──
  try {
    const info = await getPlayerInfo(bvid, Number(v.cid), credential)
    overview.chapters = (Array.isArray(info.view_points) ? info.view_points : []).map((p) => ({
      fromSec: Math.round(Number(p.from) || 0),
      title: String(p.content ?? '').trim(),
    }))
    const sub = pickSubtitle(info)
    if (!sub) {
      overview.subtitleMissing = info.need_login_subtitle ? 'need-login' : 'none'
    } else {
      const lines = await getSubtitleLines(bvid, sub, credential)
      if (!lines.length) overview.subtitleMissing = 'none'
      else {
        const all = flowText(lines.map((l) => l.text))
        const last = lines[lines.length - 1]
        overview.subtitle = {
          kind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc',
          preview: all.slice(0, 500),
          chars: all.length,
          fromSec: Math.round(lines[0].from),
          toSec: Math.round(last.to || last.from),
        }
      }
    }
  } catch (e) { notes.push({ stage: 'chapters', message: `章节/字幕读取失败：${msg(e)}` }) }

  // ── 弹幕热词 ──
  try {
    const dm = await getDanmakuBrief(bvid, Number(v.cid), credential)
    if (dm.count > 0) {
      overview.danmaku = {
        count: dm.count,
        top: dm.top.map(([word, n]) => ({ word, n })),
        denseAtSec: dm.dense?.from,
        denseInMinute: dm.dense?.n,
      }
    }
  } catch (e) { notes.push({ stage: 'danmaku', message: `弹幕读取失败：${msg(e)}` }) }

  // ── 热评（只取前 5 条：这是「氛围」，不是调研）──
  try {
    const j = await apiGet<ApiEnvelope<{ replies?: ReplyRow[] }>>(
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=2&ps=10&pn=1`,
      { cred: credential },
    )
    overview.topReplies = (j.data?.replies ?? []).slice(0, 5).map((r) => ({
      like: Number(r.like ?? 0) || 0,
      author: String(r.member?.uname ?? ''),
      text: String(r.content?.message ?? '').replace(/\s+/g, ' '),
      replyCount: r.count === undefined ? undefined : Number(r.count),
    }))
  } catch (e) { notes.push({ stage: 'replies', message: `热评读取失败：${msg(e)}` }) }

  recordWatch(bvid, title, v)

  return overview
}

/** 记一笔「看过」。概览与深读共用一条路 —— 两个入口各写一份是最容易漏的地方 */
function recordWatch(bvid: string, title: string, v: VideoView): void {
  ledgerAppend({
    type: 'watch',
    bvid,
    up: v.owner?.name ? String(v.owner.name).slice(0, 40) : undefined,
    title: title.slice(0, 60),
  })
}

/** 深读：字幕正文，全文或按时间区间，绝不截断 —— 深浅是它的事，读不设限（克制只管写） */
async function transcript(
  bvid: string,
  title: string,
  v: VideoView,
  credential: Cred,
  read: VideoRead,
): Promise<VideoTranscript> {
  let from = 0
  let to: number | undefined
  if (read.mode === 'range') {
    from = Number(read.fromSec)
    if (!Number.isFinite(from) || from < 0) throw new BiliError('usage', '--read 的起始时间认不出', '写成 03:00-08:30，或秒数 180-510')
    if (read.toSec !== undefined) {
      to = Number(read.toSec)
      if (!Number.isFinite(to)) throw new BiliError('usage', '--read 的结束时间认不出', '写成 03:00-08:30，或秒数 180-510')
      if (to <= from) throw new BiliError('usage', '--read 的结束时间要晚于开始时间')
    }
  }
  const upper = to ?? Infinity
  const base: VideoTranscript = { kind: 'transcript', bvid, title, fromSec: from, toSec: to, chars: 0, text: '' }
  const info = await getPlayerInfo(bvid, Number(v.cid), credential)
  const sub = pickSubtitle(info)
  if (!sub) return { ...base, empty: 'no-subtitle' }
  const lines = await getSubtitleLines(bvid, sub, credential)
  const sel = lines.filter((l) => l.to > from && l.from < upper)
  if (!sel.length) return { ...base, subtitleKind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc', empty: 'no-lines-in-range' }
  const text = flowText(sel.map((l) => l.text))
  return { ...base, subtitleKind: String(sub.lan ?? '').startsWith('ai-') ? 'ai' : 'cc', chars: text.length, text }
}

// ── shots ───────────────────────────────────────────────────────────────
/** 一张拼图：路径 + 每格的时间点（秒，按行读；没抽出来的格也在里面） */
export interface ShotsSheet {
  path: string
  timesSec: number[]
}

export type ShotsMode = 'grid' | 'at' | 'range'

export interface ShotsOptions {
  bvid: string
  /** 形如 3x3；每边 1–6 格，默认 3x3（也是每张图的上限） */
  grid?: string
  page?: number
  outDir?: string
  /** 指定时间点（秒）；与 range 互斥，按时间排序、去重 */
  at?: number[]
  /** 只抽这一段（秒）；to 超出可抽范围会被截到 span */
  range?: { fromSec: number; toSec: number }
  /**
   * 区间密抽帧率（1–5）。只在 range 下有效；配 diff 时默认 2。
   * 不给 fps 也不给 diff 时，区间内等间隔取满一张图（和整条视频的 grid 一样）。
   */
  fps?: number
  /** 区间密抽后只留画面真的变过的帧（相邻帧 SSIM ≥ 0.985 就当没变） */
  diff?: boolean
  /**
   * diff 判相似时忽略底部这一条（0–0.9，占画面高度）。口播 / 白板视频里字幕是逐行
   * 重绘的，整行换掉就能把 SSIM 压到 0.98（阈值 0.985），画面其实一动没动。
   */
  diffIgnoreBottom?: number
  /**
   * 换一套判据：平均像素差（0–255）超过它才算变了，给了就不再走 SSIM。
   * SSIM 对「人没换姿势但全身在微微动」很敏感，对「整块色卡换色」反而未必 —— 两个判据各管一摊。
   */
  diffThreshold?: number
  /**
   * 只出分数、不靠猜阈值：把相邻候选帧的差异分布（P50 / P75 / P90 + 极值）带回来。
   * 配 diff 时照常筛帧；单独给时只报告、一帧不丢 —— 一轮就能把阈值定下来。
   */
  diffReport?: boolean
  /** 裁剪：相对坐标 [x,y,w,h]（0–1），配 2×2 看字幕卡片 / 角落文字 */
  crop?: [number, number, number, number]
  /** 取消信号：会真正 kill 正在跑的那一帧，不只是帧间检查 */
  signal?: AbortSignal
  /** 终端进度（头部信息 + 取帧计数）；工具侧不传，数据一律走返回值 */
  progress?: (p: ShotsProgress) => void
}

export type ShotsProgress =
  | {
    stage: 'plan'; title: string; up?: string; durationSec: number; page: number; quality?: number
    segments: number; spanSec: number; times: number[]; mode: ShotsMode
    range?: { fromSec: number; toSec: number }; fps?: number; requestedFps?: number; diff: boolean
    diffIgnoreBottom?: number; diffThreshold?: number; candidates: number; note?: string
  }
  | { stage: 'frame'; done: number; total: number }
  | { stage: 'select'; candidates: number; kept: number; dropped: number; missing: number }

export interface ShotsDiffReport {
  /** 用的哪套判据：SSIM（越高越像）/ 平均像素差（越低越像） */
  judge: 'ssim' | 'pixel'
  /** 参与比较的相邻帧对数（算不出来的不算） */
  pairs: number
  p50: number
  p75: number
  p90: number
  min: number
  max: number
  /** 本次实际用的阈值（没给就说明只做了报告） */
  threshold?: number
}

export interface ShotsResult {
  bvid: string
  title: string
  up?: string
  /** 第一张拼图的绝对路径（多张时 = paths[0]，兼容只认单张的调用方） */
  path: string
  /** 全部拼图（按时间顺序；>1 张说明没把格子塞满） */
  paths: string[]
  /** 每张图的路径 + 每格时间点（按行） */
  sheets: ShotsSheet[]
  cols: number
  rows: number
  cellWidth: number
  /** 一格的总高：画面 + 顶部格号条（没烧格号时就是画面高） */
  cellHeight: number
  /** 顶部格号条的高度（没烧格号 / 没字体时不给） */
  labelHeight?: number
  /** 所有选中帧的时间点（跨图展平，按时间顺序；没抽出来的格也在） */
  timesSec: number[]
  mode: ShotsMode
  range?: { fromSec: number; toSec: number }
  /** 实际用的密抽帧率（只有 range + fps / diff 才有；区间太长时可能低于 1） */
  fps?: number
  /** 自动降过帧率时给原值（1–5）；没降就不给 */
  requestedFps?: number
  diff?: boolean
  /** diff 判相似时忽略的底部高度占比（给了才回） */
  diffIgnoreBottom?: number
  /** 像素差判据的阈值（给了就说明没用 SSIM） */
  diffThreshold?: number
  /** 阈值扫描用的分数分布（给了 diffReport 才有） */
  diffReport?: ShotsDiffReport
  /** 降档 / 截断说明：为什么实际帧率和请求的不一样、range 该缩到多长 */
  note?: string
  /** 区间密抽一共抽了多少候选帧 */
  candidates?: number
  /** 因画面没变或没抽出来而丢掉的帧数（diff 才有） */
  dropped?: number
  /** 图上有没有烧格号 + 时间码（没字体 / ffmpeg 没 drawtext 时 false） */
  labels: boolean
  /** 没抽出来的时间点（这些格是黑的） */
  missingSec: number[]
  /** 命中缓存（同一 BV / 参数 7 天内不重抽） */
  cached?: boolean
  quality?: number
  page: number
  pageCount: number
  durationSec: number
  segments: number
  truncatedAtSec?: number
}

const SHOTS_KEEP = 40
const SHOTS_CACHE_TTL_MS = 7 * 24 * 3600_000
/** 缓存格式版本：抽帧算法 / 产物形状变了就 +1，旧缓存自然失效 */
const SHOTS_CACHE_VERSION = 5
const FRAME_CONCURRENCY = 4
const FRAME_ATTEMPTS = 2
const MAX_CANDIDATES = 40
/** 相邻帧 SSIM ≥ 这个值就当「没变」 */
const DIFF_SSIM = 0.985
/** 只清自己生成的图：BV-pN-时间-格数(-第几张).jpg */
const SHOTS_FILE_RE = /^BV[0-9A-Za-z]{10}(?:-p\d+)?-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-\d+x\d+(?:-\d+of\d+)?\.jpg$/

interface ShotsCacheMeta {
  v: number
  createdAt: number
  result: ShotsResult
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** 限并发跑任务；任何一项抛错就整体失败（abort 时其余项会很快看到 signal） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** n 帧平均分到若干张图，尽量不把最后一张塞爆（不够的格补黑） */
function sheetSizes(n: number, capacity: number): number[] {
  if (n <= 0) return []
  const count = Math.ceil(n / capacity)
  const base = Math.floor(n / count)
  const extra = n % count
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0))
}

/** filter 里的路径转义：冒号是选项分隔符，单引号是字符串边界 */
const filterQuote = (s: string): string => `'${s.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`

/**
 * 只画格号 + 时间码的滤镜（裁切 / 缩放已经在取帧时做过了）。
 * 格号跟这张图的行序号一致：图会进日记 / 笔记、以后还会被重读，
 * 没有格号就只能靠"每张图重新数"，脱离了这次的终端输出就对不上。
 *
 * 字画在格子顶部的黑边上（取帧时就 pad 出来了），不压画面 —— 裁切之后左上角
 * 往往正是要看的那块内容，压上去就没法看了。
 */
const LABEL_MARGIN = 3

/**
 * 格号条的高度与字号：都跟着格子宽度走，宁可小一点也别占掉太多画面。
 * 高度 ≈ ascent + descent（Noto CJK 约 1.48 倍字号）+ 上下留白；
 * 黑边本身就是底色，所以不画 drawtext 的 box，省下一圈边距。
 * 字号沿用原来压在画面上的那档（cw/24）—— 拼图会被看图工具缩放，再小就看不清了。
 */
function labelMetrics(cw: number): { size: number; height: number } {
  const size = Math.max(14, Math.round(cw / 24))
  return { size, height: even(Math.ceil(size * 1.55) + 2 * LABEL_MARGIN) }
}

function labelVf(font: string, cellNo: number, sec: number, size: number): string {
  const text = `${cellNo} ${formatClockFine(sec)}`.replace(/:/g, '\\:')
  return `drawtext=fontfile=${filterQuote(font)}:text='${text}':x=8:y=${LABEL_MARGIN}:fontsize=${size}:fontcolor=white`
}

function shotsCacheFile(key: string): string {
  return path.join(SHOTS_DIR, '.cache', `${key}.json`)
}

function readShotsCache(key: string): ShotsResult | null {
  try {
    const meta = JSON.parse(fs.readFileSync(shotsCacheFile(key), 'utf8')) as ShotsCacheMeta
    if (meta.v !== SHOTS_CACHE_VERSION || !meta.result || Date.now() - Number(meta.createdAt) > SHOTS_CACHE_TTL_MS) return null
    const paths = Array.isArray(meta.result.paths) ? meta.result.paths : []
    if (!paths.length || !paths.every((p) => fs.existsSync(p))) return null
    return { ...meta.result, missingSec: meta.result.missingSec ?? [], cached: true }
  } catch { return null }
}

function writeShotsCache(key: string, result: ShotsResult): void {
  try {
    const file = shotsCacheFile(key)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const meta: ShotsCacheMeta = { v: SHOTS_CACHE_VERSION, createdAt: Date.now(), result }
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(meta))
    fs.renameSync(tmp, file)
  } catch { /* 缓存写失败不影响这次结果 */ }
}

/** 只留最近 40 张图；顺手清掉过期 / 指向已删图的缓存索引 */
function pruneShots(): void {
  try {
    if (!fs.existsSync(SHOTS_DIR)) return
    const files = fs.readdirSync(SHOTS_DIR)
      .filter((n) => SHOTS_FILE_RE.test(n))
      .map((n) => { const p = path.join(SHOTS_DIR, n); return { p, mtime: fs.statSync(p).mtimeMs } })
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(SHOTS_KEEP)) fs.rmSync(f.p, { force: true })

    const cacheDir = path.join(SHOTS_DIR, '.cache')
    if (!fs.existsSync(cacheDir)) return
    for (const n of fs.readdirSync(cacheDir)) {
      const p = path.join(cacheDir, n)
      try {
        const meta = JSON.parse(fs.readFileSync(p, 'utf8')) as ShotsCacheMeta
        const stale = !meta.result || Date.now() - Number(meta.createdAt) > SHOTS_CACHE_TTL_MS * 2
        const missing = !Array.isArray(meta.result?.paths) || !meta.result.paths.every((x) => fs.existsSync(x))
        if (stale || missing) fs.rmSync(p, { force: true })
      } catch { fs.rmSync(p, { force: true }) }
    }
  } catch { /* 清理失败不影响抽帧 */ }
}

/**
 * 两帧像不像（SSIM，1 = 一样）；算不出来返回 null（调用方当作「变了」）。
 * ignoreBottom > 0 时两边一起裁掉底部那条（字幕区）：口播 / 白板类视频里字幕整行重绘
 * 能把 SSIM 压到 0.98 上下（阈值 0.985，够不够全看字幕多长），裁掉之后同样的两帧回到
 * 1.0，而真换一张卡片仍然只有 0.96 —— 判据要的是后者。
 */
async function ssimScore(bin: string, a: string, b: string, ignoreBottom: number, signal?: AbortSignal): Promise<number | null> {
  return pairScore(bin, a, b, ignoreBottom, 'ssim', signal, (r) => {
    const m = /All:([0-9.]+)/.exec(r)
    return m ? Number(m[1]) : null
  })
}

/**
 * 平均像素差（0–255）：由 psnr 的 average 换算（RMSE = 255 / 10^(dB/20)）。
 * 用 average 而不是只看 y —— 色块整块换色时亮度可能几乎没变，色度平面才看得出来。
 */
async function pixelDelta(bin: string, a: string, b: string, ignoreBottom: number, signal?: AbortSignal): Promise<number | null> {
  return pairScore(bin, a, b, ignoreBottom, 'psnr', signal, (r) => {
    const m = /average:([0-9.]+|inf)/.exec(r)
    if (!m) return null
    return m[1] === 'inf' ? 0 : 255 / 10 ** (Number(m[1]) / 20)
  })
}

/** 两帧比一次：先按 ignoreBottom 裁掉底部，再跑 ssim / psnr（两者的 crop 写法必须一致） */
async function pairScore(
  bin: string, a: string, b: string, ignoreBottom: number, tail: 'ssim' | 'psnr',
  signal: AbortSignal | undefined, parse: (stderr: string) => number | null,
): Promise<number | null> {
  const keep = 1 - Math.max(0, Math.min(0.9, ignoreBottom))
  const crop = (i: number): string =>
    `[${i}:v]crop=iw:trunc(ih*${keep.toFixed(4)}/2)*2:0:0,setsar=1[${i === 0 ? 'x' : 'y'}]`
  const vf = keep < 1 ? `${crop(0)};${crop(1)};[x][y]${tail}` : tail === 'ssim' ? 'ssim' : 'psnr'
  try {
    const r = await runFfmpegAsync(bin, [
      '-nostdin', '-hide_banner', '-loglevel', 'info', '-nostats',
      '-i', a, '-i', b, '-lavfi', vf, '-f', 'null', '-',
    ], { timeout: 30_000, signal })
    return parse(r.stderr)
  } catch (e) {
    if (isFfmpegAbort(e)) throw new BiliError('unsupported', '抽帧被取消')
    return null
  }
}

/** 相邻帧分数的分布：扫描阈值时一轮就能看清拐点大概在哪，不用逐个阈值试 */
function diffStats(scores: Array<number | null>, judge: 'ssim' | 'pixel', threshold?: number): ShotsDiffReport | undefined {
  const vals = scores.filter((s): s is number => s !== null && Number.isFinite(s)).sort((a, b) => a - b)
  if (!vals.length) return undefined
  const at = (q: number): number => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * q)))]
  return {
    judge,
    pairs: vals.length,
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    min: vals[0],
    max: vals[vals.length - 1],
    threshold,
  }
}

/**
 * 抽帧看画面：整条等间隔（grid）、指定时刻（at）、或区间密抽（range）。
 * 默认 3×3 九宫格；格号 + 时间码烧在每格顶部的黑边上（`1 12:30`），图离开终端也能对上字幕。
 *
 * 不落整段视频 —— 对直链按时间点远程 seek，只读需要的那几个字节范围。
 * 取帧 4 路并发；一帧失败重试一次，仍失败就留黑格并在 missingSec 里点名，
 * 不因为一格毁掉整张图。range + diff 时先密抽、再按 SSIM（或 --diff-threshold 的像素差）
 * 丢掉没变的帧；候选帧数超过 40 就自动降档，但不低于 1fps —— 1fps 仍塞不下就只取前 40 秒，
 * 把原因和「range 该缩到多长」写进 note，不直接报错。--diff-report 再额外带回分数分布。
 * 帧数超过一张图的格数就出第二张 —— 宁可多一张，不把格子塞满。
 *
 * 同一 BV / page / 参数在 7 天内直接复用缓存（SHOTS_DIR 只留最近 40 张）。
 * progress 是给终端看的，工具侧不传 —— 数据一律走返回值。
 */
export async function shots(opts: ShotsOptions): Promise<ShotsResult> {
  const bvid = String(opts.bvid ?? '').trim()
  if (!BV_RE.test(bvid)) throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD')

  const grid = String(opts.grid ?? '3x3')
  const m = /^(\d)x(\d)$/.exec(grid)
  const cols = Number(m?.[1])
  const rows = Number(m?.[2])
  if (!m || cols < 1 || rows < 1 || cols > 6 || rows > 6) {
    throw new BiliError('usage', '--grid 要写成 3x3 / 4x4 这样（每边 1–6 格）')
  }
  const capacity = cols * rows
  const p = Math.max(1, Math.trunc(finiteOr(opts.page, 1)))

  const at = opts.at?.length ? [...new Set(opts.at)].sort((a, b) => a - b) : undefined
  const range = opts.range
  if (at && range) throw new BiliError('usage', '--at 和 --range 只能给一个', '整条就 --grid；某几秒就 --at；某一段就 --range')
  if (at && opts.diff) throw new BiliError('usage', '--diff 只用于 --range', '--at 给的时刻本来就是你挑的')
  if (at && opts.fps !== undefined) throw new BiliError('usage', '--fps 只用于 --range')
  if (opts.diff && !range) throw new BiliError('usage', '--diff 要配 --range', '先圈一段，再只留画面变过的帧')
  if (opts.fps !== undefined && !range) throw new BiliError('usage', '--fps 只用于 --range')

  const mode: ShotsMode = at ? 'at' : range ? 'range' : 'grid'
  const fps = range && (opts.diff || opts.diffReport || opts.fps !== undefined) ? (opts.fps ?? 2) : undefined
  if (fps !== undefined && (!Number.isFinite(fps) || fps < 1 || fps > 5)) {
    throw new BiliError('usage', '--fps 要在 1–5 之间', '区间不长，2 帧/秒通常够了')
  }
  // 实际用的帧率：区间太长时按 40 帧上限自动降档 —— 但不会低于 1fps（理由见下面区间计划）
  let effFps = fps
  let fpsClamped = false
  let note: string | undefined

  if (opts.diffReport && !range) throw new BiliError('usage', '--diff-report 要配 --range', '先圈一段，再看相邻帧的差异分布')

  const ignoreBottom = opts.diffIgnoreBottom ?? 0
  if (ignoreBottom !== 0) {
    if (!opts.diff && !opts.diffReport) throw new BiliError('usage', '--diff-ignore-bottom 只配 --diff / --diff-report', '它只影响「画面变没变」的判断，不影响取帧')
    if (!Number.isFinite(ignoreBottom) || ignoreBottom <= 0 || ignoreBottom > 0.9) {
      throw new BiliError('usage', '--diff-ignore-bottom 要在 0–0.9 之间', '按字幕实际占的高度给（常见 0.25–0.35）：0.15 压不住字幕条')
    }
  }

  // 像素差判据（0–255 的平均差）：给了它就不用 SSIM —— 人物轻微晃动在 SSIM 上未必过得了
  // 阈值，但它真实存在（人物真的换了姿势），两种判据点不是一回事，只能选一个
  const diffThreshold = opts.diffThreshold
  if (diffThreshold !== undefined) {
    if (!opts.diff && !opts.diffReport) throw new BiliError('usage', '--diff-threshold 只配 --diff / --diff-report', '它只影响「画面变没变」的判断，不影响取帧')
    if (!Number.isFinite(diffThreshold) || diffThreshold <= 0 || diffThreshold > 64) {
      throw new BiliError('usage', '--diff-threshold 要在 0–64 之间（0–255 的平均像素差）', '先试 8，再看 --diff-report 的 P75 / P90 往上加（常见 12–20）')
    }
  }

  const crop = opts.crop
  if (crop) {
    const [x, y, w, h] = crop
    const ok = [x, y, w, h].every((n) => Number.isFinite(n))
      && x >= 0 && y >= 0 && w >= 0.01 && h >= 0.01 && x + w <= 1.0001 && y + h <= 1.0001
    if (!ok) throw new BiliError('usage', 'crop 要写成 x,y,w,h（0–1 的相对坐标）', '例：0.62,0.06,0.36,0.30')
  }

  const useCache = !opts.outDir
  const cacheKey = createHash('sha1').update(JSON.stringify({
    v: SHOTS_CACHE_VERSION,
    bvid,
    page: p,
    grid,
    mode,
    at: at ? at.map((t) => t.toFixed(2)).join(',') : '',
    range: range ? `${range.fromSec.toFixed(2)}-${range.toSec.toFixed(2)}` : '',
    fps: fps ?? 0,
    diff: !!opts.diff,
    diffIgnoreBottom: ignoreBottom,
    diffThreshold: diffThreshold ?? 0,
    diffReport: !!opts.diffReport,
    crop: crop ? crop.map((n) => n.toFixed(3)).join(',') : '',
  })).digest('hex')
  if (useCache) {
    const hit = readShotsCache(cacheKey)
    if (hit) return hit
  }

  let ff: string
  try { ff = requireFfmpeg() } catch (e) {
    throw new BiliError('unsupported', msg(e), '装 ffmpeg：winget / brew / apt install ffmpeg，或用 $FFMPEG 指路径')
  }
  const credential = cred()
  const v = await getView(bvid, credential)
  const pages = Array.isArray(v.pages) && v.pages.length ? v.pages : [v]
  const page = pages[p - 1]
  if (!page?.cid) throw new BiliError('usage', `这条只有 ${pages.length} P`, `--p 最多到 ${pages.length}`)
  const dur = Number(page.duration) || Number(v.duration) || 0
  if (dur < 1) throw new BiliError('unsupported', '拿不到视频时长（互动视频 / 直播回放）—— 抽不了帧')

  const play = await getPlayUrl(bvid, page.cid, credential)
  // 多段视频（老的长视频）只有第一段能抽 —— 把时间点压缩到这一段里，别在后半段白等
  const span = play.seconds > 1 ? Math.min(dur, play.seconds) : dur
  const truncatedAtSec = play.segments > 1 ? span : undefined
  const maxT = Math.max(0, span - 0.2)

  // ── 计划时间点 ──
  let planned: number[] = []
  if (at) {
    planned = [...at]
    if (planned.length > MAX_CANDIDATES) {
      throw new BiliError('usage', `一次最多 ${MAX_CANDIDATES} 个时间点`, '分几次抽，或用 --range')
    }
    const bad = planned.find((t) => !Number.isFinite(t) || t < 0 || t >= span)
    if (bad !== undefined) {
      throw new BiliError('usage', `时间点 ${formatClock(bad)} 超出可抽范围 00:00–${formatClock(span)}`,
        play.segments > 1 ? '多条分段的老视频只抽第一段 —— 这个时间点之后抽不到' : '换个时间点')
    }
  } else if (range) {
    const from = Math.max(0, range.fromSec)
    const to = Math.min(span, range.toSec)
    if (!(from < to)) {
      throw new BiliError('usage', `--range 超出可抽范围（00:00–${formatClock(span)}）`, '起点要早于终点，且落在视频里')
    }
    if (fps !== undefined) {
      // 上限卡的是「候选帧数」，不是帧率。降档分两种：
      //  · 1fps 还塞得下 → 均匀降帧率（仍在 1–5 区间里），整段都覆盖；
      //  · 1fps 都塞不下 → 保 1fps，只取区间前 40 秒（从尾部截断）。
      //    整段均匀降采样（1.5 秒一帧）反而更容易漏掉半秒级的切点，
      //    宁可少盖一截、把「range 该缩到多长」直接写进 note。
      const durSec = to - from
      const need = Math.ceil(fps * durSec)
      if (need > MAX_CANDIDATES) {
        fpsClamped = true
        effFps = Math.max(1, MAX_CANDIDATES / durSec)
      }
      const step = 1 / effFps!
      // 保 1fps 时只走到第 40 帧为止；区间够短就正常走到 to
      const endSec = Math.min(to, from + MAX_CANDIDATES / effFps! + 1e-6)
      const out: number[] = []
      for (let t = from + step / 2; t < endSec && out.length < MAX_CANDIDATES; t += step) {
        out.push(Math.min(Math.max(0, to - 0.01), t))
      }
      planned = out
      if (fpsClamped) {
        const capSec = Math.floor(MAX_CANDIDATES / fps)
        note = effFps! > 1
          ? `区间 ${formatClock(durSec)} 按 ${fps}fps 要 ${need} 帧，超 ${MAX_CANDIDATES} 帧上限：`
            + `已按 ${Number(effFps!.toFixed(2))}fps 均匀抽 ${MAX_CANDIDATES} 帧`
          : `区间 ${formatClock(durSec)} 按 ${fps}fps 要 ${need} 帧，超 ${MAX_CANDIDATES} 帧上限：`
            + `已保持 1fps 只取前 ${MAX_CANDIDATES} 秒（${formatClock(from)}–${formatClock(endSec)}）；`
            + `建议把 range 缩到 ${capSec} 秒以内（${fps}fps × ${MAX_CANDIDATES} 帧）`
      }
    } else {
      planned = Array.from({ length: capacity }, (_, i) =>
        Math.min(Math.max(0, to - 0.01), from + ((i + 0.5) * (to - from)) / capacity))
    }
  } else {
    // 每格取「该格时间窗的中点」：开头常是黑场/片头，结尾常是黑场，掐头去尾各半格
    planned = Array.from({ length: capacity }, (_, i) => Math.min(maxT, Math.max(0, ((i + 0.5) * span) / capacity)))
  }

  opts.progress?.({
    stage: 'plan',
    title: String(v.title ?? ''),
    up: v.owner?.name ? String(v.owner.name) : undefined,
    durationSec: dur,
    page: p,
    quality: play.quality,
    segments: play.segments,
    spanSec: span,
    times: planned,
    mode,
    range: range ? { fromSec: Math.max(0, range.fromSec), toSec: Math.min(span, range.toSec) } : undefined,
    fps: effFps,
    requestedFps: fpsClamped ? fps : undefined,
    diff: !!opts.diff,
    diffIgnoreBottom: ignoreBottom || undefined,
    diffThreshold,
    candidates: planned.length,
    note,
  })

  // 格子尺寸跟画面（裁切后）比例走；竖屏就 360×640，裁一块就按裁切后的比例
  const dw = Number(v.dimension?.width) || 16
  const dh = Number(v.dimension?.height) || 9
  const ar = crop ? (dw * crop[2]) / (dh * crop[3]) : dw / dh
  const base = 640
  const cw = even(ar >= 1 ? base : base * ar)
  const ch = even(ar >= 1 ? base / ar : base)

  // 格号条在取帧时就 pad 出来：这样画字成不成功，每格尺寸都一样（拼图要求等大），
  // 画上去也只占黑边，不压画面
  const caps = ffmpegCaps(ff)
  if (diffThreshold !== undefined && !caps.psnr) {
    throw new BiliError('unsupported', '这台 ffmpeg 没有 psnr 滤镜，用不了 --diff-threshold',
      '去掉它就走 SSIM 判据（--diff），或者换一份带完整滤镜的 ffmpeg')
  }
  const font = caps.drawtext ? findFfmpegFont() : null
  let labels = !!font
  const label = labels && font ? labelMetrics(cw) : null
  const chp = ch + (label?.height ?? 0)
  const scalePad = [
    ...(crop
      ? [`crop=trunc(iw*${crop[2].toFixed(4)}/2)*2:trunc(ih*${crop[3].toFixed(4)}/2)*2:trunc(iw*${crop[0].toFixed(4)}/2)*2:trunc(ih*${crop[1].toFixed(4)}/2)*2`]
      : []),
    `scale=${cw}:${ch}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${cw}:${chp}:(ow-iw)/2:${label ? label.height : '(oh-ih)/2'}:color=black`,
  ].join(',')
  const headers = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`

  const outDir = opts.outDir ? path.resolve(opts.outDir) : SHOTS_DIR
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  const stem = `${bvid}${p > 1 ? `-p${p}` : ''}-${stamp}-${cols}x${rows}`
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-shots-'))
  try {
    // ── 取帧（4 路并发；一帧失败重试一次，仍失败就留黑格）──
    const extract = async (t: number, file: string): Promise<{ ok: boolean; error?: string }> => {
      let last = ''
      for (let attempt = 1; attempt <= FRAME_ATTEMPTS; attempt += 1) {
        if (opts.signal?.aborted) throw new BiliError('unsupported', '抽帧被取消')
        try {
          await runFfmpegAsync(ff, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-headers', headers, '-ss', t.toFixed(2), '-i', play.url,
            '-frames:v', '1', '-vf', scalePad, '-q:v', '2', file,
          ], { timeout: 120_000, signal: opts.signal })
          if (fs.existsSync(file) && fs.statSync(file).size >= 1000) return { ok: true }
          last = `${formatClock(t)} 这一帧没抽出来`
        } catch (e) {
          if (isFfmpegAbort(e)) throw new BiliError('unsupported', '抽帧被取消')
          last = msg(e)
          if (last.includes('超时')) break
        }
        fs.rmSync(file, { force: true })
      }
      return { ok: false, error: last }
    }

    let done = 0
    const extracted = await mapLimit(planned, FRAME_CONCURRENCY, async (t, i) => {
      const file = path.join(tmp, `c${String(i).padStart(2, '0')}.jpg`)
      const r = await extract(t, file)
      done += 1
      opts.progress?.({ stage: 'frame', done, total: planned.length })
      return { t, file: r.ok ? file : null, error: r.error }
    })

    const okFrames = extracted.flatMap((f) => (f.file ? [{ t: f.t, file: f.file }] : []))
    if (!okFrames.length) {
      const firstErr = extracted.find((f) => f.error)?.error
      throw new BiliError('upstream', '一帧都没抽出来', firstErr ? `最后一次：${firstErr.slice(0, 160)}` : '换 --p / 稍后再试')
    }

    // ── 去重：先密抽，再只留画面真的变过的帧；格号 / 时间码等选完再烧，免得文字差异干扰判据 ──
    let slots: Array<{ t: number; file: string | null }> = []
    let dropped: number | undefined
    let diffReport: ShotsDiffReport | undefined
    const usePixel = diffThreshold !== undefined
    const canScore = usePixel || caps.ssim
    let scores: Array<number | null> = []
    if ((opts.diff || opts.diffReport) && canScore && okFrames.length > 1) {
      const pairs = okFrames.slice(1).map((f, i) => [okFrames[i], f] as const)
      scores = await mapLimit(pairs, FRAME_CONCURRENCY, async ([a, b]) => (
        usePixel
          ? pixelDelta(ff, a.file, b.file, ignoreBottom, opts.signal)
          : ssimScore(ff, a.file, b.file, ignoreBottom, opts.signal)))
      if (opts.diffReport) diffReport = diffStats(scores, usePixel ? 'pixel' : 'ssim', diffThreshold)
    }
    if (opts.diff) {
      const keep: Array<{ t: number; file: string }> = [okFrames[0]]
      if (scores.length) {
        okFrames.slice(1).forEach((b, i) => {
          const v = scores[i]
          // 算不出来（滤镜报错 / 解码失败）按「变了」处理，宁可多留一帧也别漏掉一段
          if (v === null || (usePixel ? v > diffThreshold! : v < DIFF_SSIM)) keep.push(b)
        })
      } else {
        keep.push(...okFrames.slice(1))
      }
      slots = keep.map((f) => ({ t: f.t, file: f.file }))
      dropped = planned.length - slots.length
      opts.progress?.({
        stage: 'select', candidates: planned.length, kept: slots.length,
        dropped, missing: planned.length - okFrames.length,
      })
    } else {
      slots = extracted.map((f) => ({ t: f.t, file: f.file }))
    }
    const missingSec = extracted.filter((f) => !f.file).map((f) => f.t)

    // ── 格号 + 时间码 ──
    // 每张图从 1 数到格数（和返回的 timesSec 顺序一致）；先按格数分好张，
    // 才知道这一帧落到第几张、第几格。
    const sizes = sheetSizes(slots.length, capacity)
    const cellNo = new Array<number>(slots.length)
    {
      let start = 0
      for (const size of sizes) {
        for (let k = 0; k < size; k += 1) cellNo[start + k] = k + 1
        start += size
      }
    }
    if (labels && font && label) {
      let labelFailed = false
      const labelDir = path.join(tmp, 'label')
      fs.mkdirSync(labelDir, { recursive: true })
      slots = await mapLimit(slots, FRAME_CONCURRENCY, async (s, i) => {
        if (!s.file) return s
        const dst = path.join(labelDir, `l${String(i).padStart(2, '0')}.jpg`)
        try {
          await runFfmpegAsync(ff, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', s.file, '-frames:v', '1', '-vf', labelVf(font, cellNo[i], s.t, label.size), '-q:v', '2', dst,
          ], { timeout: 30_000, signal: opts.signal })
          if (fs.existsSync(dst) && fs.statSync(dst).size >= 1000) return { t: s.t, file: dst }
        } catch (e) {
          if (isFfmpegAbort(e)) throw new BiliError('unsupported', '抽帧被取消')
        }
        labelFailed = true
        return s
      })
      labels = !labelFailed
    }

    // ── 拼图：按格数分张，超过就出第二张；缺的格用黑图补 ──
    fs.mkdirSync(outDir, { recursive: true })
    const black = path.join(tmp, 'black.jpg')
    await runFfmpegAsync(ff, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=black:s=${cw}x${chp}:d=1`,
      '-frames:v', '1', '-q:v', '2', black,
    ], { timeout: 30_000, signal: opts.signal })

    const sheets: ShotsSheet[] = []
    let cursor = 0
    for (let s = 0; s < sizes.length; s += 1) {
      const chunk = slots.slice(cursor, cursor + sizes[s])
      cursor += sizes[s]
      const dir = path.join(tmp, `sheet${s}`)
      fs.mkdirSync(dir, { recursive: true })
      for (let k = 0; k < capacity; k += 1) {
        fs.copyFileSync(chunk[k]?.file ?? black, path.join(dir, `f${String(k).padStart(2, '0')}.jpg`))
      }
      const file = path.join(outDir, `${stem}${sizes.length > 1 ? `-${s + 1}of${sizes.length}` : ''}.jpg`)
      await runFfmpegAsync(ff, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', path.join(dir, 'f%02d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '2', file,
      ], { timeout: 60_000, signal: opts.signal })
      if (!fs.existsSync(file)) throw new BiliError('upstream', '拼图没生成', '换 --grid 少抽几帧再试')
      sheets.push({ path: file, timesSec: chunk.map((f) => f.t) })
    }

    const result: ShotsResult = {
      bvid,
      title: String(v.title ?? ''),
      up: v.owner?.name ? String(v.owner.name) : undefined,
      path: sheets[0].path,
      paths: sheets.map((s) => s.path),
      sheets,
      cols,
      rows,
      cellWidth: cw,
      /** 含顶部格号条（没有格号条时 = 画面高） */
      cellHeight: chp,
      labelHeight: label?.height,
      timesSec: sheets.flatMap((s) => s.timesSec),
      mode,
      range: range ? { fromSec: Math.max(0, range.fromSec), toSec: Math.min(span, range.toSec) } : undefined,
      fps: effFps,
      requestedFps: fpsClamped ? fps : undefined,
      diff: opts.diff ? true : undefined,
      diffIgnoreBottom: ignoreBottom || undefined,
      diffThreshold,
      diffReport,
      note,
      candidates: effFps !== undefined ? planned.length : undefined,
      dropped,
      labels,
      missingSec,
      quality: play.quality,
      page: p,
      pageCount: pages.length,
      durationSec: dur,
      segments: play.segments,
      truncatedAtSec,
    }

    if (useCache) {
      writeShotsCache(cacheKey, result)
      pruneShots()
    }
    return result
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ── inbox ───────────────────────────────────────────────────────────────
export interface InboxOptions {
  limit?: number
  /** 把翻过的也列出来（默认只列新的） */
  includeSeen?: boolean
}

export interface InboxMessage {
  kind: 'reply' | 'at'
  id: string
  atSec: number
  seen: boolean
  from: { mid: string; name: string }
  bvid: string
  title: string
  text: string
  /** 认不出就不填 —— 宁可提示「这条别硬回」，也不挂错楼层 */
  replyTo?: { rpid: number; root?: number }
}

export interface InboxResult {
  /** 没看过的总数 */
  fresh: number
  total: number
  /** 本次列了几条 */
  shown: number
  /** 还没列出来的还剩几条（含下一页的） */
  remaining: number
  messages: InboxMessage[]
}

/**
 * 副作用：把列出来的标记已读、推进 cursor（与今天 CLI 行为一致）。
 * 这意味着「调一次就消耗掉了」—— 想重复看同一批要显式 includeSeen。
 */
/** 收件箱的落盘状态：已看过的消息 id + 两个收件箱的时间水位 */
interface InboxState { seen?: Record<string, number>; cursor?: { reply?: number; at?: number } }

/** 归一后的一条通知（内部形状；对外只出 InboxMessage） */
interface InboxEntry {
  kind: 'reply' | 'at'
  id: string
  t: number
  mid: string
  who: string
  bvid: string
  aid: number
  title: string
  text: string
  /** 「回复我的」里被回复的那条（我的评论）—— 认楼层用 */
  source: number
  /** 要挂上去的那条评论（parent）；0 = 认不出，别硬回 */
  rpid: number
  /** 楼层根；0 = 顶层 */
  root: number
}

/** 收件箱条目（时间倒序）；翻到看过的水位就停，别为几条消息把请求打满 */
async function pullInbox(kind: 'reply' | 'at', credential: Cred, since: number, pages = 2): Promise<MsgFeedRow[]> {
  const rows: MsgFeedRow[] = []
  let cursor = ''
  for (let p = 0; p < pages; p += 1) {
    const [page] = await getMsgFeed(kind, credential, { cursor, pages: 1 })
    const items = page?.items ?? []
    if (!items.length) break
    rows.push(...items)
    const times = items.map((x) => Number(x.reply_time ?? x.at_time ?? 0)).filter((t) => t > 0)
    const oldest = times.length ? Math.min(...times) : 0
    cursor = String(page?.cursor?.id ?? '')
    if (!cursor || page?.cursor?.is_end) break
    if (since && oldest && oldest < since) break
  }
  return rows
}

/** 一条通知 → 可回的形状。动态 / 专栏 / 音频的 @ 直接丢掉（lite 只回视频评论） */
function toInboxEntry(kind: 'reply' | 'at', row: MsgFeedRow): InboxEntry | null {
  const it = row.item ?? {}
  const bvid = (String(it.uri ?? '').match(/BV[0-9A-Za-z]{10}/) ?? [''])[0]
  const aid = Number(it.subject_id ?? 0)
  if (!bvid || !aid) return null
  const t = Number(row.reply_time ?? row.at_time ?? 0)
  // 「@我的」：source_content 就是那条评论；「回复我的」：正文以回读楼层为准（见 resolveReplyTarget），
  // 收件箱里 target_reply_content 只是线索 —— 官方字段语义没文档，别拿它当正文用
  const raw = kind === 'reply' ? it.target_reply_content : it.source_content
  return {
    kind,
    id: String(row.id ?? `${t}:${row.user?.mid ?? ''}`),
    t,
    mid: String(row.user?.mid ?? ''),
    who: String(row.user?.nickname ?? row.user?.uname ?? '?'),
    bvid,
    aid,
    title: String(it.title ?? ''),
    text: String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    source: Number(it.source_id ?? 0),
    // @ 通道的 source_id 就是 @ 我的那条评论，可以直接回；回复通道要回读楼层才知道
    rpid: kind === 'at' ? Number(it.source_id ?? 0) : 0,
    root: Number(it.root_id ?? 0),
  }
}

/** 「回复我的」→ 回读楼层，认准「他回我那条」的 rpid。认不出就留 0：挂错地方比不回更糟 */
async function resolveReplyTarget(e: InboxEntry, credential: Cred): Promise<void> {
  const thread = e.root || e.source
  if (!thread) return
  try {
    const { root, replies } = await getThreadReplies(e.aid, thread, credential)
    const all = [...(root ? [root] : []), ...replies]
    const mine = all.filter((r) => String(r.mid ?? r.member?.mid ?? '') === e.mid)
    const hit = mine.find((r) => String(r.parent ?? '') === String(e.source))
      ?? [...mine].sort((a, b) => Number(b.ctime ?? 0) - Number(a.ctime ?? 0))[0]
    const rpid = Number(hit?.rpid ?? 0)
    if (!rpid) return
    e.rpid = rpid
    e.root = Number(hit?.root ?? thread) || thread
    // 正文一律以楼层为准：收件箱那条只用来「发现有人找你」，说的话得回原帖读
    const said = String(hit?.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
    if (said) e.text = said
  } catch { /* 楼层读不到（删了 / 风控）：保持 rpid=0，让调用方自己去看 */ }
}

/**
 * 收件箱：谁 @ 了你 / 谁回了你。
 *
 * 发现靠官方两个收件箱（/x/msgfeed/reply 与 /at），但两者都不给「对方那条评论的 rpid」，
 * 正文语义也不可靠 ⇒ 回读楼层认「谁 + 父评论」，认不出就留空（挂错地方比不回更糟）。
 *
 * 副作用（本层的责任，别上移）：把列出来的标记已读、推进两个收件箱的时间水位。
 * 所以「调一次就消耗掉了」—— 想重复看同一批要显式 includeSeen。
 */
export async function inbox(opts: InboxOptions = {}): Promise<InboxResult> {
  const n = clamp(Math.trunc(finiteOr(opts.limit, 5)), 1, 20)
  const all = opts.includeSeen === true
  const credential = cred()
  const miss = (['sessdata', 'bili_jct'] as const).filter((k) => !credential[k])
  if (miss.length) {
    throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 收件箱要登录态`, '去设置页「B站养鱼」补一次 cookie')
  }

  const st = readJson<InboxState>(INBOX_FILE, {})
  const since = { reply: Number(st.cursor?.reply ?? 0), at: Number(st.cursor?.at ?? 0) }
  // 串行：lib 的节流是全局的，并发两条只会一起撞 412
  const replyRows = await pullInbox('reply', credential, since.reply)
  const atRows = await pullInbox('at', credential, since.at)

  const entries = [
    ...replyRows.map((r) => toInboxEntry('reply', r)),
    ...atRows.map((r) => toInboxEntry('at', r)),
  ].filter((x): x is InboxEntry => x !== null)

  const byKey = new Map<string, InboxEntry>()
  for (const e of entries) byKey.set(`${e.kind}:${e.id}`, e)   // 同一收件箱翻页会给回重叠条目（实测每条两遍）
  const merged = [...byKey.values()].sort((a, b) => b.t - a.t)

  const seen = st.seen ?? {}
  const fresh = merged.filter((e) => !seen[`${e.kind}:${e.id}`])
  const shown = (all ? merged : fresh).slice(0, n)

  // 只对真要展示的几条回读楼层，别为全量付请求
  for (const e of shown) if (e.kind === 'reply') await resolveReplyTarget(e, credential)

  // ── 落盘：已读 + 水位（列出来的才算看过；--all 也照记）──
  const nextSeen: Record<string, number> = { ...seen }
  for (const e of shown) nextSeen[`${e.kind}:${e.id}`] = Date.now()
  // 只按条数裁：给「看过」加保质期会让老消息以 [新] 复现（假信号），而更老的条目早被 cursor 的两页窗口挡在外面了
  const kept = Object.entries(nextSeen).slice(-1000)
  const maxT = (rows: MsgFeedRow[]): number => rows.reduce((m, r) => Math.max(m, Number(r.reply_time ?? r.at_time ?? 0)), 0)
  writeJson(INBOX_FILE, {
    seen: Object.fromEntries(kept),
    cursor: { reply: Math.max(since.reply, maxT(replyRows)), at: Math.max(since.at, maxT(atRows)) },
  })

  return {
    // 两个数分开：「新的」是拉到的里面没见过的几条，不是本次列了几条
    // （合成一个数会让人以为跑一次就清完了，实际得跑四趟）
    fresh: fresh.length,
    total: merged.length,
    shown: shown.length,
    remaining: (all ? merged.length : fresh.length) - shown.length,
    messages: shown.map((e) => ({
      kind: e.kind,
      id: e.id,
      atSec: e.t,
      seen: !!seen[`${e.kind}:${e.id}`],
      from: { mid: e.mid, name: e.who },
      bvid: e.bvid,
      title: e.title,
      text: e.text,
      replyTo: e.rpid ? { rpid: e.rpid, root: e.root || undefined } : undefined,
    })),
  }
}

// ── 写操作：先 plan 后 commit ────────────────────────────────────────────
/**
 * dry 与 go 共用同一份校验：分享开关 → 额度 → 判重 → 内容规则 → 登录态，
 * 全过之后才分叉（dry 只回 plan，go 真发）。顺序不能改 —— 先分叉就等于
 * 让 --dry 变成「不校验的预览」，那它就没用了。
 */
export interface WritePlan {
  url: string
  method: 'POST'
  referer: string
  /** 永远脱敏：csrf 恒为 ***；正文原样，它得看得见自己要发的话 */
  form: Record<string, string>
  /** 当前登录的账号（脱敏后的显示名） */
  account?: string
  /** 取消类（取消赞 / 取关）= false：不占额度、不判重 */
  counted: boolean
  usedToday: number
  limit: number
  remainingAfter: number
}

export interface CommentOptions {
  bvid: string
  message: string
  /** 回复某条评论：rpid 是被回复的那条；楼中楼才带 root */
  reply?: { rpid: number; root?: number }
  mode: 'dry' | 'go'
}

export interface CommentDry {
  kind: 'dry'
  plan: WritePlan
  object: {
    bvid: string
    title: string
    aid: number
    replyTo?: { rpid: number; root?: number }
  }
}

export interface CommentDone {
  kind: 'done'
  object: CommentDry['object']
  /** B 站回执里的新评论 id（可见性核对用） */
  rpid?: number
  usedToday: number
  limit: number
  /** 真发之前验过的登录态（CLI 要报一句「登录态 ✓ 谁」） */
  account?: { name: string; mid: string }
}

export async function comment(opts: CommentOptions): Promise<CommentDry | CommentDone> {
  const bvid = String(opts.bvid ?? '').trim()
  const message = String(opts.message ?? '')
  if (!BV_RE.test(bvid)) throw new BiliError('usage', '需要一个 BV 号', '形如 BV1xx411c7mD')
  if (!message.trim()) throw new BiliError('usage', '正文不能为空')
  if (opts.mode !== 'dry' && opts.mode !== 'go') throw new BiliError('usage', '写操作必须显式 dry 或 go', '先 dry 看一眼，再 go 真发')

  // 回复：parent 是要回的那条评论，root 是楼层根（不填 = 它自己就是根）
  const parent = opts.reply ? Number(opts.reply.rpid) : 0
  const threadRoot = opts.reply?.root === undefined ? 0 : Number(opts.reply.root)
  if (parent && (!Number.isFinite(parent) || parent <= 0)) throw new BiliError('usage', '--reply 要填 rpid（纯数字，从 inbox 里抄）')
  if (threadRoot && !parent) throw new BiliError('usage', '--root 只在和 --reply 一起用时才有意义')
  if (threadRoot && (!Number.isFinite(threadRoot) || threadRoot <= 0)) throw new BiliError('usage', '--root 要填根评论的 rpid（纯数字）')
  const actualRoot = parent ? (threadRoot || parent) : 0

  // ── 护栏：顺序不能改（分享 → 额度 → 判重 → 内容规则）──
  const cfg = config()
  if (cfg.share?.enabled === false) throw new BiliError('guard', '分享已在设置里关闭（share.enabled=false）→ 这次不发（看视频 / 写日记照常）')
  const limit = Math.max(0, Number(cfg.quota?.writeDaily ?? DEFAULTS.quota.writeDaily))
  const wrote = writesToday()
  if (wrote.length >= limit) throw new BiliError('guard', `今天的写额度用完了（${wrote.length}/${limit}）`, '明天再说 —— 克制是功能，不是 bug')
  // 判重键：发新评论按 BV 号，回别人按那条评论的 rpid（同一视频下可以分别回不同的人）
  if (parent) {
    if (repliedWithin(parent)) throw new BiliError('guard', `这条评论 7 天内已经回过（rpid ${parent}）`, '同一句话回两遍像刷屏')
  } else if (commentedWithin(bvid)) {
    throw new BiliError('guard', '这个视频 7 天内已经评过', '判重按 BV 号算；要回别人的评论用 reply')
  }
  if (message.includes('@')) {
    throw new BiliError('usage', '共用账号不需要、也不应该 @ 任何人（@ 的是别人的粉丝，不是主人）', '去掉正文里的 @ 再发')
  }
  if (message.length > 500) throw new BiliError('usage', `正文 ${message.length} 字 —— 太长了，像刷屏`, '压到 500 字以内')

  const credential = cred()
  const miss = (['sessdata', 'bili_jct'] as const).filter((k) => !credential[k])
  if (miss.length) throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 写操作必须要`, '去设置页「B站养鱼」补一次 cookie')
  const v = await getView(bvid, credential)

  const body: Record<string, string> = { type: '1', oid: String(v.aid), message, plat: '1', csrf: credential.bili_jct }
  if (parent) { body.root = String(actualRoot); body.parent = String(parent) }
  const referer = `https://www.bilibili.com/video/${bvid}/`
  const url = 'https://api.bilibili.com/x/v2/reply/add'
  const plan: WritePlan = {
    url, method: 'POST', referer,
    form: { ...body, csrf: '***' },
    account: cfg.self?.name ? String(cfg.self.name) : undefined,
    counted: true,
    usedToday: wrote.length,
    limit,
    remainingAfter: Math.max(0, limit - wrote.length - 1),
  }
  const object = {
    bvid,
    title: String(v.title ?? ''),
    aid: Number(v.aid ?? 0),
    replyTo: parent ? { rpid: parent, root: threadRoot || undefined } : undefined,
  }

  if (opts.mode === 'dry') return { kind: 'dry', plan, object }

  // --go：先校验登录态（cookie 失效就别浪费额度）
  const nav = await apiGet<NavResp>('https://api.bilibili.com/x/web-interface/nav', { cred: credential })
  if (nav.code !== 0 || nav.data?.isLogin !== true) {
    throw new BiliError('auth', `登录态失效：${explainCode(nav.code)}`, '重抄 cookie 再来')
  }
  const j = await apiPost<{ rpid?: number }>(url, body, { cred: credential, referer })
  if (Number(j.code) !== 0) {
    throw new BiliError('upstream', `${parent ? '回复' : '发送'}失败：${explainCode(j.code)}${j.message ? `（B站原文：${j.message}）` : ''}`)
  }
  const newRpid = Number(j.data?.rpid ?? 0) || undefined
  ledgerAppend({
    type: 'comment', bvid, target: `BV:${bvid}`, note: message.slice(0, 60), newRpid,
    ...(parent ? { rpid: parent, root: actualRoot } : {}),
  })
  return { kind: 'done', object, rpid: newRpid, usedToday: wrote.length + 1, limit, account: loginOf(nav) }
}

export interface InteractOptions {
  /** BV 号（点赞）或 mid / 名字（关注） */
  target: string
  action: 'like' | 'follow'
  /** 取消赞 / 取关：不占额度，也不参与 7 天判重 */
  undo?: boolean
  mode: 'dry' | 'go'
}

export interface InteractDry {
  kind: 'dry'
  plan: WritePlan
  object: {
    kind: 'video' | 'user'
    bvid?: string
    mid?: string
    title?: string
    upName?: string
  }
}

export interface InteractDone {
  kind: 'done'
  object: InteractDry['object']
  counted: boolean
  usedToday: number
  limit: number
  account?: { name: string; mid: string }
}

export async function interact(opts: InteractOptions): Promise<InteractDry | InteractDone> {
  const target = String(opts.target ?? '').trim()
  const action = opts.action
  const undo = opts.undo === true
  if (action !== 'like' && action !== 'follow') throw new BiliError('usage', '一次只做一件事：like 或 follow')
  if (opts.mode !== 'dry' && opts.mode !== 'go') throw new BiliError('usage', '写操作必须显式 dry 或 go', '先 dry 看一眼，再 go 真做')
  const isBv = BV_RE.test(target)
  if (!isBv && !(action === 'follow' && /^\d{1,12}$/.test(target))) {
    throw new BiliError('usage', `目标要写成 BV 号${action === 'follow' ? '（或直接写 UP 的 UID）' : ''}`)
  }

  const cfg = config()
  if (cfg.share?.enabled === false) throw new BiliError('guard', '分享已在设置里关闭（share.enabled=false）→ 这次不做（看视频 / 写日记照常）')
  const credential = cred()
  const miss = (['sessdata', 'bili_jct'] as const).filter((k) => !credential[k])
  if (miss.length) throw new BiliError('credential', `凭据缺 ${miss.join(', ')} —— 写操作必须要`, '去设置页「B站养鱼」补一次 cookie')

  // 视频类互动要拿 aid（点赞接口只认 aid）与 UP 的 mid（关注）；只读，dry 也要这一步
  const v: VideoView = isBv ? await getView(target, credential) : {}
  const fid = action !== 'follow' ? '' : (isBv ? String(v.owner?.mid ?? '') : target)
  if (action === 'follow' && !fid) throw new BiliError('notfound', '拿不到 UP 的 mid', '用 UID 直接关注')
  if (action === 'follow' && String(cfg.self?.mid ?? '') === fid) {
    throw new BiliError('usage', '这是你自己（与主人共用的号）—— 不能关注自己')
  }

  const key = action === 'follow' ? `uid:${fid}` : target
  const limit = Math.max(0, Number(cfg.quota?.interactDaily ?? DEFAULTS.quota.interactDaily))
  const acted = interactionsToday()
  if (!undo) {
    if (acted.length >= limit) throw new BiliError('guard', `今天的互动额度用完了（${acted.length}/${limit}）`, '明天再说 —— 克制是功能，不是 bug')
    if (interactedWithin(key, action)) {
      throw new BiliError('guard', `这个${action === 'follow' ? ' UP' : '视频'} 7 天内已经${action === 'follow' ? '关注' : '点赞'}过`, `判重按 ${action === 'follow' ? 'mid' : 'BV 号'}算`)
    }
  }

  let url: string
  let body: Record<string, string>
  if (action === 'like') {
    url = 'https://api.bilibili.com/x/web-interface/archive/like'
    body = { aid: String(v.aid), like: undo ? '2' : '1', csrf: credential.bili_jct }
  } else {
    url = 'https://api.bilibili.com/x/relation/modify'
    body = { fid, act: undo ? '2' : '1', re_src: '11', csrf: credential.bili_jct }
  }
  const referer = isBv ? `https://www.bilibili.com/video/${target}/` : 'https://space.bilibili.com/'

  const plan: WritePlan = {
    url, method: 'POST', referer,
    form: { ...body, csrf: '***' },
    account: cfg.self?.name ? String(cfg.self.name) : undefined,
    counted: !undo,
    usedToday: acted.length,
    limit,
    remainingAfter: undo ? Math.max(0, limit - acted.length) : Math.max(0, limit - acted.length - 1),
  }
  const object = {
    kind: (isBv ? 'video' : 'user') as 'video' | 'user',
    bvid: isBv ? target : undefined,
    mid: action === 'follow' ? fid : undefined,
    title: isBv ? String(v.title ?? '') : undefined,
    upName: isBv && action === 'follow' ? (v.owner?.name ? String(v.owner.name) : undefined) : undefined,
  }

  if (opts.mode === 'dry') return { kind: 'dry', plan, object }

  // --go：先校验登录态（cookie 失效就别白发一次写请求）
  const nav = await apiGet<NavResp>('https://api.bilibili.com/x/web-interface/nav', { cred: credential })
  if (nav.code !== 0 || nav.data?.isLogin !== true) {
    throw new BiliError('auth', `登录态失效：${explainCode(nav.code)}`, '重抄 cookie 再来')
  }
  if (action === 'follow' && String(nav.data.mid) === fid) {
    throw new BiliError('usage', '这是你自己（与主人共用的号）—— 不能关注自己')
  }
  const j = await apiPost(url, body, { cred: credential, referer })
  if (Number(j.code) !== 0) {
    throw new BiliError('upstream', `${undo ? '取消' : ''}${action === 'follow' ? '关注' : '点赞'}失败：${explainCode(j.code)}${j.message ? `（B站原文：${j.message}）` : ''}`)
  }
  ledgerAppend({ type: 'interact', action, undo: undo || undefined, target: key, bvid: isBv ? target : undefined, note: `${undo ? '取消' : ''}${action === 'follow' ? '关注' : '点赞'} ${isBv ? target : fid}` })
  return { kind: 'done', object, counted: !undo, usedToday: undo ? acted.length : acted.length + 1, limit, account: loginOf(nav) }
}

/** nav 回执 → 登录态摘要（两个写操作都要报一句「登录态 ✓ 谁」） */
function loginOf(nav: NavResp): { name: string; mid: string } | undefined {
  if (!nav.data?.uname) return undefined
  return { name: String(nav.data.uname), mid: String(nav.data.mid ?? '') }
}

// ── schedule ────────────────────────────────────────────────────────────
export type ScheduleCommand =
  | { action: 'add'; at?: string; daily?: string; every?: string; label?: string; forDays?: string | number }
  | { action: 'list' }
  | { action: 'drop'; id: string }
  | { action: 'clear' }

export interface ScheduleEntryView {
  id: string
  label: string
  kind: 'once' | 'daily' | 'every'
  /**
   * fmtWhen() 的结果 —— 唯一的「口径混进数据」的例外。
   * 理由：这段中文的规则在 lib/schedule（与 bili-pulse 共用的唯一真相），
   * 搬到渲染层就会出现两份，迟早漂移。下同 expiryText。
   */
  whenText: string
  /** ISO 时间戳 */
  nextDue: string
  fires: number
  createdAt: string
  /** 保质期（daily / every 才有） */
  expiresAt?: string
  forDays?: number
  /** 「还剩 N 天」这类人话；null = 一次性（没有保质期） */
  expiryText?: string
}

export type ScheduleResult =
  | { action: 'add'; entry: ScheduleEntryView; note?: string; pending: number; maxPending: number }
  | {
      action: 'list'
      entries: ScheduleEntryView[]
      /** 最近触发过的几条（投过就撤/续，让它知道自己排过什么） */
      fired: Array<{ at: string; id: string; label: string }>
      pending: number
      maxPending: number
    }
  | { action: 'drop'; id: string; pending: number; maxPending: number }
  | { action: 'clear'; removed: number; pending: number; maxPending: number }

/** 同步：只碰本地 json，不发请求 */
export function schedule(cmd: ScheduleCommand): ScheduleResult {
  if (cmd.action === 'add') {
    let added: { entry: ScheduleEntry; note: string | null }
    try {
      added = addEntry({
        at: cmd.at,
        daily: cmd.daily,
        every: cmd.every,
        label: cmd.label,
        forDays: cmd.forDays === undefined ? undefined : String(cmd.forDays),
      })
    } catch (e) { throw new BiliError('usage', msg(e)) }
    return {
      action: 'add',
      entry: entryView(added.entry),
      note: added.note ?? undefined,
      pending: readPlan().entries.length,
      maxPending: MAX_PENDING,
    }
  }

  if (cmd.action === 'list') {
    const p = readPlan()
    return {
      action: 'list',
      entries: [...p.entries]
        .sort((a, b) => Date.parse(a.nextDue) - Date.parse(b.nextDue))
        .map(entryView),
      fired: p.fired.slice(-5).reverse().map((f) => ({ at: f.at, id: f.id, label: f.label })),
      pending: p.entries.length,
      maxPending: MAX_PENDING,
    }
  }

  if (cmd.action === 'drop') {
    const id = String(cmd.id ?? '').trim()
    if (!id) throw new BiliError('usage', '要给 id', 'schedule list 看 id')
    if (!dropEntry(id)) throw new BiliError('notfound', `没有 [${id}] 这条`, 'schedule list 对一眼')
    return { action: 'drop', id, pending: readPlan().entries.length, maxPending: MAX_PENDING }
  }

  const removed = clearPlan()
  return { action: 'clear', removed, pending: readPlan().entries.length, maxPending: MAX_PENDING }
}

/** ScheduleEntry → 对外的视图（两个格式化函数借自 lib/schedule，理由见类型注释） */
function entryView(e: ScheduleEntry): ScheduleEntryView {
  return {
    id: e.id,
    label: e.label,
    kind: e.kind,
    whenText: fmtWhen(e),
    nextDue: e.nextDue,
    fires: Number(e.fires) || 0,
    createdAt: e.createdAt,
    expiresAt: e.expiresAt,
    forDays: e.forDays,
    expiryText: expiryText(e) ?? undefined,
  }
}

// ── history：账本 + 口味回顾 ─────────────────────────────────────────────
export type HistoryQuery = { kind: 'ledger' } | { kind: 'taste'; days?: number; limit?: number }

export interface LedgerSnapshot {
  kind: 'ledger'
  /** 今天（YYYY-MM-DD，本地时区） */
  day: string
  written: Array<{ at: string; type: string; bvid?: string; note?: string; title?: string }>
  writeLimit: number
  interacted: Array<{ at: string; action?: string; note?: string }>
  interactLimit: number
  /** 今天看过哪些（账本顺序，按 BV） */
  watchedToday: string[]
  /** 风控熔断中：到什么时候、为什么 */
  ban?: { untilMs: number; reason?: string }
}

export interface TasteSnapshot {
  kind: 'taste'
  days: number
  totalEntries: number
  earliestDay?: string
  counts: { watched: number; comments: number; interactions: number; likes: number; follows: number }
  /** 本次「最近看过 / 动过手」各列几条（收过边界后的真实值） */
  limit: number
  /** 看得最多的 UP（最多 10 位） */
  topUps: Array<{ name: string; count: number }>
  /** 最近看过的，最新在前 */
  recentWatched: Array<{ at: string; bvid: string; title?: string; up?: string }>
  /** 动过手的目标（评论 / 互动），最新在前 */
  touched: Array<{ at: string; kind: 'comment' | 'interact'; action?: string; isReply?: boolean; note?: string; bvid?: string; title?: string }>
}

/**
 * 账本与口味回顾。两者是同一份数据（ledger.json）的两个视角，合成一个 op 是因为
 * 它们共享「读账本 + 按天切」这层，合并后设置页与工具都只面对一个入口。
 *
 * 纯本地：不发请求，也不需要凭据。
 */
export function history(q: HistoryQuery): LedgerSnapshot | TasteSnapshot {
  if (q.kind === 'ledger') {
    const led = readLedger()
    const limit = Math.max(0, Number(config().quota?.writeDaily ?? DEFAULTS.quota.writeDaily))
    const ilimit = Math.max(0, Number(config().quota?.interactDaily ?? DEFAULTS.quota.interactDaily))
    const banned = banUntil()
    return {
      kind: 'ledger',
      day: today(),
      written: writesToday().map((x) => ({ at: x.at, type: x.type, bvid: x.bvid, note: x.note, title: x.title })),
      writeLimit: limit,
      interacted: interactionsToday().map((x) => ({ at: x.at, action: x.action, note: x.note })),
      interactLimit: ilimit,
      watchedToday: led.log
        .filter((x) => x.type === 'watch' && new Date(x.at).toLocaleDateString('sv-SE') === today())
        .map((x) => String(x.bvid ?? '')),
      ban: banned > Date.now() ? { untilMs: banned, reason: banWhy() } : undefined,
    }
  }

  const days = clamp(Math.trunc(finiteOr(q.days, 30)), 1, 3650)
  const lim = clamp(Math.trunc(finiteOr(q.limit, 15)), 1, 60)
  const log = readLedger().log
  const since = Date.now() - days * 86_400_000
  const recent = log.filter((x) => new Date(x.at).getTime() >= since)
  const watched = recent.filter((x) => x.type === 'watch')
  const comments = recent.filter((x) => x.type === 'comment')
  const acts = recent.filter((x) => x.type === 'interact' && !x.undo)
  const byAct = (a: string): number => acts.filter((x) => x.action === a).length

  // UP 只从新记录里有（watch.up 是后加的）；老记录只有标题，照样能读
  const ups = new Map<string, number>()
  for (const x of watched) if (x.up) ups.set(x.up, (ups.get(x.up) ?? 0) + 1)

  // 标题索引取自整份账本：动过手的那条自己未必带标题
  const titles = new Map<string, string>()
  for (const x of log) if (x.bvid && x.title) titles.set(x.bvid, x.title)

  return {
    kind: 'taste',
    days,
    totalEntries: log.length,
    earliestDay: log.length ? new Date(log[0].at).toLocaleDateString('sv-SE') : undefined,
    counts: { watched: watched.length, comments: comments.length, interactions: acts.length, likes: byAct('like'), follows: byAct('follow') },
    limit: lim,
    topUps: [...ups].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })),
    recentWatched: watched.slice(-lim).reverse().map((x) => ({ at: x.at, bvid: String(x.bvid ?? ''), title: x.title, up: x.up })),
    touched: [...comments, ...acts]
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, lim)
      .map((x) => ({
        at: x.at,
        kind: x.type === 'comment' ? 'comment' as const : 'interact' as const,
        action: x.action,
        isReply: x.type === 'comment' ? !!x.rpid : undefined,
        note: x.note,
        bvid: x.bvid,
        title: x.bvid ? titles.get(x.bvid) : undefined,
      })),
  }
}
