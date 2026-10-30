/**
 * dsh-bili-lite · settings —— 设置壳（宿主半边）—— 本 feature 的公共入口
 *
 * 职责只有四件：
 *   1. 设置 API：GET/POST /dsh-bili-lite/api/settings → 读写 ~/.dsh/bili-lite-work/bili-lite.config.json
 *      （默认值与键清单来自 config/store —— 不搞两套 ✗）
 *   2. 凭据写入：POST /dsh-bili-lite/api/cookie → 先真的去 nav 验证一次（lib 的 whoami），
 *      验证通过才落盘（lib 的 saveCred，0600），且永不回显
 *   3. 扫码登录：POST /api/qr/start 出一张二维码（同一份 lib/qrcode 编码器出 SVG dataURL），
 *      POST /api/qr/poll 轮询状态；凭据取自 poll 响应的 Set-Cookie，先验证、通过才落盘
 *      （验证不过一个字节都不写，原登录态不变）。会话只存内存（重启丢失，重扫即可）
 *   4. 自检：GET /dsh-bili-lite/api/selftest → 真跑一次 `bun <bili.ts> selftest --json`
 *
 * 浏览器半边在本目录 client.ts（DSH 设置页的「B站养鱼」section），由包导出
 * ./client 加载 —— 单文件加载契约，两侧互不 import，靠同一份 API 契约对齐。
 * 错误约定：handler 内自己返 { ok:false, error }；漏网抛错由 app 的 route 兜底成 500。
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type { IncomingMessage } from 'node:http'
import { json, readBody } from '../../lib/http.ts'
import { qrGenerate, qrPoll, saveCred, whoami } from '../../lib/bilibili.ts'
import { qrMatrix, qrSvg } from '../../lib/qrcode.ts'
import { config, writeConfig, DEFAULTS, CONFIG_KEYS } from '../../config/store.ts'
import type { Config } from '../../config/store.ts'
import { CFG_FILE } from '../../config/paths.ts'
import { parseCookie, credState } from './cookie.ts'
import { resolveRuntime } from './runtime.ts'
import type { Route } from '../../lib/dsh.ts'

const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS)

export interface SettingsDeps {
  route: Route
  isTrusted: (req: IncomingMessage) => boolean
  cliPath: string
}

/** 扫码会话只存内存：key → { qrcodeKey, at }；重启即失效，重扫即可 */
interface QrSession { qrcodeKey: string; at: number }

export function registerSettings({ route, isTrusted, cliPath }: SettingsDeps): void {
  // 找一个真能跑脚本的运行时（Bun 优先；没有就退 Node —— 编译产物两种都吃）
  const RUNTIME = resolveRuntime()

  // ── 设置读写（读和写合成一个 handler：宿主若「首个匹配即终止」，分开注册会丢 POST）──
  route('/dsh-bili-lite/api/settings', async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, config: config(), credentials: credState(), configPath: CFG_FILE })
      return
    }
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    const body = JSON.parse(await readBody(req) || '{}') as Record<string, unknown>
    const incoming = (body && typeof body.config === 'object' && body.config ? body.config : body) as Record<string, unknown>
    // 顶层白名单：只合并认识的键（防止被塞任意字段 ✓）
    const cur: Config = { ...config() }
    for (const [k, v] of Object.entries(incoming)) if (CONFIG_KEY_SET.has(k)) (cur as unknown as Record<string, unknown>)[k] = v
    // 范围校验：别让设置页把东西写成负数 / 离谱值
    const em = Number(cur.pulse.everyMin)
    cur.pulse.everyMin = Number.isFinite(em) ? Math.min(360, Math.max(5, em)) : DEFAULTS.pulse.everyMin
    const wd = Number(cur.quota.writeDaily)
    cur.quota.writeDaily = Number.isFinite(wd) ? Math.min(10, Math.max(0, wd)) : DEFAULTS.quota.writeDaily
    const id = Number(cur.quota.interactDaily)
    cur.quota.interactDaily = Number.isFinite(id) ? Math.min(50, Math.max(0, id)) : DEFAULTS.quota.interactDaily
    cur.risk.minGapMs = Math.min(60000, Math.max(300, Number(cur.risk.minGapMs) || DEFAULTS.risk.minGapMs))
    cur.persona = { name: String(cur.persona?.name ?? '').trim().slice(0, 24) }   // 名字只用于抬头：去掉空白、限长
    writeConfig(cur)   // 心跳每拍都重新读配置 → 保存即生效，无需任何回调 ✓
    json(res, 200, {
      ok: true, config: cur,
    })
  })

  // ── 凭据写入：先验证（真的去 nav 请求一次），通过才落盘；失败不动旧凭据 ──
  route('/dsh-bili-lite/api/cookie', async (req, res) => {
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    let cred
    try { cred = parseCookie(JSON.parse(await readBody(req) || '{}') as Record<string, unknown>) }
    catch (e) { json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) }); return }
    let self
    try { self = await whoami(cred) }   // 先真实验证一次（不做离线格式检查就当成功那种事不存在）
    catch (e) { json(res, 400, { ok: false, error: String(e instanceof Error ? e.message : e) + ' —— 未保存，原登录态不变' }); return }
    saveCred(cred)
    writeConfig({ ...config(), self })
    json(res, 200, { ok: true, self, detail: `已登录：${self.name}（mid ${self.mid}）` })
  })

  // ── 扫码登录：start 出二维码（SVG dataURL），poll 查状态；key 只在内存，重启即失效 ──
  const qrSessions = new Map<string, QrSession>()
  route('/dsh-bili-lite/api/qr/start', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    try {
      for (const [k, v] of qrSessions) if (Date.now() - v.at > 5 * 60_000) qrSessions.delete(k)
      const g = await qrGenerate()
      const key = crypto.randomBytes(16).toString('hex')
      qrSessions.set(key, { qrcodeKey: g.qrcodeKey, at: Date.now() })
      const svg = qrSvg(qrMatrix(g.url))
      json(res, 200, { ok: true, key, img: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` })
    } catch (e) { json(res, 502, { ok: false, error: '申请二维码失败：' + String(e instanceof Error ? e.message : e).slice(0, 160) }) }
  })
  route('/dsh-bili-lite/api/qr/poll', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    const { key } = JSON.parse(await readBody(req) || '{}') as { key?: unknown }
    const s = qrSessions.get(String(key ?? ''))
    if (!s) { json(res, 200, { ok: true, status: 'gone' }); return }
    try {
      const st = await qrPoll(s.qrcodeKey)
      if (st.status !== 'done') { json(res, 200, { ok: true, status: st.status }); return }
      // 先验证、后落盘：验证不过就一个字节都不写，原登录态原样保留（qrcode_key 一次性，失败后让用户重扫）
      const cred = parseCookie({ sessdata: st.cred.sessdata, bili_jct: st.cred.bili_jct, buvid3: st.cred.buvid3, buvid4: st.cred.buvid4 })
      const self = await whoami(cred)
      saveCred(cred)
      writeConfig({ ...config(), self })
      qrSessions.delete(String(key))
      json(res, 200, { ok: true, status: 'done', detail: `已登录：${self.name}（mid ${self.mid}）` })
    } catch (e) {
      qrSessions.delete(String(key))
      json(res, 200, { ok: false, status: 'error', error: '扫码登录失败：' + String(e instanceof Error ? e.message : e).slice(0, 200) + '（未保存，原登录态不变）' })
    }
  })

  // ── 自检：真的跑一次 <runtime> <bili.js> selftest --json ──
  route('/dsh-bili-lite/api/selftest', async (req, res) => {
    if (!RUNTIME) { json(res, 200, { ok: false, error: '找不到 bun / node 运行时 —— 装 Bun（推荐）或 Node 18+，或用 $BUN / $DSH_NODE 指路径', items: [] }); return }
    execFile(RUNTIME.exe, [cliPath, 'selftest', '--json'], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      try { json(res, 200, JSON.parse(String(stdout || '{}'))) }
      catch { json(res, 200, { ok: false, error: String(stderr || err?.message || 'selftest 跑失败').slice(0, 300), items: [] }) }
    })
  })
}
