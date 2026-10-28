/**
 * dsh-bili-lite —— 宿主侧插件（应用层：唯一的组合点）
 *
 * 这里只做装配，不放业务：
 *   · 信任栅栏：回环直通 + connection.requestRejection（fail-closed）—— 所有路由的公共门。
 *     Web 端口是回环地址，但浏览器里任何一个网页都能向回环发请求 —— 不加栅栏
 *     等于把配置与账号凭据开放给任意页面。
 *   · 把 features（settings / bili-pulse）挂到路由上，feature 之间不互相 import
 *     （心跳自己每拍读配置 —— 没有需要跨 feature 注入的回调 ✓）。
 *   · agent CLI（features/bili-agent/bili.mjs）只被引用路径：宿主 spawn 它跑自检、
 *     心跳文案里点名它 —— 从不 import 它的代码。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { json } from '../lib/http.js'
import { CFG_FILE } from '../config/paths.js'
import { startPulse } from '../features/bili-pulse/feature.js'
import { registerSettings } from '../features/settings/feature.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.join(HERE, '..', 'features', 'bili-agent', 'bili.mjs')

export default {
  name: 'dsh-bili-lite',
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx) {
    // ── 信任栅栏：回环直通；其余交给 DSH 的 connection 判定（fail-closed）────
    function isLoopbackReq(req) {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function isTrustedReq(req) {
      if (isLoopbackReq(req)) return true
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }
    /** 栅栏不可用 → 拒绝（安全组件的默认值必须是「关」） */
    function rejected(req, res) {
      if (isTrustedReq(req) === false) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') {
          json(res, 503, { ok: false, error: '信任栅栏不可用，拒绝访问（fail-closed）' }); return true
        }
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        json(res, 503, { ok: false, error: '信任栅栏异常，拒绝访问（fail-closed）' }); return true
      }
    }

    const disposers = []
    function route(pathname, handler) {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
          }
        },
      }))
    }

    // ── 心跳：先起（/api/status 由它自己注册；起不来 → 这里兜底一条「未启动」）──
    let pulse = null
    try {
      pulse = startPulse({ getSession: () => ctx.sessionController, route, cliPath: CLI_PATH })
    } catch (e) {
      try { console.warn('[bili-lite] 心跳启动失败：' + (e?.message ?? e)) } catch {}
      route('/dsh-bili-lite/api/status', async (req, res) => json(res, 200, { ok: true, pulse: { ok: false } }))
    }

    // ── 设置壳：settings / cookie / selftest 三条路由 ──
    registerSettings({ route, isTrusted: isTrustedReq, cliPath: CLI_PATH })

    ctx.effect(() => () => {
      try { pulse?.stop() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try { console.log(`[bili-lite] 已挂载：/dsh-bili-lite/api/* · 配置 ${CFG_FILE}`) } catch {}
  },
}
