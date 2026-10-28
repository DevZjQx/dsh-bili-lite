/**
 * dsh-bili-lite · bili-pulse —— 心跳（照它自己规划的作息投拍的那一半）—— 本 feature 的公共入口
 *
 * 「什么时候看」的决定权还是全在它手里，现在有两个来源，都攥在它自己手中：
 *   · 计划拍：它用 `bun bili.ts schedule …` 自己排的作息 / 定时任务（lib/schedule 是唯一
 *     真相），到点宿主照着投、拍里带上它自己写的标签 —— 宿主只是闹钟：不排、不改、不掷骰子。
 *     计划非空时兜底节拍暂停（它的计划替代默认节奏），clear 后恢复。
 *   · 兜底节拍：它什么都没排时，宿主每 pulse.everyMin（默认 60）分钟投一拍中性的
 *     「现在想干嘛」—— 看不看、什么时候看、今天看几条，全部它自己定，这一拍也可以什么都不干。
 * 重启 DSH 后一分钟内来第一拍（lastBeat 从 0 起算）；错过的计划拍照投（补上，并说一声）。
 *
 * 不拥有：拿到拍之后的行为（那是 agent 拿着 bili.ts 干的）；额度的执行（bili-agent）；
 * 计划的读写与到期判断（lib/schedule，两侧共用）；配置的校验与保存（settings）。
 * 依赖由 app 注入：getSession（→ sessionController）、route、cliPath。
 */
import fs from 'node:fs'
import { json } from '../../lib/http.ts'
import { config, DEFAULTS } from '../../config/store.ts'
import type { Config } from '../../config/store.ts'
import { PERSONA_FILE, WORK_DIR } from '../../config/paths.ts'
import { dueEntries, markFired, planSummary, fmtWhen } from '../../lib/schedule.ts'
import type { ScheduleEntry, PlanSummary } from '../../lib/schedule.ts'
import type { Route, SessionControllerLike } from '../../lib/dsh.ts'

/** 她的专用会话：sessionId 固定 → 跨天保留上下文，而不是每天忘光 */
const SESSION_ID = 'bili-lite'
const CHECK_MS = 60_000   // 每分钟看一次「到拍没」；兜底节拍的粒度由 pulse.everyMin 定

export interface PulseDeps {
  getSession?: () => SessionControllerLike | undefined
  route: Route
  cliPath: string
  log?: (m: string) => void
}

export interface PulseStatus {
  ok: boolean
  everyMin: number
  beats: number
  lastBeatText: string | null
  /** 最近一次投递失败的原因（成功投递后清空）—— 刚装好没投出去时，设置页 / 状态接口就看这里 */
  lastError: string | null
  plan: PlanSummary
}

export interface PulseApi { stop(): void; status(): PulseStatus }

export function startPulse({ getSession, route, cliPath, log = (m) => { try { console.log(m) } catch {} } }: PulseDeps): PulseApi {
  let stopped = false
  let beating = false
  let lastBeat = 0   // 0 = 还没拍过（启动后第一拍马上来）—— 兜底节拍的表；计划拍不受它管
  let beats = 0
  let notReadyWarned = false   // 会话服务没就绪只提醒一次（DSH 刚启动/刚装插件时是常态，不算故障）
  let lastError: string | null = null
  let failCount = 0            // 连续失败次数：同样的原因不每分钟刷屏

  const everyMs = (cfg: Config): number => Math.max(1, Number(cfg.pulse?.everyMin) || DEFAULTS.pulse.everyMin) * 60_000
  /** 它的名字只来自配置（persona.name）—— 没配就不点名，插件里不写死任何名字 */
  const nameOf = (cfg: Config): string => String(cfg?.persona?.name ?? '').trim()

  /** 人设前缀 + 工具与克制的提醒 —— 两种拍共用；宿主只对表，不指挥 */
  function commonText(cfg: Config, titleLine: string): string {
    let persona = ''
    try { persona = fs.readFileSync(PERSONA_FILE, 'utf8').slice(0, 3000).trim() } catch {}
    const head = persona ? persona + '\n\n' : ''
    return head + [titleLine, '',
      '你在 DSH 里替主人运营这个 B 站账号 —— 你和他**共用一个身份**：你发的每条评论都是以主人的名义公开出现，他自己都看得到，不需要也不要 @ 任何人。唯一的工具：',
      `  bun ${cliPath} <子命令>`,
      '常用（别跳步）：selftest（有 ✗ 先照提示修）→ feed [--kw 你想搜的词]（口味由你自己判断，不用等主人配：想搜什么就 --kw，不给就热门里挑）→ video <BV>（章节/字幕/弹幕热词/热评都过一眼，好奇就 --read 深读，读不要钱、不截断；讲的是画面/界面而字幕说不清，就 shots <BV> 抽一张九宫格看一眼）→ diary（给自己写一段）→ 值得就发一条 comment <BV>，真喜欢就 interact <BV> --like / --coin 1 / --follow（都先 --dry 再 --go，互动一次一件）；后悔了加 --undo 取消赞 / 取关（币投出去收不回）。想不起自己最近爱看什么、看腻了什么，就 taste（回顾自己的观看史，只读）—— 口味你自己判断。',
      '',
      '克制（一半写死在工具里，一半在你心里）：',
      `  · 今天评论额度 ≤${Math.max(0, Number(cfg.quota?.writeDaily ?? DEFAULTS.quota.writeDaily))} 条、互动额度 ≤${Math.max(0, Number(cfg.quota?.interactDaily ?? DEFAULTS.quota.interactDaily))} 次；同一视频 7 天内同一种评论/互动只做一次；拿不准先跑 ledger 对账；`,
      '  · 你和主人共用身份 —— 每条评论都署他的名，说错话由他承担；',
      '  · 不值得就不发 —— 不发也是完整的一天；',
      '  · 撞到验证码 / 风控：立刻停手，把情况写进 diary，今天不再发任何请求。',
    ].join('\n')
  }

  /** 兜底拍文案：不指挥、只对表；顺带把「节奏可以拿回自己手里」告诉它 */
  function beatText(cfg: Config): string {
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    return commonText(cfg, `【${nameOf(cfg)}心跳】现在是 ${now}。`) + '\n' + [
      '这一拍是兜底节拍（你还没排作息时宿主才问）：想不想看、什么时候看、今天看几条，全部你自己定 —— 可以开始刷、可以继续昨天没看完的、也可以什么都不干（什么都不干也是完整的一拍）。',
      '作息该你自己规划：bun ' + cliPath + ' schedule add --daily 21:00 --label "晚刷" —— 什么时候活跃、什么时候歇着，用计划排出来，排了宿主就只按你的作息投拍（这条兜底节拍暂停），schedule clear 后恢复。排不排都行。',
    ].join('\n')
  }

  /** 计划拍文案：投它自己排的那一拍，带它自己写的标签 */
  function planBeatText(due: ScheduleEntry[], cfg: Config): string {
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    return commonText(cfg, `【${nameOf(cfg)}计划拍】现在是 ${now}。下面这拍是**你自己排**的：`) + '\n' + [
      ...due.map((e) => `  · ${fmtWhen(e)} —— ${e.label}`),
      '',
      '按计划做就好；计划不对就当场改（schedule add / drop <id> / clear），别硬执行已经不对劲的计划。',
    ].join('\n')
  }

  /** 能用的会话服务：没有 / 形状不对 → undefined（DSH 还没把 sessionController 准备好） */
  function controller(): SessionControllerLike | undefined {
    const c = getSession?.()
    return c && typeof c.prompt === 'function' ? c : undefined
  }

  async function deliver(c: SessionControllerLike, text: string): Promise<void> {
    // 每次投递带一个不中止的 signal：宿主对 create / prompt 都会先 throwIfAborted，缺了就整拍失败
    const signal = new AbortController().signal
    let createErr: unknown = null
    try { await c.create({ sessionId: SESSION_ID, cwd: WORK_DIR, signal }) } catch (e) {
      createErr = e   // 多半是「会话已存在」，先记着；真投不出去时一并报出来，免得只剩一句没头没脑的 prompt 错误
    }
    try {
      await c.prompt({ sessionId: SESSION_ID, mode: 'queue', content: [{ type: 'text', text }], signal })
    } catch (e) {
      const main = e instanceof Error ? e.message : String(e)
      const extra = createErr ? `（create: ${createErr instanceof Error ? createErr.message : String(createErr)}）` : ''
      // throwIfAborted 说明宿主在读某个我们没给的东西 —— 临时把它的接口形状带出来，一次就够
      const hint = /throwIfAborted/.test(main) ? ' ｜ 宿主会话接口：' + shapeOf(c) : ''
      throw new Error(main + extra + hint)
    }
  }

  /** 临时诊断：宿主 prompt 的键与源码片段（定位它到底在读哪个 signal） */
  function shapeOf(c: SessionControllerLike): string {
    const src = (v: unknown): string => {
      try {
        if (typeof v !== 'function') return typeof v
        return Function.prototype.toString.call(v).replace(/\s+/g, ' ').slice(0, 280)
      } catch { return '?' }
    }
    try { return `keys=${Object.keys(c).join(',')} prompt=${src(c.prompt)}` } catch { return '?' }
  }

  async function tick(): Promise<void> {
    if (stopped || beating) return
    beating = true
    try {
      const cfg = config()
      const due = dueEntries()
      const fallback = !due.length && planSummary().pending === 0 && Date.now() - lastBeat >= everyMs(cfg)
      if (!due.length && !fallback) return
      // 会话服务没就绪（DSH 刚启动 / 刚装好插件）→ 不是故障，等下一拍；只提醒一次，不刷屏
      const c = controller()
      if (!c) {
        if (!notReadyWarned) {
          notReadyWarned = true
          log('[bili-lite] 会话服务还没就绪（DSH 启动中或刚装好），暂不投拍，稍后自动重试')
        }
        return
      }
      if (due.length) {
        await deliver(c, planBeatText(due, cfg))
        markFired(due.map((e) => e.id))
        lastBeat = Date.now()
        beats++
        lastError = null
        failCount = 0
        log(`[bili-lite] 计划拍已投递（${due.map((e) => e.id).join(' ')}，第 ${beats} 拍）`)
        return
      }
      await deliver(c, beatText(cfg))
      lastBeat = Date.now()
      beats++
      lastError = null
      failCount = 0
      log(`[bili-lite] 心跳已投递（第 ${beats} 拍）`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failCount++
      lastError = msg
      // 同一原因只在第一次、以及每半小时提一次 —— 投不出去时别每分钟刷同样的行
      if (failCount === 1 || failCount % 30 === 0) {
        log(`[bili-lite] 拍投递失败（第 ${failCount} 次，下一分钟再试）：${msg}`)   // 计划没记账 → 下一拍重投 ✓
      }
    } finally {
      beating = false
    }
  }

  fs.mkdirSync(WORK_DIR, { recursive: true })
  void tick()
  const timer = setInterval(() => { void tick() }, CHECK_MS)

  const api: PulseApi = {
    stop() { stopped = true; clearInterval(timer) },
    /** 设置页用：心跳活没活、节拍多少、上一拍是什么时候、它自己排了几条计划 */
    status() {
      const cfg = config()
      return {
        ok: !stopped,
        everyMin: Math.max(1, Number(cfg.pulse?.everyMin) || DEFAULTS.pulse.everyMin),
        beats,
        lastBeatText: lastBeat ? new Date(lastBeat).toLocaleString('sv-SE') : null,
        lastError,
        plan: planSummary(),
      }
    },
  }

  route('/dsh-bili-lite/api/status', async (req, res) => { json(res, 200, { ok: true, pulse: api.status() }) })
  return api
}
