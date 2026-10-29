# bili-pulse（心跳）

**Purpose.** 让它「在场」，且节奏攥在它自己手里：宿主常驻，每分钟看两眼 —— 它自己排的计划（`~/.dsh/bili-lite-work/schedule.json`，agent 用 `bili.ts schedule` 写）到点没：到点就投「计划拍」，拍里带上它自己写的标签，错过的补投；它什么都没排时，按 `pulse.everyMin`（默认 60）分钟投一拍中性的「现在想干嘛」当兜底。**计划非空时兜底节拍暂停**（它的计划替代默认节奏），`schedule clear` 后恢复。**计划有保质期**（`--daily` / `--every` 默认 14 天，`--for` 可改）：到点不是投普通计划拍，而是投一拍「这条到期了，还续不续」；投完由 `markExpired` 撤掉，不自动续 —— 计划会自然消亡、回落兜底节拍，不会一条道走到黑。sessionId 固定为 `bili-lite`，跨天保留上下文。

**Owns.** 每分钟 tick（到期拍 / 计划拍优先 → 兜底节拍）；投递前的可用性闸门（没有 API 凭证 / 没有可用模型 → 不投，软等待、不算失败、不记账，恢复后下一拍自动继续）；三种拍文案（人设前缀 + 现在几点 + 工具用法与克制的提醒；计划拍带它自己写的标签和「第 N 次 · 排于 X 天前」；到期拍说清「不是你排错，是它到点了」并给续 / 改 / 不管三条路；抬头里的名字取 `persona.name`，可空 —— 插件不写死名字）；投递后的计划记账（`markFired` 记次数、`markExpired` 撤掉到期条目：投递失败都不记账 → 下一拍重投）；会话服务未就绪时的软等待（DSH 刚启动 / 刚装插件：不算投递失败、只提醒一次、下一拍再试）；连续失败只记头一次与每半小时一次、`lastError` 上报；`GET /dsh-bili-lite/api/status`（含 `plan` 概要、`gated` 与 `lastError`，设置页 / 排查用）。

**Does not own.** 计划的读写与到期判断（`lib/schedule`，与 `bili-agent` 共用，宿主只照投、不排不改）；拿到拍之后的任何行为（agent 拿 `bili-agent` 的 CLI 自己干）；额度/判重的执行（`bili-agent`）；`pulse.everyMin` 的校验与保存（`settings`）；会话服务的实现（app 注入 getSession）；「有没有可用模型 / 凭证」的判断（`lib/model-ready`，app 探好后注入 `probeReady`）。拍文案里的写额度只是展示，真正的额度执行在 `bili-agent`。

**Depends on.** `config/paths`（persona/workdir）、`config/store`（读配置）、`lib/schedule`（到期判断 / 记账 / 概要）；app 注入 `getSession` / `route` / `cliPath` / `probeReady`。

**Public surface.** `feature.ts` 的 `startPulse()`，返回 `{ stop, status }`。

**Owner.** 暂无专人（app owner 代管）。

**Rejected.** 「只靠『计划不对劲就改』」—— 那只有「对 / 错」两态，占绝大多数时间的「还行」没有任何重新问一次的入口，于是正常计划会一直走到黑、显得僵化。根因不是它不肯改，是没人问；所以给计划加了保质期和到期复查（到期拍），让它有自然寿命，而不是只靠一个错误条件才被推翻。更早的醒来机制（作息窗口 + 掷骰子 + skipChance + 宿主写 `state.json` 计划文件）——「今天几点醒」「今天想不想看」原本是宿主替它掷的骰子，决定在宿主手里；现在反过来：宿主只是闹钟，计划由 agent 自己写，宿主照着投。也拒绝「计划与固定节拍并行」—— 那样每小时一遍的兜底拍会把计划淹没，排了等于没排；兜底只在没计划时才走。用 cron / 外部进程 —— 宿主本来就常驻，60s tick 足够，且要能直接 prompt DSH 会话。

**Exceptions.** 对 `bili-agent` 的唯一耦合是 app 注入的 `cliPath`（拍文案里点名的命令行）—— 只引用路径字符串，不 import 其代码。
