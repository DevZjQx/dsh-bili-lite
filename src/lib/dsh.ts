/**
 * DSH 宿主契约（shared，纯类型零运行时）—— 插件这一侧只知道这么多。
 *
 * 为什么要自己写一份：DSH 的类型包不随插件分发，而 app 与 features 都要引用同一份
 * 形状（route 处理器、会话控制器、信任栅栏）。放在 lib 层，谁都不必 import app。
 * 全部是 interface / type：编译后被完全擦除，不产生任何运行时依赖 ✓
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 路由处理器：app 已经包好信任栅栏与 500 兜底，feature 只管业务 */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
export interface RouteSpec { kind: 'exact'; path: string; handler: RouteHandler }
/** 注册一条路由，返回撤销函数 */
export type Route = (path: string, handler: RouteHandler) => void

export interface WebServerLike { register(spec: RouteSpec): () => void }

/** 一拍的面貌：宿主只认 text / image / file 三种 part */
export interface PromptPartLike { type: 'text'; text: string }

/**
 * 投一拍 —— 形状照抄 DSH 的 SessionController（packages/api/session-controller/src/index.ts）：
 *   prompt(request, signal) 两个位置参数，request 里必须有 requestId（客户端自己 mint 的 uuid）。
 * signal 是第二个参数，不是 request 字段 —— 传错就是 throwIfAborted 读 undefined。
 */
export interface SessionPromptRequestLike {
  requestId: string
  sessionId: string
  mode: 'queue' | 'steer'
  content: PromptPartLike[]
  clientTimeZone?: string
}

export interface SessionControllerLike {
  /** 返回真正落地的 sessionId（可能和请求的不一样，复用已有会话时） */
  create(request: { sessionId?: string; cwd?: string }): Promise<{ sessionId?: string } | undefined>
  prompt(request: SessionPromptRequestLike, signal: AbortSignal): Promise<unknown>
}

export interface ConnectionLike {
  isTrusted?(req: IncomingMessage): boolean
  /** 返回 undefined/null/false = 放行；否则是拒绝码 */
  requestRejection?(req: IncomingMessage): unknown
}

/** app 拿到的插件上下文（DSH 只保证这几个能力） */
export interface PluginContext {
  get<T = unknown>(name: string): T | undefined
  connection?: ConnectionLike
  webServer: WebServerLike
  sessionController?: SessionControllerLike
  effect(fn: () => undefined | (() => void)): void
}
