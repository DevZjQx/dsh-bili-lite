# bili-tools（模型的手：bili_* 工具）

**Purpose.** 把 `bili-agent` 的 ops 层包成模型可直接调用的工具，让 agent 不必记住「绝对路径 + 子命令」也能看视频、发评论、排作息。工具注册后 schema 自动进 system prompt —— 这是相对 CLI 的唯一实质收益。

**Owns.** 10 个工具的定义与渲染：`bili_feed` / `bili_up` / `bili_following` / `bili_video` / `bili_shots` / `bili_inbox` / `bili_comment` / `bili_interact` / `bili_schedule` / `bili_history`；参数 schema（裸 JSON Schema）、参数收敛（宿主不校验裸注册的工具，这里补）、`render`（纯函数，把规范化值变人话）、以及注册/卸载（`registerBiliTools` 返回撤销函数）。

**Does not own.** 取数与全部副作用（`bili-agent/ops.ts`：额度记账、判重、已读、计划落盘）；护栏判断（同样是 ops —— 工具层**不重复**判，否则两条路会分叉）；终端输出与 flags 解析（`bili-agent/commands.ts`）；工具在 app 里的装配时机（`app/plugin.ts`）。

**Depends on.** `features/bili-agent/feature.ts`（唯一被允许的跨 feature 入口，纯库、零副作用）、`lib/dsh.ts` 的工具契约类型（纯类型）。**不依赖** `@deepseek-ai/dsh-tools`：那个包只随宿主分发，插件不能假设它可解析；代价是参数校验自己写、schema 写成 JSON Schema 而不是它的 DSL。

**Public surface.** `feature.ts` 的 `buildTools()`（测试用）与 `registerBiliTools(tools)`（装配用）。

**Owner.** 暂无专人（app owner 代管）。

**Rejected.** 把 12 个子命令一对一映射成 12 个工具 —— `selftest` / `login` / `whoami` 是人在设置页做的事，模型没有理由调；`feed` 的候选、`up` 的投稿、`inbox` 的消息才是它的决策输入。把 `up` 和 `following` 合成一个工具（不传 mid 就看关注名单）—— 两者返回值形状不同，合并只能给一个松散的联合 schema，不如两个小工具各自精确。用一个 `bili` 工具带 `command` 字符串 —— 参数无法按分支校验，description 会膨胀成帮助文档，PTC 也拿不到类型。

**Exceptions.** `bili_video` 一个工具两种返回（概览 / 字幕正文），共用一个 `kind` 判别、schema 是扁平可选字段的联合 —— 拆成两个工具就是 11 个，而「看懂一条」在模型眼里本来就是同一个动作（`read` 只是深度参数）。`bili_schedule` / `bili_history` 同理：`action` / `kind` 判别，schema 用可选字段承载不同分支。
