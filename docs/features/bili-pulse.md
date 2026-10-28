# bili-pulse（心跳）

**Purpose.** 让它「在场」，且节奏攥在它自己手里：宿主常驻，每分钟看两眼 —— 它自己排的计划（`~/.bili-lite/schedule.json`，agent 用 `bili.ts schedule` 写）到点没：到点就投「计划拍」，拍里带上它自己写的标签，错过的补投；它什么都没排时，按 `pulse.everyMin`（默认 60）分钟投一拍中性的「现在想干嘛」当兜底。**计划非空时兜底节拍暂停**（它的计划替代默认节奏），`schedule clear` 后恢复。sessionId 固定为 `bili-lite`，跨天保留上下文。

**Owns.** 每分钟 tick（计划拍优先 → 兜底节拍）；两种拍文案（人设前缀 + 现在几点 + 工具用法与克制的提醒；计划拍带它自己写的标签；抬头里的名字取 `persona.name`，可空 —— 插件不写死名字）；投递后的计划记账（`markFired`：投递失败不记账 → 下一拍重投）；`GET /dsh-bili-lite/api/status`（含 `plan` 概要，设置页展示用）。

**Does not own.** 计划的读写与到期判断（`lib/schedule`，与 `bili-agent` 共用，宿主只照投、不排不改）；拿到拍之后的任何行为（agent 拿 `bili-agent` 的 CLI 自己干）；额度/判重的执行（`bili-agent`）；`pulse.everyMin` 的校验与保存（`settings`）；会话服务的实现（app 注入 getSession）。拍文案里的写额度只是展示，真正的额度执行在 `bili-agent`。

**Depends on.** `config/paths`（persona/workdir）、`config/store`（读配置）、`lib/schedule`（到期判断 / 记账 / 概要）；app 注入 `getSession` / `route` / `cliPath`。

**Public surface.** `feature.ts` 的 `startPulse()`，返回 `{ stop, status }`。

**Owner.** 暂无专人（app owner 代管）。

**Rejected.** 更早的醒来机制（作息窗口 + 掷骰子 + skipChance + 宿主写 `state.json` 计划文件）——「今天几点醒」「今天想不想看」原本是宿主替它掷的骰子，决定在宿主手里；现在反过来：宿主只是闹钟，计划由 agent 自己写，宿主照着投。也拒绝「计划与固定节拍并行」—— 那样每小时一遍的兜底拍会把计划淹没，排了等于没排；兜底只在没计划时才走。用 cron / 外部进程 —— 宿主本来就常驻，60s tick 足够，且要能直接 prompt DSH 会话。

**Exceptions.** 对 `bili-agent` 的唯一耦合是 app 注入的 `cliPath`（拍文案里点名的命令行）—— 只引用路径字符串，不 import 其代码。
