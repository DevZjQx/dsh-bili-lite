# bili-agent（agent 的手和眼）

**Purpose.** agent（和人）操作 B 站的唯一 CLI：自检、扫码登录、看候选（口味不存配置，搜索词由 agent 当场用 `--kw` 自己给）、读视频（字幕/弹幕/热评 + 抽帧九宫格看画面）、发评论、点赞 / 投币 / 关注（写操作）、写日记、额度账本、自己排作息 / 定时任务（schedule）。

**Owns.** 全部子命令（selftest / login / whoami / feed / video / shots / comment / interact / diary / ledger / taste / schedule）的实现与终端输出；`taste` 的口味回顾（只读账本：看过的标题、常看的 UP、动过手的目标，不替它下结论、不存偏好）；`shots` 的取帧策略（等间隔取中点、格子尺寸跟视频比例、按行列拼图）与产物落点（`~/.bili-lite/shots/`）；账本 `~/.bili-lite/ledger.json`（写额度 / 7 天判重 / 「看过」的唯一真相）；日记文件的追加；计划的写入入口（经 `lib/schedule` 落盘到 `~/.bili-lite/schedule.json` —— 它是计划的唯一作者，宿主只照投）。互动的判断也在这里：一天 ≤ `quota.interactDaily` 次、同目标同动作 7 天一次（判重看最后一条记录：取消类不占额度、不判重，取消后可以再做）、投币前先看硬币够不够、不能关注自己；安全约定写死在代码里：写操作必须显式 `--dry|--go`、评论正文带 @ 直接拒绝、超 500 字拒绝；计划防滥用上限同样写死（在排 ≤30 条、`--every` 最短 5 分钟）。`login` 扫码成功后凭据落盘走 `lib/bilibili` 的 `saveCred`（0600，不回显），并用 `whoami` 真实验证后才报成功。

**Does not own.** B 站 HTTP 细节与扫码登录协议（`lib/bilibili`：节流 / 熔断 / 缓存 / WBI 签名 / 播放直链 getPlayUrl / 写操作 POST apiPost / passport 二维码 generate→poll）；二维码的编码与渲染（`lib/qrcode`）；ffmpeg 的定位与调用（`lib/ffmpeg`：$FFMPEG → PATH → 仓库 bin → `~/.bili-lite/bin`，缺失时给安装提示）；配置与路径（`config/`）；谁在什么时候跑它（`bili-pulse` 只负责按节拍问一拍「现在想干嘛」，跑不跑、发不发由 agent 决定）；凭据的日常写入入口（`settings` 的设置页，`login` 只是另一条通往同一个 `saveCred` 的路）。

**Depends on.** `config/paths`、`config/store`、`lib/bilibili`、`lib/qrcode`、`lib/json-file`、`lib/schedule`（计划的唯一真相，与 `bili-pulse` 共用）、`lib/ffmpeg`（可选依赖：只有 `shots` 用得到，缺了不影响其余子命令）。

**Public surface.** `bili.mjs` —— 可执行入口（`node …/bili.mjs <子命令>`）。宿主只引用路径（spawn 自检、心跳文案点名），从不 import 它。

**Owner.** 暂无专人（app owner 代管）。

**Rejected.** 把每个子命令拆一个文件 —— 代码总量千行上下，commands.js + ledger.js 已经够清楚。把额度/判重做成可配置关闭 —— 拒绝：克制是功能，不是开关。为抽帧引 npm 的 JPEG 解码器或随包分发 ffmpeg —— 拒绝：lite 不背二进制和依赖树；改为「用得上的人自己装 ffmpeg，装不上就少画面这一路」。把整段视频下载下来再抽 —— 拒绝：直接对直链按时间点 seek，抽完即删，磁盘不随视频长度涨。

**Exceptions.** 入口文件名是 `bili.mjs` 而不是 `feature.mjs`：CLI 的「框架约定」是可执行文件名（对 agent 与 README 的命令行保持可读）。结构检查脚本把「带 shebang 的根级 .mjs」认作合法入口，详见文件头注释。
