// ============================================================================
// dsh-bili-lite · agent 命令实现（selftest / whoami / feed / video / comment / diary / ledger）
// 只有 CLI 入口（bili.mjs）调用这里；账本在 ledger.js，B 站 HTTP 在 lib/bilibili.js。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { config, writeConfig, DEFAULTS } from '../../config/store.js'
import { CFG_FILE, CRED_FILE, DATA_DIR, DIARY_FILE, SCHEDULE_FILE } from '../../config/paths.js'
import { apiGet, explainCode, loadCred, saveCred, whoami, qrGenerate, qrPoll, cookieHeader, UA, wbi, banUntil, banWhy, getPlayerInfo, pickSubtitle, getSubtitleLines, getDanmakuBrief } from '../../lib/bilibili.js'
import { qrMatrix, qrTerminal } from '../../lib/qrcode.js'
import { writesToday, commentedWithin, seenSet, ledgerAppend, readLedger, today } from './ledger.js'
import { readPlan, addEntry, dropEntry, clearPlan, fmtWhen, planSummary, MAX_PENDING, MIN_EVERY_MIN, MAX_EVERY_MIN } from '../../lib/schedule.js'

// ── 小工具 ─────────────────────────────────────────────────────────────────
const fmtNum = (n) => Number(n) >= 10000 ? (Number(n) / 10000).toFixed(1) + '万' : String(n ?? 0)
const fmtDur = (s) => { const m = Math.floor(Number(s) / 60); return `${String(m).padStart(2, '0')}:${String(Math.floor(Number(s) % 60)).padStart(2, '0')}` }
/** 时长容错：搜索接口给 "HH:MM:SS" / "MM:SS" / 秒数，都归一成 MM:SS */
const durText = (d) => {
  const s = String(d ?? '')
  const parts = s.split(':').map(Number)
  if (parts.length >= 2 && parts.every((x) => Number.isFinite(x))) return fmtDur(parts.reduce((a, b) => a * 60 + b, 0))
  return fmtDur(Number(s) || 0)
}
const BV_RE = /^BV[0-9A-Za-z]{10}$/

/** "90" / "1:30" / "1:02:03" → 秒；非数字 → NaN（让调用方报用法，不静默当 0） */
const toSec = (s) => String(s).trim().split(':').reduce((a, x) => { const n = Number(x); return Number.isFinite(n) ? a * 60 + n : NaN }, 0)
/** 逐句字幕拼成可读的流水：CJK 边界不加空格，英文边界加 */
const flowText = (texts) => texts.reduce((acc, t) => {
  if (!acc) return t
  const cjk = /[\u4e00-\u9fff，。！？、；：…）》」』％]$/.test(acc.slice(-1)) || /^[\u4e00-\u9fff，。！？、；：…（《「『]/.test(t)
  return acc + (cjk ? '' : ' ') + t
}, '')
/** 字幕种类标签：ai- 开头的是 AI 生成，其余是 UP 自己配的 CC */
const subKind = (sub) => String(sub?.lan ?? '').startsWith('ai-') ? 'AI 生成' : 'UP 配'

async function getView(bvid, cred) {
  const j = await apiGet(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { cred, ttlMs: 24 * 3600_000 })
  if (j.code !== 0) throw new Error(`查不到视频 ${bvid}：${explainCode(j.code)}${j.message ? '（' + j.message + '）' : ''}`)
  return j.data
}

export const HELP = `用法: node bili.mjs <命令> [参数…]
命令：
  selftest                启动自检（装完先跑这个）
  login                   扫码登录（手机 B 站 App 扫码，免手抄 cookie）
  whoami                  cookie 是哪个号
  feed [--n 5]            今天的候选（只读）
  video <BV> [--read 全文|mm:ss-mm:ss]
                          看懂一条：概览 = 简介/章节/字幕试读/弹幕热词/热评（只读）；
                          --read 深读字幕全文或某一段（不截断，读多深自己定）
  comment <BV> --message "…" --dry|--go
                          发一条评论（唯一写操作；必须 --dry 或 --go）
  diary <text…> | show    写日记 / 看最近
  ledger                  今天的额度账本
  schedule add --at "21:30" | --at "2026-02-06 21:30" | --daily "09:00" | --every 90m [--label "…"]
                          排一拍（一次性 / 每天 / 每隔 N 分钟）—— 到点宿主照投，带你自己写的标签
  schedule list           看排了什么（最近投过的也在）
  schedule drop <id>      撤一条；schedule clear 全撤（撤完宿主恢复兜底节拍）
安全约定（代码强制）：
  · 写操作必须显式 --dry 或 --go；每天 ≤${DEFAULTS.quota.writeDaily} 条；同一视频 7 天一次
  · 撞 412/风控码自动熔断 5–30 分钟；凭据永不回显`

export async function cmdSelftest(asJson) {
  const items = []
  const add = (name, ok, detail) => items.push({ name, ok: !!ok, detail })
  const [major] = String(process.version).slice(1).split('.')
  add('Node 版本', Number(major) >= 18, `${process.version}${Number(major) >= 18 ? '' : ' —— 需要 18+（fetch/AbortSignal）'}`)
  add('配置文件', true, `${CFG_FILE}${fs.existsSync(CFG_FILE) ? '' : '（还没写过，用默认值 ✓）'}`)
  let cred = null
  try {
    cred = loadCred()
    const miss = ['sessdata', 'bili_jct'].filter((k) => !cred[k])
    add('凭据', !miss.length, miss.length ? `缺 ${miss.join(', ')} —— 去设置页粘贴 cookie` : `${CRED_FILE}（三个字段齐 ✓）`)
  } catch (e) { add('凭据', false, e.message) }
  if (cred) {
    try {
      const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred })
      const login = nav.code === 0 && nav.data?.isLogin === true
      add('登录态', login, login ? `已登录：${nav.data.uname}（mid ${nav.data.mid}）` : `${explainCode(nav.code)} —— cookie 失效，重抄一次`)
      add('WBI 密钥', !!nav.data?.wbi_img?.img_url, nav.data?.wbi_img ? '搜索可用 ✓' : 'nav 未返回 wbi_img，搜索不可用')
      if (login) {
        const cur = config()
        if (String(cur.self?.mid ?? '') !== String(nav.data.mid)) {
          try { fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true }); fs.writeFileSync(CFG_FILE, JSON.stringify({ ...cur, self: { mid: String(nav.data.mid), name: String(nav.data.uname ?? '') } }, null, 2) + '\n') } catch {}
        }
      }
      // 字幕/章节接口可达性（player v2 要 WBI 签名；AI 字幕列表要登录态才返回）——
      // 让「看不懂」在装完当天就暴露，而不是某天 video 命令静默降级
      try {
        const pop = await apiGet('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', { cred, ttlMs: 10 * 60_000 })
        const s = (pop.data?.list ?? []).find((x) => x.bvid && x.cid)
        if (!s) throw new Error('热门列表拿不到样本视频，跳过')
        const info = await getPlayerInfo(s.bvid, s.cid, cred)
        const n = info.subtitle?.subtitles?.length ?? 0
        add('字幕接口', true, `可达 ✓（样本${n ? `带 ${n} 条字幕` : '样本无字幕'}${info.need_login_subtitle && !login ? '；AI 字幕需登录' : ''}）`)
      } catch (e) { add('字幕接口', false, e.message) }
    } catch (e) { add('登录态', false, e.message) }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const probe = path.join(DATA_DIR, '.write-probe')
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe)
    add('数据目录', true, `${DATA_DIR} 可写 ✓`)
  } catch (e) { add('数据目录', false, `${DATA_DIR} 写不进去：${e.message}`) }
  try {
    fs.mkdirSync(path.dirname(DIARY_FILE), { recursive: true })
    if (!fs.existsSync(DIARY_FILE)) fs.writeFileSync(DIARY_FILE, '# 小鲤的日记\n\n')
    add('日记', true, `${DIARY_FILE} ✓`)
  } catch (e) { add('日记', false, `${DIARY_FILE}：${e.message}`) }
  add('心跳', true, `兜底节拍每 ${Number(config().pulse?.everyMin) || 60} 分钟一拍 —— 只在它没排计划时走；排了计划（schedule add）宿主只按它的计划投拍 ✓`)
  try {
    const p = readPlan()
    const sum = planSummary()
    add('计划文件', true, `${SCHEDULE_FILE}${p.entries.length ? `（在排 ${p.entries.length}/${MAX_PENDING} 条，下一次：${sum.nextDueText} ${sum.nextWhenText}）` : '（还没排 —— 排不排它自己定 ✓）'}；--every 最短 ${MIN_EVERY_MIN} 分钟`)
  } catch (e) { add('计划文件', false, e.message) }

  const ok = items.every((x) => x.ok)
  if (asJson) { console.log(JSON.stringify({ ok, node: process.version, items }, null, 2)); process.exit(ok ? 0 : 1) }
  console.log('── 启动自检（dsh-bili-lite）──')
  for (const it of items) console.log(`  ${it.ok ? '✓' : '✗'} ${it.name}：${it.detail}`)
  console.log(`\n${ok ? '══ 全部通过 ✓ 可以用了 ══' : '══ 有 ✗，先照提示修 ══'}`)
  console.log('\n接下来要做的两件事（很多人卡在这）：')
  console.log('  ① 左侧「工作区」→ 展开「未分组」→ 找到 bili-lite 会话（不点开看不见 ✗）')
  console.log('  ② 打开它 → 权限设置 → 选「完全访问 / danger-full-access」')
  process.exit(ok ? 0 : 1)
}

// ── 扫码登录：终端出二维码 → 轮询到确认 → 真实验证后落盘（免手抄 cookie 的入口）────────
export async function cmdLogin() {
  for (let round = 1; ; round += 1) {
    if (round > 3) throw new Error('连续 3 张二维码都过期了 —— 手机扫码不成功时，去设置页手动粘贴 cookie 兜底')
    const g = await qrGenerate()
    console.log(`\n用手机 B 站 App → 扫一扫，扫下面的二维码并确认登录（第 ${round} 张，约 3 分钟内有效，过期自动换新）：`)
    console.log(process.stdout.isTTY ? qrTerminal(qrMatrix(g.url)) : '（当前不是交互终端，显示不了图形 —— 在真实终端里跑这条命令 ✓）')
    console.log('等待扫码中…（Ctrl+C 退出）')
    const deadline = Date.now() + 180_000
    let saidScanned = false
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await qrPoll(g.qrcodeKey)
      if (st.status === 'scanned' && !saidScanned) { saidScanned = true; console.log('已扫码 —— 请在手机上点「确认登录」') }
      if (st.status === 'expired') { console.log('二维码过期了，换新的一张…'); break }
      if (st.status === 'done') {
        saveCred(st.cred)
        const self = await whoami(st.cred)   // 落盘后真实验证一次，确认登录态可用
        writeConfig({ ...config(), self })
        console.log(`\n✓ 登录成功：${self.name}（mid ${self.mid}）—— 凭据已写入 ${CRED_FILE}（0600，永不回显）`)
        console.log('⚠️ 这是与 AI 共用的账号：它发的每条评论都会以这个身份公开出现 —— 确认是主人授权的号')
        return
      }
    }
  }
}

export async function cmdWhoami() {
  const cred = loadCred()
  const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred })
  if (nav.code !== 0 || nav.data?.isLogin !== true) { console.error(`✗ 未登录：${explainCode(nav.code)}`); process.exit(4) }
  console.log(`账号: ${nav.data.uname}   (mid ${nav.data.mid})`)
  console.log(`硬币 ${nav.data.money ?? '?'}   等级 ${nav.data.level_info?.current_level ?? '?'}`)
  console.log('⚠️ 这是与 AI 共用的账号：它发的每条评论都会以这个身份公开出现 —— 确认是主人授权的号')
}

export async function cmdFeed(flags) {
  const n = Math.min(10, Math.max(1, Number(flags.get('n') ?? 5)))
  const cfg = config()
  const like = (cfg.preferences?.like ?? []).map(String).filter(Boolean)
  const dislike = (cfg.preferences?.dislike ?? []).map(String).filter(Boolean)
  const cred = loadCred()
  const seen = seenSet()
  const pool = []
  const push = (v) => { if (BV_RE.test(v.bvid ?? '') && !seen.has(v.bvid) && !pool.some((x) => x.bvid === v.bvid)) pool.push(v) }

  // ① 照偏好搜（每条偏好取第一个可切的短词）
  for (const pref of like.slice(0, 3)) {
    const kw = pref.split(/[\s·,，、/]+/).map((s) => s.trim()).find((s) => s.length >= 2) ?? pref
    try {
      const qs = await wbi({ search_type: 'video', keyword: kw.slice(0, 40), page: 1 }, cred)
      const j = await apiGet(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, { cred, referer: 'https://search.bilibili.com/' })
      for (const r of j.data?.result ?? []) push({
        bvid: r.bvid, title: String(r.title ?? '').replace(/<[^>]+>/g, ''),
        up: r.author, play: r.play, duration: r.duration, why: `搜「${kw}」`,
      })
    } catch (e) { console.log(`（搜「${kw}」失败：${e.message}）`) }
    if (pool.length >= n * 3) break
  }
  // ② 不够就用热门补
  if (pool.length < n) {
    try {
      const j = await apiGet('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', { cred })
      for (const r of j.data?.list ?? []) push({ bvid: r.bvid, title: r.title, up: r.owner?.name, play: r.stat?.view, duration: fmtDur(r.duration), why: '热门' })
    } catch (e) { console.log(`（热门列表失败：${e.message}）`) }
  }
  // ③ 过滤不爱看的
  const bad = (t) => dislike.some((d) => t.includes(d))
  const picks = pool.filter((v) => !bad(v.title)).slice(0, n)
  if (!picks.length) { console.log('（没有捞到候选 —— 换几个偏好关键词，或稍后再试）'); return }
  console.log(`今天的候选（${picks.length} 条，已排除看过的${dislike.length ? ' / 不爱看的' : ''}）：`)
  for (const [i, v] of picks.entries()) {
    console.log(`\n[${i + 1}] ${v.bvid} —— ${v.title}`)
    console.log(`    ${v.up ?? '?'} · 播放 ${fmtNum(v.play)} · ${durText(v.duration)} · ${v.why}`)
  }
  console.log('\n下一步：node bili.mjs video <BV> —— 看懂了再说话 ✓')
}

export async function cmdVideo(flags, positional) {
  const bvid = String(positional[0] ?? '')
  const readArg = String(flags.get('read') ?? '').trim()
  if (!BV_RE.test(bvid)) { console.error('用法: node bili.mjs video <BV号> [--read 全文|mm:ss-mm:ss]'); process.exit(2) }
  const cred = loadCred()
  const v = await getView(bvid, cred)
  if (readArg) return readTranscript(bvid, v, cred, readArg)
  console.log(`=== 《${v.title}》===`)
  console.log(`UP: ${v.owner?.name}（mid ${v.owner?.mid}）   发布: ${new Date(Number(v.pubdate) * 1000).toLocaleDateString('sv-SE')}   时长: ${fmtDur(v.duration)}`)
  console.log(`播放 ${fmtNum(v.stat?.view)} · 弹幕 ${fmtNum(v.stat?.danmaku)} · 赞 ${fmtNum(v.stat?.like)} · 币 ${fmtNum(v.stat?.coin)} · 藏 ${fmtNum(v.stat?.favorite)}`)
  const desc = String(v.desc ?? '').trim()
  if (desc) console.log(`简介: ${desc.slice(0, 400)}${desc.length > 400 ? '…' : ''}`)
  // 内容四层：章节 → 字幕试读 → 弹幕热词 → 热评；读不花额度、不截断，深浅由 agent 自己定
  try {
    const info = await getPlayerInfo(bvid, v.cid, cred)
    const vp = Array.isArray(info.view_points) ? info.view_points : []
    if (vp.length) {
      console.log('--- 章节 ---')
      for (const p of vp) console.log(`  ${fmtDur(Math.round(Number(p.from) || 0))} ${String(p.content ?? '').trim()}`)
    }
    const sub = pickSubtitle(info)
    if (!sub) {
      console.log(`--- 字幕 ---\n  （没有可用字幕${info.need_login_subtitle ? ' —— AI 字幕要登录态才给，先跑 whoami 查 cookie' : ' —— 这条只能凭简介/弹幕/热评理解，发言前掂量探量'}）`)
    } else {
      const lines = await getSubtitleLines(bvid, sub, cred)
      const all = flowText(lines.map((l) => l.text))
      const cover = `${fmtDur(Math.round(lines[0].from))}–${fmtDur(Math.round(lines[lines.length - 1].to || lines[lines.length - 1].from))}`
      console.log(`--- 字幕（${subKind(sub)} · 全文 ${all.length} 字 · 覆盖 ${cover}）---`)
      console.log(`  ${all.slice(0, 500)}${all.length > 500 ? '…' : ''}`)
      if (all.length > 500) console.log(`  ↳ 想细读哪段就 --read：node bili.mjs video ${bvid} --read 全文（或 --read 03:00-08:30）`)
    }
  } catch (e) { console.log(`（章节/字幕读取失败：${e.message}）`) }
  try {
    const dm = await getDanmakuBrief(bvid, v.cid, cred)
    if (dm.count > 0) {
      console.log('--- 弹幕 ---')
      const words = dm.top.map(([w, n]) => `${w}×${n}`).join(' ')
      console.log(`  共 ${fmtNum(dm.count)} 条${words ? ` · 热词：${words}` : ''}`)
      if (dm.dense) console.log(`  最热闹在 ${fmtDur(dm.dense.from)} 前后（那一分钟 ${dm.dense.n} 条 —— 精彩大概率在这）`)
    }
  } catch (e) { console.log(`（弹幕读取失败：${e.message}）`) }
  try {
    const j = await apiGet(`https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&sort=2&ps=10&pn=1`, { cred })
    const replies = j.data?.replies ?? []
    if (replies.length) {
      console.log('--- 热评 ---')
      for (const [i, r] of replies.slice(0, 5).entries()) {
        const msg = String(r.content?.message ?? '').replace(/\s+/g, ' ').slice(0, 120)
        console.log(`  [+${fmtNum(r.like)}] ${r.member?.uname}: ${msg}${r.count ? `（${r.count} 回复）` : ''}`)
      }
    } else console.log('--- 没有评论 ---')
  } catch (e) { console.log(`（热评读取失败：${e.message}）`) }
  ledgerAppend({ type: 'watch', bvid, title: String(v.title).slice(0, 60) })
}

/** 深读：字幕正文，全文或按时间区间，绝不截断 —— 深浅是 agent 的事，读不设限（克制只管写） */
async function readTranscript(bvid, v, cred, readArg) {
  let from = 0, to = Infinity
  if (!/^(all|全文)$/i.test(readArg)) {
    const [a, b] = readArg.split(/\s*-\s*/)
    from = toSec(a)
    to = b === undefined ? Infinity : toSec(b)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      console.error('用法: --read 全文 或 --read 03:00-08:30（也认秒数 --read 180-510）'); process.exit(2)
    }
  }
  const info = await getPlayerInfo(bvid, v.cid, cred)
  const sub = pickSubtitle(info)
  if (!sub) { console.log('（这条没有可用字幕 —— 概览里的简介/章节/弹幕/热评就是全部了）'); return }
  const lines = await getSubtitleLines(bvid, sub, cred)
  const sel = lines.filter((l) => l.to > from && l.from < to)
  if (!sel.length) { console.log(`（${fmtDur(from)} 之后这段没有字幕 —— 换个区间，或 --read 全文）`); return }
  console.log(`=== 《${v.title}》字幕（${subKind(sub)}${to === Infinity ? ' · 全文' : ` · ${fmtDur(from)}–${fmtDur(to)}`}）===`)
  console.log(flowText(sel.map((l) => l.text)))
}

export async function cmdComment(flags, positional) {
  const bvid = String(positional[0] ?? '')
  let message = String(flags.get('message') ?? '')
  const dry = flags.has('dry') || flags.get('dry') === true
  const go = flags.has('go') || flags.get('go') === true
  if (!BV_RE.test(bvid) || !message.trim()) { console.error('用法: node bili.mjs comment <BV> --message "…" [--dry|--go]'); process.exit(2) }
  if (dry && go) { console.error('--dry 和 --go 二选一'); process.exit(2) }
  if (!dry && !go) { console.error('拒绝裸跑：写操作必须显式 --dry（只打印）或 --go（真的发）'); process.exit(2) }

  const cfg = config()
  if (cfg.share?.enabled === false) { console.error('分享已在设置里关闭（share.enabled=false）→ 这次不发（看视频/写日记照常 ✓）'); process.exit(3) }
  const limit = Math.max(0, Number(cfg.quota?.writeDaily ?? 3))
  const wrote = writesToday()
  if (wrote.length >= limit) {
    console.error(`✗ 今天的写额度用完了（${wrote.length}/${limit}）。明天再说 —— 克制是功能，不是 bug ✓`)
    process.exit(3)
  }
  if (commentedWithin(bvid)) { console.error(`✗ 这个视频 7 天内已经评过 → 这次不发（判重按 BV 号算）`); process.exit(3) }
  if (message.includes('@')) { console.error('共用账号不需要、也不应该 @ 任何人（@ 的是别人的粉丝，不是主人）→ 去掉正文里的 @ 再发'); process.exit(2) }
  if (message.length > 500) { console.error(`正文 ${message.length} 字 —— 太长了，像刷屏 ✗ 压到 500 字以内`); process.exit(2) }

  const cred = loadCred()
  const miss = ['sessdata', 'bili_jct'].filter((k) => !cred[k])
  if (miss.length) { console.error(`凭据缺 ${miss.join(', ')} —— 写操作必须要，去设置页补`); process.exit(3) }
  const v = await getView(bvid, cred)

  const body = { type: 1, oid: String(v.aid), message, plat: 1, csrf: cred.bili_jct }
  const url = 'https://api.bilibili.com/x/v2/reply/add'
  if (dry) {
    console.log('=== 将要发出的请求（--dry，没有发）===')
    console.log(`  POST ${url}`)
    console.log(`  referer: https://www.bilibili.com/video/${bvid}/`)
    console.log(`  ${new URLSearchParams({ ...body, csrf: '***' }).toString()}`)
    console.log(`  账号：${cfg.self?.name || '(未体检)'} · 今天已写 ${wrote.length}/${limit} · 发出后剩 ${limit - wrote.length - 1}`)
    console.log('觉得行就去掉 --dry 换 --go')
    return
  }
  // --go：先校验登录态（cookie 失效就别浪费额度）
  const nav = await apiGet('https://api.bilibili.com/x/web-interface/nav', { cred })
  if (nav.code !== 0 || nav.data?.isLogin !== true) { console.error(`✗ 登录态失效：${explainCode(nav.code)} —— 重抄 cookie 再来`); process.exit(4) }
  console.log(`登录态 ✓ ${nav.data.uname}（mid ${nav.data.mid}）`)
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'user-agent': UA, referer: `https://www.bilibili.com/video/${bvid}/`, cookie: cookieHeader(cred), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30000),
  })
  const j = await r.json().catch(() => ({ code: -1, message: '非 JSON 响应' }))
  if (Number(j.code) !== 0) { console.error(`✗ 发送失败：${explainCode(j.code)}${j.message ? `（B站原文：${j.message}）` : ''}`); process.exit(5) }
  ledgerAppend({ type: 'comment', bvid, target: `BV:${bvid}`, note: message.slice(0, 60) })
  console.log(`✓ 已发出（rpid ${j.data?.rpid ?? '?'}）· 今天已写 ${wrote.length + 1}/${limit}`)
  console.log('把这条也记进 diary ✓（说了什么、为什么值得）')
}

export async function cmdDiary(positional) {
  if (positional[0] === 'show') {
    const n = Math.min(100, Math.max(1, Number(positional[1] ?? 20)))
    try {
      const lines = fs.readFileSync(DIARY_FILE, 'utf8').trimEnd().split('\n')
      console.log(lines.slice(-n).join('\n') || '（日记还是空的）')
    } catch { console.log('（日记还是空的）') }
    return
  }
  const text = positional.join(' ').trim()
  if (!text) { console.error('用法: node bili.mjs diary <今天的一段话>  |  diary show [N]'); process.exit(2) }
  fs.mkdirSync(path.dirname(DIARY_FILE), { recursive: true })
  const stamp = new Date()
  fs.appendFileSync(DIARY_FILE, `\n## ${stamp.toLocaleDateString('sv-SE')} ${stamp.toTimeString().slice(0, 5)}\n${text}\n`)
  console.log(`✓ 写进 ${DIARY_FILE}`)
}

// ── schedule：它自己排作息 / 定时任务（写到 lib/schedule 的唯一真相；到点由宿主投「计划拍」）──
const SCHEDULE_USAGE = `用法: node bili.mjs schedule <add|list|drop|clear> [参数]
  add --at "21:30" | --at "2026-02-06 21:30" | --daily "09:00" | --every 90m [--label "…"]
      三选一：一次性（今天/某天的某个点，过了会排到明天说一声）/ 每天 / 每隔 N 分钟（最短 ${MIN_EVERY_MIN}，最长 1 天）
  list                        看排了什么、下一次什么时候（最近投过的也在）
  drop <id>                   撤一条；clear 全撤 —— 撤完计划为空，宿主恢复兜底节拍
计划非空时宿主只按你的计划投拍（固定兜底节拍暂停）—— 节奏拿回你自己手里 ✓`

export function cmdSchedule(positional, flags) {
  const sub = positional[0]
  if (sub === 'add') {
    let r
    try {
      r = addEntry({
        at: flags.has('at') ? String(flags.get('at')) : undefined,
        daily: flags.has('daily') ? String(flags.get('daily')) : undefined,
        every: flags.has('every') ? String(flags.get('every')) : undefined,
        label: flags.has('label') ? String(flags.get('label')) : undefined,
      })
    } catch (e) { console.error(`✗ ${e.message}\n\n${SCHEDULE_USAGE}`); process.exit(2) }
    const e = r.entry
    console.log(`✓ 已排（id ${e.id}）：${fmtWhen(e)} —— ${e.label}`)
    if (r.note) console.log(`  （${r.note}）`)
    console.log(`到点宿主把这一拍投进会话；在排 ${planSummary().pending}/${MAX_PENDING} 条。撤：node bili.mjs schedule drop ${e.id}`)
    return
  }
  if (sub === 'list') {
    const p = readPlan()
    if (!p.entries.length) console.log('（没排任何计划 —— 宿主按兜底节拍一拍一拍地问；想自己掌节奏：schedule add）')
    else {
      console.log(`在排 ${p.entries.length}/${MAX_PENDING} 条（到点宿主照投，兜底节拍暂停）：`)
      for (const e of [...p.entries].sort((a, b) => Date.parse(a.nextDue) - Date.parse(b.nextDue))) {
        console.log(`  [${e.id}] ${fmtWhen(e)} —— ${e.label}（下一拍 ${new Date(e.nextDue).toLocaleString('sv-SE')}）`)
      }
    }
    const fired = p.fired.slice(-5).reverse()
    if (fired.length) {
      console.log('最近投过的：')
      for (const f of fired) console.log(`  ${new Date(f.at).toLocaleString('sv-SE')} [${f.id}] ${f.label}`)
    }
    return
  }
  if (sub === 'drop') {
    const id = positional[1]
    if (!id) { console.error(`✗ 要给 id：node bili.mjs schedule drop s1（schedule list 看 id）`); process.exit(2) }
    if (!dropEntry(id)) { console.error(`✗ 没有 [${id}] 这条 —— schedule list 对一眼`); process.exit(2) }
    console.log(`✓ 撤了 [${id}]${readPlan().entries.length ? '' : ' —— 计划空了，宿主恢复兜底节拍'}`)
    return
  }
  if (sub === 'clear') {
    const n = clearPlan()
    console.log(n ? `✓ 全撤了（${n} 条）—— 宿主恢复兜底节拍` : '（本来就没排）')
    return
  }
  console.log(SCHEDULE_USAGE)
  process.exit(sub ? 2 : 0)
}

export function cmdLedger() {
  const led = readLedger()
  const limit = Math.max(0, Number(config().quota?.writeDaily ?? 3))
  const wrote = writesToday()
  console.log(`今天（${today()}）：已写 ${wrote.length}/${limit} 条`)
  for (const x of wrote) console.log(`  - ${new Date(x.at).toTimeString().slice(0, 5)} ${x.type} ${x.bvid} ${x.note ?? x.title ?? ''}`)
  const recent = led.log.filter((x) => x.type === 'watch' && new Date(x.at).toLocaleDateString('sv-SE') === today())
  console.log(`看过：${recent.length} 条${recent.length ? '（' + recent.map((x) => x.bvid).join(' ') + '）' : ''}`)
  const banned = banUntil()
  if (banned > Date.now()) console.log(`⚠️ 风控熔断中：剩 ${Math.ceil((banned - Date.now()) / 60000)} 分钟（${banWhy()}）`)
}
