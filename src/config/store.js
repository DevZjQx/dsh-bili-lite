/**
 * 配置存取 —— 默认值是唯一真相：宿主、CLI、心跳都从这里 import，不另抄一份。
 * 读写同一份 ~/.dsh/bili-lite.config.json；没有配置文件就用默认值。
 * 键清单（CONFIG_KEYS）= 设置页 POST 的顶层白名单：加字段只改 DEFAULTS。
 */
import fs from 'node:fs'
import path from 'node:path'
import { CFG_FILE } from './paths.js'

export const DEFAULTS = {
  self: { mid: '', name: '' },           // 账号自己（cookie 体检时自动回填；与主人共用一个身份）
  pulse: { everyMin: 60 },               // 兑底节拍：它没排计划时，每这么久问一拍「现在想干嘛」（排了计划宿主只按计划投）
  preferences: { like: [], dislike: [] },
  quota: { writeDaily: 3 },              // 每天最多写几条（评论）
  share: { enabled: true },
  risk: { minGapMs: 1200 },
}
/** 设置页 POST 的顶层白名单：只合并认识的键（防止被塞任意字段 ✓；共用账号：没有 owner） */
export const CONFIG_KEYS = Object.keys(DEFAULTS)

const merge = (base, over) => {
  const out = { ...base }
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] ?? {}, v) : v
  }
  return out
}

export function config() {
  let user = {}
  try { user = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) } catch { /* 没配就用默认 */ }
  // 白名单不只管 POST —— 读的时候也只认认识的键（旧文件里已废弃的键，如 night，自动丢弃 ✓）
  const known = {}
  for (const [k, v] of Object.entries(user || {})) if (CONFIG_KEYS.includes(k)) known[k] = v
  return merge(DEFAULTS, known)
}

export function writeConfig(next) {
  fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
  fs.writeFileSync(CFG_FILE, JSON.stringify(next, null, 2) + '\n')
}
