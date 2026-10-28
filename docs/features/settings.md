# settings（设置与凭据）

**Purpose.** 主人配置它的地方：心跳节拍、克制额度、B 站凭据 —— 一个设置页 + 一组同源 API。口味不在这里：看什么由 agent 自己在 `feed --kw` 时决定。

**Owns.** GET/POST `/dsh-bili-lite/api/settings`（读写 `~/.dsh/bili-lite.config.json`，含顶层白名单与范围校验）；POST `/api/cookie`（先真实 nav 验证、通过才落盘、永不回显）；POST `/api/qr/start` 与 `/api/qr/poll`（扫码登录：start 用 `lib/qrcode` 出 SVG dataURL，poll 查状态，成功后验证并经 `saveCred` 落盘；会话只存内存，重启丢失重扫即可）；GET `/api/selftest`（真跑一次 agent CLI 的 `selftest --json`）；浏览器半边 `client.js`（设置 section UI、字段清单 FIELDS、扫码二维码展示与 2s 轮询、心跳状态展示）。

**Does not own.** 心跳的执行（`bili-pulse`）；额度/判重的执行（`bili-agent`）；默认值与路径（在 `config/`，两侧只引用不改写）。「字段加在哪」：labels/hints 加在 `client.js` 的 FIELDS，键加在 `config/store.js` 的 DEFAULTS —— 白名单直接取 `Object.keys(DEFAULTS)`，不存在第三处。

**Depends on.** `config/paths`、`config/store`、`lib/http`、`lib/bilibili`（`qrGenerate`/`qrPoll`/`saveCred`/`whoami`）、`lib/qrcode`（宿主侧出 SVG，浏览器半边不 import）；app 注入 `route` / `isTrusted` / `cliPath`。

**Public surface.** `feature.js`。`client.js` 由包导出 `./client` 暴露（加载契约，见 Exceptions）。

**Owner.** 暂无专人（app owner 代管）。

**Rejected.** 把「字段白名单」留在宿主与 client 各手工维护一份 —— 改为从 DEFAULTS 取键，加字段少改一处。把凭据验证做成离线格式检查 —— 拒绝：必须真的 nav 一次，防写入即失效的 cookie。

**Exceptions.** `client.js` 必须单文件（DSH web 的 `__ModuleLoader__` 直接加载该文件，只提供 `require("react")`），因此它不 import 本 feature 任何模块，`feature.js` 也不 import 它 —— 两半靠 API 路径与 config 键清单对齐，详见文件头注释。
