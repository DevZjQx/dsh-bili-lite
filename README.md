# dsh-bili-lite 0.2.0

> Bun + TypeScript：源码全是 `.ts`，Bun 直接跑 CLI，宿主半边编译成 `dist/` 的普通 ESM（DSH 用 Node 加载，无感）。
>
> 极简版「让 AI 自己运营 B 站」：给 DSH 装一个 B 站分身 —— 它**自己规划作息**：什么时候刷、
> 看什么、看不看，全部它自己定；刷候选、真看懂（章节 + 字幕 + 弹幕热词 + 热评）、
> 写日记；值得的发一条评论，真喜欢就点个赞 / 关注 UP；有人 @ 它 / 回它，它自己决定回不回。
>
> **单账号模型**：AI 与主人**共用一个号** —— 它发的每条评论、每个赞都以你的身份出现，
> 你自己都看得到，不需要、也不会去 @ 谁。
>
> 参考 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 的理念
> （自主节律 + 自己的口味 + 克制），砍到最小可用：**3 个运行面**（宿主插件 / 设置页 / agent CLI），
> 没有私信/弹幕/动态 —— 只保留「自己过日子」的那条主线（想看图，一条命令抽张九宫格，可选）。

## 它每天干什么

- **自己定**：没排计划时，宿主每 `pulse.everyMin` 分钟（默认 60）问一拍「现在想干嘛」当兑底；它也可以用 `bun bili.ts schedule add --daily "HH:MM" --label "…"` **自己排作息和定时任务** —— 计划非空时宿主只按它的计划投拍（兑底暂停），`schedule clear` 恢复。看不看、什么时候看、排不排，全它自己定（包括什么都不干）
- **计划会过期**：`--daily` / `--every` 默认只活 14 天（`--for 7d` 自己定，1–365 天），到期不自动续 —— 宿主投一拍「这条你 X 天前排的、投了 N 次，还这么过吗」，续 / 改 / 不管都行；不管就撤掉、回到兜底节拍。每拍还会带上「第 N 次 · 排于 X 天前」，让「一直在重复」这件事自己看得见：便条不是命令，照旧、换个过法、什么都不做都算完整的一拍
- **自己挑**：喜欢 / 讨厌什么全由它自己判断（没有口味配置）—— `feed --kw "此刻想搜的词"` 自己搜；
  不给就先端关注的人最近发了什么（关注动态），不够再热门补，只排除看过的；想不起最近爱看什么就跑 `taste` 回顾自己的观看史；
  喜欢上谁就跑 `up <mid|名字>` 把 TA 的投稿翻一遍（只读，可翻页）
- **真看懂**：概览章节/字幕试读/弹幕热词/热评；字幕想读多深自己 `--read`（读不设限、不截断 —— 克制只管写，不管读）；字幕说不清的画面，`shots` 先 3×3 扫一遍、再用 `--at` / `--range` 定位（格号 + 时间码烧在格子上；要 ffmpeg，可选）
- **写日记**：它自己写 —— 用什么方式、写在哪个文件、按天还是按主题分篇、格式怎么写，全它自己定
- **互动**：真喜欢就点赞 / 关注 UP（每天 ≤ `quota.interactDaily`（默认 **10**）次，同一视频 7 天内同一种互动只做一次）
- **分享**：最多挑 1 条，发一条普通评论（共用账号，不需要 @ 谁；发之前先翻一眼自己写的日记 / 笔记，别重复、也别跟记下的打架；先 `--dry` 看一眼再 `--go`）
- **有人找它**：`inbox` 拉一次收件箱（谁 @ 了它 / 谁回了它，只读），它自己判断回不回 ——
  值得回就用 `comment <BV> --reply <rpid>` 回到那条评论下面（跟评论共用同一个每日额度，同一条评论 7 天只回一次）
- **克制**：撞到风控（412 / 验证码 / 限流）**立刻熔断停手**

## 它不会做什么（写死在代码里）

- ❌ 私信 / 群发 / 花钱（充电）/ 弹幕 / 动态
- ❌ 每天评论 + 回复超过 `quota.writeDaily`（默认 **10**）条、互动超过 `quota.interactDaily`（默认 **10**）次
- ❌ 同一视频 7 天内评第二次 / 同一条评论 7 天内回第二次 / 同一种互动做第二次（取消赞、取关是在纠正，不占额度也不判重；取消后可以再做，判重看最后一条记录）
- ❌ 用 @ 招呼陌生人（评论正文里带 @ 直接拒绝 ✓ 共用账号更不该拉山头）
- ❌ 不带 `--dry` / `--go` 的写命令（拒绝裸跑）
- ❌ 凭据回显（cookie 只写 `~/.dsh/bili-lite-work/credentials.json`，文件 0600、目录 0700；日志 / 终端出口统一脱敏，设置页只回不可逆指纹）
- ❌ 撞 412/风控码硬闯（自动熔断 5/10/20/30 分钟退避）
- ❌ 计划无限堆 / 无限走（在排最多 30 条；`--every` 最短 5 分钟；`--daily` / `--every` 保质期最长 365 天，默认 14 天，到期必须它自己再表一次态）

## 装

**前提**：**Bun ≥ 1.2**（CLI 由它直接跑 TypeScript；找不到时会退到 Node 18+，`$BUN` / `$DSH_NODE` 都能指定）。
宿主那一半是 TypeScript 编译出来的 `dist/`（普通 ESM）—— DSH 照旧用 Node 加载，不需要它认识 TS。
抽帧另需 **ffmpeg**（可选，见下文；不装只是少画面那一路）。

```bash
# 0) 装依赖（dist 随仓库提交，装的时候不编译；改过源码才需要 bun run build）
bun install

# 1) 装插件（GitHub / npm / 本地目录都行）
dsh plugin --profile desktop add github:DevZjQx/dsh-bili-lite
# 本地目录：
# dsh plugin --profile desktop add "link:/path/to/dsh-bili-lite"

# 2) 重启一次 DSH（bundle 层要重启才组装）

# 3) 打开「设置 → B站养鱼」（不是浏览器里直接开 API —— 那个被信任栅栏挡着 ✗）
```

设置页里两件事：

1. **登录** —— 点「显示二维码」，手机 B 站 App 扫一扫确认即可（凭据自动验证并写入）。
   手机不在手边时手动粘 cookie 兑底：在 `bilibili.com` 按 **F12 → Application → Cookies → bilibili.com**，
   手动复制 `SESSDATA`、`bili_jct`、`buvid3` / `buvid4`（后两个可空，但有的话写操作更稳）粘进设置页，点「写入凭据」。
   ⚠️ 别用 `document.cookie` ✗ —— `SESSDATA` 是 **HttpOnly**，脚本里读不到。
2. **点「启动自检」** —— 它会真的请求一次 B 站验证登录态。

> ⚠️ 输入框是先改在本地、点「保存」才落盘 —— 不点保存 = 什么都没发生 ✗
> 改心跳间隔保存后立刻生效（心跳每拍重新读配置，无需重启）✓

## 共用账号意味着什么（先读这个）

这个插件是**单账号模型**：AI 和你用同一个 B 站号，它发的每一条评论都以你的身份公开出现 ——
不 @ 谁，也没有第二个号。三点建议：

- 它的评论、点赞、关注都记在**你的号**上，说错话是你在承担：把「每天最多写几条 / 互动几次」设小一点
  （评论默认 10、互动默认 10；想更稳就调小；设 0 = 只看、只写日记、不发言）
- 它不会用 @ 去招呼陌生人（工具里写死：评论正文带 @ 直接拒绝）✓
- 有人 @ 它 / 回它时，它跑 `inbox` 看一眼再自己判断回不回 —— 回一条也署你的名、也占当天评论额度，
  同一条评论 7 天内只回一次；不想让它跟人搭话就把每日额度调小（0 = 只看不发言）
- 它每天写在哪：它自己的会话工作目录里 —— 位置、文件名、分篇方式它自己定，插件不规定；那是它干了什么的入口，也是它的心里话

## 权限（不用开完全访问）

它的所有落盘（cookie / 账本 / 计划 / 缓存 / 日记 / 人设 / shots）都在它自己的会话工作目录
`~/.dsh/bili-lite-work/` —— 也就是会话 cwd，正好是 `workspace-write` 的可写根。
所以权限保持「工作区读写」即可：既不需要 `danger-full-access`，也不需要额外配置
`additionalWritableRoots`。

> ⚠️ cookie 现在也在这个工作区里（`credentials.json`，0600）—— 它是它的私有目录，
> 别提交到 git、别打包分享。

## 启动测试（装完立刻跑）

```bash
bun <插件目录>/src/features/bili-agent/bili.ts selftest
```

最后两行是新手最常卡的地方：

| 症状 | 真正原因 |
|---|---|
| 「装完了，但找不到它」 | 它的会话在**工作区 → 未分组**里，不点开看不见 ✗ |
| 「找到了，但什么都不干」 | 权限被设成「只读」✗ 切成「工作区读写 / workspace-write」即可 ✓（不用完全访问） |
| 「cookie 填了还是未登录」 | 用了 `document.cookie` ✗ 必须 F12 手动复制 ✓（或者干脆 `bun bili.ts login` 扫码 ✓） |
| 「心跳一直 0 拍」 | DSH 没有可用的模型 / API 凭证 —— 先在 Models 页配好 key；插件不会投注定失败的拍 ✓ |

想立刻看它跑一轮：把心跳间隔改成 5 分钟 → 保存 → 等下一拍（最多 5 分钟）✓

## 它用什么（人也可以手动用的）

心跳文案里注入的是本工具的**绝对路径**；下面的相对路径以插件目录为基准：

```
bun src/features/bili-agent/bili.ts login         # 扫码登录（免手抄 cookie）
bun src/features/bili-agent/bili.ts selftest       # 启动自检
bun src/features/bili-agent/bili.ts whoami         # cookie 是哪个号
bun src/features/bili-agent/bili.ts feed [--n 5] [--kw 词,词]   # 今天的候选：关注动态 → 搜索 → 热门（只读）
bun src/features/bili-agent/bili.ts up <mid|名字|空间链接> [--n 20] [--page 1] [--order pubdate|click|stow]
                                                     # 某位 UP 的投稿列表（只读，可翻页 / 换排序）
bun src/features/bili-agent/bili.ts following [--n 50] [--page 1]
                                                     # 我关注了谁：名单 + mid + 关注时间（只读）
bun src/features/bili-agent/bili.ts video <BV>     # 看懂一条：章节/字幕试读/弹幕热词/热评（只读）
bun src/features/bili-agent/bili.ts video <BV> --read 全文     # 深读字幕全文（--read 03:00-08:30 看某一段）
bun src/features/bili-agent/bili.ts shots <BV>     # 抽帧看画面（3×3；--at / --range 定位，要 ffmpeg）
bun src/features/bili-agent/bili.ts comment <BV> --message "…" --dry|--go
bun src/features/bili-agent/bili.ts comment <BV> --message "…" --reply <rpid> [--root <根rpid>] --dry|--go
                                                     # 回到某条评论下面（rpid 从 inbox 给的那行抄）
bun src/features/bili-agent/bili.ts inbox [--n 5] [--all]   # 收件箱：谁 @ 了你 / 谁回了你（只读）
bun src/features/bili-agent/bili.ts interact <BV|UID> --like|--follow [--undo] --dry|--go
                                                     # 点赞 / 关注（一次一件；--undo 取消赞、取关）
bun src/features/bili-agent/bili.ts ledger         # 今天的额度账本
bun src/features/bili-agent/bili.ts taste [--days 30]  # 口味回顾：看过的 / 常看的 UP / 动过手的（只读）
```

## 抽帧看画面（可选，要 ffmpeg）

字幕/弹幕/热评都说不到「画面上是什么」时，让它自己看一眼：

```bash
bun src/features/bili-agent/bili.ts shots <BV>                              # 3×3 等间隔 9 帧
bun src/features/bili-agent/bili.ts shots <BV> --grid 4x4 --p 2             # 更细 / 换一 P
bun src/features/bili-agent/bili.ts shots <BV> --at 03:20,05:10             # 只抽这两个时刻
bun src/features/bili-agent/bili.ts shots <BV> --range 02:10-02:35 --fps 2 --diff  # 区间密抽，只留变化帧
bun src/features/bili-agent/bili.ts shots <BV> --range 02:50-03:10 --fps 2 --diff --diff-ignore-bottom 0.15
                                                     # 口播 / 白板：字幕在变不算画面变
bun src/features/bili-agent/bili.ts shots <BV> --crop 0.62,0.06,0.36,0.30 --grid 2x2  # 裁一块看卡片 / 角落
```

输出落在 `~/.dsh/bili-lite-work/shots/`，把路径交给看图工具读一眼即可。

- **格号 + 时间码烧在每格顶部的黑边上**（如 `3 12:30`）：不压画面（裁切之后左上角常是正文）；
  图离开终端也能对上字幕；同一秒里有多帧时带十分之一秒（`00:12.3`）。
- **先扫后定位**：3×3 看结构，`--at` / `--range` 看具体那一段；`--diff` 只留画面真的变过的帧，
  帧数超过一张图的格数就多出几张图（按格数平均分、缺的格补黑），不硬塞。
- **`--diff` 对字幕不设防**：口播 / 白板类视频画面不动、字幕整行重绘，相邻帧 SSIM 约 0.98（阈值 0.985），
  会被当成「变了」。加 `--diff-ignore-bottom 0.15` 把底部字幕带排除 —— 同一对帧回到 1.00，真换一张卡片仍有 0.96。
- **不落整段视频**：ffmpeg 直接对播放直链按时间点 seek，抽完临时帧就删 —— 长视频也不占磁盘。
- **缓存与清理**：同一 BV / page / 参数 7 天内复用；`shots/` 只留最近 40 张（`--out` 指定的目录不参与清理）。
- **要 ffmpeg**（不装 npm 包、不随包分发）：`winget install ffmpeg` / `brew install ffmpeg` / `apt install ffmpeg`，
  或用环境变量 `FFMPEG=/绝对路径/ffmpeg` 指，或把它放到 `~/.dsh/bili-lite-work/bin/ffmpeg`；`selftest` 会显示装没装。
  画时间码的字体默认自动找（Windows/macOS/Linux 常见路径 + fontconfig），也可以用 `FFMPEG_FONT=/路径/字体` 指定；
  找不到字体就只抽图、不烧码，其余照常。
- **不装也不影响别的**：只有 `shots` 报错，`video` / `feed` / `comment` 照常。
- **画质跟登录态走**：匿名只有 360P，登录后一般 720P（多段老视频只抽第一段，会提示）。
- **边界**：静帧只能证明「这一秒长这样」，证明不了「在动 / 在说什么」；字幕是平台转写（UP 配 / AI），不是原声。
  想要声音、画面、原文三路独立证据，需要宿主另有 ASR —— lite 不假装有。

## 人设（可选）

插件不内置任何人格，也不内置名字。想让它是谁，写一段放到 `~/.dsh/bili-lite-work/persona.md`：
每次心跳时取**前 3000 字**附在最前面（清空文件 = 撤销）。它叫什么写在配置里（`persona.name`，
设置页「人设」一栏）—— 只用于心跳抬头（`【<名字>心跳】`），留空就不点名（日记它自己写，插件不规定写法）。

建议顺序：
`# 我是谁` → `# 说话` → `# 我在意什么` → `# 我绝不会` → `# 日记怎么写 / 分享的标准`。

## 文件都在哪

全部在它的会话工作目录 `~/.dsh/bili-lite-work/` 里（= 会话 cwd = `workspace-write` 的可写根）：

| 文件 | 作用 |
|---|---|
| `~/.dsh/bili-lite-work/bili-lite.config.json` | 配置（**不含凭据**），设置页和工具链共用同一份 |
| `~/.dsh/bili-lite-work/credentials.json` | cookie（0600，目录 0700，永不回显；设置页只显示 sha256 前 8 位指纹） |
| `~/.dsh/bili-lite-work/ledger.json` | 写额度 / 判重账本（comment / reply / interact / watch 都记） |
| `~/.dsh/bili-lite-work/inbox.json` | 收件箱水位：哪些 @ / 回复已经看过、翻到哪儿了（只影响「哪条算新」） |
| `~/.dsh/bili-lite-work/api-cache.json` `api-ban.json` | 元信息缓存 / 风控熔断状态 |
| `~/.dsh/bili-lite-work/persona.md` | 人设（可选） |
| `~/.dsh/bili-lite-work/shots/` | 抽帧拼图（`shots` 的落点；7 天缓存，自动只留最近 40 张） |
| `~/.dsh/bili-lite-work/` 下的日记 | 它自己写的（文件名 / 位置 / 分篇 / 格式全由它定，插件不规定） |

## 开发（Bun + TypeScript）

- 源码全是 `.ts`（`src/` 与 `scripts/`），仓库里**没有 JS 源文件**；跑和装都走 Bun（`bun.lock` 锁版本）。
- 宿主半边要编译：`bun run build` → `dist/`（tsc 1:1 产出，`main` / `exports` 都指向 dist）。**dist 随仓库提交** —— 这样 `dsh plugin add github:…` 不会触发安装时构建（pnpm v11 默认禁止 git 依赖跑构建脚本，会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）；改完源码必须重新构建并把 dist 一起提交。构建最后一步 `scripts/postbuild.ts`
  会去掉浏览器半边 `client.js` 里 tsc 自动补的 `export {}`：那个文件由 DSH 的 `__ModuleLoader__` 当普通脚本加载，不是 ES 模块。
- CLI 不必编译也能跑：`bun src/features/bili-agent/bili.ts selftest`（Bun 直接吃 TS）；插件 spawn 的是 dist 里的那份。
- 常用：`bun run typecheck`（tsc --noEmit）· `bun run check`（类型 + 构建 + 结构）· `bun run cli`（等于跑 CLI）。

## 项目结构（防弹边界）

三个运行面，一个方向：**共享（config, lib）→ features → app**，不可逆。每个 feature 只有一个公共入口，删除任何一个 feature 只会破坏 `src/app` 的组合点。

```
src/
├── app/plugin.ts                # 应用层：插件装配、信任柵栏、路由门（唯一组合点）
├── config/                      # 共享：路径常量 + 配置默认值（唯一真相）
│   ├── paths.ts
│   └── store.ts
├── lib/                         # 共享：B 站 HTTP 客户端（节流/焸断/WBI/扫码登录）+ 二维码编码器 + 小工具
│   ├── bilibili.ts
│   ├── qrcode.ts
│   ├── ffmpeg.ts                # 抽帧的可选依赖：定位/调用/体检（没装就只 shots 用不了）
│   ├── json-file.ts
│   ├── http.ts
│   └── dsh.ts                   # DSH 宿主契约（纯类型，编译后是空模块）
└── features/
    ├── settings/                # 设置壳：宿主 API + 浏览器 section（docs/features/settings.md）
    ├── bili-pulse/              # 心跳：照它排的作息投拍，没排作息时兜底问一拍（docs/features/bili-pulse.md）
    ├── bili-agent/              # 数据面 ops + agent CLI：看/评/账本（docs/features/bili-agent.md）
    └── bili-tools/              # 模型可调用的 bili_* 工具：schema + 人话（docs/features/bili-tools.md）
```

- 每个 feature 一个入口：`feature.ts`（CLI 按框架约定是 `bili.ts`）；`settings/client.ts` 是单文件加载的浏览器半边（零 import）。
- 跨 feature 不直接 import：心跳每拍重新读配置 —— 没有需要注入的回调 ✓。
- `bun run check` = 类型检查 + 构建 + 结构检查（方向不可逆、无 barrel、浏览器半边零 import）。feature 的边界决策见 `docs/features/*.md`。

## 和 dsh-bili-whale 的关系

同一理念的最小实现，规模对照：

| | whale | lite |
|---|---|---|
| 代码文件 | ~50 个 | ~17 个（3 个运行面） |
| 看 | 字幕+弹幕+热评+抽帧九宫格 | 字幕+弹幕+热评+抽帧（整条九宫格 / 指定时刻 / 区间去重；要 ffmpeg，可选） |
| 写 | 评论/私信/弹幕/动态/收藏/三连 | 评论 + 回复（限额 + 判重）+ 点赞/关注 |
| 登录 | 扫码 + 手动 cookie | 扫码 + 手动 cookie（同一份二维码编码器，终端出图形、设置页出 SVG） |
| 监听 | 评论/私信/直播间轮询 | 无后台监听 —— 靠 `inbox` 拉一次收件箱（谁 @ / 谁回），跑一次看一次 |
| 限额/熔断/判重 | ✓ | ✓（同样写死） |

想升级再看 whale：`dsh plugin --profile desktop add dsh-bili-whale`。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-bili-lite
rm -rf ~/.dsh/bili-lite-work
```

## License

MIT
