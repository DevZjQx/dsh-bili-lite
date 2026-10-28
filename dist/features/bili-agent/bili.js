#!/usr/bin/env bun
// ============================================================================
// dsh-bili-lite · agent 的手和眼 —— CLI 公共入口
//
//   bun bili.ts selftest              启动自检（装完先跑）
//   bun bili.ts login                 扫码登录（手机 B 站 App 扫码，免手抄 cookie）
//   bun bili.ts whoami                我是谁（cookie 属于哪个号）
//   bun bili.ts feed [--n 5] [--kw 词,词]
//                                       今天的候选（只读，排除看过的；搜什么自己定，不给就热门）
//   bun bili.ts video <BV> [--read 全文|mm:ss-mm:ss]
//                                       看懂一条：概览（章节/字幕试读/弹幕热词/热评）；
//                                       --read 深读字幕，不截断（只读）
//   bun bili.ts shots <BV> [--grid 3x3] [--p 1] [--out 目录]
//                                       抽帧九宫格：等间隔抽 N 帧拼一张图（要 ffmpeg，可选）
//   bun bili.ts comment <BV> --message "…" [--reply <rpid> [--root <根rpid>]] --dry|--go
//                                       发一条评论；--reply 回到某条评论下面
//   bun bili.ts inbox [--n 5] [--all] 收件箱：谁 @ 了你 / 谁回了你（只读）
//   bun bili.ts interact <BV|UID> --like | --follow [--undo] [--dry|--go]
//                                       点赞 / 关注（一次一件；同样先 --dry 再 --go）
//   bun bili.ts diary <text…>         写日记 / diary show 看最近
//   bun bili.ts ledger                今天的额度账本
//   bun bili.ts taste [--days 30]     口味回顾：看过的 / 常看的 UP / 动过手的（只读，自己判断）
//   bun bili.ts schedule …            自己排作息 / 定时任务（add / list / drop / clear）
//
// 安全约定（写死在代码里，不靠自觉）：
//   · 写操作必须显式 --dry（只打印）或 --go（真的发），拒绝裸跑
//   · 每天评论 ≤ quota.writeDaily（默认 3）、互动 ≤ quota.interactDaily（默认 10）；
//     同一视频 7 天内同一种评论/互动只做一次（取消赞 / 取关不占额度）
//   · 两次请求至少隔 risk.minGapMs（默认 1200ms）；撞 412/风控码 → 熔断退避（lib/bilibili.ts）
//   · 凭据只从 ~/.dsh/bili-lite-work/credentials.json 读，永远不回显
//
// 【结构例外（SKILL §10）】入口文件按 CLI 的框架约定叫 bili.ts 而非 feature.ts：
// 它是本 feature 唯一入口 —— 命令实现在 commands.ts、账本在 ledger.ts、
// B 站 HTTP 在 lib/bilibili.ts。宿主只引用这个路径（spawn 自检、心跳文案点名），
// 从不 import 它的代码。跑法：bun 直接吃 TypeScript，不需要先编译 ✓
// ============================================================================
import { pathToFileURL } from 'node:url';
import { migrateLegacy } from '../../config/migrate.js';
import { cmdSelftest, cmdWhoami, cmdLogin, cmdFeed, cmdVideo, cmdShots, cmdComment, cmdInbox, cmdInteract, cmdDiary, cmdLedger, cmdTaste, cmdSchedule, HELP } from './commands.js';
/** 极简参数解析：--k v / --k（值为 true）/ 其余算位置参数 */
function parseArgs(rest) {
    const flags = new Map();
    const positional = [];
    for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i];
        if (a.startsWith('--'))
            flags.set(a.slice(2), rest[i + 1]?.startsWith('--') ? true : rest[++i] ?? true);
        else
            positional.push(a);
    }
    return { flags, positional };
}
// ── main（只有直接运行时才执行；被 import 时只是库，没有副作用） ───────────
const [cmd, ...rest] = process.argv.slice(2);
const invokedDirectly = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
    const { flags, positional } = parseArgs(rest);
    try {
        migrateLegacy();
        if (cmd === 'selftest')
            await cmdSelftest(flags.has('json'));
        else if (cmd === 'login')
            await cmdLogin();
        else if (cmd === 'whoami')
            await cmdWhoami();
        else if (cmd === 'feed')
            await cmdFeed(flags);
        else if (cmd === 'video')
            await cmdVideo(flags, positional);
        else if (cmd === 'shots')
            await cmdShots(flags, positional);
        else if (cmd === 'comment')
            await cmdComment(flags, positional);
        else if (cmd === 'inbox')
            await cmdInbox(flags);
        else if (cmd === 'interact')
            await cmdInteract(flags, positional);
        else if (cmd === 'diary')
            await cmdDiary(positional);
        else if (cmd === 'ledger')
            await cmdLedger();
        else if (cmd === 'taste')
            cmdTaste(flags);
        else if (cmd === 'schedule')
            cmdSchedule(positional, flags);
        else {
            console.log(HELP);
            process.exit(cmd ? 2 : 0);
        }
    }
    catch (e) {
        console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    }
}
