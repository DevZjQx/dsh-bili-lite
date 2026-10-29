/**
 * 配置存取 —— 默认值是唯一真相：宿主、CLI、心跳都从这里 import，不另抄一份。
 * 读写同一份 ~/.dsh/bili-lite-work/bili-lite.config.json；没有配置文件就用默认值。
 * 键清单（CONFIG_KEYS）= 设置页 POST 的顶层白名单：加字段只改 DEFAULTS。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CFG_FILE } from './paths.ts'

export interface PersonaConfig { name: string }
export interface SelfConfig { mid: string; name: string }
export interface PulseConfig { everyMin: number }
export interface QuotaConfig { writeDaily: number; interactDaily: number }
export interface ShareConfig { enabled: boolean }
export interface RiskConfig { minGapMs: number }

export interface Config {
  /** 它叫什么（可空）：只用于心跳抬头 —— 插件不写死任何名字，留空就不点名 */
  persona: PersonaConfig
  /** 账号自己（cookie 体检时自动回填；与主人共用一个身份） */
  self: SelfConfig
  /** 兑底节拍：它没排计划时，每这么久问一拍「现在想干嘛」（排了计划宿主只按计划投） */
  pulse: PulseConfig
  /** 每天最多发几条评论 / 做几次互动（赞·币·关注） */
  quota: QuotaConfig
  share: ShareConfig
  risk: RiskConfig
}

export const DEFAULTS: Config = {
  persona: { name: '' },
  self: { mid: '', name: '' },
  pulse: { everyMin: 60 },
  quota: { writeDaily: 3, interactDaily: 10 },
  share: { enabled: true },
  risk: { minGapMs: 1200 },
}

type JsonObject = Record<string, unknown>
const isObject = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v)

/** 设置页 POST 的顶层白名单：只合并认识的键（防止被塞任意字段 ✓；共用账号：没有 owner） */
export const CONFIG_KEYS: Array<keyof Config> = Object.keys(DEFAULTS) as Array<keyof Config>
const CONFIG_KEY_SET: ReadonlySet<string> = new Set(CONFIG_KEYS)

/** 默认值打底、用户值覆盖（递归合并：{ pulse: { everyMin: 30 } } 只改这一个键） */
function merge(base: unknown, over: unknown): unknown {
  if (!isObject(over)) return over
  const out: JsonObject = isObject(base) ? { ...base } : {}
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v)
  return out
}

export function config(): Config {
  let user: unknown = {}
  try { user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { /* 没配就用默认 */ }
  // 白名单不只管 POST —— 读的时候也只认认识的键（旧文件里已废弃的键，如 night，自动丢弃 ✓）
  const known: JsonObject = {}
  for (const [k, v] of Object.entries(isObject(user) ? user : {})) if (CONFIG_KEY_SET.has(k)) known[k] = v
  return merge(DEFAULTS, known) as Config
}

export function writeConfig(next: Config): void {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n')
}
