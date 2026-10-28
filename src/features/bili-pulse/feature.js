/**
 * dsh-bili-lite · bili-pulse —— 心跳（照它自己规划的作息投拍的那一半）—— 本 feature 的公共入口
 *
 * 「什么时候看」的决定权还是全在它手里，现在有两个来源，都攥在它自己手中：
 *   · 计划拍：它用 `node bili.mjs schedule …` 自己排的作息 / 定时任务（lib/schedule 是唯一
 *     真相），到点宿主照着投、拍里带上它自己写的标签 —— 宿主只是闹钟：不排、不改、不掷骰子。
 *     计划非空时兜底节拍暂停（它的计划替代默认节奏），clear 后恢复。
 *   · 兜底节拍：它什么都没排时，宿主每 pulse.everyMin（默认 60）分钟投一拍中性的
 *     「现在想干嘛」—— 看不看、什么时候看、今天看几条，全部它自己定，这一拍也可以什么都不干。
 * 重启 DSH 后一分钟内来第一拍（lastBeat 从 0 起算）；错过的计划拍照投（补上，并说一声）。
 *
 * 不拥有：拿到拍之后的行为（那是 agent 拿着 bili.mjs 干的）；额度的执行（bili-agent）；
 * 计划的读写与到期判断（lib/schedule，两侧共用）；配置的校验与保存（settings）。
 * 依赖由 app 注入：getSession（→ sessionController）、route、cliPath。
 */
import fs from 'node:fs'
import { json } from '../../lib/http.js'
import { config, DEFAULTS } from '../../config/store.js'
import { PERSONA_FILE, WORK_DIR } from '../../config/paths.js'
import { dueEntries, markFired, planSummary, fmtWhen } from '../../lib/schedule.js'

/** 她的专用会话：sessionId 固定 → 跨天保留上下文，而不是每天忘光 */
const SESSION_ID = 'bili-lite'
const CHECK_MS = 60_000   // 每分钟看一次「到拍没」；兜底节拍的粒度由 pulse.everyMin 定

export function startPulse({ getSession, route, cliPath, log = (m) => { try { console.log(m) } catch {} } }) {
  let stopped = false
  let beating = false
  let lastBeat = 0   // 0 = 还没拍过（启动后第一拍马上来）—— 兜底节拍的表；计划拍不受它管
  let beats = 0

  const everyMs = (cfg) => Math.max(1, Number(cfg.pulse?.everyMin) || DEFAULTS.pulse.everyMin) * 60_000

  /** 人设前缀 + 工具与克制的提醒 —— 两种拍共用；宿主只对表，不指挥 */
  function commonText(cfg, titleLine) {
    let persona = ''
    try { persona = fs.readFileSync(PERSONA_FILE, 'utf8').slice(0, 3000).trim() } catch {}
    const head = persona ? persona + '\n\n' : ''
    return head + [titleLine, '',
      '你在 DSH 里替主人运营这个 B 站账号 —— 你和他**共用一个身份**：你发的每条评论都是以主人的名义公开出现，他自己都看得到，不需要也不要 @ 任何人。唯一的工具：',
      `  node ${cliPath} <子命令>`,
      '常用（别跳步）：selftest（有 ✗ 先照提示修）→ feed（从候选里挑想看的）→ video <BV>（章节/字幕/弹幕热词/热评都过一眼，好奇就 --read 深读，读不要钱、不截断；讲的是画面/界面而字幕说不清，就 shots <BV> 抽一张九宫格看一眼）→ diary（给自己写一段）→ 最多挑 1 条值得发的 comment <BV>（先 --dry 再 --go）。',
      '',
      '克制（一半写死在工具里，一半在你心里）：',
      `  · 今天写额度 ≤${Math.max(0, Number(cfg.quota?.writeDaily ?? DEFAULTS.quota.writeDaily))} 条；同一视频 7 天只评一次；拿不准先跑 ledger 对账；`,
      '  · 你和主人共用身份 —— 每条评论都署他的名，说错话由他承担；',
      '  · 不值得就不发 —— 不发也是完整的一天；',
      '  · 撞到验证码 / 风控：立刻停手，把情况写进 diary，今天不再发任何请求。',
    ].join('\n')
  }

  /** 兜底拍文案：不指挥、只对表；顺带把「节奏可以拿回自己手里」告诉它 */
  function beatText(cfg) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    return commonText(cfg, `【小鱼心跳】现在是 ${now}。`) + '\n' + [
      '这一拍是兜底节拍（你还没排作息时宿主才问）：想不想看、什么时候看、今天看几条，全部你自己定 —— 可以开始刷、可以继续昨天没看完的、也可以什么都不干（什么都不干也是完整的一拍）。',
      '作息该你自己规划：node ' + cliPath + ' schedule add --daily 21:00 --label "晚刷" —— 什么时候活跃、什么时候歇着，用计划排出来，排了宿主就只按你的作息投拍（这条兜底节拍暂停），schedule clear 后恢复。排不排都行。',
    ].join('\n')
  }

  /** 计划拍文案：投它自己排的那一拍，带它自己写的标签 */
  function planBeatText(due, cfg) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false })
    return commonText(cfg, `【小鱼计划拍】现在是 ${now}。下面这拍是**你自己排**的：`) + '\n' + [
      ...due.map((e) => `  · ${fmtWhen(e)} —— ${e.label}`),
      '',
      '按计划做就好；计划不对就当场改（schedule add / drop <id> / clear），别硬执行已经不对劲的计划。',
    ].join('\n')
  }

  async function deliver(text) {
    const controller = getSession?.()
    if (!controller || typeof controller.prompt !== 'function') throw new Error('sessionController 不可用')
    try { await controller.create({ sessionId: SESSION_ID, cwd: WORK_DIR }) } catch { /* 会话已存在 → 沿用 ✓ */ }
    await controller.prompt({ sessionId: SESSION_ID, mode: 'queue', content: [{ type: 'text', text }] })
  }

  async function tick() {
    if (stopped || beating) return
    beating = true
    try {
      const cfg = config()
      // ① 计划拍优先：到点的（含重启后补投的）照投，投完记账 —— 计划非空时兜底暂停
      const due = dueEntries()
      if (due.length) {
        await deliver(planBeatText(due, cfg))
        markFired(due.map((e) => e.id))
        lastBeat = Date.now()
        beats++
        log(`[bili-lite] 计划拍已投递（${due.map((e) => e.id).join(' ')}，第 ${beats} 拍）`)
        return
      }
      // ② 兜底节拍：只在它没排任何计划时走 —— 有计划就信它的计划
      if (planSummary().pending > 0) return
      if (Date.now() - lastBeat < everyMs(cfg)) return
      await deliver(beatText(cfg))
      lastBeat = Date.now()
      beats++
      log(`[bili-lite] 心跳已投递（第 ${beats} 拍）`)
    } catch (e) {
      log('[bili-lite] 拍投递失败，下一分钟再试：' + (e?.message ?? e))   // 计划没记账 → 下一拍重投 ✓
    } finally {
      beating = false
    }
  }

  fs.mkdirSync(WORK_DIR, { recursive: true })
  tick()
  const timer = setInterval(tick, CHECK_MS)

  const api = {
    stop() { stopped = true; clearInterval(timer) },
    /** 设置页用：心跳活没活、节拍多少、上一拍是什么时候、它自己排了几条计划 */
    status() {
      const cfg = config()
      return {
        ok: !stopped,
        everyMin: Math.max(1, Number(cfg.pulse?.everyMin) || DEFAULTS.pulse.everyMin),
        beats,
        lastBeatText: lastBeat ? new Date(lastBeat).toLocaleString('sv-SE') : null,
        plan: planSummary(),
      }
    },
  }

  route('/dsh-bili-lite/api/status', async (req, res) => json(res, 200, { ok: true, pulse: api.status() }))
  return api
}
