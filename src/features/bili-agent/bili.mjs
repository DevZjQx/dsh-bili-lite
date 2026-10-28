#!/usr/bin/env node
// ============================================================================
// dsh-bili-lite · agent 的手和眼 —— CLI 公共入口
//
//   node bili.mjs selftest              启动自检（装完先跑）
//   node bili.mjs login                 扫码登录（手机 B 站 App 扫码，免手抄 cookie）
//   node bili.mjs whoami                我是谁（cookie 属于哪个号）
//   node bili.mjs feed [--n 5]          今天的候选（只读，排除看过的/不爱看的）
//   node bili.mjs video <BV> [--read 全文|mm:ss-mm:ss]
//                                       看懂一条：概览（章节/字幕试读/弹幕热词/热评）；
//                                       --read 深读字幕，不截断（只读）
//   node bili.mjs comment <BV> --message "…" --dry|--go
//                                       发一条评论（唯一写操作；必须显式 --dry 或 --go）
//   node bili.mjs diary <text…>         写日记 / diary show 看最近
//   node bili.mjs ledger                今天的额度账本
//   node bili.mjs schedule …            自己排作息 / 定时任务（add / list / drop / clear）
//
// 安全约定（写死在代码里，不靠自觉）：
//   · 写操作必须显式 --dry（只打印）或 --go（真的发），拒绝裸跑
//   · 每天 write ≤ quota.writeDaily（默认 3）；同一视频 7 天只评一次
//   · 两次请求至少隔 risk.minGapMs（默认 1200ms）；撞 412/风控码 → 熔断退避（lib/bilibili.js）
//   · 凭据只从 ~/.bili-lite/credentials.json 读，永远不回显
//
// 【结构例外（SKILL §10）】入口文件按 CLI 的框架约定叫 bili.mjs 而非 feature.mjs：
// 它是本 feature 唯一入口 —— 命令实现在 commands.js、账本在 ledger.js、
// B 站 HTTP 在 lib/bilibili.js。宿主只引用这个路径（spawn 自检、心跳文案点名），
// 从不 import 它的代码。
// ============================================================================
import { pathToFileURL } from 'node:url'
import { cmdSelftest, cmdWhoami, cmdLogin, cmdFeed, cmdVideo, cmdComment, cmdDiary, cmdLedger, cmdSchedule, HELP } from './commands.js'

function parseArgs(rest) {
  const flags = new Map(), positional = []
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]
    if (a.startsWith('--')) flags.set(a.slice(2), rest[i + 1]?.startsWith('--') ? true : rest[++i] ?? true)
    else positional.push(a)
  }
  return { flags, positional }
}

// ── main（只有直接运行时才执行；被 import 时只是库，没有副作用） ───────────
const [cmd, ...rest] = process.argv.slice(2)
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  const { flags, positional } = parseArgs(rest)
  try {
    if (cmd === 'selftest') await cmdSelftest(flags.has('json'))
    else if (cmd === 'login') await cmdLogin()
    else if (cmd === 'whoami') await cmdWhoami()
    else if (cmd === 'feed') await cmdFeed(flags)
    else if (cmd === 'video') await cmdVideo(flags, positional)
    else if (cmd === 'comment') await cmdComment(flags, positional)
    else if (cmd === 'diary') await cmdDiary(positional)
    else if (cmd === 'ledger') await cmdLedger()
    else if (cmd === 'schedule') cmdSchedule(positional, flags)
    else { console.log(HELP); process.exit(cmd ? 2 : 0) }
  } catch (e) {
    console.error(`✗ ${e.message ?? e}`)
    process.exit(1)
  }
}
