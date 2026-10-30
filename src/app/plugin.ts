/**
 * dsh-bili-lite —— 宿主侧插件（应用层：唯一的组合点）
 *
 * 这里只做装配，不放业务：
 *   · 信任栅栏：回环直通 + connection.requestRejection（fail-closed）—— 所有路由的公共门。
 *     Web 端口是回环地址，但浏览器里任何一个网页都能向回环发请求 —— 不加栅栏
 *     等于把配置与账号凭据开放给任意页面。
 *   · 把 features（settings / bili-pulse）挂到路由上，feature 之间不互相 import
 *     （心跳自己每拍读配置 —— 没有需要跨 feature 注入的回调 ✓）。
 *   · agent CLI（features/bili-agent/bili.ts）只被引用路径：宿主 spawn 它跑自检、
 *     心跳文案里点名它 —— 从不 import 它的代码。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { json } from '../lib/http.ts'
import { redact } from '../lib/redact.ts'
import { probeModel } from '../lib/model-ready.ts'
import { CFG_FILE } from '../config/paths.ts'
import { startPulse } from '../features/bili-pulse/feature.ts'
import type { PulseApi } from '../features/bili-pulse/feature.ts'
import { registerSettings } from '../features/settings/feature.ts'
import type { PluginContext, ConnectionLike, RouteHandler, SessionControllerLike } from '../lib/dsh.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI_PATH = path.join(HERE, '..', 'features', 'bili-agent', 'bili.js')

export default {
  name: 'dsh-bili-lite',
  inject: ['sessionController', 'webServer', 'connection'],
  apply(ctx: PluginContext): void {
    // ── 信任栅栏：回环直通；其余交给 DSH 的 connection 判定（fail-closed）────
    function isLoopbackReq(req: IncomingMessage): boolean {
      const host = String(req.headers?.host ?? '').toLowerCase()
      const h = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
      return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
    }
    function connection(): ConnectionLike | undefined {
      return ctx.get<ConnectionLike>('connection') || ctx.connection
    }
    /** 会话服务同样两条路取：有的宿主只挂在 ctx.get 上，有的直接给 ctx 属性 */
    function sessionController(): SessionControllerLike | undefined {
      return ctx.get<SessionControllerLike>('sessionController') || ctx.sessionController
    }
    function isTrustedReq(req: IncomingMessage): boolean {
      if (isLoopbackReq(req)) return true
      try {
        const conn = connection()
        if (conn && typeof conn.isTrusted === 'function') return conn.isTrusted(req) === true
      } catch {}
      return false
    }
    /** 栅栏不可用 → 拒绝（安全组件的默认值必须是「关」） */
    function rejected(req: IncomingMessage, res: ServerResponse): boolean {
      if (isTrustedReq(req) === false) { json(res, 403, { ok: false, error: '不受信任的访问来源' }); return true }
      try {
        const conn = connection()
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

    const disposers: Array<() => void> = []
    function route(pathname: string, handler: RouteHandler): void {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          try { await handler(req, res) } catch (err) {
            try { json(res, 500, { ok: false, error: redact(err instanceof Error ? err.message : err) }) } catch {}
          }
        },
      }))
    }

    // ── 心跳：先起（/api/status 由它自己注册；起不来 → 这里兜底一条「未启动」）──
    // probeReady：没有 API 凭证 / 没有可用模型时不投拍 —— 否则每拍都会以
    // MISSING_CREDENTIAL 失败。探针只读 llm 目录（listModels 本身是凭证门控的）。
    let pulse: PulseApi | null = null
    try {
      pulse = startPulse({
        getSession: sessionController,
        route,
        cliPath: CLI_PATH,
        probeReady: async () => {
          const readiness = await probeModel((name) => ctx.get(name))
          return readiness.ok ? undefined : readiness.reason
        },
      })
    } catch (e) {
      try { console.warn('[bili-lite] 心跳启动失败：' + (e instanceof Error ? e.message : e)) } catch {}
      route('/dsh-bili-lite/api/status', async (_req, res) => { json(res, 200, { ok: true, pulse: { ok: false } }) })
    }

    // ── 设置壳：settings / cookie / qr / selftest 四条路由 ──
    registerSettings({ route, isTrusted: isTrustedReq, cliPath: CLI_PATH })

    ctx.effect(() => () => {
      try { pulse?.stop() } catch {}
      for (const d of disposers) { try { d() } catch {} }
    })

    try { console.log(`[bili-lite] 已挂载：/dsh-bili-lite/api/* · 配置 ${CFG_FILE}`) } catch {}
  },
}
