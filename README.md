# dsh-bili-lite 0.1.0

> 极简版「让 AI 自己运营 B 站」：给 DSH 装一个 B 站分身 —— 它**自己规划作息**：什么时候刷、
> 看什么、看不看，全部它自己定；刷候选、真看懂（章节 + 字幕 + 弹幕热词 + 热评）、
> 写日记；值得的发一条评论，真喜欢就点个赞 / 投个币 / 关注 UP。
>
> **单账号模型**：AI 与主人**共用一个号** —— 它发的每条评论、每个赞都以你的身份出现，
> 你自己都看得到，不需要、也不会去 @ 谁。
>
> 参考 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 的理念
> （自主节律 + 自己的口味 + 克制），砍到最小可用：**3 个运行面**（宿主插件 / 设置页 / agent CLI），
> 没有私信/弹幕/动态 —— 只保留「自己过日子」的那条主线（想看图，一条命令抽张九宫格，可选）。

## 它每天干什么

- **自己定**：没排计划时，宿主每 `pulse.everyMin` 分钟（默认 60）问一拍「现在想干嘛」当兑底；它也可以用 `node bili.mjs schedule add --daily 21:00 --label "晚刷"` **自己排作息和定时任务** —— 计划非空时宿主只按它的计划投拍（兑底暂停），`schedule clear` 恢复。看不看、什么时候看、排不排，全它自己定（包括什么都不干）
- **自己挑**：喜欢 / 讨厌什么全由它自己判断（没有口味配置）—— `feed --kw "此刻想搜的词"` 自己搜，不给就热门里挑，只排除看过的；想不起最近爱看什么就跑 `taste` 回顾自己的观看史
- **真看懂**：概览章节/字幕试读/弹幕热词/热评；字幕想读多深自己 `--read`（读不设限、不截断 —— 克制只管写，不管读）；字幕说不清的画面，`shots` 抽 9 帧拼一张图看（要 ffmpeg，可选）
- **写日记**：`~/.dsh/bili-lite-diary.md`，一天几段
- **互动**：真喜欢就点赞 / 投 1–2 个币 / 关注 UP（每天 ≤ `quota.interactDaily`（默认 **10**）次，同一视频 7 天内同一种互动只做一次）
- **分享**：最多挑 1 条，发一条普通评论（共用账号，不需要 @ 谁；先 `--dry` 看一眼再 `--go`）
- **克制**：撞到风控（412 / 验证码 / 限流）**立刻熔断停手**

## 它不会做什么（写死在代码里）

- ❌ 私信 / 群发 / 花钱（充电）/ 弹幕 / 动态
- ❌ 每天评论超过 `quota.writeDaily`（默认 **3**）条、互动超过 `quota.interactDaily`（默认 **10**）次
- ❌ 同一视频 7 天内评第二次 / 同一种互动做第二次（取消赞、取关是在纠正，不占额度也不判重；取消后可以再做，判重看最后一条记录）
- ❌ 用 @ 招呼陌生人（评论正文里带 @ 直接拒绝 ✓ 共用账号更不该拉山头）
- ❌ 不带 `--dry` / `--go` 的写命令（拒绝裸跑）
- ❌ 凭据回显（cookie 只写 `~/.bili-lite/credentials.json`，权限 0600）
- ❌ 撞 412/风控码硬闯（自动熔断 5/10/20/30 分钟退避）
- ❌ 计划无限堆（在排最多 30 条；`--every` 最短 5 分钟）

## 装

**前提**：Node 18+（插件用系统 node 跑 `src/features/bili-agent/bili.mjs`；找不到时可设 `DSH_NODE` 指向真实 node）。
抽帧九宫格另需 **ffmpeg**（可选，见下文；不装只是少画面那一路）。

```bash
# 1) 装插件（本地目录 / npm 都行）
dsh plugin --profile desktop add "link:/path/to/dsh-bili-lite"

# 2) 重启一次 DSH（bundle 层要重启才组装）

# 3) 打开「设置 → B站养鱼」（不是浏览器里直接开 API —— 那个被信任栅栏挡着 ✗）
```

设置页里两件事：

1. **登录** —— 点「显示二维码」，手机 B 站 App 扫一扫确认即可（凭据自动验证并写入）。
   手机不在手边时手动粘 cookie 兑底：在 `bilibili.com` 按 **F12 → Application → Cookies → bilibili.com**，
   手动复制 `SESSDATA`、`bili_jct`、`buvid3`（可空）粘进设置页，点「写入凭据」。
   ⚠️ 别用 `document.cookie` ✗ —— `SESSDATA` 是 **HttpOnly**，脚本里读不到。
2. **点「启动自检」** —— 它会真的请求一次 B 站验证登录态。

> ⚠️ 输入框是先改在本地、点「保存」才落盘 —— 不点保存 = 什么都没发生 ✗
> 改心跳间隔保存后立刻生效（心跳每拍重新读配置，无需重启）✓

## 共用账号意味着什么（先读这个）

这个插件是**单账号模型**：AI 和你用同一个 B 站号，它发的每一条评论都以你的身份公开出现 ——
不 @ 谁，也没有第二个号。三点建议：

- 它的评论、点赞、投币、关注都记在**你的号**上，说错话是你在承担：把「每天最多写几条 / 互动几次」设小一点
  （评论默认 3、互动默认 10；想更稳就调小；设 0 = 只看、只写日记、不发言）
- 它不会用 @ 去招呼陌生人（工具里写死：评论正文带 @ 直接拒绝）✓
- 它每天写在哪：`~/.dsh/bili-lite-diary.md` —— 那是它干了什么的入口，也是它的心里话

## 启动测试（装完立刻跑）

```bash
node <插件目录>/src/features/bili-agent/bili.mjs selftest
```

最后两行是新手最常卡的地方：

| 症状 | 真正原因 |
|---|---|
| 「装完了，但找不到它」 | 它的会话在**工作区 → 未分组**里，不点开看不见 ✗ |
| 「找到了，但什么都不干」 | 新会话默认没有完全权限 ✗ 给它 `danger-full-access` ✓ |
| 「cookie 填了还是未登录」 | 用了 `document.cookie` ✗ 必须 F12 手动复制 ✓（或者干脆 `node bili.mjs login` 扫码 ✓） |

想立刻看它跑一轮：把心跳间隔改成 5 分钟 → 保存 → 等下一拍（最多 5 分钟）✓

## 它用什么（人也可以手动用的）

心跳文案里注入的是本工具的**绝对路径**；下面的相对路径以插件目录为基准：

```
node src/features/bili-agent/bili.mjs login         # 扫码登录（免手抄 cookie）
node src/features/bili-agent/bili.mjs selftest       # 启动自检
node src/features/bili-agent/bili.mjs whoami         # cookie 是哪个号
node src/features/bili-agent/bili.mjs feed [--n 5] [--kw 词,词]   # 今天的候选（只读；搜什么自己定）
node src/features/bili-agent/bili.mjs video <BV>     # 看懂一条：章节/字幕试读/弹幕热词/热评（只读）
node src/features/bili-agent/bili.mjs video <BV> --read 全文     # 深读字幕全文（--read 03:00-08:30 看某一段）
node src/features/bili-agent/bili.mjs shots <BV>     # 抽帧九宫格（3×3；--grid 4x4 更细，要 ffmpeg）
node src/features/bili-agent/bili.mjs comment <BV> --message "…" --dry|--go
node src/features/bili-agent/bili.mjs interact <BV|UID> --like|--coin [1|2]|--follow [--undo] --dry|--go
                                                     # 点赞 / 投币 / 关注（一次一件；--undo 取消赞、取关）
node src/features/bili-agent/bili.mjs diary <text…>  # 写日记 / diary show 看
node src/features/bili-agent/bili.mjs ledger         # 今天的额度账本
node src/features/bili-agent/bili.mjs taste [--days 30]  # 口味回顾：看过的 / 常看的 UP / 动过手的（只读）
```

## 抽帧九宫格（可选，要 ffmpeg）

字幕/弹幕/热评都说不到「画面上是什么」时，让它自己看一眼：

```bash
node src/features/bili-agent/bili.mjs shots <BV>                     # 3×3 等间隔 9 帧，拼一张图
node src/features/bili-agent/bili.mjs shots <BV> --grid 4x4 --p 2    # 更细 / 换一 P
```

输出落在 `~/.bili-lite/shots/<BV>-<时间>-3x3.jpg`，把路径交给看图工具读一眼即可。

- **要 ffmpeg**（不装 npm 包、不随包分发）：`winget install ffmpeg` / `brew install ffmpeg` / `apt install ffmpeg`，
  或用环境变量 `FFMPEG=/绝对路径/ffmpeg` 指，或把它放到 `~/.bili-lite/bin/ffmpeg`；`selftest` 会显示装没装。
- **不装也不影响别的**：只有 `shots` 报错，`video` / `feed` / `comment` 照常。
- **不落整段视频**：ffmpeg 直接对播放直链按时间点 seek，抽完临时帧就删 —— 长视频也不占磁盘。
- **画质跟登录态走**：匿名只有 360P，登录后一般 720P（多段老视频只抽第一段，会提示）。

## 人设（可选）

插件不内置任何人格，也不内置名字。想让它是谁，写一段放到 `~/.bili-lite/persona.md`：
每次心跳时取**前 3000 字**附在最前面（清空文件 = 撤销）。它叫什么写在配置里（`persona.name`，
设置页「人设」一栏）—— 只用于心跳抬头（`【<名字>心跳】`）和日记抬头，留空就不点名。

建议顺序：
`# 我是谁` → `# 说话` → `# 我在意什么` → `# 我绝不会` → `# 日记怎么写 / 分享的标准`。

## 文件都在哪

| 文件 | 作用 |
|---|---|
| `~/.dsh/bili-lite.config.json` | 配置（**不含凭据**），设置页和工具链共用同一份 |
| `~/.bili-lite/credentials.json` | cookie（0600，永不回显） |
| `~/.bili-lite/ledger.json` | 写额度 / 判重账本（comment / interact / watch 都记） |
| `~/.bili-lite/api-cache.json` `api-ban.json` | 元信息缓存 / 风控熔断状态 |
| `~/.bili-lite/persona.md` | 人设（可选） |
| `~/.bili-lite/shots/` | 抽帧九宫格生成的图（`shots` 的落点，看完可删） |
| `~/.dsh/bili-lite-diary.md` | 日记 |
| `~/.dsh/bili-lite-work/` | 它的专用会话工作目录 |

## 项目结构（防弹边界）

三个运行面，一个方向：**共享（config, lib）→ features → app**，不可逆。每个 feature 只有一个公共入口，删除任何一个 feature 只会破坏 `src/app` 的组合点。

```
src/
├── app/plugin.js                # 应用层：插件装配、信任柵栏、路由门（唯一组合点）
├── config/                      # 共享：路径常量 + 配置默认值（唯一真相）
│   ├── paths.js
│   └── store.js
├── lib/                         # 共享：B 站 HTTP 客户端（节流/焸断/WBI/扫码登录）+ 二维码编码器 + 小工具
│   ├── bilibili.js
│   ├── qrcode.js
│   ├── ffmpeg.js                # 抽帧的可选依赖：定位/调用/体检（没装就只 shots 用不了）
│   ├── json-file.js
│   └── http.js
└── features/
    ├── settings/                # 设置壳：宿主 API + 浏览器 section（docs/features/settings.md）
    ├── bili-pulse/              # 心跳：照它排的作息投拍，没排作息时兜底问一拍（docs/features/bili-pulse.md）
    └── bili-agent/              # agent CLI：看/评/日记/账本（docs/features/bili-agent.md）
```

- 每个 feature 一个入口：`feature.js`（CLI 按框架约定是 `bili.mjs`）；`settings/client.js` 是单文件加载的浏览器半边（零 import）。
- 跨 feature 不直接 import：心跳每拍重新读配置 —— 没有需要注入的回调 ✓。
- `npm run check` 跑结构检查：方向不可逆、无 barrel、浏览器半边零 import、全量语法检查。feature 的边界决策见 `docs/features/*.md`。

## 和 dsh-bili-whale 的关系

同一理念的最小实现，规模对照：

| | whale | lite |
|---|---|---|
| 代码文件 | ~50 个 | ~17 个（3 个运行面） |
| 看 | 字幕+弹幕+热评+抽帧九宫格 | 字幕+弹幕+热评+抽帧九宫格（要 ffmpeg，可选：没装就只少画面这一路） |
| 写 | 评论/私信/弹幕/动态/收藏/三连 | 评论 + 点赞/投币/关注（限额 + 判重） |
| 登录 | 扫码 + 手动 cookie | 扫码 + 手动 cookie（同一份二维码编码器，终端出图形、设置页出 SVG） |
| 监听 | 评论/私信/直播间轮询 | 无（只有心跳） |
| 限额/熔断/判重 | ✓ | ✓（同样写死） |

想升级再看 whale：`dsh plugin --profile desktop add dsh-bili-whale`。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-bili-lite
rm -rf ~/.bili-lite ~/.dsh/bili-lite-work ~/.dsh/bili-lite-diary.md ~/.dsh/bili-lite.config.json
```

## License

MIT
