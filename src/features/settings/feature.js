/**
 * dsh-bili-lite · settings —— 设置壳（宿主半边）—— 本 feature 的公共入口
 *
 * 职责只有四件：
 *   1. 设置 API：GET/POST /dsh-bili-lite/api/settings → 读写 ~/.dsh/bili-lite.config.json
 *      （默认值与键清单来自 config/store —— 不搞两套 ✗）
 *   2. 凭据写入：POST /dsh-bili-lite/api/cookie → 先真的去 nav 验证一次（lib 的 whoami），
 *      验证通过才落盘（lib 的 saveCred，0600），且永不回显
 *   3. 扫码登录：POST /api/qr/start 出一张二维码（同一份 lib/qrcode 编码器出 SVG dataURL），
 *      POST /api/qr/poll 轮询状态；成功后验证并落盘。会话只存内存（重启丢失，重扫即可）
 *   4. 自检：GET /dsh-bili-lite/api/selftest → 真跑一次 `node <bili.mjs> selftest --json`
 *
 * 浏览器半边在本目录 client.js（DSH 设置页的「B站小鲤」section），由包导出
 * ./client 加载 —— 单文件加载契约，两侧互不 import，靠同一份 API 契约对齐。
 * 错误约定：handler 内自己返 { ok:false, error }；漏网抛错由 app 的 route 兜底成 500。
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { json, readBody } from '../../lib/http.js'
import { qrGenerate, qrPoll, saveCred, whoami } from '../../lib/bilibili.js'
import { qrMatrix, qrSvg } from '../../lib/qrcode.js'
import { config, writeConfig, DEFAULTS, CONFIG_KEYS } from '../../config/store.js'
import { CFG_FILE } from '../../config/paths.js'
import { parseCookie, credState } from './cookie.js'
import { resolveNode } from './node-runtime.js'

const CONFIG_KEY_SET = new Set(CONFIG_KEYS)

export function registerSettings({ route, isTrusted, cliPath }) {
  // 找一个真能跑脚本的 node（Electron 里 process.execPath 是主程序 ✗ 跑不了脚本）
  const NODE_EXE = resolveNode()

  // ── 设置读写（读和写合成一个 handler：宿主若「首个匹配即终止」，分开注册会丢 POST）──
  route('/dsh-bili-lite/api/settings', async (req, res) => {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, config: config(), credentials: credState(), configPath: CFG_FILE })
      return
    }
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    const incoming = (body && typeof body.config === 'object' && body.config) || body || {}
    // 顶层白名单：只合并认识的键（防止被塞任意字段 ✓）
    const cur = { ...config() }
    for (const [k, v] of Object.entries(incoming)) if (CONFIG_KEY_SET.has(k)) cur[k] = v
    // 范围校验：别让设置页把东西写成负数 / 离谱值
    const em = Number(cur.pulse.everyMin)
    cur.pulse.everyMin = Number.isFinite(em) ? Math.min(360, Math.max(5, em)) : DEFAULTS.pulse.everyMin
    const wd = Number(cur.quota.writeDaily)
    cur.quota.writeDaily = Number.isFinite(wd) ? Math.min(10, Math.max(0, wd)) : DEFAULTS.quota.writeDaily
    cur.risk.minGapMs = Math.min(60000, Math.max(300, Number(cur.risk.minGapMs) || DEFAULTS.risk.minGapMs))
    writeConfig(cur)   // 心跳每拍都重新读配置 → 保存即生效，无需任何回调 ✓
    json(res, 200, {
      ok: true, config: cur,
      warn: cur.quota.writeDaily > 3 ? '写额度 >3：看起来会像刷量，平台可能限流/封号' : null,
    })
  })

  // ── 凭据写入：先验证（真的去 nav 请求一次），通过才落盘；失败不动旧凭据 ──
  route('/dsh-bili-lite/api/cookie', async (req, res) => {
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    let cred
    try { cred = parseCookie(JSON.parse(await readBody(req) || '{}')) }
    catch (e) { json(res, 400, { ok: false, error: e.message }); return }
    let self
    try { self = await whoami(cred) }   // 先真实验证一次（不做离线格式检查就当成功那种事不存在）
    catch (e) { json(res, 400, { ok: false, error: String(e?.message ?? e) + ' —— 未保存，原登录态不变' }); return }
    saveCred(cred)
    writeConfig({ ...config(), self })
    json(res, 200, { ok: true, self, detail: `已登录：${self.name}（mid ${self.mid}）` })
  })

  // ── 扫码登录：start 出二维码（SVG dataURL），poll 查状态；key 只在内存，重启即失效 ──
  const qrSessions = new Map()
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
    } catch (e) { json(res, 502, { ok: false, error: '申请二维码失败：' + String(e?.message ?? e).slice(0, 160) }) }
  })
  route('/dsh-bili-lite/api/qr/poll', async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
    if (!isTrusted(req)) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return }
    const { key } = JSON.parse(await readBody(req) || '{}')
    const s = qrSessions.get(String(key ?? ''))
    if (!s) { json(res, 200, { ok: true, status: 'gone' }); return }
    try {
      const st = await qrPoll(s.qrcodeKey)
      if (st.status !== 'done') { json(res, 200, { ok: true, status: st.status }); return }
      saveCred(st.cred)
      const self = await whoami(st.cred)   // 落盘后真实验证一次
      writeConfig({ ...config(), self })
      qrSessions.delete(String(key))
      json(res, 200, { ok: true, status: 'done', detail: `已登录：${self.name}（mid ${self.mid}）` })
    } catch (e) { json(res, 502, { ok: false, error: '扫码登录失败：' + String(e?.message ?? e).slice(0, 160) }) }
  })

  // ── 自检：真的跑一次 node <bili.mjs> selftest --json ──
  route('/dsh-bili-lite/api/selftest', async (req, res) => {
    if (!NODE_EXE) { json(res, 200, { ok: false, error: '找不到可执行的 node 运行时 —— 安装 node 或设置 DSH_NODE', items: [] }); return }
    execFile(NODE_EXE, [cliPath, 'selftest', '--json'], { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
      try { json(res, 200, JSON.parse(String(stdout || '{}'))) }
      catch { json(res, 200, { ok: false, error: String(stderr || err?.message || 'selftest 跑失败').slice(0, 300), items: [] }) }
    })
  })
}
